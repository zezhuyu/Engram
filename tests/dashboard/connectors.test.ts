import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { validateConnectorTestUrl, validateConnectorRedirect, saveConnectorConfig, connectorConfig, testConnectorConnection, resolveConnectorAddress } from '../../packages/dashboard/connectors.js';
import { assets } from '../../packages/dashboard/ui/view-model.js';
import { resolveHttpActor } from '../../packages/mcp/credentials.js';
import { logoAssets } from '../../packages/dashboard/ui/logo-assets.js';
import { disposableVault } from './helpers.js';

async function call(port: number, path: string, options: { method?: string; cookie?: string; csrf?: boolean; origin?: boolean; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers['X-Engram-Dashboard'] = '1';
  if (options.origin) headers.Origin = `http://127.0.0.1:${port}`;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: options.method ?? 'GET', headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  return { status: response.status, headers: response.headers, body: await response.text() };
}
async function signedIn(t: import('node:test').TestContext) {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const setup = await call(dashboard.port, '/api/auth/setup', { method: 'POST', origin: true, csrf: true, body: { token: dashboard.token, password: 'correct horse battery staple', confirm: 'correct horse battery staple' } }); assert.equal(setup.status, 200);
  const login = await call(dashboard.port, '/api/auth/login', { method: 'POST', origin: true, csrf: true, body: { password: 'correct horse battery staple' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return { ...v, dashboard, cookie };
}

test('connector secrets are write-only, mode 0600, and only field names enter audit', async t => {
  const { root, dashboard, cookie } = await signedIn(t), secret = 'fixture-tunnel-secret-not-for-api';
  assert.equal((await call(dashboard.port, '/api/connectors', { cookie, csrf: true })).status, 200);
  const saved = await call(dashboard.port, '/api/connectors/config', { method: 'POST', cookie, csrf: true, origin: true, body: { connector: 'openai', confirm: 'SAVE OPENAI CONNECTOR', values: { publicUrl: 'https://memory.example.com', tunnelToken: secret, oauthClientSecret: 'oauth-secret-fixture' } } });
  assert.equal(saved.status, 200); assert.doesNotMatch(saved.body, /fixture-tunnel-secret|oauth-secret-fixture/); assert.match(saved.body, /memory\.example\.com/);
  const configFile = `${root}/.mdb/dashboard/connectors.json`, stat = await fs.stat(configFile);
  assert.equal(stat.mode & 0o777, 0o600);
  const stored = await fs.readFile(configFile, 'utf8'); assert.match(stored, /fixture-tunnel-secret/);
  const badSave = await call(dashboard.port, '/api/connectors/config', { method: 'POST', cookie, csrf: true, origin: true, body: { connector: 'openai', confirm: 'SAVE OPENAI CONNECTOR', values: { publicUrl: 'http://user:password@bad.example/?secret=secret-leak-sentinel' } } }); assert.equal(badSave.status, 400); assert.doesNotMatch(badSave.body, /secret-leak-sentinel|password@/);
  const state = await call(dashboard.port, '/api/connectors', { cookie, csrf: true }); assert.doesNotMatch(state.body, /fixture-tunnel-secret|oauth-secret-fixture/); assert.match(state.body, /\"tunnelToken\":\{\"set\":true\}/);
  const audit = await fs.readFile(`${root}/.mdb/dashboard/audit.jsonl`, 'utf8'); assert.doesNotMatch(audit, /fixture-tunnel-secret|oauth-secret-fixture/); assert.match(audit, /"fields":\["publicUrl","tunnelToken","oauthClientSecret"\]/);
  await saveConnectorConfig(root, 'openai', { tunnelToken: null }, 'SAVE OPENAI CONNECTOR');
  assert.equal((await connectorConfig(root)).openai!.tunnelToken!.set, false);
});

test('connector credential routes require session plus CSRF and reveal tokens once', async t => {
  const { root, dashboard, cookie } = await signedIn(t), path = '/api/connectors/credentials';
  assert.equal((await call(dashboard.port, '/api/connectors', { token: dashboard.token })).status, 401, 'bootstrap bearer is not a connector session');
  assert.equal((await call(dashboard.port, path, { method: 'POST', cookie, origin: true, body: { actorId: 'connector-test', permissions: ['workspace:alpha:read'] } })).status, 401, 'session without CSRF header is refused');
  const created = await call(dashboard.port, path, { method: 'POST', cookie, csrf: true, origin: true, body: { actorId: 'connector-test', permissions: ['workspace:alpha:read'], expiresAt: new Date(Date.now() + 86400_000).toISOString() } });
  assert.equal(created.status, 201); const { token, id } = JSON.parse(created.body); assert.match(token, /^engram_/);
  await resolveHttpActor(root, `Bearer ${token}`);
  const listed = await call(dashboard.port, path, { cookie, csrf: true }); assert.equal(listed.status, 200); assert.doesNotMatch(listed.body, new RegExp(token)); assert.match(listed.body, /connector-test/); assert.match(listed.body, /"lastUsedAt":"/); assert.match(listed.body, /"expiresAt":"/);
  const rotated = await call(dashboard.port, path + `/${id}/rotate`, { method: 'POST', cookie, csrf: true, origin: true, body: {} }); assert.equal(rotated.status, 200); const replacement = JSON.parse(rotated.body); assert.notEqual(replacement.token, token);
  assert.equal((await call(dashboard.port, path + `/${replacement.id}/revoke`, { method: 'POST', cookie, csrf: true, origin: true, body: { confirm: `REVOKE ${replacement.id}` } })).status, 200);
  assert.doesNotMatch((await call(dashboard.port, '/api/audit', { cookie, csrf: true })).body, new RegExp(token));
});

test('connection URL policy rejects HTTP/private and cross-host redirects', async () => {
  assert.throws(() => validateConnectorTestUrl('http://memory.example.com'), /HTTPS/);
  assert.throws(() => validateConnectorTestUrl('https://127.0.0.1'), /Private and loopback/);
  assert.throws(() => validateConnectorTestUrl('https://192.168.1.2'), /Private and loopback/);
  assert.throws(() => validateConnectorTestUrl('https://memory.example.com?token=secret'), /HTTPS URL/);
  assert.throws(() => validateConnectorRedirect(new URL('https://memory.example.com/version'), 'https://attacker.example/collect'), /another host/);
  await assert.rejects(() => testConnectorConnection('https://localhost/version'), /Private and loopback/);
});

test('connector DNS rebinding uses one validated answer and pins that address', async () => {
  let calls = 0;
  const resolveHost = async () => { calls++; return calls === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
  const pinned = await resolveConnectorAddress(new URL('https://memory.example.com/version'), false, resolveHost);
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
  assert.equal(calls, 1, 'the connector must not perform a second DNS lookup after validation');
  await assert.rejects(() => resolveConnectorAddress(new URL('https://memory.example.com/version'), false, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /Private and loopback/);
});

test('connector connection pins the resolver address and refuses a local redirect to a private host', async t => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-connector-tls-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const certPath = path.join(fixtureDir, 'cert.pem'), keyPath = path.join(fixtureDir, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:memory.example.com', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' });
  if (generated.error && (generated.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('TLS redirect test requires openssl to generate its throwaway self-signed certificate');
    return;
  }
  assert.equal(generated.status, 0, `openssl certificate generation failed: ${generated.stderr}`);
  const cert = await fs.readFile(certPath);
  const key = await fs.readFile(keyPath);
  const server = createHttpsServer({ cert, key }, (_request, response) => { response.writeHead(302, { Location: 'https://127.0.0.1/private' }); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let resolutions = 0;
  const resolveHost = async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; };
  await assert.rejects(() => testConnectorConnection(`https://memory.example.com:${address.port}/version`, true, resolveHost, {}, { ca: cert, allowNonstandardPort: true }), /redirect to another host/);
  assert.equal(resolutions, 1, 'the TLS request uses the validated address without a second DNS lookup');
});

test('dashboard serves only fixed logo bytes with image types and immutable cache headers', async t => {
  const { dashboard } = await signedIn(t);
  for (const [route, asset] of Object.entries(logoAssets)) {
    const response = await fetch(`http://127.0.0.1:${dashboard.port}${route}`);
    assert.equal(response.headers.get('content-type'), 'image/png'); assert.match(response.headers.get('cache-control')!, /max-age=31536000/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.body);
  }
  assert.equal((await fetch(`http://127.0.0.1:${dashboard.port}/assets/not-real.png`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${dashboard.port}/assets/logo-64.png?x=1`)).status, 200);
  assert.equal(assets['/']!.body!.includes('apple-touch-icon'), true); assert.equal(assets['/']!.body!.includes('alt="Engram"'), true);
});
