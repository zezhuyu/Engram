import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assetsFor } from '../../packages/dashboard/ui/assets.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { compactScript, disposableVault } from './helpers.js';

test('the health pill shows Disconnected after a failed refresh instead of the last good result, and recovers', () => {
  for (const mode of ['server', 'client'] as const) {
    const source = compactScript(assetsFor(mode)['/assets/app.js']!.body as string);
    const start = source.indexOf('let linkDown=false'), end = source.indexOf('\nfunction dataTable(', start);
    assert.ok(start >= 0 && end > start, `${mode}: setHealth is available`);
    const node = (tag: string, className = '', text = '') => ({ tag, className, textContent: text });
    const health: { className: string; title: string; children: Array<{ textContent: string }> ; replaceChildren(...items: Array<{ textContent: string }>): void } = { className: '', title: '', children: [], replaceChildren(...items) { this.children = items; } };
    const sandbox: Record<string, unknown> = { health, node, icons: { ok: '✓', attention: '!', problem: 'x', unknown: '?' }, statusTone: () => 'ok', status: { doctor: { state: 'ok' } } };
    const api = vm.runInNewContext(`${source.slice(start, end)};({set:v=>{linkDown=v},run:setHealth})`, sandbox) as { set(value: boolean): void; run(): void };
    const label = () => health.children.map(child => child.textContent).join('');
    api.run(); assert.match(label(), /OK/, `${mode}: healthy`);
    api.set(true); api.run(); assert.match(label(), /Disconnected/, `${mode}: a stale OK must not remain`); assert.match(health.className, /state-problem/);
    api.set(false); api.run(); assert.match(label(), /OK/, `${mode}: recovers`);
  }
  for (const mode of ['server', 'client'] as const) {
    const source = compactScript(assetsFor(mode)['/assets/app.js']!.body as string);
    assert.match(source, /linkDown=true/, `${mode}: a failed refresh marks the link down`);
    assert.match(source, /linkDown=false/, `${mode}: a good refresh clears it`);
  }
});

test('profile domain discovery is session-only, refuses without a model or consent, and never errors the dashboard', async t => {
  const vault = await disposableVault();
  const dashboard = await createDashboardServer({ engram: vault.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await vault.cleanup(); });
  const origin = `http://127.0.0.1:${dashboard.port}`, password = 'discovery-test-password-2026', json = { Origin: origin, 'Content-Type': 'application/json' };
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ token: dashboard.token, password, confirm: password }) }); assert.equal(setup.status, 200);
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password }) }); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const post = (headers: Record<string, string>) => fetch(origin + '/api/profile/domains', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ operation: 'discover' }) });
  assert.equal((await post({})).status, 401, 'anonymous requests are refused');
  const reply = await post({ Cookie: cookie, Origin: origin, 'X-Engram-Dashboard': '1' });
  assert.equal(reply.status, 200, await reply.clone().text());
  const body = await reply.json() as { discovery: { status: string; reason?: string; classified?: number; calls?: number } };
  assert.ok(['unavailable', 'complete'].includes(body.discovery.status));
  if (body.discovery.status === 'unavailable') assert.ok(body.discovery.reason && body.discovery.reason.length > 10);
  else assert.equal(body.discovery.calls, 0, 'an empty profile makes no model call');
});
