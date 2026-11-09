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
test('actions are single-flight, report timeout, and require explicit model network consent', async t => {
  const v = await disposableVault();
  const original = v.engram.verify.bind(v.engram);
  (v.engram as any).verify = async () => { await delay(80); return { ok: true, issues: [], objects: 0 }; };
  const dashboard = await createDashboardServer({ engram: v.engram, token: 'c'.repeat(64), actionTimeoutMs: 20 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const [one, two] = await Promise.all([post(dashboard.port, dashboard.token, 'verify-vault'), post(dashboard.port, dashboard.token, 'verify-vault')]);
  const first = await one.json() as { id: string; state: string }, second = await two.json() as { id: string; state: string };
  assert.equal(first.id, second.id); assert.equal(one.status, 202); assert.equal(two.status, 202);
  assert.equal((await post(dashboard.port, dashboard.token, 'verify-index')).status, 409);
  await delay(30);
  const timed = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${first.id}`, { headers: { Authorization: `Bearer ${dashboard.token}` } });
  assert.equal((await timed.json() as { state: string }).state, 'failed');
  await delay(60);
  (v.engram as any).verify = original;
  const model = await post(dashboard.port, dashboard.token, 'test-model'); const modelView = await model.json() as { id: string };
  await delay(10);
  const modelResult = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${modelView.id}`, { headers: { Authorization: `Bearer ${dashboard.token}` } });
  assert.equal((await modelResult.json() as { state: string; error: string }).error, 'Model test requires remote network consent');
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
  await delay(20);
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/actions/${action.id}`, { headers: { Authorization: `Bearer ${dashboard.token}` } });
  const result = await response.json() as { state: string; error: string };
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
