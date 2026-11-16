import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
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
async function rawCall(port: number, requestText: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let response = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('raw dashboard request timed out')); });
    socket.on('data', chunk => { response += chunk.toString('latin1'); });
    socket.on('error', reject);
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d+)/.exec(response);
      if (!match) return resolve({ status: 0, body: response.slice(0, 200) });
      const split = response.indexOf('\r\n\r\n');
      resolve({ status: Number(match[1]), body: split < 0 ? '' : response.slice(split + 4) });
    });
    socket.on('connect', () => socket.end(requestText));
  });
}

test('dashboard validates Host once at the request boundary for every route', async t => {
  const v = await disposableVault();
  const dashboard = await createDashboardServer({ engram: v.engram, token: 'h'.repeat(64), idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const port = dashboard.port;
  const cases = [
    [`GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nhOsT: evil.example\r\nAuthorization: Bearer ${dashboard.token}\r\nConnection: close\r\n\r\n`, 400, 'duplicate Host before API auth'],
    [`GET /assets/app.js HTTP/1.1\r\nHost: 127.0.0.1:${port},evil.example\r\nConnection: close\r\n\r\n`, 400, 'comma-joined duplicate Host'],
    [`GET / HTTP/1.1\r\nHost: evil\u0000.example\r\nConnection: close\r\n\r\n`, 400, 'control character in Host'],
    [`GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`, 403, 'hostile static route'],
    [`GET /assets/app.css HTTP/1.1\r\nHost:    \r\nConnection: close\r\n\r\n`, 400, 'blank static Host'],
    [`GET /api/status HTTP/1.0\r\nAuthorization: Bearer ${dashboard.token}\r\nConnection: close\r\n\r\n`, 400, 'HTTP/1.0 missing Host'],
  ] as const;
  for (const [wire, expected, label] of cases) {
    const response = await rawCall(port, wire);
    assert.equal(response.status, expected, `${label}: ${response.body}`);
    if (expected === 400) assert.match(response.body, /INVALID_HOST/);
  }
  const hostileStatic = await Promise.all(['/','/assets/app.css','/assets/app.js'].map(route => call(port, route, { host: `evil.example:${port}` })));
  assert.ok(hostileStatic.every(reply => reply.status === 403 && reply.body === hostileStatic[0]!.body && reply.body.includes('HOST_NOT_ALLOWED')));
  assert.ok(hostileStatic.every(reply => !reply.body.includes('<html') && !reply.body.includes('body{')));
  assert.equal((await call(port, '/api/status', { token: dashboard.token, host: `LOCALHOST:${port}` })).status, 200);
  assert.equal((await call(port, '/api/status', { token: dashboard.token, host: `[::1]:${port}` })).status, 200);
  assert.equal((await call(port, '/api/status', { token: dashboard.token, host: `localhost.:${port}` })).status, 403);
  assert.equal((await call(port, '/api/status', { token: dashboard.token, host: `localhost:${port + 1}` })).status, 403);
});

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
  assert.equal(page.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
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
  assert.equal(response.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
});
