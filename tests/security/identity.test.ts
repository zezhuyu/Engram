import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { Engram } from '../../packages/sdk/index.js';
import { toolsFor } from '../../packages/mcp/index.js';
import { createHttpCredential, credentialAudit, isValidRemotePermission, resolveHttpActor, revokeHttpCredential, rotateHttpCredential } from '../../packages/mcp/credentials.js';

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

test('workspace:create is explicit, capped, audited, actor-only and exposed only remotely', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-workspace-ensure-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new Engram(root); await owner.vault.init();
  assert.equal(isValidRemotePermission('workspace:create'), true); assert.equal(isValidRemotePermission('workspace:*'), false);
  const denied = new Engram(root, { actorId: 'denied', permissions: [], credentialBound: true });
  await assert.rejects(denied.vault.ensureWorkspaceForActor('new-project'), /workspace:create.*ask the owner/);
  const actor = new Engram(root, { actorId: 'auto', permissions: ['workspace:create'], credentialBound: true });
  const priorCap = process.env.MDB_AUTO_WORKSPACE_CAP; process.env.MDB_AUTO_WORKSPACE_CAP = '1'; t.after(() => { if (priorCap === undefined) delete process.env.MDB_AUTO_WORKSPACE_CAP; else process.env.MDB_AUTO_WORKSPACE_CAP = priorCap; });
  assert.equal(await actor.vault.ensureWorkspaceForActor('new-project', 'test'), 'created');
  assert.equal(await actor.vault.ensureWorkspaceForActor('new-project', 'test'), 'exists');
  await assert.rejects(denied.vault.ensureWorkspaceForActor('new-project'), /already exists.*ask the owner/);
  await assert.rejects(actor.vault.ensureWorkspaceForActor('second-project'), /limit \(1\)/);
  assert.deepEqual((await owner.vault.listWorkspaces()).find(w => w.id === 'new-project')?.grants, { auto: ['read', 'write'] });
  const audit = (await fs.readFile(path.join(root, '.mdb', 'workspace-create-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit, [{ actorId: 'auto', workspaceId: 'new-project', at: audit[0]!.at, autoCreated: true }]); assert.ok(Number.isFinite(Date.parse(audit[0]!.at)));
  const names = (toolset: string) => toolsFor(owner, toolset).map(tool => tool.name);
  assert.ok(names('remote-web').includes('engram_workspace_ensure')); assert.ok(!names('standard').includes('engram_workspace_ensure'));
});
