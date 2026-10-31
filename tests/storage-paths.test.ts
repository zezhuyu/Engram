import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureStorageDirectory, resolveRoot, resolveStoragePath } from '../packages/core/root.js';
import { assertAvailableStorage, cleanupPreview, createOwnedOperation, storageQuota, storageStatus } from '../packages/core/storage-lifecycle.js';
import { userConfigPath } from '../packages/memory/user-config.js';
import { cacheDir } from '../packages/memory/context-hook.js';
import { defaultOutboxDirectory } from '../packages/memory/outbox.js';
import { defaultRemoteSpoolDirectory } from '../packages/memory/remote-spool.js';

test('an explicit ENGRAM_DATA_DIR roots every default Engram side-storage class', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root };
  const expected = {
    config: path.join(root, '.engram-runtime/config/user.json'), state: path.join(root, '.engram-runtime/state'),
    cache: path.join(root, '.engram-runtime/cache'), outbox: path.join(root, '.engram-runtime/outbox'),
    'remote-spool': path.join(root, '.engram-runtime/remote-spool'), tmp: path.join(root, '.engram-runtime/tmp'),
    logs: path.join(root, '.engram-runtime/logs'), 'index-scratch': path.join(root, '.engram-runtime/index-scratch'),
  };
  for (const [kind, location] of Object.entries(expected)) assert.equal(resolveStoragePath(kind as keyof typeof expected, env), location);
  assert.equal(userConfigPath(env), expected.config); assert.equal(cacheDir(env), expected.cache);
  assert.equal(defaultOutboxDirectory(env), expected.outbox); assert.equal(defaultRemoteSpoolDirectory(env), expected['remote-spool']);
  for (const location of Object.values(expected)) assert.ok(!path.relative(root, location).startsWith(`..${path.sep}`));
});

test('legacy defaults remain unchanged when ENGRAM_DATA_DIR is absent; explicit class override stays explicit', () => {
  const env = { HOME: '/home/example', XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state', XDG_CACHE_HOME: '/cache' };
  assert.equal(resolveStoragePath('config', env), '/cfg/engram/user.json');
  assert.equal(resolveStoragePath('state', env), '/state/engram');
  assert.equal(resolveStoragePath('cache', env), '/cache/engram');
  assert.equal(resolveStoragePath('outbox', env), path.join(os.homedir(), '.Engram-outbox'));
  assert.equal(resolveStoragePath('remote-spool', env), path.join(os.homedir(), '.Engram-remote-spool'));
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '', MDB_ROOT: '/legacy' }), '/legacy');
  assert.throws(() => resolveStoragePath('cache', { ENGRAM_DATA_DIR: '/owned', ENGRAM_CACHE_DIR: '/explicit-cache' }), /must remain inside ENGRAM_DATA_DIR/);
  assert.equal(resolveStoragePath('cache', { ENGRAM_DATA_DIR: '/owned', ENGRAM_CACHE_DIR: '/owned/other-cache' }), '/owned/other-cache');
});

test('owned temp operations are uniquely marked and removed only from their exact directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-operation-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root };
  const first = await createOwnedOperation('test-job', { env }); const second = await createOwnedOperation('test-job', { env });
  assert.notEqual(first.id, second.id); assert.ok(first.directory.startsWith(path.join(root, '.engram-runtime/tmp/operations')));
  assert.equal(JSON.parse(await readFile(path.join(first.directory, '.engram-operation.json'), 'utf8')).state, 'active');
  await first.cleanup(); await first.cleanup();
  await assert.rejects(readdir(first.directory), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(second.directory, '.engram-operation.json'), 'utf8')).state, 'active');
  await second.cleanup();
});

test('concurrent owned operations remain visible and cleanup preview cannot remove active work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-active-operation-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_TEMP_QUOTA_BYTES: String(1024 * 1024) };
  const operations = await Promise.all(Array.from({ length: 8 }, (_, i) => createOwnedOperation(`concurrent-${i}`, { env })));
  assert.equal(new Set(operations.map(operation => operation.id)).size, operations.length);
  const preview = await cleanupPreview(env);
  assert.equal(preview.deleted, 0);
  assert.deepEqual(preview.candidates, [], 'live process markers are not orphan cleanup candidates');
  for (const operation of operations) {
    assert.equal(JSON.parse(await readFile(path.join(operation.directory, '.engram-operation.json'), 'utf8')).state, 'active');
    assert.equal(path.relative(root, operation.directory).startsWith('..'), false);
  }
  await Promise.all(operations.map(operation => operation.cleanup()));
  assert.equal((await cleanupPreview(env)).deleted, 0, 'completed cleanup remains report-only and idempotent');
});

test('storage accounting tolerates a file removed between directory enumeration and inspection, but fails closed on other inspection errors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-accounting-race-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root }, operationsRoot = path.join(root, '.engram-runtime/tmp/operations');
  await mkdir(operationsRoot, { recursive: true });
  const transient = path.join(operationsRoot, '.engram-operation.json.atomic.tmp'); await writeFile(transient, 'atomic marker being replaced');
  const originalStat = fs.stat, originalLstat = fs.lstat; let injected = false;
  const vanished = (operation: typeof fs.stat | typeof fs.lstat) => async (...args: Parameters<typeof fs.stat>) => {
    const file = args[0];
    if (!injected && path.resolve(String(file)) === transient) {
      injected = true; const error = Object.assign(new Error('injected concurrent unlink'), { code: 'ENOENT' }); throw error;
    }
    return operation(file, args[1] as never) as never;
  };
  try {
    fs.stat = vanished(originalStat) as typeof fs.stat; fs.lstat = vanished(originalLstat) as typeof fs.lstat;
    const operation = await createOwnedOperation('race-check', { env });
    assert.ok(injected, 'the readdir-to-inspection disappearance was injected');
    await operation.cleanup();
  } finally { fs.stat = originalStat; fs.lstat = originalLstat; }

  let denied = false;
  const deniedInspection = async (...args: Parameters<typeof fs.lstat>) => {
    const file = args[0];
    if (path.resolve(String(file)) === transient) { denied = true; throw Object.assign(new Error('injected permission denial'), { code: 'EACCES' }); }
    return originalLstat(file, args[1] as never) as never;
  };
  fs.lstat = deniedInspection as typeof fs.lstat;
  try { await assert.rejects(createOwnedOperation('accounting-denied', { env }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES'); assert.ok(denied); }
  finally { fs.lstat = originalLstat; }
});

test('an independent process cannot classify or remove another live process operation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-cross-process-cleanup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const operation = await createOwnedOperation('cross-process', { env: { ENGRAM_DATA_DIR: root } });
  const activePayload = path.join(operation.directory, 'active.bin'); await writeFile(activePayload, 'owned until process A completes');
  const canonical = path.join(root, '.mdb/events/commits.jsonl'); await mkdir(path.dirname(canonical), { recursive: true }); await writeFile(canonical, 'recovery-critical sentinel');
  const lifecycle = pathToFileURL(path.resolve('dist/packages/core/storage-lifecycle.js')).href;
  const script = `const {cleanupPreview}=await import(${JSON.stringify(lifecycle)});console.log(JSON.stringify(await cleanupPreview({ENGRAM_DATA_DIR:${JSON.stringify(root)}})));`;
  const processB = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, ENGRAM_DATA_DIR: root }, timeout: 5000 });
  assert.equal(processB.status, 0, processB.stderr);
  const report = JSON.parse(processB.stdout) as { deleted: number; candidates: Array<{ id: string }> };
  assert.equal(report.deleted, 0); assert.deepEqual(report.candidates, [], 'the active PID is not an orphan candidate');
  assert.equal(await readFile(activePayload, 'utf8'), 'owned until process A completes');
  await operation.cleanup();
  await assert.rejects(readFile(operation.directory), { code: 'ENOENT' }, 'process A removes only its completed, owned disposable directory');
  assert.equal(await readFile(canonical, 'utf8'), 'recovery-critical sentinel', 'canonical recovery data is never a cleanup target');
});

test('temporary quota and background-job admission defer work without touching canonical roots', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-quota-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_BACKGROUND_JOB_LIMIT: '1' };
  const job = await createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs', scope: '/same-vault' });
  await assert.rejects(createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs', scope: '/same-vault' }), /background job limit reached/);
  await job.cleanup();
  await assert.rejects(createOwnedOperation('too-small', { env: { ...env, ENGRAM_STORAGE_TEMP_QUOTA_BYTES: '1' } }), /temporary storage quota reached/);
  await assert.rejects(readFile(path.join(root, '.mdb/events/commits.jsonl')));
});

test('optional work is rejected when the configured minimum free-space reserve is unmet', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-space-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_MIN_FREE_BYTES: '8000000000000000' };
  await assert.rejects(assertAvailableStorage(root, env), /below ENGRAM_STORAGE_MIN_FREE_BYTES/);
  await assert.rejects(createOwnedOperation('deferred-job', { env }), /below ENGRAM_STORAGE_MIN_FREE_BYTES/);
});

test('cleanup metadata ENOSPC preserves an active operation for later recovery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-cleanup-enospc-')); t.after(() => rm(root, { recursive: true, force: true }));
  let fail = true;
  const operation = await createOwnedOperation('metadata-test', { env: { ENGRAM_DATA_DIR: root }, fault: stage => { if (fail && stage === 'operation.marker_complete') { const error = new Error('injected ENOSPC') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; } } });
  await assert.rejects(operation.cleanup(), { code: 'ENOSPC' });
  const marker = JSON.parse(await readFile(path.join(operation.directory, '.engram-operation.json'), 'utf8')) as { state: string };
  assert.equal(marker.state, 'active', 'failed cleanup does not erase operation ownership evidence');
  fail = false; await operation.cleanup();
  await assert.rejects(readdir(operation.directory), { code: 'ENOENT' });
});

test('cleanup preview identifies abandoned marked operations without deleting them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-orphan-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root }; const operationRoot = path.join(root, '.engram-runtime/tmp/operations');
  await mkdir(operationRoot, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000001', directory = path.join(operationRoot, `orphan-${id}`);
  await mkdir(directory);
  await writeFile(path.join(directory, '.engram-operation.json'), JSON.stringify({ schemaVersion: 1, id, category: 'orphan', pid: 2147483000, createdAt: new Date(0).toISOString(), state: 'active' }));
  const preview = await cleanupPreview(env);
  assert.equal(preview.deleted, 0); assert.equal(preview.candidates.length, 1); assert.equal(preview.candidates[0]?.id, id);
  assert.ok(await readFile(path.join(directory, '.engram-operation.json')));
});

test('cleanup preview marks its inventory incomplete when an entry is ambiguous', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-orphan-incomplete-')); t.after(() => rm(root, { recursive: true, force: true }));
  const operationRoot = path.join(root, '.engram-runtime/tmp/operations'); await mkdir(operationRoot, { recursive: true });
  await mkdir(path.join(operationRoot, 'unmarked-directory')); await writeFile(path.join(operationRoot, 'unexpected-file'), 'preserve');
  const preview = await cleanupPreview({ ENGRAM_DATA_DIR: root });
  assert.equal(preview.deleted, 0); assert.equal(preview.complete, false); assert.equal(preview.uninspectedEntries, 2); assert.deepEqual(preview.candidates, []);
  assert.equal(await readFile(path.join(operationRoot, 'unexpected-file'), 'utf8'), 'preserve');
});

test('dead interrupted background-job markers do not permanently consume the concurrency quota', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-job-orphan-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_BACKGROUND_JOB_LIMIT: '1' }, operationRoot = path.join(root, '.engram-runtime/tmp/operations');
  const id = '00000000-0000-4000-8000-000000000002', directory = path.join(operationRoot, `intelligence-job-${id}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, '.engram-operation.json'), JSON.stringify({ schemaVersion: 1, id, category: 'intelligence-job', pid: 2147483000, createdAt: new Date(0).toISOString(), state: 'active' }));
  const operation = await createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs' });
  await operation.cleanup();
  assert.ok(await readFile(path.join(directory, '.engram-operation.json')), 'interrupted evidence remains intact');
});

test('background-job quotas are isolated by vault scope and still cap one vault', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-job-scope-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_BACKGROUND_JOB_LIMIT: '1' };
  const first = await createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs', scope: '/vault/one' });
  const second = await createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs', scope: '/vault/two' });
  await assert.rejects(createOwnedOperation('intelligence-job', { env, quotaKind: 'background-jobs', scope: '/vault/one' }), /background job limit reached/);
  await first.cleanup(); await second.cleanup();
});

test('configured storage refuses a symlinked runtime path instead of writing outside the selected root', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-symlink-')); t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.engram-runtime'));
  await assert.rejects(ensureStorageDirectory('cache', { ENGRAM_DATA_DIR: root }), /symlink or non-directory/);
  assert.deepEqual(await readdir(outside), []);
});

test('owned operation creation refuses a symlinked operations directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-operation-symlink-')); t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'engram-operation-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root }, runtimeTemp = await ensureStorageDirectory('tmp', env);
  await symlink(outside, path.join(runtimeTemp, 'operations'));
  await assert.rejects(createOwnedOperation('unsafe', { env }), /unsafe Engram operation directory/);
  assert.deepEqual(await readdir(outside), []);
});

test('storage quota settings are validated and status reports logical bytes without scanning global tmp', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-status-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ENGRAM_DATA_DIR: root, ENGRAM_STORAGE_TEMP_QUOTA_BYTES: '4096', ENGRAM_STORAGE_BACKGROUND_JOB_LIMIT: '3' };
  assert.equal(storageQuota('temporary', env), 4096); assert.equal(storageQuota('background-jobs', env), 3);
  assert.throws(() => storageQuota('cache', { ENGRAM_STORAGE_CACHE_QUOTA_BYTES: 'not-a-number' }), /positive integer/);
  await writeFile(path.join(root, 'sample.txt'), 'abc');
  const status = await storageStatus(env) as { logicalBytes: Record<string, number | null>; quotas: Record<string, number>; quotaUsage: Record<string, { usedBytes: number | null; limit: number; utilization: number | null }>; filesystem: { availableBytes: number | null; hardQuota: boolean } };
  assert.equal(status.logicalBytes.vault, 3); assert.equal(status.quotas.temporary, 4096);
  assert.equal(status.quotaUsage.cache?.limit, status.quotas.cache); assert.equal(status.filesystem.hardQuota, false); assert.ok((status.filesystem.availableBytes ?? 0) > 0);
  const legacy = await storageStatus({}) as { logicalBytes: Record<string, number | null> };
  assert.equal(legacy.logicalBytes.tmp, null, 'the command must not recursively scan the system temp directory');
});

test('CLI exposes storage status, breakdown and report-only cleanup preview', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-storage-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  // The subprocess must not inherit an owner-level ENGRAM_* override that
  // intentionally points outside this disposable root. Verify that rejection
  // separately below instead of making the ordinary smoke test host-dependent.
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ENGRAM_')));
  const mdb = path.resolve('bin/mdb.js'), env = { ...isolated, ENGRAM_DATA_DIR: root } as NodeJS.ProcessEnv;
  for (const subcommand of ['status', 'breakdown', 'cleanup --dry-run']) {
    const args = ['storage', ...subcommand.split(' '), '--json'], result = spawnSync(process.execPath, [mdb, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `${subcommand}: ${result.stderr}`);
    const value = JSON.parse(result.stdout) as { deleted?: number; locations?: Record<string, string> };
    if (subcommand === 'cleanup --dry-run') assert.equal(value.deleted, 0);
    else assert.ok(value.locations?.cache?.startsWith(root));
  }
  const unsafe = spawnSync(process.execPath, [mdb, 'storage', 'cleanup', '--json'], { encoding: 'utf8', env });
  assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /report-only/);
  const escaped = spawnSync(process.execPath, [mdb, 'storage', 'status', '--json'], { encoding: 'utf8', env: { ...env, ENGRAM_USER_CONFIG: path.join(path.dirname(root), 'outside-user-config.json') } });
  assert.notEqual(escaped.status, 0); assert.match(escaped.stderr, /ENGRAM_USER_CONFIG must remain inside ENGRAM_DATA_DIR/);
});
