import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { writeClientHeartbeat } from '../../packages/mcp/client-presence.js';
import { handleReplicaRoute } from '../../packages/mcp/replica-http.js';
import { initializeReplica, openReplica } from '../../packages/replication/client.js';
import { syncOnce } from '../../packages/replication/sync.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { listReplicaDevices } from '../../packages/replication/devices.js';
import { defaultBinding, writeBinding } from '../../packages/core/project-binding.js';
import { trustProject } from '../../packages/core/project-trust.js';
import { disposableVault } from './helpers.js';

test('dashboard replica API reports bounded workspace bytes and resolves a real HTTP conflict without losing either revision', async t => {
  const envRoot = await mkdtemp(path.join(os.tmpdir(), 'engram-dashboard-replica-e2e-'));
  const prior = { ENGRAM_REPLICA_DIR: process.env.ENGRAM_REPLICA_DIR, ENGRAM_TRUST_FILE: process.env.ENGRAM_TRUST_FILE, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  const replicaDir = path.join(envRoot, 'replicas'); process.env.ENGRAM_REPLICA_DIR = replicaDir; process.env.ENGRAM_TRUST_FILE = path.join(envRoot, 'trusted-projects.json');
  const owner = new Engram(path.join(envRoot, 'origin')); await owner.vault.init(); await owner.createWorkspace('proj'); await owner.createWorkspace('alpha');
  await owner.vault.grant('proj', 'replica-agent', ['read', 'write']);
  await owner.vault.grant('alpha', 'replica-agent', ['read', 'write']);
  const credential = await createHttpCredential(owner.vault, 'replica-agent', ['workspace:proj:read', 'workspace:proj:write', 'workspace:alpha:read', 'workspace:alpha:write']);
  const origin = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); const actor = { actorId: 'replica-agent', permissions: ['workspace:proj:read', 'workspace:proj:write', 'workspace:alpha:read', 'workspace:alpha:write'], credentialBound: true };
    const send = (_res: typeof res, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const read = async () => JSON.parse(body.toString('utf8'));
    const auth = req.headers.authorization === `Bearer ${credential.token}`;
    if (!auth) { send(res, 401, { error: 'Unauthorized' }); return; }
    try { await handleReplicaRoute(path.join(envRoot, 'origin'), owner.vault, actor, credential.id, req, res, u, read, send); }
    catch { if (!res.headersSent) send(res, 500, { error: 'internal' }); }
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address(); assert(address && typeof address === 'object'); const originUrl = `http://127.0.0.1:${address.port}`;
  const tokenFile = path.join(envRoot, 'replica-token'); await writeFile(tokenFile, credential.token, { mode: 0o600 });
  await initializeReplica({ serverUrl: originUrl, tokenFile, name: 'dashboard-e2e', baseDir: replicaDir });
  const a = await openReplica('dashboard-e2e', replicaDir); const b = await initializeReplica({ serverUrl: originUrl, tokenFile, name: 'peer-e2e', baseDir: replicaDir });
  const peer = await openReplica(b.replicaId, replicaDir);
  for (const store of [a.store, peer.store]) { await fetch(originUrl + '/replica/v1/enroll', { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: store.deviceId, workspaceId: 'proj', label: store.replicaId }) }); await store.enrollScope({ type: 'workspace', workspaceId: 'proj' }); }
  await a.store.enrollScope({ type: 'workspace', workspaceId: 'alpha' });
  const mountedFolder = path.join(envRoot, 'projects', 'proj'), missingFolder = path.join(envRoot, 'projects', 'alpha'); await mkdir(mountedFolder, { recursive: true }); await mkdir(missingFolder, { recursive: true });
  for (const [folder, workspaceId] of [[mountedFolder, 'proj'], [missingFolder, 'alpha']] as const) { const binding = defaultBinding({ workspaceId, serverUrl: originUrl }); binding.mode = 'replica'; binding.replicaId = 'dashboard-e2e'; await writeBinding(folder, binding); await trustProject(folder, binding); }
  await rm(missingFolder, { recursive: true, force: true });
  const scope = { type: 'workspace' as const, workspaceId: 'proj' };
  await syncOnce(a.store, a.transport); await syncOnce(peer.store, peer.transport);

  const dashboardVault = await disposableVault();
  const server = await createDashboardServer({ engram: dashboardVault.engram, host: '127.0.0.1', port: 0, clientMode: true, authLocation: { env: {}, homeDir: dashboardVault.root, platform: 'linux' } });
  let ownerDashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  t.after(async () => { await ownerDashboard?.close(); await server.close(); await dashboardVault.cleanup(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); await rm(envRoot, { recursive: true, force: true }); for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const baseUrl = `http://127.0.0.1:${server.port}`, password = 'replica-e2e-password-321';
  await fetch(baseUrl + '/api/auth/setup', { method: 'POST', headers: { Origin: baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: server.token, password, confirm: password }) });
  const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { Origin: baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ password }) }); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { Cookie: cookie, 'X-Engram-Dashboard': '1' };
  const summary = await (await fetch(baseUrl + '/api/client/replica', { headers })).json() as any; assert.equal(summary.enabled, true); assert.equal(summary.state, 'Daemon stopped');
  const projects = await (await fetch(baseUrl + '/api/client/replica/projects', { headers })).json() as any; assert.equal(projects.rows.length, 3); const projRow = projects.rows.find((row: any) => row.replicaId === 'dashboard-e2e' && row.workspaceId === 'proj'); const alphaRow = projects.rows.find((row: any) => row.replicaId === 'dashboard-e2e' && row.workspaceId === 'alpha'); assert.ok(projRow && alphaRow); assert.equal(projRow.folders[0].mounted, true); assert.equal(alphaRow.folders[0].mounted, false); assert.equal(alphaRow.mounted, false); assert.equal(typeof projRow.diskSizeBytes, 'number'); assert.equal(projRow.diskSizeApproximate, false); assert.deepEqual(projects.rows.filter((row: any) => row.replicaId === 'peer-e2e').map((row: any) => row.workspaceId), ['proj']);
  const projection = path.join(a.store.root, 'vault', 'workspaces', 'proj', 'notes'); await mkdir(projection, { recursive: true }); await writeFile(path.join(projection, 'size-cache-probe.md'), 'cache probe');
  const cachedProjects = await (await fetch(baseUrl + '/api/client/replica/projects', { headers })).json() as any; assert.equal(cachedProjects.rows.find((row: any) => row.replicaId === 'dashboard-e2e' && row.workspaceId === 'proj').diskSizeBytes, projRow.diskSizeBytes, 'workspace size is cached across route requests');
  const postHeaders = { ...headers, Origin: baseUrl, 'Content-Type': 'application/json' };
  for (const [index, choice] of ['server', 'mine', 'edited', 'discard'].entries()) {
    const body = index === 2 ? '<script>alert(1)</script>\n</textarea> **markdown** <b>html</b>\n' + 'x'.repeat(100_000) : 'candidate-' + choice;
    const base = await owner.vault.put({ scope, kind: 'note', title: `Conflict ${choice}`, body: 'base-' + choice });
    const pulledA = await syncOnce(a.store, a.transport), pulledPeer = await syncOnce(peer.store, peer.transport); assert.deepEqual(pulledA.errors, []); assert.deepEqual(pulledPeer.errors, []);
    const left = await a.store.vault.get(base.id), right = await peer.store.vault.get(base.id);
    await peer.store.vault.patch({ objectId: base.id, expectedRevisionId: right.revisionId, body: 'winner-' + choice });
    await a.store.vault.patch({ objectId: base.id, expectedRevisionId: left.revisionId, body });
    await syncOnce(peer.store, peer.transport); await syncOnce(a.store, a.transport);
    const conflictResponse = await fetch(baseUrl + '/api/client/replica/conflicts', { headers }), conflicts = await conflictResponse.json() as any;
    const conflict = conflicts.rows.find((row: any) => row.objectId === base.id); assert.ok(conflict); assert.equal(conflict.local.text.length, Math.min(body.length, 100_000));
    if (index === 2) { assert.equal(conflict.local.truncated, true); assert.match(conflict.local.text, /<script>alert\(1\)<\/script>/); assert.match(conflict.local.text, /<\/textarea>/); }
    const route = choice === 'discard' ? '/api/client/replica/conflicts/discard' : '/api/client/replica/conflicts/resolve';
    const payload = choice === 'discard' ? { replicaId: 'dashboard-e2e', objectId: base.id } : { replicaId: 'dashboard-e2e', objectId: base.id, choice, ...(choice === 'edited' ? { title: 'Edited title', text: 'edited result' } : {}) };
    const resolved = await fetch(baseUrl + route, { method: 'POST', headers: postHeaders, body: JSON.stringify(payload) }); assert.equal(resolved.status, 200, await resolved.text());
    await syncOnce(a.store, a.transport); await syncOnce(peer.store, peer.transport);
    const expected = choice === 'mine' ? body : choice === 'edited' ? 'edited result' : 'winner-' + choice;
    assert.equal((await owner.vault.get(base.id)).body, expected); assert.equal((await peer.store.vault.get(base.id)).body, expected);
    const candidate = a.store.conflicts.find(item => item.objectId === base.id)!; assert.ok(candidate); assert.match(await readFile(path.join(a.store.root, 'vault', '.mdb', 'objects', base.id, 'revs', `${candidate.localRevisionId}.md`), 'utf8'), choice === 'edited' && body.length > 100_000 ? /<script>alert\(1\)/ : new RegExp(choice === 'edited' ? 'x{100}' : choice === 'discard' || choice === 'server' ? `candidate-${choice}` : `candidate-${choice}`));
    assert.equal(((await (await fetch(baseUrl + '/api/client/replica/conflicts', { headers })).json() as any).rows).some((row: any) => row.objectId === base.id), false);
  }
  const oldTime = Date.now() - 3 * 60_000, clientId = '00000000-0000-4000-8000-000000000123';
  await writeClientHeartbeat(path.join(envRoot, 'origin'), credential.id, 'replica-agent', { schemaVersion: 1, clientId, displayName: 'dashboard-e2e', hostLabel: 'Test machine', appVersion: 'replica-v1', mode: 'cached', lastSync: { serverContactAt: null, outboxDeliveredAt: null, fileSyncCommittedAt: null, contextFetchedAt: null }, queues: { outbox: 1, fileSync: 0, capture: 0, queuedBytes: 0 }, projects: [], replication: { state: 'offline', epochState: 'current', profileSnapshotAt: null, enrolledWorkspaces: [{ workspaceId: 'proj', pendingPush: 1, diverged: 0, deferred: 0, lastPullAt: null, lastPushAt: null }] } }, '127.0.0.1', oldTime);
  assert.deepEqual((await listReplicaDevices(path.join(envRoot, 'origin')))[0]?.enrolledScopes.map(item => item.workspaceId), ['proj']);
  ownerDashboard = await createDashboardServer({ engram: owner, host: '127.0.0.1', port: 0, authLocation: { env: {}, homeDir: envRoot, platform: 'linux' } });
  const ownerUrl = `http://127.0.0.1:${ownerDashboard.port}`, ownerPassword = 'replica-owner-dashboard-432';
  await fetch(ownerUrl + '/api/auth/setup', { method: 'POST', headers: { Origin: ownerUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: ownerDashboard.token, password: ownerPassword, confirm: ownerPassword }) });
  const ownerLogin = await fetch(ownerUrl + '/api/auth/login', { method: 'POST', headers: { Origin: ownerUrl, 'content-type': 'application/json' }, body: JSON.stringify({ password: ownerPassword }) }), ownerCookie = ownerLogin.headers.get('set-cookie')!.split(';')[0]!;
  const clients = await (await fetch(ownerUrl + '/api/clients?limit=100', { headers: { Cookie: ownerCookie, 'X-Engram-Dashboard': '1' } })).json() as any;
  const reported = clients.rows.find((row: any) => row.credential.id === credential.id).clients.find((item: any) => item.clientId === clientId);
  assert.equal(reported.replication.state, 'offline'); assert.deepEqual(reported.replication.enrolledWorkspaces[0].workspaceId, 'proj'); assert.equal(reported.state, 'Last seen');
  const unenroll = await fetch(ownerUrl + '/api/clients/unenroll', { method: 'POST', headers: { Cookie: ownerCookie, Origin: ownerUrl, 'X-Engram-Dashboard': '1', 'X-Engram-Reauth-Password': ownerPassword, 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId: credential.id, deviceId: a.store.deviceId, workspaceId: 'proj' }) }); assert.equal(unenroll.status, 200);
  assert.deepEqual((await listReplicaDevices(path.join(envRoot, 'origin')))[0]?.enrolledScopes, []);
  const forbidden = await fetch(originUrl + '/replica/v1/fetch', { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: a.store.deviceId, workspaceId: 'proj' }) }); assert.equal(forbidden.status, 403);
});
