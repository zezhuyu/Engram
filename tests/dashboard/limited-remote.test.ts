import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';

const lan = Object.values(os.networkInterfaces()).flat().find(n => n && n.family === 'IPv4' && !n.internal)?.address;

test('a peer outside this machine reaches only the overview, wiki chat and wiki review APIs', { skip: lan ? false : 'no non-loopback interface' }, async t => {
  const vault = await disposableVault();
  const dashboard = await createDashboardServer({ engram: vault.engram, idleMs: 60_000, host: '0.0.0.0' });
  t.after(async () => { await dashboard.close(); await vault.cleanup(); });
  const password = 'limited-remote-test-password-2026';
  const session = async (base: string) => {
    const json = { Origin: base, 'Content-Type': 'application/json' };
    const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ token: dashboard.token, password, confirm: password }) });
    if (setup.status !== 200 && setup.status !== 409) assert.fail(`setup ${setup.status}`);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    return (path: string) => fetch(base + path, { headers: { Cookie: cookie, 'X-Engram-Dashboard': '1' } });
  };
  const local = await session(`http://127.0.0.1:${dashboard.port}`);
  const remote = await session(`http://${lan}:${dashboard.port}`);
  assert.equal((await fetch(`http://${lan}:${dashboard.port}/api/auth/status`)).status, 200);
  assert.equal(((await (await fetch(`http://${lan}:${dashboard.port}/api/auth/status`)).json()) as { limited: boolean }).limited, true);
  assert.equal(((await (await fetch(`http://127.0.0.1:${dashboard.port}/api/auth/status`)).json()) as { limited: boolean }).limited, false);
  assert.equal((await remote('/api/status')).status, 200);
  for (const path of ['/api/settings', '/api/connectors', '/api/audit', '/api/workspaces', '/api/clients', '/api/dashboard/credentials']) {
    assert.equal((await remote(path)).status, 403, `remote ${path} is refused`);
    assert.notEqual((await local(path)).status, 403, `local ${path} is not refused by the limiter`);
  }
});

test('a wildcard-bound dashboard accepts the machine name, its .local name and any configured host name only', async () => {
  const { allowedRemoteHost } = await import('../../packages/dashboard/auth.js');
  assert.equal(allowedRemoteHost('studio:4871', 4871, '0.0.0.0', 'studio'), true);
  assert.equal(allowedRemoteHost('studio.local:4871', 4871, '0.0.0.0', 'studio'), true);
  assert.equal(allowedRemoteHost('studio.local:4871', 4871, '0.0.0.0', 'Studio.local'), true);
  assert.equal(allowedRemoteHost('10.0.2.154:4871', 4871, '0.0.0.0', 'studio'), true);
  assert.equal(allowedRemoteHost('evil.example:4871', 4871, '0.0.0.0', 'studio'), false);
  assert.equal(allowedRemoteHost('studio.local:80', 4871, '0.0.0.0', 'studio'), false);
  process.env.ENGRAM_DASHBOARD_ALLOWED_HOSTS = 'nas.lan, studio.home';
  try { assert.equal(allowedRemoteHost('studio.home:4871', 4871, '0.0.0.0', 'studio'), true); assert.equal(allowedRemoteHost('evil.example:4871', 4871, '0.0.0.0', 'studio'), false); }
  finally { delete process.env.ENGRAM_DASHBOARD_ALLOWED_HOSTS; }
});
