import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDashboardServer, dashboardEnabled } from '../../packages/dashboard/server.js';
import { validatePassword, dashboardSessionFile, dashboardAuthFile, passwordIsSet, resetPassword } from '../../packages/dashboard/password.js';
import { disposableVault } from './helpers.js';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: any };
async function call(port: number, pathname: string, options: { method?: string; body?: unknown; cookie?: string; token?: string; csrf?: boolean; origin?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.csrf ? { 'X-Engram-Dashboard': '1' } : {}), ...(options.origin !== undefined ? { Origin: options.origin } : options.method && options.method !== 'GET' ? { Origin: `http://127.0.0.1:${port}` } : {}),
    } }, response => { const chunks: Buffer[] = []; response.on('data', part => chunks.push(Buffer.from(part))); response.on('end', () => { const text = Buffer.concat(chunks).toString(); let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; } resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed }); }); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
async function setup(port: number, token: string, password = 'correct horse battery staple') {
  return call(port, '/api/auth/setup', { method: 'POST', csrf: true, body: { token, password, confirm: password } });
}
async function login(port: number, password: string): Promise<{ reply: Reply; cookie?: string }> {
  const reply = await call(port, '/api/auth/login', { method: 'POST', csrf: true, body: { password } });
  const setCookie = reply.headers['set-cookie'];
  return { reply, cookie: Array.isArray(setCookie) ? setCookie[0]?.split(';')[0] : setCookie?.split(';')[0] };
}
async function readVaultTextFiles(directory: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await readVaultTextFiles(file));
    else { try { results.push(await fs.readFile(file, 'utf8')); } catch { /* binary or concurrently removed */ } }
  }
  return results;
}
const authLocation = (root: string) => ({ env: { MDB_DASHBOARD_AUTH_FILE: path.join(root, 'external-auth', 'auth.json') } });

test('dashboard password setup requires bootstrap token, enforces policy, stores only a protected scrypt hash', async t => {
  const v = await disposableVault(), token = 'a'.repeat(64), auth = authLocation(v.root), server = await createDashboardServer({ engram: v.engram, token, idleMs: 60_000, authLocation: auth });
  t.after(async () => { await server.close(); await v.cleanup(); });
  assert.equal((await call(server.port, '/api/auth/status')).body.passwordSet, false);
  assert.equal((await setup(server.port, 'b'.repeat(64))).status, 400);
  assert.match(validatePassword('short') ?? '', /12 and 256/);
  assert.match(validatePassword('x'.repeat(257)) ?? '', /12 and 256/);
  assert.match(validatePassword('password123456') ?? '', /common/);
  assert.match(validatePassword(token, token) ?? '', /different/);
  assert.equal(validatePassword('p'.repeat(256)), undefined);
  assert.equal((await call(server.port, '/api/auth/setup', { method: 'POST', csrf: true, body: { token, password: 'correct horse battery staple', confirm: 'not the same password' } })).status, 400);
  assert.equal((await setup(server.port, token)).status, 200);
  const file = auth.env.MDB_DASHBOARD_AUTH_FILE, record = await fs.readFile(file, 'utf8'), info = await fs.stat(file);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(record.includes('correct horse battery staple'), false);
  const stored = JSON.parse(record) as { salt: string; hash: string };
  assert.match(record, /"N":32768/); assert.match(record, /"salt":"[a-f0-9]{32}"/); assert.match(record, /"hash":"[a-f0-9]{128}"/);
  for (const response of [await call(server.port, '/api/auth/status'), await call(server.port, '/api/settings', { token }), await call(server.port, '/api/audit', { token }), await call(server.port, '/api/status', { token })]) {
    const body = JSON.stringify(response.body); assert.equal(body.includes(stored.hash), false); assert.equal(body.includes(stored.salt), false);
  }
  assert.equal((await call(server.port, '/api/auth/status')).body.passwordSet, true);
  assert.equal((await readVaultTextFiles(v.root)).some(contents => contents.includes('correct horse battery staple')), false, 'password is absent from vault files and logs');
  assert.equal((await setup(server.port, token)).status, 409);
});

test('password login returns strict HttpOnly cookie, session CSRF is enforced, and password change signs out every session', async t => {
  const v = await disposableVault(), token = 'c'.repeat(64), auth = authLocation(v.root), server = await createDashboardServer({ engram: v.engram, token, idleMs: 60_000, authLocation: auth });
  t.after(async () => { await server.close(); await v.cleanup(); });
  await setup(server.port, token);
  const bad = await login(server.port, 'wrong password'); assert.equal(bad.reply.status, 401); assert.match(bad.reply.body.error.message, /Sign-in failed/);
  const first = await login(server.port, 'correct horse battery staple'); assert.equal(first.reply.status, 200); assert.ok(first.cookie);
  const cookieFlags = String(first.reply.headers['set-cookie']); assert.match(cookieFlags, /HttpOnly/); assert.match(cookieFlags, /SameSite=Strict/); assert.match(cookieFlags, /Path=\//); assert.match(cookieFlags, /Max-Age=43200/); assert.doesNotMatch(cookieFlags, /Secure/);
  assert.equal((await call(server.port, '/api/actions/verify-index', { cookie: first.cookie, method: 'POST', body: {} })).status, 401, 'session writes require the dashboard header');
  assert.equal((await call(server.port, '/api/actions/verify-index', { cookie: first.cookie, csrf: true, method: 'POST', body: {}, origin: 'http://evil.invalid' })).status, 403);
  const knowledgeWrite = { scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'CSRF test', body: 'no cross-origin write' };
  assert.equal((await call(server.port, '/api/documents', { cookie: first.cookie, method: 'POST', body: knowledgeWrite })).status, 401, 'knowledge writes require the session header');
  assert.equal((await call(server.port, '/api/documents', { cookie: first.cookie, csrf: true, method: 'POST', body: knowledgeWrite, origin: 'http://evil.invalid' })).status, 403, 'knowledge writes reject cross-origin sessions');
  assert.equal((await call(server.port, '/api/actions/verify-index', { cookie: first.cookie, csrf: true, method: 'POST', body: {} })).status, 202);
  assert.equal((await call(server.port, '/api/status', { token })).status, 200, 'bearer token remains available to scripts');
  const sessionText = await fs.readFile(dashboardSessionFile(auth.env.MDB_DASHBOARD_AUTH_FILE), 'utf8');
  assert.equal(sessionText.includes(first.cookie!.split('=')[1]!), false, 'session file never stores raw cookie ids');
  assert.equal((await fs.stat(dashboardSessionFile(auth.env.MDB_DASHBOARD_AUTH_FILE))).mode & 0o777, 0o600);
  const second = await login(server.port, 'correct horse battery staple'); assert.ok(second.cookie);
  const changed = await call(server.port, '/api/auth/change-password', { method: 'POST', csrf: true, cookie: first.cookie, body: { currentPassword: 'correct horse battery staple', password: 'new very secure phrase 2026', confirm: 'new very secure phrase 2026' } });
  assert.equal(changed.status, 200);
  assert.equal((await call(server.port, '/api/settings', { cookie: second.cookie, csrf: true })).status, 401, 'password change invalidates all sessions');
  assert.equal(await fs.access(dashboardSessionFile(auth.env.MDB_DASHBOARD_AUTH_FILE)).then(() => true).catch(() => false), false, 'password change removes the persisted session file');
  assert.equal((await login(server.port, 'new very secure phrase 2026')).reply.status, 200);
  assert.equal((await fs.readFile(auth.env.MDB_DASHBOARD_AUTH_FILE, 'utf8')).includes('new very secure phrase 2026'), false);
  assert.equal((await fs.readFile(`${v.root}/.mdb/dashboard/audit.jsonl`, 'utf8').catch(() => '')).includes('new very secure phrase 2026'), false);
});

test('password lockout returns 429 and Retry-After after five failures', async t => {
  const v = await disposableVault(), server = await createDashboardServer({ engram: v.engram, token: 'd'.repeat(64), idleMs: 60_000, authLocation: authLocation(v.root) });
  t.after(async () => { await server.close(); await v.cleanup(); });
  await setup(server.port, server.token);
  let response: Reply | undefined;
  for (let attempt = 0; attempt < 5; attempt++) response = (await login(server.port, 'wrong password')).reply;
  assert.equal(response?.status, 429); assert.ok(Number(response?.headers['retry-after']) >= 1);
  assert.match(response?.body.error.message ?? '', /retry time/i);
});

test('dashboard sessions expire on idle and oldest sessions are evicted at the configured bound', async t => {
  const v = await disposableVault(), server = await createDashboardServer({ engram: v.engram, token: 'e'.repeat(64), idleMs: 60_000, sessionIdleMs: 40, maxSessions: 1, authLocation: authLocation(v.root) });
  t.after(async () => { await server.close(); await v.cleanup(); });
  await setup(server.port, server.token);
  const one = await login(server.port, 'correct horse battery staple'), two = await login(server.port, 'correct horse battery staple');
  assert.equal((await call(server.port, '/api/status', { cookie: one.cookie, csrf: true })).status, 401);
  assert.equal((await call(server.port, '/api/status', { cookie: two.cookie, csrf: true })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 60));
  const expired = await call(server.port, '/api/status', { cookie: two.cookie, csrf: true });
  assert.equal(expired.status, 401); assert.equal(expired.headers['x-engram-session-expired'], '1');
});

test('logout removes its session and dashboard reset deletes the password hash without binding a listener', async t => {
  const v = await disposableVault(), auth = authLocation(v.root), server = await createDashboardServer({ engram: v.engram, token: 'f'.repeat(64), idleMs: 60_000, authLocation: auth });
  t.after(async () => { await server.close(); await v.cleanup(); });
  await setup(server.port, server.token); const signed = await login(server.port, 'correct horse battery staple');
  const other = await login(server.port, 'correct horse battery staple');
  assert.equal((await call(server.port, '/api/auth/logout', { method: 'POST', csrf: true, cookie: signed.cookie, body: {} })).status, 200);
  assert.equal((await call(server.port, '/api/status', { cookie: signed.cookie, csrf: true })).status, 401);
  assert.equal((await call(server.port, '/api/auth/logout-all', { method: 'POST', csrf: true, cookie: other.cookie, body: {} })).status, 200);
  assert.equal((await call(server.port, '/api/status', { cookie: other.cookie, csrf: true })).status, 401);
  assert.equal(await fs.access(dashboardSessionFile(auth.env.MDB_DASHBOARD_AUTH_FILE)).then(() => true).catch(() => false), false, 'sign-out-everywhere removes persisted sessions');
  const priorAuth = process.env.MDB_DASHBOARD_AUTH_FILE; process.env.MDB_DASHBOARD_AUTH_FILE = auth.env.MDB_DASHBOARD_AUTH_FILE;
  t.after(() => { if (priorAuth === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE; else process.env.MDB_DASHBOARD_AUTH_FILE = priorAuth; });
  assert.match(String(await (await import('../../packages/cli/index.js')).execute(['dashboard', '--root', v.root, '--reset-password'])), /password removed/i);
  assert.equal(await fs.access(auth.env.MDB_DASHBOARD_AUTH_FILE).then(() => true).catch(() => false), false);
});

test('user-level password migrates legacy vault records and survives another vault and dashboard restart', async t => {
  const firstVault = await disposableVault(), secondVault = await disposableVault();
  const auth = authLocation(firstVault.root), authFile = auth.env.MDB_DASHBOARD_AUTH_FILE;
  const first = await createDashboardServer({ engram: firstVault.engram, token: 'm'.repeat(64), idleMs: 60_000, authLocation: auth });
  t.after(async () => { await first.close(); await secondVault.cleanup(); await firstVault.cleanup(); });
  await setup(first.port, first.token);
  const signed = await login(first.port, 'correct horse battery staple');
  assert.ok(signed.cookie);
  await first.close();
  const second = await createDashboardServer({ engram: secondVault.engram, token: 'n'.repeat(64), idleMs: 60_000, authLocation: auth });
  t.after(async () => second.close());
  assert.equal((await call(second.port, '/api/auth/status')).body.passwordSet, true);
  assert.equal((await login(second.port, 'correct horse battery staple')).reply.status, 200);
  assert.equal((await call(second.port, '/api/status', { cookie: signed.cookie, csrf: true })).status, 200, 'existing session survives server restart and can be used for another vault');

  const legacyVault = await disposableVault(); t.after(async () => legacyVault.cleanup());
  const legacyAuth = authLocation(legacyVault.root), legacyFile = path.join(legacyVault.root, '.mdb', 'dashboard', 'auth.json');
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  await fs.copyFile(authFile, legacyFile);
  await fs.chmod(legacyFile, 0o640);
  const alternateAuth = { env: { MDB_DASHBOARD_AUTH_FILE: path.join(legacyVault.root, 'migrated', 'auth.json') } };
  const migrated = await createDashboardServer({ engram: legacyVault.engram, token: 'o'.repeat(64), idleMs: 60_000, authLocation: alternateAuth });
  t.after(async () => migrated.close());
  assert.equal((await call(migrated.port, '/api/auth/status')).body.passwordSet, true);
  assert.equal(await fs.readFile(legacyFile, 'utf8'), await fs.readFile(alternateAuth.env.MDB_DASHBOARD_AUTH_FILE, 'utf8'));
  const legacyBeforeReset = await fs.readFile(legacyFile, 'utf8');
  const legacyMode = (await fs.stat(legacyFile)).mode & 0o777;
  assert.equal(await resetPassword(legacyVault.root, alternateAuth), true);
  assert.equal(await passwordIsSet(legacyVault.root, alternateAuth), false, 'reset marker prevents an untouched legacy file from being re-imported');
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacyBeforeReset, 'migration and reset leave legacy bytes untouched');
  assert.equal((await fs.stat(legacyFile)).mode & 0o777, legacyMode, 'migration leaves legacy permissions untouched');
});

test('auth file location supports injected home, XDG config, and explicit override paths', () => {
  assert.equal(dashboardAuthFile('/vault', { platform: 'darwin', homeDir: '/isolated/home', env: {} }), '/isolated/home/Library/Application Support/Engram/dashboard/auth.json');
  assert.equal(dashboardAuthFile('/vault', { platform: 'linux', homeDir: '/isolated/home', env: {} }), '/isolated/home/.config/engram/dashboard/auth.json');
  assert.equal(dashboardAuthFile('/vault', { platform: 'linux', homeDir: '/isolated/home', env: { XDG_CONFIG_HOME: '/isolated/config' } }), '/isolated/config/engram/dashboard/auth.json');
  assert.equal(dashboardAuthFile('/vault', { platform: 'linux', homeDir: '/isolated/home', env: { MDB_DASHBOARD_AUTH_FILE: '/isolated/custom/auth.json' } }), '/isolated/custom/auth.json');
});

test('stale atomic-write temporary files leave the prior credential valid and corrupt credentials fail closed', async t => {
  const v = await disposableVault(), auth = authLocation(v.root), server = await createDashboardServer({ engram: v.engram, token: 'p'.repeat(64), idleMs: 60_000, authLocation: auth });
  t.after(async () => { await server.close(); await v.cleanup(); });
  await setup(server.port, server.token);
  const credentialFile = auth.env.MDB_DASHBOARD_AUTH_FILE;
  await fs.writeFile(path.join(path.dirname(credentialFile), '.auth.json.interrupted.tmp'), 'partial');
  assert.equal(await (await login(server.port, 'correct horse battery staple')).reply.status, 200);
  await fs.writeFile(credentialFile, '{broken');
  await server.close();
  await assert.rejects(() => createDashboardServer({ engram: v.engram, authLocation: auth }), /Dashboard password file is corrupt or unreadable.*invalid|Dashboard password file is corrupt or unreadable/);
});

test('dashboard session maximum age expires independently of activity', async t => {
  const v = await disposableVault(), server = await createDashboardServer({ engram: v.engram, token: 'g'.repeat(64), idleMs: 60_000, sessionIdleMs: 1000, sessionMaxAgeMs: 40, authLocation: authLocation(v.root) });
  t.after(async () => { await server.close(); await v.cleanup(); });
  await setup(server.port, server.token); const signed = await login(server.port, 'correct horse battery staple');
  await new Promise(resolve => setTimeout(resolve, 60));
  const expired = await call(server.port, '/api/status', { cookie: signed.cookie, csrf: true });
  assert.equal(expired.status, 401); assert.equal(expired.headers['x-engram-session-expired'], '1');
});

test('dashboard environment switch accepts documented values and disabled mode cannot bind through either entry point', async t => {
  assert.equal(dashboardEnabled({}), true); assert.equal(dashboardEnabled({ MDB_DASHBOARD_ENABLED: '' }), true);
  for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'Yes']) assert.equal(dashboardEnabled({ MDB_DASHBOARD_ENABLED: value }), true);
  for (const value of ['false', '0', 'no', 'off', 'FALSE', 'No']) assert.equal(dashboardEnabled({ MDB_DASHBOARD_ENABLED: value }), false);
  assert.throws(() => dashboardEnabled({ MDB_DASHBOARD_ENABLED: 'enabled-ish' }), /MDB_DASHBOARD_ENABLED.*true\/1\/yes\/on.*false\/0\/no\/off/);
  const v = await disposableVault(), prior = process.env.MDB_DASHBOARD_ENABLED, priorAuth = process.env.MDB_DASHBOARD_AUTH_FILE;
  t.after(async () => { if (prior === undefined) delete process.env.MDB_DASHBOARD_ENABLED; else process.env.MDB_DASHBOARD_ENABLED = prior; if (priorAuth === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE; else process.env.MDB_DASHBOARD_AUTH_FILE = priorAuth; await v.cleanup(); });
  process.env.MDB_DASHBOARD_ENABLED = 'off';
  const temporary = createServer(); await new Promise<void>(resolve => temporary.listen(0, '127.0.0.1', resolve)); const address = temporary.address(); assert.ok(address && typeof address !== 'string'); const freePort = address.port; await new Promise<void>(resolve => temporary.close(() => resolve()));
  await assert.rejects(() => createDashboardServer({ engram: v.engram, port: freePort }), /Dashboard disabled by MDB_DASHBOARD_ENABLED=false/);
  await new Promise<void>((resolve, reject) => { const check = createServer(); check.once('error', reject); check.listen(freePort, '127.0.0.1', () => check.close(error => error ? reject(error) : resolve())); });
  await assert.rejects(() => (async () => (await import('../../packages/cli/index.js')).execute(['dashboard', '--root', v.root]))(), /Dashboard disabled by MDB_DASHBOARD_ENABLED=false/);
});
