import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { execute, isReadOnlyCommand } from '../../packages/cli/index.js';
import { disposableVault } from './helpers.js';

async function call(port: number, path: string, opts: { method?: string; token?: string; host?: string; connectHost?: string; origin?: string; body?: string; contentType?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: opts.connectHost ?? '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { ...(opts.host ? { Host: opts.host } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.origin ? { Origin: opts.origin } : {}), ...(opts.body ? { 'Content-Type': opts.contentType ?? 'application/json', 'Content-Length': Buffer.byteLength(opts.body) } : {}) } }, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(Buffer.from(c))); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
    req.on('error', reject); if (opts.body) req.write(opts.body); req.end();
  });
}
test('dashboard security gates API requests and serves only fixed assets', async t => {
  assert.equal(isReadOnlyCommand('dashboard', undefined), true);
  await assert.rejects(() => execute(['dashboard', '--host', 'example.com']), /local interface IP address/);
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, token: 'a'.repeat(64), idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  process.env.DASHBOARD_SECRET_SENTINEL = 'never-return-this-secret';
  await v.engram.vault.setConfig(config => { config.model.provider = 'openai-compatible'; config.model.apiKeyEnv = 'DASHBOARD_SECRET_SENTINEL'; });
  assert.equal((await call(dashboard.port, '/api/status')).status, 401);
  assert.equal((await call(dashboard.port, '/api/status', { token: 'b'.repeat(64) })).status, 401);
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, host: 'evil.example' })).status, 403);
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, host: '127.0.0.1.evil:80' })).status, 403);
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, origin: 'http://evil.example' })).status, 403);
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, method: 'PUT' })).status, 405);
  const tooBig = await call(dashboard.port, '/api/settings/apply', { token: dashboard.token, method: 'POST', body: JSON.stringify({ value: 'x'.repeat(70_000), key: 'x', etag: 'x' }) });
  assert.equal(tooBig.status, 413);
  assert.equal((await call(dashboard.port, '/%2e%2e/package.json')).status, 404);
  const page = await call(dashboard.port, '/', { host: `127.0.0.1:${dashboard.port}` });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['x-content-type-options'], 'nosniff'); assert.equal(page.headers['referrer-policy'], 'no-referrer');
  const good = await call(dashboard.port, '/api/status', { token: dashboard.token });
  assert.equal(good.status, 200); assert.equal(good.body.includes(dashboard.token), false);
  assert.equal(good.body.includes('never-return-this-secret'), false);
  for (const route of ['/api/settings', '/api/audit', '/api/status/provider']) {
    const response = await call(dashboard.port, route, { token: dashboard.token });
    assert.equal(response.body.includes('never-return-this-secret'), false);
    assert.equal(response.body.includes(dashboard.token), false);
  }
  delete process.env.DASHBOARD_SECRET_SENTINEL;
  await assert.rejects(() => createDashboardServer({ engram: v.engram, host: '192.0.2.123' }), /not assigned to a local interface/);
  assert.equal(dashboard.host, '127.0.0.1');
});

test('dashboard binds a configured local interface and validates port conflicts', async t => {
  const v = await disposableVault();
  t.after(async () => { await v.cleanup(); });
  const ipv4 = Object.values((await import('node:os')).networkInterfaces()).flatMap(entries => entries ?? []).find(entry => entry.family === 'IPv4' && !entry.internal)?.address;
  if (!ipv4) { t.skip('no non-loopback IPv4 interface is available'); return; }
  const dashboard = await createDashboardServer({ engram: v.engram, host: ipv4, idleMs: 60_000 });
  t.after(async () => dashboard.close());
  assert.equal(dashboard.host, ipv4);
  const response = await call(dashboard.port, '/api/status', { connectHost: ipv4, host: `${ipv4}:${dashboard.port}`, token: dashboard.token });
  assert.equal(response.status, 200, 'configured host and Host:port are accepted');
  assert.equal((await call(dashboard.port, '/api/status', { connectHost: ipv4, host: `127.0.0.1:${dashboard.port}`, token: dashboard.token })).status, 403, 'other interface IPs are not accepted for a specific bind');
  await assert.rejects(() => createDashboardServer({ engram: v.engram, host: ipv4, port: dashboard.port }), /already in use/);
  const wildcard = await createDashboardServer({ engram: v.engram, host: '::', idleMs: 60_000 });
  t.after(async () => wildcard.close());
  assert.equal(wildcard.host, '::');
});

test('remote dashboard binds all interfaces and enforces remote host, origin, token, and lockout rules', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, allowRemote: true, token: 'c'.repeat(64), idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  assert.equal(dashboard.host, '0.0.0.0');
  const ipv4 = Object.values((await import('node:os')).networkInterfaces()).flatMap(entries => entries ?? []).find(entry => entry.family === 'IPv4' && !entry.internal)?.address;
  if (!ipv4) { t.skip('no non-internal IPv4 interface is available for a remote-bind connection check'); return; }
  const reachable = await call(dashboard.port, '/api/status', { connectHost: ipv4, host: `${ipv4}:${dashboard.port}`, token: dashboard.token });
  assert.equal(reachable.status, 200);
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, host: `foreign-${hostname()}.invalid:${dashboard.port}` })).status, 403);
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, host: `192.0.2.8:${dashboard.port}` })).status, 200, 'IP-literal Host values are accepted');
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, host: `${hostname()}:${dashboard.port}` })).status, 200, 'machine hostname is accepted');
  assert.equal((await call(dashboard.port, '/api/status', { token: dashboard.token, host: `${ipv4}:${dashboard.port}`, origin: 'http://foreign.example' })).status, 403);
  assert.equal((await call(dashboard.port, '/api/status', { host: `${ipv4}:${dashboard.port}`, token: 'wrong' })).status, 401);
  for (let i = 1; i < 10; i++) assert.equal((await call(dashboard.port, '/api/status', { host: `${ipv4}:${dashboard.port}`, token: 'wrong' })).status, 401);
  assert.equal((await call(dashboard.port, '/api/status', { host: `${ipv4}:${dashboard.port}`, token: dashboard.token })).status, 429);
  const response = await call(dashboard.port, '/', { host: `${ipv4}:${dashboard.port}` });
  assert.equal(response.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
});
