import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { FONT_SHA256, fontAssets } from '../../packages/dashboard/ui/fonts.js';
import { disposableVault } from './helpers.js';

const fontSource = readFileSync(new URL('../../../packages/dashboard/ui/fonts.ts', import.meta.url), 'utf8');

test('embedded fonts match their recorded SHA-256, are real woff2 files, and carry the licence text', () => {
  assert.deepEqual(Object.keys(fontAssets).sort(), Object.keys(FONT_SHA256).sort());
  for (const [route, asset] of Object.entries(fontAssets)) {
    assert.equal(createHash('sha256').update(asset.body).digest('hex'), FONT_SHA256[route], `${route} hash`);
    assert.equal(asset.body.subarray(0, 4).toString('latin1'), 'wOF2', `${route} is woff2`);
    assert.equal(asset.contentType, 'font/woff2');
  }
  assert.match(fontSource, /SIL OPEN FONT LICENSE Version 1\.1/i);
});

test('both dashboards serve the fonts from their own origin with immutable caching, and no other font route exists', async t => {
  for (const clientMode of [false, true]) {
    const vault = await disposableVault();
    const dashboard = await createDashboardServer({ engram: vault.engram, clientMode, idleMs: 60_000 });
    t.after(async () => { await dashboard.close(); await vault.cleanup(); });
    const origin = `http://127.0.0.1:${dashboard.port}`;
    for (const [route, asset] of Object.entries(fontAssets)) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, `${clientMode ? 'client' : 'server'} ${route}`);
      assert.equal(response.headers.get('content-type'), 'font/woff2');
      assert.match(response.headers.get('cache-control') ?? '', /immutable/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.body);
    }
    assert.equal((await fetch(origin + '/assets/fonts/not-real.woff2')).status, 404);
    assert.equal((await fetch(origin + '/assets/fonts/..%2Fapp.js')).status, 404);
    const csp = (await fetch(origin + '/')).headers.get('content-security-policy') ?? '';
    assert.match(csp, /font-src 'self'/);
    assert.doesNotMatch(csp, /https?:|\*/, 'the policy never allows an outside origin');
  }
});

test('the server dashboard has no client routes and the client dashboard has no server administration', async t => {
  const password = 'separate-modes-password-2026';
  const open = async (clientMode: boolean) => {
    const vault = await disposableVault();
    const dashboard = await createDashboardServer({ engram: vault.engram, clientMode, idleMs: 60_000 });
    t.after(async () => { await dashboard.close(); await vault.cleanup(); });
    const origin = `http://127.0.0.1:${dashboard.port}`, json = { Origin: origin, 'Content-Type': 'application/json' };
    const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ token: dashboard.token, password, confirm: password }) }); assert.equal(setup.status, 200);
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password }) }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    return { origin, status: async (path: string, method = 'GET') => (await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, 'X-Engram-Dashboard': '1', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, body: method === 'GET' ? undefined : '{}' })).status };
  };
  const server = await open(false), client = await open(true);

  // Removed remote administration: no saved dashboard connections, no proxy, in either mode, even when signed in.
  for (const mode of [server, client])
    for (const [path, method] of [['/api/client/connections', 'GET'], ['/api/client/connections', 'POST'], ['/api/client/connections/x', 'DELETE'], ['/api/client/connections/x/test', 'POST']] as const)
      assert.equal(await mode.status(path, method), 404, `${method} ${path} is not served`);
  // The server dashboard answers only the mode probe under /api/client/.
  assert.equal(await server.status('/api/client/mode'), 200);
  for (const path of ['/api/client/status', '/api/client/folders', '/api/client/workspaces', '/api/client/settings', '/api/client/device', '/api/client/replica', '/api/client/server'])
    assert.equal(await server.status(path), 404, `server dashboard must not serve ${path}`);
  assert.equal(await client.status('/api/client/status'), 200);
  // The client dashboard serves none of the server administration routes.
  for (const path of ['/api/settings', '/api/connectors', '/api/dashboard/credentials', '/api/documents', '/api/clients', '/api/chat/capabilities'])
    assert.equal(await client.status(path), 404, `client dashboard must not serve ${path}`);

  // Each dashboard ships only its own page shell.
  const serverHtml = await fetch(server.origin + '/').then(response => response.text()), clientHtml = await fetch(client.origin + '/').then(response => response.text());
  assert.match(serverHtml, /data-mode="server"/); assert.match(clientHtml, /data-mode="client"/);
  assert.match(serverHtml, /id="credential-modal"/); assert.doesNotMatch(clientHtml, /id="credential-modal"|id="review"/);
});
