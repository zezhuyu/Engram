import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { createHttpCredential, credentialAudit, resolveHttpActor, revokeHttpCredential, rotateHttpCredential } from '../../packages/mcp/credentials.js';

test('credential rotation atomically revokes the old bearer, preserves identity, narrows scopes, and audits without secrets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-identity-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new Vault(root); await owner.init();
  const first = await createHttpCredential(owner, 'agent-1', ['workspace:alpha:read', 'workspace:alpha:write', 'workspace:beta:read']);
  const oldActor = await resolveHttpActor(root, `Bearer ${first.token}`); assert.deepEqual(oldActor?.permissions.sort(), ['workspace:alpha:read', 'workspace:alpha:write', 'workspace:beta:read']);
  const next = await rotateHttpCredential(owner, first.id, ['workspace:alpha:read']);
  assert.equal(await resolveHttpActor(root, `Bearer ${first.token}`), undefined, 'old token is invalid immediately after committed rotation');
  const newActor = await resolveHttpActor(root, `Bearer ${next.token}`); assert.equal(newActor?.actorId, 'agent-1'); assert.deepEqual(newActor?.permissions, ['workspace:alpha:read']); assert.equal(newActor?.credentialBound, true);
  assert.equal(await resolveHttpActor(root, 'Bearer definitely-not-a-token'), undefined);
  assert.equal(await resolveHttpActor(root, undefined), undefined);
  const audit = await credentialAudit(owner); assert.deepEqual(audit.map(e => e.action), ['created', 'rotated', 'authorization_failed', 'authorization_failed', 'authorization_failed']); assert.equal(audit[1]?.credentialId, first.id); assert.equal(audit[1]?.replacementId, next.id); assert.deepEqual(audit[1]?.permissions, ['workspace:alpha:read']);
  const stored = await fs.readFile(path.join(root, '.mdb', 'http-credentials.json'), 'utf8'); assert.doesNotMatch(stored, new RegExp(first.token)); assert.doesNotMatch(stored, new RegExp(next.token));
});

test('credential identities remain distinct under simultaneous provisioning and unauthorized audit reads disclose nothing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-identity-concurrent-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new Vault(root); await owner.init(); const agent = new Vault(root, { actorId: 'agent-1', permissions: ['global:wiki:read'] });
  const results = await Promise.allSettled([createHttpCredential(owner, 'agent-1', ['workspace:alpha:read']), createHttpCredential(owner, 'agent-1', ['workspace:beta:read'])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await assert.rejects(credentialAudit(agent), { code: 'NOT_FOUND_OR_FORBIDDEN' });
});

test('credential revocation is immediate and writes a secret-free administrative audit event', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-identity-revoke-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new Vault(root); await owner.init(); const credential = await createHttpCredential(owner, 'agent-revoked', ['global:wiki:read']);
  assert.equal(await revokeHttpCredential(owner, credential.id), true);
  assert.equal(await resolveHttpActor(root, `Bearer ${credential.token}`), undefined, 'revocation immediately removes the bearer mapping');
  const audit = await credentialAudit(owner); assert.deepEqual(audit.map(event => event.action), ['created', 'revoked']); assert.equal(audit[1]?.credentialId, credential.id);
  assert.doesNotMatch(JSON.stringify(audit), /engram_[A-Za-z0-9_-]+|tokenHash/);
});

test('supported TLS reverse-proxy example terminates HTTPS in front of loopback-only MCP', async () => {
  const config = await fs.readFile(path.join(process.cwd(), 'deploy/Caddyfile'), 'utf8');
  assert.match(config, /^memory\.example\.com \{/m, 'Caddy automatic HTTPS is enabled for a real hostname');
  assert.match(config, /reverse_proxy 127\.0\.0\.1:3333/, 'MCP is reached through loopback');
  assert.doesNotMatch(config, /reverse_proxy https?:\/\/0\.0\.0\.0/, 'the example does not expose the unauthenticated app listener publicly');
});
