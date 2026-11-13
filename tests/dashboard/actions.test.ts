import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';

async function post(port: number, token: string, action: string) {
  return fetch(`http://127.0.0.1:${port}/api/actions/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
}
async function waitForAction(port: number, token: string, id: string): Promise<{ state: string; error?: string }> {
  const deadline = Date.now() + 5_000;
  let result: { state: string; error?: string } | undefined;
  do {
    const response = await fetch(`http://127.0.0.1:${port}/api/actions/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    result = await response.json() as typeof result;
    if (!result) throw new Error(`action ${id} returned an empty response`);
    if (result.state !== 'running') return result;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`action ${id} did not reach a terminal state within 5000 ms`);
}

test('actions are single-flight and report timeout', async t => {
  const v = await disposableVault();
  const original = v.engram.verify.bind(v.engram);
  let verifySettledResolve!: () => void;
  const verifySettled = new Promise<void>(resolve => { verifySettledResolve = resolve; });
  (v.engram as any).verify = async () => { try { await delay(80); return { ok: true, issues: [], objects: 0 }; } finally { verifySettledResolve(); } };
  const dashboard = await createDashboardServer({ engram: v.engram, token: 'c'.repeat(64), actionTimeoutMs: 20 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const [one, two] = await Promise.all([post(dashboard.port, dashboard.token, 'verify-vault'), post(dashboard.port, dashboard.token, 'verify-vault')]);
  const first = await one.json() as { id: string; state: string }, second = await two.json() as { id: string; state: string };
  assert.equal(first.id, second.id); assert.equal(one.status, 202); assert.equal(two.status, 202);
  assert.equal((await post(dashboard.port, dashboard.token, 'verify-index')).status, 409);
  const timed = await waitForAction(dashboard.port, dashboard.token, first.id);
  assert.equal(timed.state, 'failed');
  await verifySettled;
  (v.engram as any).verify = original;
});

test('test-model requires explicit model network consent', async t => {
  const v = await disposableVault();
  const dashboard = await createDashboardServer({ engram: v.engram });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const model = await post(dashboard.port, dashboard.token, 'test-model'); const modelView = await model.json() as { id: string };
  const modelResult = await waitForAction(dashboard.port, dashboard.token, modelView.id);
  assert.equal(modelResult.state, 'failed');
  assert.equal(modelResult.error, 'Model test requires remote network consent');
});

test('test-model action permits loopback Ollama without network consent and reports no vault content', async t => {
  const v = await disposableVault();
  const fake = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ kind: 'note', title: 'ok', body: 'ok', evidence: [{ uri: 'mdb://wiki/objects/obj_model_test', revisionId: 'rev_model_test' }] }) }, finish_reason: 'stop' }] })); });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve)); const port = (fake.address() as AddressInfo).port;
  await v.engram.vault.setConfig(config => { config.model.provider = 'ollama'; config.model.modelName = 'synthetic-test'; config.model.baseUrl = `http://127.0.0.1:${port}/v1`; config.model.allowNetwork = false; });
  const dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { fake.closeAllConnections(); await new Promise<void>(resolve => fake.close(() => resolve())); await dashboard.close(); await v.cleanup(); });
  const started = await post(dashboard.port, dashboard.token, 'test-model'), action = await started.json() as { id: string };
  let state: { state: string; result?: { ok: boolean; provider: string; locality: string; latencyMs: number; sentVaultContent: boolean } } | undefined;
  for (let i = 0; i < 50; i++) { const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${action.id}`, { headers: { Authorization: `Bearer ${dashboard.token}` } }); state = await response.json() as typeof state; if (state?.state !== 'running') break; await delay(10); }
  assert.equal(state?.state, 'complete'); assert.equal(state?.result?.ok, true); assert.equal(state?.result?.provider, 'ollama:synthetic-test'); assert.equal(state?.result?.locality, 'local'); assert.equal(state?.result?.sentVaultContent, false);
});

test('test-model permits a consented remote provider against a loopback fake only', async t => {
  const v = await disposableVault(), requests: string[] = [];
  const fake = createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', part => chunks.push(Buffer.from(part))); req.on('end', () => { requests.push(Buffer.concat(chunks).toString()); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ kind: 'note', title: 'ok', body: 'ok', evidence: [{ uri: 'mdb://wiki/objects/obj_model_test', revisionId: 'rev_model_test' }] }) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve)); const port = (fake.address() as AddressInfo).port;
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-test-key';
  await v.engram.vault.setConfig(config => { config.model.provider = 'openai'; config.model.modelName = 'synthetic-test'; config.model.baseUrl = `http://127.0.0.1:${port}/v1`; config.model.allowNetwork = true; config.model.allowPrivateContentToRemote = false; });
  const dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { fake.closeAllConnections(); await new Promise<void>(resolve => fake.close(() => resolve())); await dashboard.close(); await v.cleanup(); if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; });
  const started = await post(dashboard.port, dashboard.token, 'test-model'), action = await started.json() as { id: string };
  let state: { state: string; result?: { ok: boolean; locality: string; sentVaultContent: boolean } } | undefined;
  for (let i = 0; i < 50; i++) { const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${action.id}`, { headers: { Authorization: `Bearer ${dashboard.token}` } }); state = await response.json() as typeof state; if (state?.state !== 'running') break; await delay(10); }
  assert.equal(state?.state, 'complete'); assert.equal(state?.result?.ok, true); assert.equal(state?.result?.locality, 'remote'); assert.equal(state?.result?.sentVaultContent, false);
  assert.equal(requests.length, 1); assert.match(requests[0]!, /synthetic connectivity check/); assert.equal(requests[0]!.includes(v.root), false);
});

test('test-model denies remote providers before any request when network consent is absent', async t => {
  const v = await disposableVault();
  await v.engram.vault.setConfig(config => { config.model.provider = 'openai'; config.model.modelName = 'synthetic-test'; config.model.baseUrl = 'https://api.openai.com/v1'; config.model.allowNetwork = false; });
  const dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const started = await post(dashboard.port, dashboard.token, 'test-model'), action = await started.json() as { id: string };
  const result = await waitForAction(dashboard.port, dashboard.token, action.id);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'Model test requires remote network consent');
});

test('dashboard idle timeout closes its listener', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 20 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  await new Promise<void>(resolve => dashboard.server.once('close', () => resolve()));
  assert.equal(dashboard.server.listening, false);
});

test('cancelling a running action reports cancellation and keeps single-flight until work settles', async t => {
  const v = await disposableVault();
  const original = v.engram.verify.bind(v.engram);
  (v.engram as any).verify = async () => { await delay(80); return { ok: true, issues: [], objects: 0 }; };
  const dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000, actionTimeoutMs: 5_000 });
  t.after(async () => { (v.engram as any).verify = original; await dashboard.close(); await v.cleanup(); });
  const started = await post(dashboard.port, dashboard.token, 'verify-vault');
  const action = await started.json() as { id: string };
  const cancelled = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${action.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${dashboard.token}` } });
  assert.equal((await cancelled.json() as { state: string }).state, 'cancelled');
  assert.equal((await post(dashboard.port, dashboard.token, 'verify-index')).status, 409);
  await delay(90);
  const next = await post(dashboard.port, dashboard.token, 'verify-index');
  assert.equal(next.status, 202);
  const nextAction = await next.json() as { id: string };
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${nextAction.id}`, { headers: { Authorization: `Bearer ${dashboard.token}` } });
    if ((await state.json() as { state: string }).state !== 'running') break;
    await delay(10);
  }
});
