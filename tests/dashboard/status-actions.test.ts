import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readDashboardStatus, summarizeIndex } from '../../packages/dashboard/status.js';
import { disposableVault } from './helpers.js';

test('dashboard status summarizes an empty vault and excludes document content and secrets', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  const priorProvider = process.env.ENGRAM_MODEL_PROVIDER; process.env.ENGRAM_MODEL_PROVIDER = '';
  t.after(() => { if (priorProvider === undefined) delete process.env.ENGRAM_MODEL_PROVIDER; else process.env.ENGRAM_MODEL_PROVIDER = priorProvider; });
  await v.engram.vault.setConfig(config => { config.model.provider = null; });
  await v.engram.createWorkspace('dashboard-test');
  await v.engram.put({ scope: { type: 'workspace', workspaceId: 'dashboard-test' }, kind: 'note', title: 'DASHBOARD_TITLE_SENTINEL', body: 'DASHBOARD_BODY_SENTINEL' });
  process.env.DASH_FAKE_SECRET = 'DASH_SECRET_SENTINEL';
  try {
    const started = performance.now(), status = await readDashboardStatus(v.engram);
    assert.ok(performance.now() - started < 300, 'first aggregate response stays within the 300 ms status budget');
    const response = JSON.stringify(status);
    for (const secret of ['DASHBOARD_TITLE_SENTINEL', 'DASHBOARD_BODY_SENTINEL', 'DASH_SECRET_SENTINEL', v.root]) assert.equal(response.includes(secret), false, `response disclosed ${secret}`);
    assert.equal(response.includes('unavailable') || response.includes('doctor'), true);
    assert.equal((status.provider as { configured: boolean }).configured, false);
  } finally { delete process.env.DASH_FAKE_SECRET; }
});

test('torn journal degrades dashboard status by section without a server error', async t => {
  const v = await disposableVault(); t.after(v.cleanup);
  await mkdir(path.join(v.root, '.mdb/events'), { recursive: true });
  await writeFile(path.join(v.root, '.mdb/events/commits.jsonl'), '{"torn":');
  const status = await readDashboardStatus(v.engram);
  assert.equal(typeof status.generatedAt, 'string');
  assert.ok(status.doctor);
  assert.ok(status.jobs);
});

test('index errors are reduced to content-free health state', () => {
  const summary = JSON.stringify(summarizeIndex({ backend: 'sqlite', available: false, databases: { workspace: { ok: false, error: '/outside/private/index.sqlite: access denied' } } }));
  assert.equal(summary.includes('/outside/private'), false);
  assert.equal(summary.includes('access denied'), false);
  assert.equal(summary.includes('workspace'), true);
});
