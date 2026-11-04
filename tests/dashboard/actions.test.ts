import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';

async function post(port: number, token: string, action: string) {
  return fetch(`http://127.0.0.1:${port}/api/actions/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
}
test('actions are single-flight, report timeout, and require explicit model network permission', async t => {
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
  assert.equal((await modelResult.json() as { state: string; error: string }).error, 'Model test requires network permission');
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
