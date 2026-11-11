import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { ReplicaStore } from '../../packages/replication/replica.js';
import { DEFAULT_REPLICA_LIMITS } from '../../packages/replication/internals.js';
import { Vault } from '../../packages/core/vault.js';
import { fetchEvents } from '../../packages/replication/feed.js';
import { fetchReplicaBlob, readOriginalBlob } from '../../packages/replication/client.js';
import { applyOperation } from '../../packages/replication/server.js';

test('replica pending quotas reject before commit and allow writes after the queue drains', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-quota-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = path.join(home, 'replicas');
  let store = await ReplicaStore.replicaInit('quota-test', 'http://127.0.0.1:1234', base);
  await store.enrollScope({ type: 'workspace', workspaceId: 'quota-proj' });
  const limitsFile = path.join(store.state, 'limits.json');
  const limits = { ...DEFAULT_REPLICA_LIMITS, maxPendingOps: 1, maxPendingBytes: 4096 };
  await writeFile(limitsFile, JSON.stringify(limits), { mode: 0o600 });
  store = await ReplicaStore.replicaInit('quota-test', 'http://127.0.0.1:1234', base);
  await store.vault.put({ scope: { type: 'workspace', workspaceId: 'quota-proj' }, kind: 'note', title: 'first', body: 'retained' });
  const before = await store.vault.events();
  await assert.rejects(
    store.vault.put({ scope: { type: 'workspace', workspaceId: 'quota-proj' }, kind: 'note', title: 'second', body: 'must not commit' }),
    error => (error as { code?: string }).code === 'QUOTA_EXCEEDED' && /pending operation limit/.test(String(error)),
  );
  assert.equal((await store.vault.events()).length, before.length, 'quota refusal happens before a journal commit');
  const op = store.pendingBatch()[0]!;
  await store.markResult(op.opId, { status: 'rejected', code: 'test-terminal' });
  await store.vault.put({ scope: { type: 'workspace', workspaceId: 'quota-proj' }, kind: 'note', title: 'after drain', body: 'allowed' });
  assert.equal(store.status().pendingPush, 1);
  const byteLimited = { ...limits, maxPendingOps: 10, maxPendingBytes: 1 };
  await writeFile(limitsFile, JSON.stringify(byteLimited), { mode: 0o600 });
  store = await ReplicaStore.replicaInit('quota-test', 'http://127.0.0.1:1234', base);
  await assert.rejects(store.vault.put({ scope: { type: 'workspace', workspaceId: 'quota-proj' }, kind: 'note', title: 'too many bytes', body: 'refused' }), error => (error as { code?: string }).code === 'QUOTA_EXCEEDED' && /pending byte limit/.test(String(error)));
  const config = JSON.parse(await readFile(limitsFile, 'utf8')) as typeof limits;
  assert.deepEqual(config, byteLimited);
});

test('replica limits default to documented safe values', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-limits-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await ReplicaStore.replicaInit('defaults', 'http://127.0.0.1:1234', home);
  assert.deepEqual(store.limits, { maxReplicaBytes: 2 * 1024 ** 3, maxPendingOps: 10_000, maxPendingBytes: 256 * 1024 ** 2, maxBlobBytes: 64 * 1024 ** 2 });
  assert.equal((await store.verify()).ok, true);
});

test('real SIGKILL after pending append recovers the acknowledged local journal commit', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-kill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = path.join(home, 'replicas');
  const initial = await ReplicaStore.replicaInit('kill-test', 'http://127.0.0.1:1234', base);
  await initial.enrollScope({ type: 'workspace', workspaceId: 'kill-proj' });
  const moduleUrl = pathToFileURL(path.resolve('dist/packages/replication/replica.js')).href;
  const childScript = `const {ReplicaStore}=await import(${JSON.stringify(moduleUrl)});const store=await ReplicaStore.replicaInit('kill-test','http://127.0.0.1:1234',${JSON.stringify(base)});await store.vault.put({scope:{type:'workspace',workspaceId:'kill-proj'},kind:'note',title:'survives kill',body:'durable'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', MDB_FAULT_KILL_AT: 'local.after_pending_append' }, stdio: 'ignore' });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, 'SIGKILL');
  const recovered = await ReplicaStore.replicaInit('kill-test', 'http://127.0.0.1:1234', base);
  assert.equal(recovered.status().pendingPush, 1);
  assert.equal((await recovered.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'kill-proj' }] })).length, 1);
  assert.equal((await recovered.verify()).ok, true);
});

test('real local commit SIGKILL matrix recovers across revision, journal, and queue boundaries', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-kill-matrix-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve('dist/packages/replication/replica.js')).href;
  const rows: Array<{ point: string; outcome: string }> = [];
  for (const [index, point] of ['local.after_revision_write', 'local.after_journal_append', 'local.after_pending_append'].entries()) {
    const base = path.join(home, `replicas-${index}`), id = `kill-${index}`;
    const initial = await ReplicaStore.replicaInit(id, 'http://127.0.0.1:1234', base);
    await initial.enrollScope({ type: 'workspace', workspaceId: 'kill-proj' });
    const childScript = `const {ReplicaStore}=await import(${JSON.stringify(moduleUrl)});const store=await ReplicaStore.replicaInit(${JSON.stringify(id)},'http://127.0.0.1:1234',${JSON.stringify(base)});await store.vault.put({scope:{type:'workspace',workspaceId:'kill-proj'},kind:'note',title:'boundary ${index}',body:'recover'});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', MDB_FAULT_KILL_AT: point }, stdio: 'ignore' });
    const exit = await new Promise<{ signal: NodeJS.Signals | null }>(resolve => child.once('exit', (_code, signal) => resolve({ signal })));
    assert.equal(exit.signal, 'SIGKILL', point);
    const recovered = await ReplicaStore.replicaInit(id, 'http://127.0.0.1:1234', base);
    const committed = point !== 'local.after_revision_write';
    assert.equal((await recovered.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'kill-proj' }] })).length, committed ? 1 : 0, point);
    assert.equal(recovered.status().pendingPush, committed ? 1 : 0, point);
    assert.equal((await recovered.verify()).ok, true, point);
    rows.push({ point, outcome: committed ? 'recovered commit + pending op; verify ok' : 'pre-commit orphan ignored; verify ok' });
  }
  console.log('\nReplica local SIGKILL matrix\n' + rows.map(row => `${row.point.padEnd(32)} ${row.outcome}`).join('\n'));
});

test('source revisions clone as metadata; original blobs fetch on demand and verify their digest', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-blob-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const origin = new Vault(path.join(home, 'origin'));
  await origin.init();
  await origin.createWorkspace('blob-proj', '', { reader: ['read', 'write'] });
  const actor = { actorId: 'reader', permissions: ['workspace:blob-proj:read', 'workspace:blob-proj:write'], credentialBound: true };
  const original = Buffer.from([0, 255, 1, 42, 13, 10]);
  const sourceFile = path.join(home, 'source.bin');
  await writeFile(sourceFile, original);
  const source = await origin.ingest(sourceFile, { type: 'workspace', workspaceId: 'blob-proj' });
  const tokenFile = path.join(home, 'token');
  await writeFile(tokenFile, 'synthetic-token\n', { mode: 0o600 });
  const initialized = await import('../../packages/replication/client.js').then(({ initializeReplica }) => initializeReplica({ serverUrl: 'http://127.0.0.1:0', tokenFile, name: 'blob-client', baseDir: path.join(home, 'replicas') }));
  const store = await ReplicaStore.replicaInit('blob-client', 'http://127.0.0.1', path.join(home, 'replicas'));
  await store.enrollScope({ type: 'workspace', workspaceId: 'blob-proj' });
  const page = await fetchEvents(origin, actor, { type: 'workspace', workspaceId: 'blob-proj' }, store.deviceId, undefined, 100, path.join(home, 'feed'));
  await store.installRemote(page.events, page.cursor, page.epoch, 'blob-proj');
  assert.equal((await store.vault.get(source.id)).metadata.sha256, createHash('sha256').update(original).digest('hex'));
  await assert.rejects(readOriginalBlob('blob-client', 'blob-proj', String(source.metadata.sha256), path.join(home, 'replicas')), error => (error as { code?: string }).code === 'BLOB_NOT_CACHED');

  const blobStore = store;
  let corrupt = true;
  const server = createServer((request, response) => { assert.match(request.url ?? '', /\/replica\/v1\/blobs\//); assert.equal(request.headers.authorization, 'Bearer synthetic-token'); response.end(corrupt ? Buffer.from([1, 2, 3, 4, 5, 6]) : original); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === 'object');
  const configFile = path.join(initialized.root, '.replica', 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8')) as { serverUrl: string };
  config.serverUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(configFile, JSON.stringify({ ...JSON.parse(await readFile(configFile, 'utf8')), serverUrl: config.serverUrl }), { mode: 0o600 });
  const digest = String(source.metadata.sha256);
  await assert.rejects(fetchReplicaBlob('blob-client', 'blob-proj', digest, path.join(home, 'replicas')), /hash mismatch/);
  corrupt = false;
  const fetched = await fetchReplicaBlob('blob-client', 'blob-proj', digest, path.join(home, 'replicas'));
  assert.equal(fetched.bytes, original.length);
  assert.deepEqual(await readOriginalBlob('blob-client', 'blob-proj', digest, path.join(home, 'replicas')), original);
  await writeFile(path.join(blobStore.state, 'blobs', digest), 'tampered');
  await assert.rejects(readOriginalBlob('blob-client', 'blob-proj', digest, path.join(home, 'replicas')), /cached source blob hash mismatch/);
  await access(path.join(blobStore.state, 'blobs', digest));
  assert.equal((await blobStore.verify()).ok, true, 'metadata-only source revisions verify without local originals');
});

test('an orphaned local revision is rejected as PARENT_MISSING after an origin restore', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-restore-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const origin = new Vault(path.join(home, 'origin'));
  await origin.init();
  await origin.createWorkspace('restore-proj', '', { writer: ['read', 'write'] });
  const actor = { actorId: 'writer', permissions: ['workspace:restore-proj:read', 'workspace:restore-proj:write'], credentialBound: true };
  const shared = await origin.put({ scope: { type: 'workspace', workspaceId: 'restore-proj' }, kind: 'note', title: 'Shared', body: 'base' });
  const store = await ReplicaStore.replicaInit('restore-client', 'http://127.0.0.1', path.join(home, 'replicas'));
  await store.enrollScope({ type: 'workspace', workspaceId: 'restore-proj' });
  const page = await fetchEvents(origin, actor, { type: 'workspace', workspaceId: 'restore-proj' }, store.deviceId, undefined, 100, path.join(home, 'feed'));
  await store.installRemote(page.events, page.cursor, page.epoch, 'restore-proj');
  await store.vault.patch({ objectId: shared.id, expectedRevisionId: shared.revisionId, body: 'local-only edit' });
  const orphan = store.pendingBatch()[0]!;

  const restored = new Vault(path.join(home, 'restored-origin'));
  await restored.init();
  await restored.createWorkspace('restore-proj', '', { writer: ['read', 'write'] });
  const result = await applyOperation(restored, actor, orphan, { resultsFile: path.join(home, 'restored-results.json') });
  assert.deepEqual({ status: result.status, code: result.code }, { status: 'rejected', code: 'PARENT_MISSING' });
  assert.equal((await restored.events()).length, 0, 'the orphan is retained locally and never force-pushed');
  assert.equal((await store.vault.get(shared.id)).body, 'local-only edit');
  await store.markResult(orphan.opId, result);
  assert.equal(store.status().pendingPush, 0);
  assert.equal((await store.verify()).ok, true);
});
