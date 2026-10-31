import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { assertAvailableStorage, classifyStoragePressure, cleanupPreview, createOwnedOperation, DEFAULT_STORAGE_DURABLE_RESERVE_BYTES, storageStatus } from '../packages/core/storage-lifecycle.js';
import { Vault } from '../packages/core/vault.js';
import { OWNER } from '../packages/core/types.js';
import { enqueueEvent, spoolStats } from '../packages/memory/capture.js';
import type { MemoryEvent } from '../packages/memory/types.js';
import { enqueueWrite, listOutbox } from '../packages/memory/outbox.js';
import { queueRemoteCapture } from '../packages/memory/remote-spool.js';
import { buildFsIndex } from '../packages/search-files/postings.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { writeUserConfig } from '../packages/memory/user-config.js';

async function rootFor(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-pressure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('pressure transitions and projected growth apply the configured reserves', async () => {
  const env = { ENGRAM_STORAGE_MIN_FREE_BYTES: '1000', ENGRAM_STORAGE_DURABLE_RESERVE_BYTES: '100' };
  assert.equal(classifyStoragePressure(5000, 0, env), 'NORMAL');
  assert.equal(classifyStoragePressure(2000, 1, env), 'WARNING');
  assert.equal(classifyStoragePressure(1000, 0, env), 'CRITICAL');
  assert.equal(classifyStoragePressure(500, 450, env), 'READ_ONLY');
  assert.equal(classifyStoragePressure(1500, 600, env), 'CRITICAL');
  await assert.rejects(assertAvailableStorage(os.tmpdir(), env, 0, 1000), /deferred optional work/);
  assert.equal(DEFAULT_STORAGE_DURABLE_RESERVE_BYTES, 64 * 1024 * 1024, 'production reserve is configurable and is not the investigation 40 GiB floor');
});

test('READ_ONLY rejects canonical writes before revision creation; reads/recovery work and writes resume after capacity returns', async t => {
  const root = await rootFor(t); let available = DEFAULT_STORAGE_DURABLE_RESERVE_BYTES + 1024 * 1024;
  const vault = new Vault(root, OWNER, { storageAvailableBytes: async () => available });
  await vault.init();
  const committed = await vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'durable', body: 'protected-canonical-canary' });
  const priorEvents = await vault.events();
  available = DEFAULT_STORAGE_DURABLE_RESERVE_BYTES + 1;
  await assert.rejects(vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'blocked', body: 'must not be acknowledged' }), /READ_ONLY/);
  const concurrentVault = new Vault(root, OWNER, { storageAvailableBytes: async () => available });
  const concurrent = await Promise.allSettled([concurrentVault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'racing', body: 'must not race past reserve' })]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 0, 'another Engram process sees READ_ONLY while capacity remains low');
  assert.deepEqual(await vault.events(), priorEvents, 'rejected write appended no journal event');
  assert.equal((await vault.get(committed.id)).body, 'protected-canonical-canary');
  await vault.recover();
  await assert.rejects(vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'still blocked', body: 'recovery is allowed but mutation is not' }), /READ_ONLY/);
  available = DEFAULT_STORAGE_DURABLE_RESERVE_BYTES + 1024 * 1024;
  assert.equal((await vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'resumed', body: 'capacity returned' })).body, 'capacity returned');
});

test('independent writer processes both reject mutations while the configured durable reserve is unavailable', async t => {
  const root = await rootFor(t); const vault = new Vault(root); await vault.init();
  const moduleUrl = new URL('../packages/core/vault.js', import.meta.url).href;
  const script = `import { Vault } from ${JSON.stringify(moduleUrl)};\ntry { await new Vault(process.env.ENGRAM_DATA_DIR).put({scope:{type:'global',area:'shared'},kind:'note',title:process.env.WRITER,body:'must stay uncommitted'}); process.exitCode=3; } catch (e) { if (!String(e?.message).includes('READ_ONLY')) { console.error(String(e?.message)); process.exitCode=2; } }`;
  const start = (writer: string): Promise<{ code: number | null; stderr: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_DURABLE_RESERVE_BYTES: '9000000000000000', WRITER: writer }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  });
  const results = await Promise.all([start('writer-a'), start('writer-b')]);
  assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.stderr).join('\n'));
  assert.deepEqual(await vault.events(), [], 'neither process acknowledges or journals a write');
});

test('READ_ONLY also rejects durable user-configuration writes beneath ENGRAM_DATA_DIR', async t => {
  const root = await rootFor(t); const config = { schemaVersion: 1 as const, serverUrl: 'http://127.0.0.1:3000/mcp', tokenEnv: 'ENGRAM_TEST_TOKEN', workspaceId: 'personal', registrationId: 'registration', principalId: 'owner', hosts: ['codex'] as ['codex'], captureConsent: true as const, paused: false, excludeProjects: [] };
  await assert.rejects(writeUserConfig(config, { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_DURABLE_RESERVE_BYTES: '9000000000000000' }), /READ_ONLY/);
  await assert.rejects(readFile(path.join(root, '.engram-runtime/config/user.json')), { code: 'ENOENT' });
});

test('capture, outbox and remote spool preserve accepted work and reject new enqueue under CRITICAL pressure', async t => {
  const root = await rootFor(t); const original = process.env.ENGRAM_STORAGE_MIN_FREE_BYTES;
  t.after(() => { if (original === undefined) delete process.env.ENGRAM_STORAGE_MIN_FREE_BYTES; else process.env.ENGRAM_STORAGE_MIN_FREE_BYTES = original; });
  const event = (id: string): { registrationId: string; event: MemoryEvent } => ({ registrationId: 'reg', event: { eventId: id, timestamp: new Date().toISOString(), host: 'test', sessionId: 'session', workspaceId: 'w', principalId: 'p', type: 'user.message', classification: 'workspace_private', consentPolicyId: 'test', schemaVersion: 1, content: 'synthetic' } });
  await enqueueEvent(root, event('accepted'));
  const outbox = path.join(root, '.engram-runtime/outbox'), remote = path.join(root, '.engram-runtime/remote-spool');
  await enqueueWrite(outbox, { url: 'http://127.0.0.1:1/mcp', tool: 'memory_put', arguments: { title: 'accepted' } });
  process.env.ENGRAM_STORAGE_MIN_FREE_BYTES = '9000000000000000';
  await assert.rejects(enqueueEvent(root, event('rejected')));
  await assert.rejects(enqueueWrite(outbox, { url: 'http://127.0.0.1:1/mcp', tool: 'memory_put', arguments: { title: 'rejected' } }));
  await assert.rejects(queueRemoteCapture({ url: 'http://127.0.0.1:1/capture', registrationId: 'reg', payload: { event: 'synthetic' }, directory: remote }));
  assert.equal((await spoolStats(root)).queued, 1, 'accepted capture remains queued');
  assert.equal((await listOutbox(outbox)).length, 1, 'accepted outbox item remains queued');
  await assert.rejects(readdir(remote), { code: 'ENOENT' }, 'rejected remote item created no spool artifact');
  if (original === undefined) delete process.env.ENGRAM_STORAGE_MIN_FREE_BYTES; else process.env.ENGRAM_STORAGE_MIN_FREE_BYTES = original;
  assert.equal(await enqueueEvent(root, event('after-recovery')), 'queued', 'capture admission recovers after free-space state returns');
  await enqueueWrite(outbox, { url: 'http://127.0.0.1:1/mcp', tool: 'memory_put', arguments: { title: 'after recovery' } });
  assert.equal((await listOutbox(outbox)).length, 2);
});

test('index rebuild defers before creating scratch under CRITICAL pressure', async t => {
  const root = await rootFor(t); const vault = new Vault(root);
  await vault.init();
  await vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'index me', body: 'synthetic' });
  await assert.rejects(buildFsIndex(vault, { env: { ENGRAM_STORAGE_MIN_FREE_BYTES: '9000000000000000' } }), /deferred optional work/);
  await assert.rejects(readdir(path.join(root, '.mdb/indexes/.engram-builds')), { code: 'ENOENT' });
});

test('optional operation admission rejects Dream/model scratch at CRITICAL and cleanup/status protect canonical data', async t => {
  const root = await rootFor(t); const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_MIN_FREE_BYTES: '9000000000000000' };
  await assert.rejects(createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs' }), /deferred optional work/);
  const vault = new Vault(root); await vault.init(); await vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'note', title: 'keep', body: 'never-delete-this-private-body' });
  const engine = new IntelligenceEngine(vault); const job = await engine.enqueue('dream', { mode: 'micro' });
  const oldRoot = process.env.ENGRAM_DATA_DIR, oldReserve = process.env.ENGRAM_STORAGE_MIN_FREE_BYTES;
  process.env.ENGRAM_DATA_DIR = root; process.env.ENGRAM_STORAGE_MIN_FREE_BYTES = '9000000000000000';
  try { await assert.rejects(engine.run({ jobId: job.id }), /deferred optional work/); }
  finally { if (oldRoot === undefined) delete process.env.ENGRAM_DATA_DIR; else process.env.ENGRAM_DATA_DIR = oldRoot; if (oldReserve === undefined) delete process.env.ENGRAM_STORAGE_MIN_FREE_BYTES; else process.env.ENGRAM_STORAGE_MIN_FREE_BYTES = oldReserve; }
  assert.equal((await engine.jobs()).find(item => item.id === job.id)?.status, 'pending', 'Dream work stays queued when admission is rejected');
  const active = await createOwnedOperation('test-job', { env: { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_MIN_FREE_BYTES: '0' } });
  const preview = await cleanupPreview({ ENGRAM_DATA_DIR: root }); assert.equal(preview.deleted, 0); assert.equal(preview.candidates.length, 0);
  const status = await storageStatus({ ENGRAM_DATA_DIR: root }); const diagnostic = JSON.stringify(status);
  assert.equal(diagnostic.includes('never-delete-this-private-body'), false);
  assert.equal((status.pressure as { state: string }).state.length > 0, true);
  assert.equal(await readFile(path.join(root, '.mdb/objects', (await vault.events())[0]!.objectId, 'revs', `${(await vault.events())[0]!.revisionId}.md`), 'utf8').then(text => text.includes('never-delete-this-private-body')), true);
  await active.cleanup();
});

test('temporary operation quota is checked incrementally and status reports peak, protected and recoverable bytes without content', async t => {
  const root = await rootFor(t); const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_MIN_FREE_BYTES: '0', ENGRAM_STORAGE_OPERATION_QUOTA_BYTES: '2048' };
  const operation = await createOwnedOperation('bounded-scratch', { env });
  await writeFile(path.join(operation.directory, 'scratch.bin'), Buffer.alloc(4096));
  await assert.rejects(operation.checkQuota(), /per-operation scratch quota/);
  const markerPath = path.join(operation.directory, '.engram-operation.json');
  await writeFile(markerPath, `${JSON.stringify({ ...operation.marker, pid: 2_000_000_000 })}\n`);
  const status = await storageStatus(env) as { ownedOperations: Array<{ id: string; bytes: number; peakBytes?: number }>; pressure: { protectedDurableBytes: number; recoverableDisposableBytes: number; availableBytes: number | null; state: string } };
  const report = status.ownedOperations.find(item => item.id === operation.id)!;
  assert.ok(report.bytes >= 4096); assert.ok((report.peakBytes ?? 0) >= 4096);
  assert.equal(status.pressure.protectedDurableBytes, 0);
  assert.ok(status.pressure.recoverableDisposableBytes >= report.bytes);
  assert.equal(typeof status.pressure.availableBytes, 'number');
  await writeFile(markerPath, `${JSON.stringify(operation.marker)}\n`);
  await operation.cleanup();
});

