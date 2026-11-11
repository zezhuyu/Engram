import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engram } from '../../packages/sdk/index.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { defaultBinding, writeBinding, type ProjectBinding } from '../../packages/core/project-binding.js';
import { bindingFingerprint } from '../../packages/core/project-trust.js';

type TestEnv = { HOME: string; XDG_CONFIG_HOME: string; XDG_CACHE_HOME: string; XDG_STATE_HOME: string; XDG_DATA_HOME: string; ENGRAM_DATA_DIR: string; ENGRAM_TRUST_FILE: string; ENGRAM_REPLICA_DIR: string; ENGRAM_OUTBOX: string; ENGRAM_CACHE_DIR: string; MDB_DASHBOARD_AUTH_FILE: string };
async function isolated(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-client-folders-'));
  const saved = new Map<string, string | undefined>();
  const env: TestEnv = {
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg', 'config'), XDG_CACHE_HOME: path.join(root, 'xdg', 'cache'), XDG_STATE_HOME: path.join(root, 'xdg', 'state'), XDG_DATA_HOME: path.join(root, 'xdg', 'data'),
    ENGRAM_DATA_DIR: path.join(root, 'data'), ENGRAM_TRUST_FILE: path.join(root, 'trust', 'trusted-projects.json'), ENGRAM_REPLICA_DIR: path.join(root, 'data', '.engram-runtime', 'replica'), ENGRAM_OUTBOX: path.join(root, 'data', '.engram-runtime', 'outbox'), ENGRAM_CACHE_DIR: path.join(root, 'data', '.engram-runtime', 'cache'), MDB_DASHBOARD_AUTH_FILE: path.join(root, 'auth', 'auth.json'),
  };
  for (const [key, value] of Object.entries(env)) { saved.set(key, process.env[key]); process.env[key] = value; }
  await fs.mkdir(env.HOME, { recursive: true });
  const engram = new Engram(path.join(root, 'vault'));
  await engram.init({ sqlite: false });
  const server = await createDashboardServer({ engram, host: '127.0.0.1', port: 0, clientMode: true, idleMs: 60_000 });
  const origin = 'http://127.0.0.1:' + server.port, password = 'folder-dashboard-test-password-83';
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: server.token, password, confirm: password }) });
  assert.equal(setup.status, 200);
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const request = () => fetch(origin + '/api/client/folders', { headers: { Cookie: cookie, 'X-Engram-Dashboard': '1' } });
  t.after(async () => { await server.close(); await engram.close(); await fs.rm(root, { recursive: true, force: true }); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { root, env, engram, server, origin, cookie, request };
}

async function bind(root: string, name: string, mode: 'local' | 'remote' | 'replica', workspaceId: string, extra: Partial<ProjectBinding> = {}) {
  const folder = path.join(root, 'projects', name);
  await fs.mkdir(folder, { recursive: true });
  const binding: ProjectBinding = { ...defaultBinding({ workspaceId }), mode, ...(mode === 'remote' || mode === 'replica' ? { serverUrl: 'http://127.0.0.1:45678' } : {}), ...(mode === 'replica' ? { replicaId: 'test-replica' } : {}), domains: ['general'], ...extra };
  await writeBinding(folder, binding);
  return { folder, binding, entry: { root: folder, fingerprint: bindingFingerprint(binding), trustedAt: new Date().toISOString(), workspaceId, mode, ...(binding.replicaId ? { replicaId: binding.replicaId } : {}) } };
}

async function writeRegistry(file: string, entries: unknown[]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, entries })); }
 test('client folders lists all trusted modes without replica, reports metadata only, and enforces local session auth', async t => {
  const x = await isolated(t), remote = await bind(x.root, '<script>', 'remote', 'remote-ws'), local = await bind(x.root, 'local-project', 'local', 'local-ws'), replica = await bind(x.root, 'replica-project', 'replica', 'replica-ws'), gone = await bind(x.root, 'unmounted-project', 'remote', 'gone-ws'), long = await bind(x.root, 'x'.repeat(180), 'local', 'long-ws');
  await fs.mkdir(path.join(remote.folder, '.claude'), { recursive: true }); await fs.writeFile(path.join(remote.folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
  await fs.rm(path.join(gone.folder, '.engram', 'project.json'), { force: true });
  await writeRegistry(x.env.ENGRAM_TRUST_FILE, [remote.entry, local.entry, replica.entry, gone.entry, long.entry]);
  const secret = 'MUST_NOT_LEAK_CONTEXT_TEXT_OR_TOKEN';
  const cacheDir = path.join(x.env.ENGRAM_CACHE_DIR, 'context'); await fs.mkdir(cacheDir, { recursive: true });
  const cacheName = createHash('sha256').update('remote-cache-fixture').digest('hex').slice(0, 24) + '.json';
  await fs.writeFile(path.join(cacheDir, cacheName), JSON.stringify({ workspaceId: 'remote-ws', serverUrl: 'http://127.0.0.1:45678', credential: 'hash-only', fetchedAt: new Date(Date.now() - 60_000).toISOString(), text: secret }));
  const stateDir = path.join(x.env.ENGRAM_DATA_DIR, '.engram-runtime', 'state'); await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'context-state.json'), JSON.stringify({ 'claude-code:remote-ws': { workspaceId: 'remote-ws', outcome: 'stale' } }));
  const outbox = x.env.ENGRAM_OUTBOX; await fs.mkdir(outbox, { recursive: true });
  const queueName = '20260101000000-00000000-0000-4000-8000-000000000001.json';
  await fs.writeFile(path.join(outbox, queueName), JSON.stringify({ version: 1, workspaceId: 'remote-ws', arguments: { text: secret }, token: secret }));

  assert.equal((await fetch(x.origin + '/api/client/folders')).status, 401);
  assert.equal((await fetch(x.origin + '/api/client/folders', { headers: { Cookie: x.cookie, Origin: 'https://attacker.example', 'X-Engram-Dashboard': '1' } })).status, 403);
  const response = await x.request(); assert.equal(response.status, 200);
  const body = await response.json() as { rows: Array<Record<string, any>>; approximate: boolean };
  assert.deepEqual(body.rows.map(row => row.mode).sort(), ['local', 'local', 'remote', 'remote', 'replica']);
  assert.equal(body.rows.find(row => row.workspaceId === 'gone-ws')?.mounted, false);
  assert.equal(body.rows.find(row => row.workspaceId === 'remote-ws')?.contextCache.stale, true);
  assert.equal(body.rows.find(row => row.workspaceId === 'remote-ws')?.hooksInstalled, true);
  assert.equal(body.rows.find(row => row.workspaceId === 'remote-ws')?.queuedWrites, 1);
  assert.equal(body.rows.find(row => row.workspaceId === 'remote-ws')?.queuedBytes, Buffer.byteLength(await fs.readFile(path.join(outbox, queueName))));
  assert.equal(body.rows.find(row => row.workspaceId === 'replica-ws')?.replica.pending, 0);
  assert.ok(body.rows.find(row => row.workspaceId === 'remote-ws')?.folderName.length <= 120);
  assert.equal(body.rows.find(row => row.workspaceId === 'long-ws')?.folderName.length, 120);
  assert.doesNotMatch(JSON.stringify(body), /MUST_NOT_LEAK|"text"|"token"|"arguments"|"credential"/);
  assert.equal(body.rows.find(row => row.workspaceId === 'remote-ws')?.folderName, '<script>');
});

test('client folders joins replica status while still listing remote and local folders', async t => {
  const x = await isolated(t), remote = await bind(x.root, 'remote-project', 'remote', 'remote-ws'), local = await bind(x.root, 'local-project', 'local', 'local-ws'), replica = await bind(x.root, 'replica-project', 'replica', 'replica-ws');
  await writeRegistry(x.env.ENGRAM_TRUST_FILE, [remote.entry, local.entry, replica.entry]);
  const tokenFile = path.join(x.root, 'token'); await fs.writeFile(tokenFile, 'fixture-token', { mode: 0o600 });
  const { initializeReplica, openReplica } = await import('../../packages/replication/client.js');
  await initializeReplica({ serverUrl: 'http://127.0.0.1:45678', tokenFile, name: 'test-replica', baseDir: x.env.ENGRAM_REPLICA_DIR });
  const opened = await openReplica('test-replica', x.env.ENGRAM_REPLICA_DIR); await opened.store.enrollScope({ type: 'workspace', workspaceId: 'replica-ws' });
  const response = await x.request(); assert.equal(response.status, 200);
  const rows = (await response.json() as { rows: Array<Record<string, any>> }).rows;
  assert.deepEqual(rows.map(row => row.workspaceId).sort(), ['local-ws', 'remote-ws', 'replica-ws']);
  const item = rows.find(row => row.workspaceId === 'replica-ws')!;
  assert.equal(typeof item.replica.state, 'string'); assert.equal(typeof item.replica.pending, 'number'); assert.equal(typeof item.replica.conflicts, 'number');
  assert.equal(rows.find(row => row.workspaceId === 'remote-ws')?.mode, 'remote');
});
