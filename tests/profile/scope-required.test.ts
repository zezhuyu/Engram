import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import type { ModelProvider } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
const idle: ModelProvider = { id: 'must-not-be-called', async generate() { throw new Error('the model must not be called when there is nothing to read'); } };

test('running the profile job without a scope is an explicit error that says how to scope it, not an empty job', async t => {
  const { vault } = await (async (u: T) => disposableVault(u))(t); await vault.createWorkspace('proj', '');
  await vault.put({ scope: { type: 'workspace', workspaceId: 'proj' }, kind: 'note', title: 'A note', body: 'Nothing captured passively here.' }); // no passive user event, so no scoped job is auto-queued
  const engine = new IntelligenceEngine(vault, idle);
  await assert.rejects(engine.run({ job: 'profile' }), /explicit scope.*profile propose --workspace/s);
  assert.equal((await engine.jobs()).filter(j => j.kind === 'profile').length, 0, 'no empty job was created behind the error');
  recordCase({ suite: 'profile', name: 'profile-scope-required', status: 'PASS' });
});

test('global mode only reads global areas and says so when it finds nothing; a workspace job with nothing new says what it searched', async t => {
  const { vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  await vault.put({ scope: { type: 'workspace', workspaceId: 'proj' }, kind: 'observation', title: 'User message', body: 'I prefer tabs.', metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message' } });
  const engine = new IntelligenceEngine(vault, idle);
  await engine.enqueue('profile', { scope: { type: 'global', area: 'profile' } }); const [global] = await engine.run({ job: 'profile', limit: 1 });
  assert.notEqual(global!.status, 'complete', 'an empty global job is never reported as a success');
  assert.match(global!.error!, /global area "profile"/); assert.match(global!.error!, /never workspace conversations/); assert.match(global!.error!, /--workspace ID/);
  await engine.enqueue('profile', { scope: { type: 'workspace', workspaceId: 'proj' }, incremental: true, instruction: 'first' }); await engine.run({ job: 'profile', limit: 1 });
  recordCase({ suite: 'profile', name: 'profile-global-mode-explicit', status: 'PASS' });
});
