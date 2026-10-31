import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential, resolveHttpActor } from '../../packages/mcp/credentials.js';

test('write idempotency replays require current ACL and direct SDK status updates remain ACL-governed', async t => {
  const { root, vault: owner } = await disposableVault(t);
  await owner.createWorkspace('acl-replay');
  const scope = { type: 'workspace' as const, workspaceId: 'acl-replay' };
  const credential = await createHttpCredential(owner, 'acl-replay-agent', ['workspace:acl-replay:read', 'workspace:acl-replay:write']);
  await owner.grant('acl-replay', 'acl-replay-agent', ['read', 'write']);
  const actor = (await resolveHttpActor(root, `Bearer ${credential.token}`))!;
  assert.ok(actor?.credentialBound);
  const sdk = new Engram(root, actor);
  t.after(() => sdk.close());

  const page = await sdk.put({ scope, kind: 'wiki_page', title: 'Direct retirement', body: 'A page retired by a direct ACL-authorized write.' });
  const retired = await sdk.patch({ objectId: page.id, expectedRevisionId: page.revisionId, status: 'deleted' });
  assert.equal(retired.status, 'deleted');
  assert.equal((await owner.history(page.id)).length, 2, 'direct status retirement is journaled as a revision');
  const recoveredPage = await sdk.restore(page.id, page.revisionId, retired.revisionId);
  assert.equal(recoveredPage.status, 'active', 'direct retirement remains recoverable through a Vault restore revision');
  assert.equal((await owner.history(page.id)).length, 3);

  const deletePage = await owner.put({ scope, kind: 'wiki_page', title: 'Delete replay', body: 'Delete replay target.' });
  const agentVault = sdk.vault;
  const deleted = await agentVault.delete(deletePage.id, deletePage.revisionId, 'delete-replay');
  const restoreTarget = await owner.put({ scope, kind: 'wiki_page', title: 'Restore replay', body: 'Restore replay target.' });
  const tombstone = await owner.delete(restoreTarget.id, restoreTarget.revisionId);
  const restored = await agentVault.restore(restoreTarget.id, restoreTarget.revisionId, tombstone.revisionId, 'restore-replay');

  await owner.grant('acl-replay', 'acl-replay-agent', ['read']);
  for (const replay of [
    () => agentVault.delete(deletePage.id, deletePage.revisionId, 'delete-replay'),
    () => agentVault.restore(restoreTarget.id, restoreTarget.revisionId, tombstone.revisionId, 'restore-replay')
  ]) await assert.rejects(replay(), { code: 'NOT_FOUND_OR_FORBIDDEN' });

  // Existing write paths also check authorization before their idempotency lookup.
  await owner.grant('acl-replay', 'acl-replay-agent', ['read', 'write']);
  const putInput = { scope, kind: 'note', title: 'Put replay', body: 'Put replay body.', idempotencyKey: 'put-replay' } as const;
  const put = await agentVault.put(putInput);
  const patch = await agentVault.patch({ objectId: put.id, expectedRevisionId: put.revisionId, body: 'Patched once.', idempotencyKey: 'patch-replay' });
  const importPath = path.join(root, 'agent-import.txt'); await fs.writeFile(importPath, 'explicitly selected import');
  const ingested = await agentVault.ingest(importPath, scope);
  await owner.grant('acl-replay', 'acl-replay-agent', ['read']);
  await assert.rejects(agentVault.put(putInput), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await assert.rejects(agentVault.patch({ objectId: put.id, expectedRevisionId: put.revisionId, body: 'Patched once.', idempotencyKey: 'patch-replay' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await assert.rejects(agentVault.ingest(importPath, scope), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  assert.equal(deleted.status, 'deleted'); assert.equal(restored.status, 'active'); assert.equal(patch.body, 'Patched once.'); assert.ok(ingested.id);
  recordCase({ suite: 'security', name: 'acl-current-write-before-idempotency-and-direct-retire', status: 'PASS' });
});
