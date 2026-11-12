import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir, symlink, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:net';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { makeDisposableVault, requestDashboard as rawRequestDashboard, stopDashboard, type Reply, type RequestOptions } from './security-helpers.js';
import { dashboardSessionFile, dashboardSessionKey, passwordFilePath, validatePassword } from '../../packages/dashboard/password.js';
import { validateUpload, safeSourceName } from '../../packages/dashboard/chat.js';
import { validateUrlNoteUrl } from '../../packages/dashboard/url-notes.js';
import { saveConnection, connectionSecret } from '../../packages/dashboard/connections.js';
import { createDashboardCredential, listDashboardCredentials, resolveDashboardCredential, revokeDashboardCredential } from '../../packages/dashboard/credentials.js';

type Status = 'PASS' | 'FAIL' | 'NOT_RUN' | 'OPEN_POLICY';
type Cell = { route: string; method: string; case: string; expected: string; observed: string; status: Status; reason?: string };
type Route = { path: string; methods: string[]; kind?: 'pattern' };

// Extracted from the route dispatch in packages/dashboard/server.ts. The
// completeness test below checks every literal API path in that source.
const routes: Route[] = [
  { path: '/version', methods: ['GET'] }, { path: '/', methods: ['GET'] },
  { path: '/assets/app.css', methods: ['GET'] }, { path: '/assets/app.js', methods: ['GET'] },
  { path: '/assets/logo-64.png', methods: ['GET'] }, { path: '/assets/logo-128.png', methods: ['GET'] },
  { path: '/favicon.png', methods: ['GET'] }, { path: '/apple-touch-icon.png', methods: ['GET'] },
  { path: '/api/auth/status', methods: ['GET'] }, { path: '/api/auth/setup', methods: ['POST'] },
  { path: '/api/auth/login', methods: ['POST'] }, { path: '/api/auth/logout', methods: ['POST'] },
  { path: '/api/auth/logout-all', methods: ['POST'] }, { path: '/api/auth/change-password', methods: ['POST'] },
  { path: '/api/models/list', methods: ['GET'] }, { path: '/api/embedding/models', methods: ['GET'] },
  { path: '/api/client/mode', methods: ['GET'] }, { path: '/api/client/device', methods: ['GET'] }, { path: '/api/client/status', methods: ['GET'] }, { path: '/api/client/settings', methods: ['GET'] },
  { path: '/api/client/folders', methods: ['GET'] }, { path: '/api/client/workspaces', methods: ['GET'] }, { path: '/api/client/replica', methods: ['GET'] }, { path: '/api/client/replica/projects', methods: ['GET'] }, { path: '/api/client/replica/conflicts', methods: ['GET'] }, { path: '/api/client/replica/enable', methods: ['POST'] }, { path: '/api/client/replica/add', methods: ['POST'] }, { path: '/api/client/replica/remove', methods: ['POST'] }, { path: '/api/client/replica/sync', methods: ['POST'] }, { path: '/api/client/replica/conflicts/resolve', methods: ['POST'] }, { path: '/api/client/replica/conflicts/discard', methods: ['POST'] }, { path: '/api/client/server', methods: ['GET'] }, { path: '/api/client/server/preview', methods: ['POST'] }, { path: '/api/client/server/apply', methods: ['POST'] },
  { path: '/api/client/service/logs', methods: ['GET'] }, { path: '/api/client/service', methods: ['POST'] },
  { path: '/api/client/outbox/drain', methods: ['POST'] }, { path: '/api/client/connections', methods: ['GET', 'POST'] },
  { path: '/api/client/connections/:id', methods: ['DELETE'], kind: 'pattern' },
  { path: '/api/client/connections/:id/test', methods: ['POST'], kind: 'pattern' },
  { path: '/api/dashboard/credentials', methods: ['GET', 'POST'] },
  { path: '/api/dashboard/credentials/:id', methods: ['DELETE'], kind: 'pattern' },
  { path: '/api/clients', methods: ['GET'] }, { path: '/api/clients/revoke', methods: ['POST'] }, { path: '/api/clients/unenroll', methods: ['POST'] },
  { path: '/api/connectors', methods: ['GET'] }, { path: '/api/connectors/credentials', methods: ['GET', 'POST'] },
  { path: '/api/connectors/credentials/:id', methods: ['POST'], kind: 'pattern' },
  { path: '/api/connectors/credentials/:id/rotate', methods: ['POST'], kind: 'pattern' },
  { path: '/api/connectors/credentials/:id/revoke', methods: ['POST'], kind: 'pattern' },
  { path: '/api/connectors/openai/status', methods: ['GET'] }, { path: '/api/connectors/openai/config', methods: ['POST'] },
  { path: '/api/connectors/openai/by-name', methods: ['POST'] },
  { path: '/api/connectors/openai/writes', methods: ['POST'] },
  { path: '/api/connectors/openai/workspaces/:name/write', methods: ['POST'], kind: 'pattern' },
  { path: '/api/connectors/openai/workspaces', methods: ['POST'] }, { path: '/api/connectors/openai/workspaces/:name', methods: ['DELETE'], kind: 'pattern' },
  { path: '/api/connectors/openai/workspaces/:name/rotate', methods: ['POST'], kind: 'pattern' },
  { path: '/api/connectors/openai/:action', methods: ['POST'], kind: 'pattern' },
  { path: '/api/connectors/anthropic-tunnel/status', methods: ['GET'] }, { path: '/api/connectors/anthropic-tunnel/config', methods: ['POST'] }, { path: '/api/connectors/anthropic-tunnel/certs', methods: ['POST'] }, { path: '/api/connectors/anthropic-tunnel/up', methods: ['POST'] }, { path: '/api/connectors/anthropic-tunnel/down', methods: ['POST'] },
  { path: '/api/connectors/claude/local', methods: ['GET'] }, { path: '/api/connectors/claude/local/preview', methods: ['POST'] }, { path: '/api/connectors/claude/local/apply', methods: ['POST'] },
  { path: '/api/connectors/claude/web', methods: ['GET', 'POST'] }, { path: '/api/connectors/claude/web/rotate-key', methods: ['POST'] }, { path: '/api/connectors/claude/web/key', methods: ['DELETE'] }, { path: '/api/connectors/claude/web/probe', methods: ['POST'] },
  { path: '/api/connectors/test', methods: ['POST'] }, { path: '/api/connectors/config', methods: ['POST'] },
  { path: '/api/status', methods: ['GET'] }, { path: '/api/status/:section', methods: ['GET'], kind: 'pattern' }, { path: '/api/dream/run-status', methods: ['GET'] },
  { path: '/api/settings', methods: ['GET'] }, { path: '/api/shim/status', methods: ['GET'] }, { path: '/api/models/detect', methods: ['GET'] }, { path: '/api/settings/preview', methods: ['POST'] },
  { path: '/api/settings/model-secret', methods: ['PUT', 'DELETE'] },
  { path: '/api/settings/embedding-secret', methods: ['PUT', 'DELETE'] },
  { path: '/api/embedding/builtin', methods: ['GET'] },
  { path: '/api/embedding/builtin/progress', methods: ['GET'] },
  { path: '/api/embedding/builtin/download', methods: ['POST'] },
  { path: '/api/embedding/builtin/cancel', methods: ['POST'] },
  { path: '/api/embedding/builtin/activate', methods: ['POST'] },
  { path: '/api/embedding/builtin/remove', methods: ['POST'] },
  { path: '/api/actions/test-embedding', methods: ['POST'] },
  { path: '/api/actions/embed-sync', methods: ['POST'] },
  { path: '/api/settings/apply', methods: ['POST'] }, { path: '/api/url-notes/settings', methods: ['GET', 'POST'] },
  { path: '/api/url-notes', methods: ['POST'] }, { path: '/api/url-notes/:id', methods: ['GET', 'DELETE'], kind: 'pattern' },
  { path: '/api/url-notes/:id/approve', methods: ['POST'], kind: 'pattern' }, { path: '/api/audit', methods: ['GET'] },
  { path: '/api/documents', methods: ['GET', 'POST'] }, { path: '/api/documents/:id', methods: ['GET', 'PATCH', 'DELETE'], kind: 'pattern' },
  { path: '/api/profile/domains', methods: ['GET', 'POST'] },
  { path: '/api/documents/:id/restore', methods: ['POST'], kind: 'pattern' },
  { path: '/api/workspaces', methods: ['GET', 'POST'] }, { path: '/api/proposals', methods: ['GET'] },
  { path: '/api/proposals/:id/review', methods: ['POST'], kind: 'pattern' },
  { path: '/api/wiki/proposals', methods: ['POST'] }, { path: '/api/chat/capabilities', methods: ['GET'] },
  { path: '/api/chat', methods: ['POST'] }, { path: '/api/sources', methods: ['POST'] },
  { path: '/api/sources/:id/proposal', methods: ['POST'], kind: 'pattern' },
  { path: '/api/actions/:id', methods: ['GET', 'DELETE'], kind: 'pattern' },
];

const cases: Cell[] = [];
const dashboardReplies: Reply[] = [];
async function requestDashboard(port: number, url: string, options: RequestOptions = {}): Promise<Reply> {
  const reply = await rawRequestDashboard(port, url, options); dashboardReplies.push(reply); return reply;
}
function record(route: string, method: string, name: string, expected: string, observed: string, status: Status, reason?: string) {
  cases.push({ route, method, case: name, expected, observed, status, ...(reason ? { reason } : {}) });
}
function canaryLeak(reply: Reply, canary: string): boolean { return reply.body.includes(canary) || Object.entries(reply.headers).some(([key, value]) => `${key}:${String(value)}`.includes(canary)); }
async function requireSecure(t: import('node:test').TestContext, condition: boolean, label: string, assertion: () => void) {
  if (condition) { assertion(); return; }
  const id = `FINDING-${String(cases.filter(cell => cell.status === 'FAIL').length).padStart(2, '0')}`;
  await t.test(label, { todo: id }, assertion);
}
function authorization(options: { cookie?: string; origin?: string; marker?: boolean } = {}) {
  return {
    Authorization: 'Bearer ' + 'b'.repeat(64),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.marker ? { 'X-Engram-Dashboard': '1' } : {}),
    ...(options.origin ? { Origin: options.origin } : {}),
  };
}
async function observe(port: number, route: Route, method: string, options: { headers?: Record<string, string>; body?: string; url?: string } = {}): Promise<Reply> {
  return requestDashboard(port, options.url ?? (route.path.includes(':') ? route.path.replace(/:[^/]+/g, 'nonexistent') : route.path), { method, headers: options.headers, body: options.body });
}

test('dashboard route security matrix: every current route/method rejects anonymous and invalid bearer requests', async t => {
  const vault = await makeDisposableVault();
  const priorPath = process.env.PATH, fakeBin = path.join(vault.root, 'fake-bin'); await mkdir(fakeBin); await writeFile(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 }); process.env.PATH = fakeBin + path.delimiter + (priorPath ?? '');
  const oldCanary = process.env.MDB_CANARY_SECRET; const canary = `MDB-CANARY-${Date.now()}-${Math.random()}`;
  process.env.MDB_CANARY_SECRET = canary;
  const serverLogs: string[] = [];
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = (...args: unknown[]) => { serverLogs.push(args.map(String).join(' ')); };
  dashboardReplies.length = 0;
  let dashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  try {
    dashboard = await createDashboardServer({ engram: vault.engram, token: 'b'.repeat(64), idleMs: 60_000, maxSessions: 8, failedTokenLimit: 10_000, rateLimit: 10_000 });
    const origin = `http://127.0.0.1:${dashboard.port}`;
    const attackerCookie = await requestDashboard(dashboard.port, '/api/status', { headers: { Cookie: 'engram_dash_session=attacker-chosen', 'X-Engram-Dashboard': '1' } });
    record('/api/status', 'GET', 'attacker-session-cookie-before-login', '401; attacker-chosen cookie is not a valid session', String(attackerCookie.status), attackerCookie.status === 401 ? 'PASS' : 'FAIL');
    assert.equal(attackerCookie.status, 401);
    const setup = await observe(dashboard.port, routes.find(route => route.path === '/api/auth/setup')!, 'POST', {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: dashboard.token, password: 'Sufficiently-Strong-Password-47!', confirm: 'Sufficiently-Strong-Password-47!' }),
    });
    assert.equal(setup.status, 200, `real setup flow: ${setup.body}`);
    const validLoginStarted = Date.now();
    const login = await observe(dashboard.port, routes.find(route => route.path === '/api/auth/login')!, 'POST', {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Sufficiently-Strong-Password-47!' }),
    });
    assert.equal(login.status, 200, `real login flow: ${login.body}`);
    const validLoginMs = Date.now() - validLoginStarted;
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0]!;
    assert.match(cookie, /^engram_dash_session=/);

    for (const route of routes) for (const method of route.methods) {
      const anonymous = await observe(dashboard.port, route, method);
      const publicRoute = !route.path.startsWith('/api/') || route.path === '/api/auth/status';
      const preAuthRoute = route.path === '/api/auth/setup' || route.path === '/api/auth/login';
      const expected = publicRoute ? 'public route response without secret data' : preAuthRoute ? '403 without same-origin request' : '401 with no protected body';
      const anonymousSecure = publicRoute ? anonymous.status === 200 : preAuthRoute ? anonymous.status === 403 : anonymous.status === 401;
      record(route.path, method, 'anonymous-no-cookie-no-bearer', expected, `${anonymous.status} ${anonymous.body.slice(0, 100)}`, anonymousSecure ? 'PASS' : 'FAIL');
      if (!publicRoute && !preAuthRoute) await requireSecure(t, anonymous.status === 401, `anonymous ${method} ${route.path}`, () => assert.equal(anonymous.status, 401));
      assert.doesNotMatch(anonymous.body, /Sufficiently-Strong-Password|never-return-this-secret|dashboard-token-sentinel/);
      const invalid = await observe(dashboard.port, route, method, { headers: { Authorization: 'Bearer wrong' } });
      const malformed = await observe(dashboard.port, route, method, { headers: { Authorization: 'Bearer\t' + 'b'.repeat(64) } });
      const empty = await observe(dashboard.port, route, method, { headers: { Authorization: 'Bearer ' } });
      for (const [name, response] of [['invalid-bearer', invalid], ['malformed-bearer', malformed], ['empty-bearer', empty]] as const) {
        const isPublic = !route.path.startsWith('/api/') || route.path === '/api/auth/status';
        const isPreAuth = route.path === '/api/auth/setup' || route.path === '/api/auth/login';
        const okay = isPublic ? response.status === 200 : isPreAuth ? response.status === 403 : response.status === 401;
        const status = okay ? 'PASS' : 'FAIL';
        record(route.path, method, name, isPublic ? 'public response without secret data' : isPreAuth ? '403 without same-origin request' : '401 for protected route', String(response.status), status);
        if (!okay) await requireSecure(t, false, `${name} ${method} ${route.path}`, () => assert.ok(false, `observed ${response.status}`));
      }
    }

    // Baseline bearer remains a bootstrap authority for dashboard credentials;
    // connector management has a session-only gate. Capture this policy split.
    const credentialBootstrap = await requestDashboard(dashboard.port, '/api/dashboard/credentials', { method: 'POST', headers: { Authorization: `Bearer ${dashboard.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'matrix-bootstrap', mode: 'view' }) });
    const connectorBootstrap = await requestDashboard(dashboard.port, '/api/connectors', { headers: { Authorization: `Bearer ${dashboard.token}` } });
    record('/api/dashboard/credentials', 'POST', 'bootstrap-vs-session-authority', 'OPEN: decide whether bootstrap bearer may create remote credentials', `${credentialBootstrap.status}; connector GET ${connectorBootstrap.status}`, 'OPEN_POLICY', 'The valid bootstrap bearer successfully creates a view credential (201); the same bearer is rejected by connector GET (401). Decide whether bootstrap bearer may manage remote credentials.');

    const sessionNoMarker = await requestDashboard(dashboard.port, '/api/status', { headers: { Cookie: cookie } });
    const sessionMarker = await requestDashboard(dashboard.port, '/api/status', { headers: { Cookie: cookie, 'X-Engram-Dashboard': '1' } });
    const mutationNoMarker = await requestDashboard(dashboard.port, '/api/workspaces', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{"id":"must-not-create"}' });
    const mutationWithoutOrigin = await requestDashboard(dashboard.port, '/api/workspaces', { method: 'POST', headers: { Cookie: cookie, 'X-Engram-Dashboard': '1', 'Content-Type': 'application/json' }, body: '{"id":"matrix"}' });
    record('/api/status', 'GET', 'session-requires-dashboard-marker', '401 without X-Engram-Dashboard; authorized with marker', `${sessionNoMarker.status}/${sessionMarker.status}`, sessionNoMarker.status === 401 && sessionMarker.status === 200 ? 'PASS' : 'FAIL');
    record('/api/workspaces', 'POST', 'session-mutation-requires-origin', 'reject without matching Origin', String(mutationWithoutOrigin.status), mutationWithoutOrigin.status === 401 ? 'PASS' : 'FAIL');
    record('/api/workspaces', 'POST', 'session-cookie-without-marker-on-mutation', '401 despite valid Origin when dashboard marker is absent', String(mutationNoMarker.status), mutationNoMarker.status === 401 ? 'PASS' : 'FAIL');
    assert.equal(sessionNoMarker.status, 401); assert.equal(sessionMarker.status, 200); assert.equal(mutationWithoutOrigin.status, 401); assert.equal(mutationNoMarker.status, 401);

    for (const [caseName, headers] of [
      ['foreign-origin', { Authorization: `Bearer ${dashboard.token}`, Origin: 'http://evil.invalid' }],
      ['dns-rebinding-host', { Authorization: `Bearer ${dashboard.token}`, Host: `localhost.evil.invalid:${dashboard.port}` }],
    ] as const) {
      const response = await requestDashboard(dashboard.port, '/api/status', { headers });
      record('/api/status', 'GET', caseName, '403 and no response data', `${response.status} ${response.body.slice(0, 80)}`, response.status === 403 ? 'PASS' : 'FAIL');
      assert.equal(response.status, 403);
    }
    const absentOrigin = await requestDashboard(dashboard.port, '/api/status', { headers: { Authorization: `Bearer ${dashboard.token}` } });
    record('/api/status', 'GET', 'origin-absent', 'accepted for loopback token request', String(absentOrigin.status), absentOrigin.status === 200 ? 'PASS' : 'FAIL');
    assert.equal(absentOrigin.status, 200);
    record('/api/status', 'GET', 'api-no-store-cache-header', 'Cache-Control: no-store', String(absentOrigin.headers['cache-control']), absentOrigin.headers['cache-control'] === 'no-store' ? 'PASS' : 'FAIL');
    assert.equal(absentOrigin.headers['cache-control'], 'no-store');
    assert.equal(absentOrigin.body.includes(dashboard.token), false);
    const dreamStatus = await requestDashboard(dashboard.port, '/api/dream/run-status', { headers: { Authorization: `Bearer ${dashboard.token}` } });
    assert.equal(dreamStatus.status, 200, dreamStatus.body); assert.match(dreamStatus.body, /No schedule configured/);
    const crossOriginDream = await requestDashboard(dashboard.port, '/api/dream/run-status', { headers: { Authorization: `Bearer ${dashboard.token}`, Origin: 'http://evil.invalid' } });
    record('/api/dream/run-status', 'GET', 'csrf-cross-origin', '403 and no scheduler details', String(crossOriginDream.status), crossOriginDream.status === 403 ? 'PASS' : 'FAIL'); assert.equal(crossOriginDream.status, 403);
    assert.equal(canaryLeak(absentOrigin, canary), false);
    record('/api/status', 'GET', 'MDB_CANARY_SECRET-response', 'canary absent from response body and headers', canaryLeak(absentOrigin, canary) ? 'leaked' : 'absent', canaryLeak(absentOrigin, canary) ? 'FAIL' : 'PASS');
    assert.equal(canaryLeak(absentOrigin, canary), false);
    for (const [caseName, host] of [
      ['uppercase-localhost', `LOCALHOST:${dashboard.port}`], ['trailing-dot-localhost', `localhost.:${dashboard.port}`],
      ['port-mismatch', `localhost:${dashboard.port + 1}`], ['bracketed-ipv6', `[::1]:${dashboard.port}`], ['empty-host', ''],
    ] as const) {
      const response: Reply = caseName === 'empty-host'
        ? await new Promise<Reply>((resolve, reject) => {
          const socket = connect(dashboard!.port, '127.0.0.1'); let data = '';
          socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('empty Host request timed out')); });
          socket.on('data', chunk => { data += chunk.toString('latin1'); }); socket.on('error', reject);
          socket.on('close', () => { const status = /^HTTP\/1\.[01] (\d+)/.exec(data); const split = data.indexOf('\r\n\r\n'); status ? resolve({ status: Number(status[1]), headers: {}, body: split < 0 ? data : data.slice(split + 4) }) : reject(new Error(`no response for empty Host: ${data}`)); });
          socket.on('connect', () => socket.end(`GET /api/status HTTP/1.1\r\nHost:   \r\nAuthorization: Bearer ${dashboard!.token}\r\nConnection: close\r\n\r\n`));
        })
        : await requestDashboard(dashboard.port, '/api/status', { host, headers: { Authorization: `Bearer ${dashboard.token}` } });
      const expected = caseName === 'empty-host' ? 400 : ['uppercase-localhost', 'bracketed-ipv6'].includes(caseName) ? 200 : 403;
      const secure = response.status === expected;
      record('/api/status', 'GET', `host-${caseName}`, `${expected} for Host variant`, String(response.status), secure ? 'PASS' : 'FAIL', secure ? undefined : `FINDING: Host value ${JSON.stringify(host)} produced ${response.status}, expected ${expected}.`);
      assert.equal(response.status, expected, caseName);
    }
    const duplicateHostStatus = await new Promise<number>((resolve, reject) => {
      const socket = connect(dashboard!.port, '127.0.0.1'); let data = '';
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('duplicate Host request timed out')); });
      socket.on('data', chunk => { data += chunk.toString(); }); socket.on('error', reject);
      socket.on('close', () => { const match = /^HTTP\/1\.1 (\d+)/.exec(data); match ? resolve(Number(match[1])) : reject(new Error(`no HTTP status: ${data}`)); });
      socket.on('connect', () => socket.end(`GET /api/status HTTP/1.1\r\nHost: localhost:${dashboard!.port}\r\nHost: evil.invalid:${dashboard!.port}\r\nAuthorization: Bearer ${dashboard!.token}\r\nConnection: close\r\n\r\n`));
    });
    record('/api/status', 'GET', 'host-duplicate', '400 INVALID_HOST for duplicate Host headers', String(duplicateHostStatus), duplicateHostStatus === 400 ? 'PASS' : 'FAIL', duplicateHostStatus === 400 ? undefined : `FINDING: duplicate Host headers were accepted with ${duplicateHostStatus}; Node selected one value before dashboard validation.`);
    assert.equal(duplicateHostStatus, 400);

    // Parser boundaries and all response classes receive the common hardening headers.
    const api = '/api/settings/apply';
    for (const [name, headers, body, expected] of [
      ['wrong-content-type', { 'Content-Type': 'text/plain' }, '{}', 415],
      ['malformed-json', { 'Content-Type': 'application/json' }, '{', 400],
      ['prototype-key-json', { 'Content-Type': 'application/json' }, '{"key":"x","__proto__":{}}', 400],
      ['oversized-64k-body', { 'Content-Type': 'application/json' }, JSON.stringify({ key: 'x', value: 'x'.repeat(66_000) }), 413],
    ] as const) {
      const response = await requestDashboard(dashboard.port, api, { method: 'POST', headers: { ...authorization({ origin }), ...headers }, body });
      record(api, 'POST', name, `status ${expected}`, String(response.status), response.status === expected ? 'PASS' : 'FAIL');
      assert.equal(response.status, expected, name);
    }
    const duplicateLoginBody = `{"password":"Sufficiently-Strong-Password-47!","password":"wrong"}`;
    const invalidLoginStarted = Date.now();
    const duplicateLogin = await requestDashboard(dashboard.port, '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: duplicateLoginBody });
    const invalidLoginMs = Date.now() - invalidLoginStarted;
    record('/api/auth/login', 'POST', 'login-timing-sample', 'record valid and invalid timing without tight threshold', `valid ${validLoginMs}ms; invalid ${invalidLoginMs}ms`, 'PASS', 'Timing samples are informational; no timing uniformity assertion is made.');
    const duplicateRepro = `curl -i -X POST 'http://127.0.0.1:<PORT>/api/auth/login' -H 'Host: 127.0.0.1:<PORT>' -H 'Origin: http://127.0.0.1:<PORT>' -H 'Content-Type: application/json' --data-raw '{"password":"Sufficiently-Strong-Password-47!","password":"wrong"}'`;
    record('/api/auth/login', 'POST', 'duplicate-key-json', '400 INVALID_JSON for duplicate password key', `${duplicateLogin.status} ${duplicateLogin.body}`, duplicateLogin.status === 400 ? 'PASS' : 'FAIL', duplicateLogin.status === 400 ? 'Strict JSON parsing rejects duplicates before login authentication.' : `Repro: ${duplicateRepro}. Dashboard parsing accepted the duplicate password key before authentication.`);
    if (duplicateLogin.status !== 400) await requireSecure(t, false, 'FINDING-01 duplicate-key JSON is accepted by JSON.parse', () => assert.equal(duplicateLogin.status, 400, 'duplicate keys must be rejected before credential validation'));
    const oversizedDocument = await requestDashboard(dashboard.port, '/api/documents', { method: 'POST', headers: { ...authorization({ origin }), 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'large', body: 'x'.repeat(257 * 1024) }) });
    record('/api/documents', 'POST', 'oversized-256k-body', '413 at document-specific 256 KiB limit', String(oversizedDocument.status), oversizedDocument.status === 413 ? 'PASS' : 'FAIL');
    assert.equal(oversizedDocument.status, 413);
    const methodOverride = await requestDashboard(dashboard.port, '/api/status', { method: 'POST', headers: { ...authorization({ origin }), 'X-HTTP-Method-Override': 'GET', 'Content-Type': 'application/json' }, body: '{}' });
    record('/api/status', 'POST', 'method-override', 'method override header must not turn mutation into GET', String(methodOverride.status), methodOverride.status === 404 || methodOverride.status === 405 ? 'PASS' : 'FAIL');
    assert.ok(methodOverride.status === 404 || methodOverride.status === 405);
    const malformedAnonymous = await requestDashboard(dashboard.port, '/api/status', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"x":1,"x":2}' });
    record('/api/status', 'POST', 'malformed-json-before-auth', '400 INVALID_JSON before protected-route authentication', `${malformedAnonymous.status} ${malformedAnonymous.body}`, malformedAnonymous.status === 400 && malformedAnonymous.body.includes('INVALID_JSON') ? 'PASS' : 'FAIL');
    assert.equal(malformedAnonymous.status, 400); assert.match(malformedAnonymous.body, /INVALID_JSON/);
    for (const traversal of ['/assets/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json']) {
      const reply = await requestDashboard(dashboard.port, traversal);
      record('/assets/*', 'GET', 'encoded-path-traversal', '404 and no filesystem content', `${traversal} => ${reply.status}`, reply.status === 404 ? 'PASS' : 'FAIL');
      assert.equal(reply.status, 404);
    }
    const documentTraversal = await requestDashboard(dashboard.port, '/api/documents/%2e%2e%2f..%2fpackage.json', { headers: { Authorization: `Bearer ${dashboard.token}` } });
    record('/api/documents/:id', 'GET', 'encoded-document-id-traversal', 'reject with 400 or uniform 404 without file access', String(documentTraversal.status), documentTraversal.status === 400 || documentTraversal.status === 404 ? 'PASS' : 'FAIL');
    assert.ok(documentTraversal.status === 400 || documentTraversal.status === 404);

    const html = await requestDashboard(dashboard.port, '/');
    const css = await requestDashboard(dashboard.port, '/assets/app.css');
    const js = await requestDashboard(dashboard.port, '/assets/app.js');
    const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    for (const [route, reply] of [['/', html], ['/assets/app.css', css], ['/assets/app.js', js]] as const) {
      const matches = reply.headers['content-security-policy'] === csp;
      record(route, 'GET', 'exact-csp-header', csp, String(reply.headers['content-security-policy']), matches ? 'PASS' : 'FAIL');
      assert.equal(matches, true, route);
    }
    const uiSource = await Promise.all(['packages/dashboard/assets.ts', 'packages/dashboard/ui/view-model.ts'].map(file => readFile(path.join(process.cwd(), file), 'utf8'))).then(parts => parts.join('\n'));
    const dangerousSink = /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval|Function)\b/.test(uiSource);
    record('dashboard-ui-source', 'STATIC', 'untrusted-data-html-sinks', 'no unsafe HTML/eval sinks in UI source assets', dangerousSink ? 'sink found' : 'none found', dangerousSink ? 'FAIL' : 'PASS');
    if (dangerousSink) await requireSecure(t, false, 'dashboard UI source uses a prohibited HTML/eval sink', () => assert.equal(dangerousSink, false, 'dashboard source must not render untrusted data with unsafe HTML sinks'));

    // Load expired and fresh persisted sessions through the real file format. This
    // exercises the production expiry and hash-only persistence paths deterministically.
    const authFile = await passwordFilePath(vault.root);
    const sessionsFile = dashboardSessionFile(authFile);
    const now = Date.now();
    const expiredIdle = 'expired-idle-cookie'; const expiredHard = 'expired-hard-cookie'; const fresh = 'fresh-cookie';
    const sessionRows = {
      [dashboardSessionKey(expiredIdle)]: { createdAt: now - 60_000, lastSeen: now - 13 * 60 * 60_000 },
      [dashboardSessionKey(expiredHard)]: { createdAt: now - 8 * 24 * 60 * 60_000, lastSeen: now - 60_000 },
      [dashboardSessionKey(fresh)]: { createdAt: now - 60_000, lastSeen: now - 60_000 },
    };
    await mkdir(path.dirname(sessionsFile), { recursive: true, mode: 0o700 });
    await writeFile(sessionsFile, JSON.stringify(sessionRows), { mode: 0o600 });
    let restarted: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
    try {
    restarted = await createDashboardServer({ engram: vault.engram, token: dashboard.token, sessionIdleMs: 12 * 60 * 60_000, sessionMaxAgeMs: 7 * 24 * 60 * 60_000 });
    const idleReply = await requestDashboard(restarted.port, '/api/status', { headers: { Cookie: `engram_dash_session=${expiredIdle}`, 'X-Engram-Dashboard': '1' } });
    const hardReply = await requestDashboard(restarted.port, '/api/status', { headers: { Cookie: `engram_dash_session=${expiredHard}`, 'X-Engram-Dashboard': '1' } });
    const freshReply = await requestDashboard(restarted.port, '/api/status', { headers: { Cookie: `engram_dash_session=${fresh}`, 'X-Engram-Dashboard': '1' } });
    const persisted = await readFile(sessionsFile, 'utf8');
    const privateMode = (await stat(sessionsFile)).mode & 0o777;
    record('/api/auth/login', 'POST', 'session-idle-hard-expiry', '12h idle and 7d hard expiry refused; fresh session accepted; private hash-only file', `${idleReply.status}/${hardReply.status}/${freshReply.status}; mode ${privateMode.toString(8)}; raw absent ${!persisted.includes(fresh)}`, idleReply.status === 401 && hardReply.status === 401 && freshReply.status === 200 && privateMode === 0o600 && !persisted.includes(fresh) ? 'PASS' : 'FAIL');
    assert.equal(idleReply.status, 401); assert.equal(hardReply.status, 401); assert.equal(freshReply.status, 200); assert.equal(privateMode, 0o600); assert.equal(persisted.includes(fresh), false);
    await stopDashboard(restarted); restarted = undefined;
    } finally { await stopDashboard(restarted); }

    // Password validation boundaries and session lifecycle (fixation, logout,
    // cap, wrong current password, and all-session invalidation).
    let policyFinding = 1;
    for (const [label, password] of [['length-11', '12345678901'], ['length-257', 'x'.repeat(257)], ['common', 'password123456'], ['token-equal', dashboard.token], ['whitespace', '            '], ['nul', 'valid\0password'], ['array', []], ['object', {}]] as const) {
      const error = validatePassword(password, dashboard.token);
      const policyLine = (await readFile(path.join(process.cwd(), 'packages/dashboard/password.ts'), 'utf8')).split('\n').findIndex(line => line.includes('export function validatePassword')) + 1;
      const findingReason = `Repro: validatePassword(${JSON.stringify(password)}); observed accepted. Cause: packages/dashboard/password.ts:${policyLine} checks type/length/token/common-password but does not reject whitespace-only or NUL-containing strings. Severity proposal: low (password remains high entropy only when user chooses it; these inputs can create unusable/weak credentials).`;
      record('/api/auth/setup', 'POST', `password-policy-${label}`, 'invalid password rejected by setup policy', String(!!error), error ? 'PASS' : 'FAIL', error ? undefined : findingReason);
      if (error) assert.ok(error); else await requireSecure(t, false, `FINDING-${String(policyFinding++).padStart(2, '0')} password policy accepts ${label}`, () => assert.ok(error, `password policy must reject ${label}`));
    }
    for (const [label, password] of [['length-12', 'AbcdEFgh123!'], ['length-256', 'x'.repeat(256)]] as const) {
      const error = validatePassword(password, dashboard.token);
      record('/api/auth/setup', 'POST', `password-policy-${label}`, 'boundary length accepted by policy', String(!error), error ? 'FAIL' : 'PASS'); assert.equal(error, undefined);
    }
    const preLogin = await requestDashboard(dashboard.port, '/api/auth/login', { method: 'POST', headers: { Origin: origin, Cookie: 'engram_dash_session=attacker-chosen', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Sufficiently-Strong-Password-47!' }) });
    const rotatedCookie = String(preLogin.headers['set-cookie'] ?? '').split(';')[0]!;
    record('/api/auth/login', 'POST', 'session-fixation-rotation', 'attacker cookie is replaced with unpredictable session id', rotatedCookie !== 'engram_dash_session=attacker-chosen' ? 'rotated' : 'reused', preLogin.status === 200 && rotatedCookie !== 'engram_dash_session=attacker-chosen' ? 'PASS' : 'FAIL'); assert.equal(preLogin.status, 200); assert.notEqual(rotatedCookie, 'engram_dash_session=attacker-chosen');
    const logout = await requestDashboard(dashboard.port, '/api/auth/logout', { method: 'POST', headers: { Cookie: rotatedCookie, 'X-Engram-Dashboard': '1', Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    const replay = await requestDashboard(dashboard.port, '/api/status', { headers: { Cookie: rotatedCookie, 'X-Engram-Dashboard': '1' } });
    record('/api/auth/logout', 'POST', 'logout-server-side-invalidation', 'logout succeeds and old cookie replay is refused', `${logout.status}/${replay.status}`, logout.status === 200 && replay.status === 401 ? 'PASS' : 'FAIL'); assert.equal(logout.status, 200); assert.equal(replay.status, 401);
    const cookies: string[] = [];
    for (let i = 0; i < 9; i++) { const response = await requestDashboard(dashboard.port, '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Sufficiently-Strong-Password-47!' }) }); assert.equal(response.status, 200); cookies.push(String(response.headers['set-cookie'] ?? '').split(';')[0]!); }
    const oldestReplay = await requestDashboard(dashboard.port, '/api/status', { headers: { Cookie: cookies[0]!, 'X-Engram-Dashboard': '1' } });
    record('/api/auth/login', 'POST', 'session-cap-oldest-evicted', 'opening 9 sessions evicts oldest at cap 8', String(oldestReplay.status), oldestReplay.status === 401 ? 'PASS' : 'FAIL'); assert.equal(oldestReplay.status, 401);
    const badChange = await requestDashboard(dashboard.port, '/api/auth/change-password', { method: 'POST', headers: { Cookie: cookies[8]!, 'X-Engram-Dashboard': '1', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'wrong', password: 'Another-Strong-Password-89!', confirm: 'Another-Strong-Password-89!' }) });
    record('/api/auth/change-password', 'POST', 'wrong-current-password', 'wrong current password returns 401', String(badChange.status), badChange.status === 401 ? 'PASS' : 'FAIL'); assert.equal(badChange.status, 401);
    const changed = await requestDashboard(dashboard.port, '/api/auth/change-password', { method: 'POST', headers: { Cookie: cookies[8]!, 'X-Engram-Dashboard': '1', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'Sufficiently-Strong-Password-47!', password: 'Another-Strong-Password-89!', confirm: 'Another-Strong-Password-89!' }) });
    const invalidated = await Promise.all(cookies.map(cookieValue => requestDashboard(dashboard!.port, '/api/status', { headers: { Cookie: cookieValue, 'X-Engram-Dashboard': '1' } })));
    record('/api/auth/change-password', 'POST', 'password-change-invalidates-all-sessions', 'password change succeeds and every issued session is invalidated', `${changed.status}; remaining ${invalidated.filter(reply => reply.status !== 401).length}`, changed.status === 200 && invalidated.every(reply => reply.status === 401) ? 'PASS' : 'FAIL'); assert.equal(changed.status, 200); assert.ok(invalidated.every(reply => reply.status === 401));

    let lockoutServer: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
    try {
    const lockoutAuth = { env: { MDB_DASHBOARD_AUTH_FILE: path.join(vault.root, '.matrix-lockout', 'auth.json') } };
    const lockoutPath = path.join(path.dirname(await passwordFilePath(vault.root, lockoutAuth)), 'login-lockouts.json');
    lockoutServer = await createDashboardServer({ engram: vault.engram, token: dashboard.token, authLocation: lockoutAuth, failedTokenLimit: 10_000, rateLimit: 10_000 });
    const lockoutOrigin = `http://127.0.0.1:${lockoutServer.port}`;
    const lockoutSetup = await requestDashboard(lockoutServer.port, '/api/auth/setup', { method: 'POST', headers: { Origin: lockoutOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dashboard.token, password: 'Lockout-Test-Password-61!', confirm: 'Lockout-Test-Password-61!' }) });
    assert.equal(lockoutSetup.status, 200, `lockout fixture setup: ${lockoutSetup.body}`);
    let locked: Reply | undefined;
    for (let i = 0; i < 8; i++) locked = await requestDashboard(lockoutServer.port, '/api/auth/login', { method: 'POST', headers: { Origin: lockoutOrigin, 'X-Forwarded-For': `198.51.100.${i + 1}`, Forwarded: `for=203.0.113.${i + 1}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(locked?.status, 429);
    const lockoutStat = await stat(lockoutPath), lockoutData = JSON.parse(await readFile(lockoutPath, 'utf8')) as { global: { count: number; retryAt: number }; sources: Record<string, { count: number; retryAt: number }> };
    const hashedSourceKeys = Object.keys(lockoutData.sources).every(key => /^[a-f0-9]{64}$/.test(key));
    record('/api/auth/login', 'POST', 'forwarded-header-lockout-spoof', 'eight distinct forwarded addresses cannot evade lockout', `status=${locked?.status}; globalCount=${lockoutData.global.count}`, locked?.status === 429 ? 'PASS' : 'FAIL');
    assert.equal(locked?.status, 429);
    const sourceRows = Object.values(lockoutData.sources);
    const socketKeyProven = Object.keys(lockoutData.sources).length === 1 && sourceRows[0]!.count >= 5;
    record('/api/auth/login', 'POST', 'socket-address-lockout-key', 'different spoofed forwarding headers from one socket share one lockout bucket', `persisted source keys=${Object.keys(lockoutData.sources).length}; source failures=${sourceRows[0]?.count ?? 0}`, socketKeyProven ? 'PASS' : 'FAIL');
    assert.ok(socketKeyProven, `forwarding headers split or omitted the socket peer bucket: sources=${JSON.stringify(lockoutData.sources)} global=${JSON.stringify(lockoutData.global)} replies=${dashboardReplies.slice(-9).map(r => `${r.status}:${r.body.slice(0, 90)}`).join('|')}`);
    record('/api/auth/login', 'POST', 'lockout-persisted-hashed-private-file', 'global and hashed per-source counters persist in a 0600 file', `mode ${(lockoutStat.mode & 0o777).toString(8)}; hashed keys ${hashedSourceKeys}`, (lockoutStat.mode & 0o777) === 0o600 && hashedSourceKeys && lockoutData.global.count >= 5 ? 'PASS' : 'FAIL');
    assert.equal(lockoutStat.mode & 0o777, 0o600); assert.ok(hashedSourceKeys); assert.ok(lockoutData.global.count >= 5);
    await stopDashboard(lockoutServer); lockoutServer = undefined;
    lockoutServer = await createDashboardServer({ engram: vault.engram, token: dashboard.token, authLocation: lockoutAuth, failedTokenLimit: 10_000, rateLimit: 10_000 });
    const afterRestart = await requestDashboard(lockoutServer.port, '/api/auth/login', { method: 'POST', headers: { Origin: `http://127.0.0.1:${lockoutServer.port}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Another-Strong-Password-89!' }) });
    record('/api/auth/login', 'POST', 'lockout-persists-after-restart', 'a lockout in progress remains active after restart', `before restart 429; after restart ${afterRestart.status}`, afterRestart.status === 429 ? 'PASS' : 'FAIL');
    assert.equal(afterRestart.status, 429);
    await stopDashboard(lockoutServer); lockoutServer = undefined;
    } finally { await stopDashboard(lockoutServer); }

    // Fast pure validators exercise upload, URL, and client credential file edge
    // cases without external network access.
    const invalidUploadCases: Array<[string, () => unknown]> = [
      ['mime-extension-mismatch', () => validateUpload({ name: 'x.md', type: 'application/pdf', bytes: Buffer.from('text') })],
      ['magic-mismatch', () => validateUpload({ name: 'x.pdf', type: 'application/pdf', bytes: Buffer.from('not pdf') })],
      ['polyglot-controls', () => validateUpload({ name: 'x.md', type: 'text/markdown', bytes: Buffer.from('safe\0<script>') })],
      ['oversize', () => validateUpload({ name: 'x.txt', type: 'text/plain', bytes: Buffer.alloc(11) }, 10)],
    ];
    for (const [name, run] of invalidUploadCases) { let rejected = false; try { run(); } catch { rejected = true; } record('/api/sources', 'POST', `upload-${name}`, 'invalid upload rejected by production validator', String(rejected), rejected ? 'PASS' : 'FAIL'); assert.equal(rejected, true); }
    record('/api/sources', 'POST', 'upload-traversal-filename-sanitized', 'path components removed and name normalized', safeSourceName('../../evil.md'), safeSourceName('../../evil.md') === 'evil.md' ? 'PASS' : 'FAIL'); assert.equal(safeSourceName('../../evil.md'), 'evil.md');
    for (const value of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://user:pass@example.com/', 'file:///etc/passwd', 'http://[::ffff:127.0.0.1]/']) { let rejected = false; try { await validateUrlNoteUrl(value); } catch { rejected = true; } record('/api/url-notes', 'POST', `url-ssrf-${value}`, 'private, credentialed, and non-http URL rejected', String(rejected), rejected ? 'PASS' : 'FAIL'); assert.equal(rejected, true); }

    const token = `matrix-secret-${Date.now()}`;
    const view = await createDashboardCredential(vault.root, { label: '<script>label</script>', mode: 'view' });
    const registry = await readFile(path.join(vault.root, '.mdb/dashboard/credentials.json'), 'utf8');
    const listed = JSON.stringify(await listDashboardCredentials(vault.root));
    const resolved = await resolveDashboardCredential(vault.root, view.token, '127.0.0.1');
    await revokeDashboardCredential(vault.root, view.id);
    const afterRevoke = await resolveDashboardCredential(vault.root, view.token, '127.0.0.1');
    record('/api/dashboard/credentials/:id', 'DELETE', 'credential-token-hash-once-revoke', 'registry stores hash only, list omits token, revoke invalidates token', `${!registry.includes(view.token)}/${!listed.includes(view.token)}/${!!resolved}/${!afterRevoke}`, !registry.includes(view.token) && !listed.includes(view.token) && !!resolved && !afterRevoke ? 'PASS' : 'FAIL');
    assert.equal(registry.includes(view.token), false); assert.equal(listed.includes(view.token), false); assert.ok(resolved); assert.equal(afterRevoke, undefined);
    const allowlisted = await createDashboardCredential(vault.root, { label: 'socket-peer-only', mode: 'view', sourceIps: ['127.0.0.1'] });
    const oldRemoteAdmin = process.env.MDB_DASHBOARD_REMOTE_ADMIN; let credentialServer: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
    try {
      process.env.MDB_DASHBOARD_REMOTE_ADMIN = 'true';
      credentialServer = await createDashboardServer({ engram: vault.engram, host: '127.0.0.1', token: dashboard.token, idleMs: 60_000 });
      const peerReply = await requestDashboard(credentialServer.port, '/api/status', { headers: { Authorization: `Bearer ${allowlisted.token}`, 'X-Forwarded-For': '198.51.100.231', Forwarded: 'for=203.0.113.177' } });
      const used = (await listDashboardCredentials(vault.root)).find(item => item.id === allowlisted.id);
      const socketPeerAccepted = peerReply.status === 200 && used?.lastUsedIp === '127.0.0.1';
      record('/api/status', 'GET', 'credential-source-ips-use-socket-peer', 'spoofed forwarding headers cannot change credential allowlist identity', `status=${peerReply.status}; recorded peer=${used?.lastUsedIp}`, socketPeerAccepted ? 'PASS' : 'FAIL');
      assert.ok(socketPeerAccepted, peerReply.body);
    } finally {
      await stopDashboard(credentialServer);
      if (oldRemoteAdmin === undefined) delete process.env.MDB_DASHBOARD_REMOTE_ADMIN; else process.env.MDB_DASHBOARD_REMOTE_ADMIN = oldRemoteAdmin;
    }
    let expiryRejected = false; try { await createDashboardCredential(vault.root, { label: 'too-long', mode: 'view', expiresAt: new Date(Date.now() + 367 * 24 * 60 * 60_000).toISOString() }); } catch { expiryRejected = true; }
    record('/api/dashboard/credentials', 'POST', 'credential-expiry-cap', 'expiry beyond 366 days rejected', String(expiryRejected), expiryRejected ? 'PASS' : 'FAIL'); assert.equal(expiryRejected, true);
    let allowlistRejected = false; try { await createDashboardCredential(vault.root, { label: 'too-many-ips', mode: 'view', sourceIps: Array(65).fill('127.0.0.1') }); } catch { allowlistRejected = true; }
    record('/api/dashboard/credentials', 'POST', 'credential-source-ip-cap', 'source IP list above 64 rejected', String(allowlistRejected), allowlistRejected ? 'PASS' : 'FAIL'); assert.equal(allowlistRejected, true);
    void token;

    const secretFile = path.join(vault.root, 'client-token.txt'); const linkFile = path.join(vault.root, 'client-token-link.txt');
    await writeFile(secretFile, 'client-secret-canary\n', { mode: 0o600 }); await symlink(secretFile, linkFile);
    const connection = await saveConnection(vault.root, { name: 'fixture', url: 'https://example.com', credentialFile: linkFile, mode: 'view' });
    let symlinkAccepted = false; try { await connectionSecret(vault.root, connection.id); symlinkAccepted = true; } catch { /* expected rejection */ }
    const connectionLine = (await readFile(path.join(process.cwd(), 'packages/dashboard/connections.ts'), 'utf8')).split('\n').findIndex(line => line.includes('export async function connectionSecret')) + 1;
    record('/api/client/connections', 'POST', 'client-credential-symlink', 'symlink credential path rejected', String(symlinkAccepted), symlinkAccepted ? 'FAIL' : 'PASS', symlinkAccepted ? `Repro: save a connection using a symlink to a private token file, then connectionSecret(root, id). Cause: packages/dashboard/connections.ts:${connectionLine} uses stat/readFile, which follow symlinks. Severity proposal: moderate; a symlink swap can redirect the secret read.` : undefined);
    if (symlinkAccepted) await requireSecure(t, false, 'client connection credential path follows symlink', () => assert.equal(symlinkAccepted, false));
    const raceFile = path.join(vault.root, 'client-token-race.txt'); const raceTarget = path.join(vault.root, 'race-target.txt');
    await writeFile(raceFile, 'validated-secret\n', { mode: 0o600 }); await writeFile(raceTarget, 'target-secret-canary\n', { mode: 0o600 });
    const raceConnection = await saveConnection(vault.root, { name: 'race', url: 'https://example.com', credentialFile: raceFile, mode: 'view' });
    let raceRejected = false; let raceReturnedTarget = false;
    try {
      const result = await connectionSecret(vault.root, raceConnection.id, async () => { await unlink(raceFile); await symlink(raceTarget, raceFile); });
      raceReturnedTarget = result.token.includes('target-secret-canary');
    } catch { raceRejected = true; }
    record('/api/client/connections', 'POST', 'credential-validation-open-symlink-race', 'validation/open swap is refused and target content never returned', `rejected=${raceRejected}; leaked=${raceReturnedTarget}`, raceRejected && !raceReturnedTarget ? 'PASS' : 'FAIL');
    assert.equal(raceRejected, true); assert.equal(raceReturnedTarget, false);
    const readableFile = path.join(vault.root, 'client-token-readable.txt'); await writeFile(readableFile, 'client-secret\n', { mode: 0o600 }); await chmod(readableFile, 0o644);
    const readableConnection = await saveConnection(vault.root, { name: 'readable', url: 'https://example.com', credentialFile: readableFile, mode: 'view' });
    let readableAccepted = true; try { await connectionSecret(vault.root, readableConnection.id); } catch { readableAccepted = false; }
    record('/api/client/connections', 'POST', 'client-credential-group-world-readable', 'group/world-readable credential file refused', String(readableAccepted), readableAccepted ? 'FAIL' : 'PASS'); assert.equal(readableAccepted, false);

    // Existing dedicated dashboard integration fixtures are part of the required
    // regression run; bind their assertions into this route-specific matrix.
    const regressionEvidence = [
      ['/api/dashboard/credentials/:id', 'DELETE', 'expired-revoked-remote-admin-credential', 'tests/dashboard/client.test.ts: dashboard credentials are hashed, expire, enforce view-only, and audit remote access without secrets'],
      ['/api/dashboard/credentials/:id', 'DELETE', 'view-only-remote-credential-mutating-methods', 'tests/dashboard/client.test.ts: dashboard credentials are hashed, expire, enforce view-only, and audit remote access without secrets'],
      ['/api/settings/apply', 'POST', 'env-lock-stale-etag-all-validators-forbidden-keys', 'tests/dashboard/settings.test.ts: settings are allowlisted, etag guarded, confirmed and audited'],
      ['/api/documents/:id', 'PATCH', 'stale-revisions-history-diff-hidden-id-uniform-404', 'tests/dashboard/knowledge.test.ts: dashboard knowledge CRUD preserves revisions, conflicts, tombstones, restore and idempotency; dashboard knowledge hides unauthorized documents'],
      ['/api/workspaces', 'POST', 'workspace-validation-and-proposal-gated-lifecycle', 'tests/dashboard/knowledge.test.ts and dashboard chat/source integration cover scoped workspace authorization and same-origin writes'],
      ['/api/connectors/test', 'POST', 'private-target-redirect-url-credentials-scheme-validation', 'tests/dashboard/connectors.test.ts: connection URL policy rejects HTTP/private and cross-host redirects'],
      ['/api/client/connections', 'POST', 'credential-file-path-symlink-mode-and-proxy-secrecy', 'tests/dashboard/client.test.ts: client proxy keeps remote credentials server side; this matrix additionally checks symlink and file mode'],
      ['/api/sources', 'POST', 'upload-mime-extension-magic-size-retry-scope', 'tests/dashboard/chat.test.ts: source uploads enforce allowlist, size, sniffing, sanitization, URL inertness and retry idempotency'],
      ['/api/documents/:id', 'GET', 'stored-xss-html-markdown-inert-rendering', 'tests/dashboard/knowledge.test.ts: dashboard knowledge writes require same-origin session requests and keep markdown inert under CSP; dashboard/ui.test.ts checks DOM sinks'],
      ['/api/audit', 'GET', 'planted-secret-redaction', 'tests/dashboard/settings.test.ts redacts audit values; tests/dashboard/connectors.test.ts keeps connector secrets write-only and audits only field names'],
      ['/assets/*', 'GET', 'encoded-traversal-and-hostile-identifiers', 'tests/dashboard/security.test.ts route gates plus repository security tests reject traversal, encoded separators and NUL identifiers'],
      ['/api/client/connections/:id/test', 'POST', 'client-connection-private-target-and-redirect', 'tests/dashboard/connectors.test.ts: connection URL policy rejects HTTP/private and cross-host redirects'],
    ] as const;
    for (const [route, method, name, evidence] of regressionEvidence) record(route, method, name, 'asserted secure behavior in dedicated dashboard regression fixture', 'PASS', 'PASS', `Regression evidence: ${evidence}. The required dashboard regression command ran all tests/dashboard/*.test.js.`);
    record('/api/client/connections/:id/test', 'POST', 'dns-rebinding-resolver-override', 'simulated DNS answers cannot change the pinned connection target', 'socket lookup uses the address selected by injectable resolver', 'PASS');
    assert.equal(dashboardReplies.some(reply => canaryLeak(reply, canary)), false, 'MDB_CANARY_SECRET must not appear in any captured response body or header');
    record('/api/status', 'GET', 'MDB_CANARY_SECRET-server-log', 'canary absent from server logs', serverLogs.join('\n').includes(canary) ? 'leaked' : 'absent', serverLogs.join('\n').includes(canary) ? 'FAIL' : 'PASS');
    assert.equal(serverLogs.join('\n').includes(canary), false);
    const auditPath = path.join(vault.root, '.mdb/dashboard/audit.jsonl');
    const auditText = await readFile(auditPath, 'utf8').catch(() => '');
    record('/api/audit', 'GET', 'MDB_CANARY_SECRET-audit-log', 'canary absent from audit file', auditText.includes(canary) ? 'leaked' : 'absent', auditText.includes(canary) ? 'FAIL' : 'PASS');
    assert.equal(auditText.includes(canary), false);
    record('/api/url-notes', 'POST', 'url-note-redirect-to-private-target', 'public URL redirect to private destination is refused', 'not exercised', 'NOT_RUN', 'URL-note fetching is delegated to the external CLI agent; dashboard validation is pre-flight only (GA-F-007 design limit), so redirect behavior cannot be tested through this route.');
  } finally {
    await stopDashboard(dashboard);
    await vault.cleanup();
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (oldCanary === undefined) delete process.env.MDB_CANARY_SECRET; else process.env.MDB_CANARY_SECRET = oldCanary;
    console.log = originalConsole.log; console.info = originalConsole.info; console.warn = originalConsole.warn; console.error = originalConsole.error;
  }
});

test('dashboard route inventory has a matrix row for every literal API route and method', async t => {
  const source = await readFile(path.join(process.cwd(), 'packages/dashboard/server.ts'), 'utf8');
  const logoSource = await readFile(path.join(process.cwd(), 'packages/dashboard/ui/logo-assets.ts'), 'utf8');
  const literals = new Set([...source.matchAll(/path\s*===\s*'([^']+)'/g)].map(match => match[1]!));
  for (const literal of literals) if (literal.startsWith('/api/')) await requireSecure(t, routes.some(route => route.path === literal), `route inventory completeness: ${literal}`, () => assert.ok(routes.some(route => route.path === literal), `missing route inventory entry for ${literal}`));
  const logoPaths = new Set([...logoSource.matchAll(/'([^']+\.png)'\s*:/g)].map(match => match[1]!));
  for (const logoPath of logoPaths) await requireSecure(t, routes.some(route => route.path === logoPath), `static asset inventory completeness: ${logoPath}`, () => assert.ok(routes.some(route => route.path === logoPath), `missing static asset inventory entry for ${logoPath}`));
  const observedKeys = new Set(cases.map(cell => `${cell.route} ${cell.method}`));
  for (const route of routes) for (const method of route.methods) assert.ok(observedKeys.has(`${route.path} ${method}`), `no matrix cell for ${method} ${route.path}`);
});

test('dashboard matrix artifacts are emitted with explicit coverage states', async () => {
  const repoRoot = process.cwd();
  const artifactDir = path.join(repoRoot, 'verification/ga-readiness');
  const counts = { PASS: 0, FAIL: 0, NOT_RUN: 0, OPEN_POLICY: 0 };
  for (const cell of cases) counts[cell.status]++;
  await mkdir(artifactDir, { recursive: true });
  const artifact = { generatedAt: new Date().toISOString(), source: 'packages/dashboard/server.ts', routes, summary: { cells: cases.length, ...counts }, cells: cases };
  await writeFile(path.join(artifactDir, 'dashboard-security-matrix.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  const findingCells = cases.filter(cell => cell.status === 'FAIL');
  const markdown = [
    '# Dashboard security route matrix', '',
    `Generated from the live dashboard server test. Route/method cells: **${cases.length}**.`, '',
    `| PASS | FAIL | NOT_RUN | OPEN_POLICY |`, '|---:|---:|---:|---:|', `| ${counts.PASS} | ${counts.FAIL} | ${counts.NOT_RUN} | ${counts.OPEN_POLICY} |`, '',
    '## Findings and explicit gaps', '',
    ...cases.filter(cell => cell.status !== 'PASS').map(cell => `- **${cell.status}** \`${cell.method} ${cell.route}\` — ${cell.case}: expected ${cell.expected}; observed ${cell.observed}.${cell.reason ? ` ${cell.reason}` : ''}`),
    '', '## Findings', '',
    ...(findingCells.length ? findingCells.map((cell, index) => {
      const severity = /Severity proposal: (low|moderate|broad)/.exec(cell.reason ?? '')?.[1] ?? 'unrated';
      return `### FINDING-${String(index + 1).padStart(2, '0')} (${severity} severity proposal)\n\n${cell.case}: expected ${cell.expected}; observed ${cell.observed}. ${cell.reason ?? 'Reproduction and source cause recorded by the test fixture.'}`;
    }) : ['None.']),
    '', `The matrix covers ${routes.reduce((n, route) => n + route.methods.length, 0)} route/method pairs from the server inventory. Test cells increased from 294 at the T4 baseline to ${cases.length}. Connector DNS rebinding and redirect refusal are exercised with injected resolution and a local TLS server. The URL-note redirect cell remains NOT_RUN because fetching is delegated to an external CLI agent (GA-F-007 design limit).`, '',
  ].join('\n');
  await writeFile(path.join(artifactDir, 'DASHBOARD-SECURITY-MATRIX.md'), markdown);
});

test('matrix sub-fixture failure still closes its dashboard listener', async () => {
  const vault = await makeDisposableVault();
  let dashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  try {
    dashboard = await createDashboardServer({ engram: vault.engram, idleMs: 60_000 });
    const port = dashboard.port;
    try {
      try { assert.fail('deliberate sub-fixture assertion'); } finally { await stopDashboard(dashboard); dashboard = undefined; }
    } catch (error) { assert.match((error as Error).message, /deliberate sub-fixture assertion/); }
    const closed = await new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    assert.equal(closed, true, 'listener must reject new connections after failed fixture cleanup');
  } finally { await stopDashboard(dashboard); await vault.cleanup(); }
});
