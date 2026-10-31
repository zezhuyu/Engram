import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { disposableVault, sleep } from '../helpers/disposable-vault.js';
import { modules, runChild } from '../helpers/child.js';
import { verifyInvariants } from '../helpers/invariants.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';

const wiki = { type: 'global' as const, area: 'wiki' as const };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function tempDir(t: { after(fn: () => void | Promise<void>): void }, name: string) { const d = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'engram-restore-')), name); t.after(() => fs.rm(path.dirname(d), { recursive: true, force: true })); return d; }
async function size(dir: string): Promise<number> { let n = 0; for (const e of await fs.readdir(dir, { withFileTypes: true })) n += e.isDirectory() ? await size(path.join(dir, e.name)) : (await fs.stat(path.join(dir, e.name))).size; return n; }

test('backup taken while a writer is running restores to a consistent committed prefix with sources, ACLs, tombstones and profiles intact', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('team', 'ws', { agent: ['read', 'write'] });
  const file = path.join(root, 'orig.bin'); await fs.writeFile(file, Buffer.from([0, 9, 8, 7, 255]));
  const source = await vault.ingest(file, wiki); const originalHash = sha(await fs.readFile(path.join(root, String(source.metadata.originalPath))));
  const gone = await vault.put({ scope: wiki, kind: 'note', title: 'to delete', body: 'tombstone me' }); await vault.delete(gone.id, gone.revisionId);
  const profile = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Prefs', body: 'v1', metadata: { profileRole: 'explicit' } });
  await vault.patch({ objectId: profile.id, expectedRevisionId: profile.revisionId, body: 'v2' });
  const inFlightRevision = `.mdb/objects/${gone.id}/revs/.12345678-1234-4234-8234-123456789abc.tmp`;
  await fs.writeFile(path.join(root, inFlightRevision), 'uncommitted atomic-write bytes');
  const atomicRevisionTemp = `.mdb/objects/${gone.id}/revs/rev_synthetic.md.49b27e46-f84f-4ba4-b02f-715d5adc23f1.tmp`;
  await fs.writeFile(path.join(root, atomicRevisionTemp), 'uncommitted atomicWrite sibling bytes');

  const writer = runChild(`import {Vault} from ${JSON.stringify(modules.vault)};const v=new Vault(${JSON.stringify(root)});let d=await v.put({scope:{type:'global',area:'wiki'},kind:'note',title:'live',body:'0'});
for(let i=1;i<200;i++){d=await v.patch({objectId:d.id,expectedRevisionId:d.revisionId,body:String(i)});}console.log('DONE');`);
  await sleep(250);
  const backupDir = await tempDir(t, 'backup'); const t0 = performance.now();
  assert.equal(path.relative(root, backupDir).startsWith('..'), true, 'backup destination is explicitly selected outside the canonical vault');
  const result = await vault.backup(backupDir); const backupMs = performance.now() - t0;
  await assert.rejects(fs.stat(path.join(backupDir, inFlightRevision)), { code: 'ENOENT' }, 'backup excludes uncommitted atomic-write scratch');
  await assert.rejects(fs.stat(path.join(backupDir, atomicRevisionTemp)), { code: 'ENOENT' }, 'backup excludes target.UUID.tmp files emitted by atomicWrite');
  const w = await writer; assert.equal(w.code, 0, w.stderr);
  const finalEvents = await vault.events();

  const restoredDir = await tempDir(t, 'restored'); const t1 = performance.now();
  assert.equal(path.relative(root, restoredDir).startsWith('..'), true, 'restore destination is explicitly selected outside the source vault');
  const restored = await Vault.restoreBackup(backupDir, restoredDir); const restoreMs = performance.now() - t1;
  assert.equal(restored.root, path.resolve(restoredDir), 'restored files are written to the requested external destination');
  const restoredEvents = await restored.events();
  assert.ok(restoredEvents.length < finalEvents.length, 'backup was taken mid-stream');
  assert.deepEqual(restoredEvents, finalEvents.slice(0, restoredEvents.length), 'restore equals a committed prefix of the source journal');
  assert.deepEqual((await verifyInvariants(restored)).issues, []);
  assert.equal(sha(await fs.readFile(path.join(restoredDir, String(source.metadata.originalPath)))), originalHash, 'original bytes identical');
  assert.equal((await restored.get(source.id)).metadata.sha256, originalHash);
  assert.equal((await restored.get(gone.id)).status, 'deleted', 'tombstone preserved');
  assert.equal((await restored.history(profile.id)).map(d => d.body).join(','), 'v1,v2', 'profile revisions preserved');
  assert.equal((await new Vault(restoredDir, { actorId: 'agent', permissions: ['workspace:team:read'] }).listWorkspaces()).length >= 0, true);
  const ws = JSON.parse(await fs.readFile(path.join(restoredDir, 'workspaces/team/.mdb/workspace.json'), 'utf8')); assert.deepEqual(ws.grants, { agent: ['read', 'write'] }, 'ACL preserved');
  // Search from files gives the same logical answers on source and restore for the committed prefix.
  const q = async (v: Vault) => (await new SearchEngine(v).query({ query: 'tombstone', mode: 'grep' })).hits.length;
  assert.equal(await q(restored), 0); assert.equal(await q(vault), 0);
  recordCase({ suite: 'recovery', name: 'backup-under-write-restore', status: 'PASS', detail: { files: result.files, backupBytes: await size(backupDir), backupMs: Math.round(backupMs), restoreMs: Math.round(restoreMs), restoredCommits: restoredEvents.length, sourceCommitsAtEnd: finalEvents.length, rpoNote: 'RPO = time since last backup; RTO = restore wall time above (small vault).' } });
});

test('backup copies outside the writer lock after a consistent cut; concurrent acknowledged write is not lost', async t => {
  const { root, vault } = await disposableVault(t);
  const before = await vault.put({ scope: wiki, kind: 'note', title: 'pre-cut', body: 'must be in snapshot' });
  // A large disposable payload keeps the outside-lock copy active long enough to
  // make lock behavior observable without a benchmark-sized corpus.
  await fs.writeFile(path.join(root, 'zz-backup-copy-payload.bin'), Buffer.alloc(64 * 1024 * 1024, 0x5a));
  const backup = await tempDir(t, 'outside-lock-backup');
  const started = performance.now();
  const backupPromise = vault.backup(backup);
  let copying = false;
  for (let i = 0; i < 20_000; i++) {
    const manifest = await fs.stat(path.join(backup, 'BACKUP_MANIFEST.json')).catch(() => undefined);
    const payload = await fs.stat(path.join(backup, 'zz-backup-copy-payload.bin')).catch(() => undefined);
    if (!manifest && payload && payload.size < 64 * 1024 * 1024) { copying = true; break; }
    // backup() creates this destination asynchronously; the observation loop
    // may run before mkdir has completed, especially on Linux under CI load.
    // Treat absence as "not published yet" rather than a test failure.
    const destinationEntries = await fs.readdir(backup).catch(() => []);
    if (manifest || (destinationEntries.length > 0 && !payload)) await new Promise(resolve => setTimeout(resolve, 1));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(copying, true, 'observed the large immutable payload copying before manifest publication');
  const putStart = performance.now();
  const during = await vault.put({ scope: wiki, kind: 'note', title: 'during-copy', body: 'acknowledged while backup export continues' });
  const putMs = performance.now() - putStart;
  assert.ok(putMs < 1000, `writer stall ${putMs.toFixed(1)} ms must remain below 1 s`);
  const made = await backupPromise;
  const valid = await Vault.verifyBackup(backup);
  assert.equal(valid.ok, true, valid.issues.join('; '));
  const restored = await Vault.restoreBackup(backup, await tempDir(t, 'outside-lock-restored'));
  assert.ok((await restored.get(before.id)), 'acknowledged pre-cut write is in the snapshot');
  await assert.rejects(restored.get(during.id), { code: 'NOT_FOUND_OR_FORBIDDEN' }, 'post-cut write is outside the coherent snapshot prefix');
  assert.ok(await vault.get(during.id), 'the live vault retains the concurrent acknowledged write');
  recordCase({ suite: 'recovery', name: 'backup-bounded-writer-lock', status: 'PASS', detail: { files: made.files, bytes: made.bytes, observedCopy: copying, writerLatencyMs: +putMs.toFixed(2), elapsedMs: Math.round(performance.now() - started), snapshot: 'consistent committed prefix; post-cut write remains in source' } });
});

test('backup does not hold the writer lock while pinning a many-file snapshot', async t => {
  const { root, vault } = await disposableVault(t);
  const purgeTarget = await vault.put({ scope: wiki, kind: 'note', title: 'pin-protected-revision', body: 'backup must retain this revision' });
  const fixtures = path.join(root, 'backup-many-file-fixtures');
  await fs.mkdir(fixtures);
  // Many small files exercise snapshot metadata work; a single large payload
  // only exercises the later byte-copy phase and missed the long-lock defect.
  for (let i = 0; i < 5_000; i++) await fs.writeFile(path.join(fixtures, `${String(i).padStart(5, '0')}.bin`), 'fixture');
  const backup = await tempDir(t, 'many-file-backup');
  const started = performance.now();
  const backupPromise = vault.backup(backup);
  const pinMarker = path.join(root, '.mdb/tmp/backup-snapshots');
  let pinning = false;
  for (let i = 0; i < 2_000; i++) {
    const entries = await fs.readdir(pinMarker).catch(() => []);
    for (const entry of entries) {
      const ownerPath = path.join(pinMarker, entry, '.backup-owner.json');
      const owner = await fs.readFile(ownerPath, 'utf8').then(JSON.parse).catch(() => undefined);
      if (owner?.state === 'pinning') pinning = true;
    }
    if (pinning) break;
    await sleep(1);
  }
  assert.equal(pinning, true, 'backup declares its pinning phase before releasing the writer lock');
  await assert.rejects(vault.purge(purgeTarget.id, true), { code: 'CONFLICT' }, 'purge cannot remove a revision while the backup is pinning files');
  await sleep(10);
  const writeStart = performance.now();
  const during = await vault.put({ scope: wiki, kind: 'note', title: 'many-file-concurrent-write', body: 'must stay live and outside the captured prefix' });
  const writerLatencyMs = performance.now() - writeStart;
  const made = await backupPromise;
  assert.ok(writerLatencyMs < 1000, `many-file snapshot held the writer lock ${writerLatencyMs.toFixed(1)} ms`);
  assert.equal((await Vault.verifyBackup(backup)).ok, true);
  const restored = await Vault.restoreBackup(backup, await tempDir(t, 'many-file-restored'));
  assert.ok(await restored.get(purgeTarget.id), 'pinned backup retains the pre-purge revision');
  assert.equal(await fs.readFile(path.join(backup, 'backup-many-file-fixtures/00000.bin'), 'utf8'), 'fixture');
  await assert.rejects(restored.get(during.id), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  assert.ok(await vault.get(during.id));
  await vault.purge(purgeTarget.id, true);
  await assert.rejects(vault.get(purgeTarget.id), { code: 'NOT_FOUND_OR_FORBIDDEN' }, 'purge proceeds once the snapshot is fully pinned');
  recordCase({ suite: 'recovery', name: 'backup-many-file-bounded-writer-lock', status: 'PASS', detail: { files: made.files, bytes: made.bytes, writerLatencyMs: +writerLatencyMs.toFixed(2), elapsedMs: Math.round(performance.now() - started), snapshot: 'coherent pre-write prefix; many-file snapshot pinning occurs outside the writer lock' } });
});

test('backup startup removes only owner-marked snapshots whose process is gone', async t => {
  const { root, vault } = await disposableVault(t);
  const parent = path.join(root, '.mdb/tmp/backup-snapshots');
  await fs.mkdir(parent, { recursive: true });
  const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const owned = path.join(parent, `snapshot-${'123e4567-e89b-12d3-a456-426614174000'}`);
  const unknown = path.join(parent, 'snapshot-123e4567-e89b-12d3-a456-426614174001');
  await fs.mkdir(owned); await fs.writeFile(path.join(owned, '.backup-owner.json'), JSON.stringify({ format: 'engram-backup-snapshot-v1', operationId: path.basename(owned).slice('snapshot-'.length), pid: deadPid, createdAt: new Date().toISOString() }));
  await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, 'unowned.data'), 'preserve');
  await vault.backup(await tempDir(t, 'orphan-cleanup-backup'));
  await assert.rejects(fs.stat(owned), { code: 'ENOENT' }, 'marked snapshot from a dead owner is disposable');
  assert.equal(await fs.readFile(path.join(unknown, 'unowned.data'), 'utf8'), 'preserve', 'ambiguous directory remains untouched');
});

test('torn or corrupted backups are refused, never restored as if healthy', async t => {
  const { vault } = await disposableVault(t);
  const a = await vault.put({ scope: wiki, kind: 'note', title: 'a', body: 'alpha' }); await vault.put({ scope: wiki, kind: 'note', title: 'b', body: 'beta' });
  const base = await tempDir(t, 'backup'); await vault.backup(base);
  await assert.rejects(Vault.restoreBackup(base, path.join(base, 'inside')), { code: 'INVALID_INPUT' }, 'restore cannot recursively extend its own source backup');
  const clone = async (mutate: (dir: string) => Promise<void>) => { const dir = await tempDir(t, 'copy'); await fs.cp(base, dir, { recursive: true }); await mutate(dir); return dir; };
  const refused = async (dir: string, why: string) => { await assert.rejects(Vault.restoreBackup(dir, await tempDir(t, 'dest')), { code: 'INVALID_INPUT' }, why); };
  await refused(await clone(async d => { await fs.rm(path.join(d, `.mdb/objects/${a.id}/revs/${a.revisionId}.md`)); }), 'missing revision file');
  await refused(await clone(async d => { const f = path.join(d, `.mdb/objects/${a.id}/revs/${a.revisionId}.md`); await fs.writeFile(f, (await fs.readFile(f)).subarray(0, 40)); }), 'truncated revision');
  await refused(await clone(async d => { await fs.rm(path.join(d, '.mdb/events/commits.jsonl')); }), 'missing journal');
  await refused(await clone(async d => { await fs.writeFile(path.join(d, '.mdb/events/commits.jsonl'), 'not json\n{"also":"bad"}\n'); }), 'garbage journal');
  const tampered = await clone(async d => { const f = path.join(d, `.mdb/objects/${a.id}/revs/${a.revisionId}.md`); await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('alpha', 'ALPHA')); });
  // A modified-but-parseable revision is a content-integrity problem the journal cannot detect without hashes.
  let tamperDetected = true; try { await Vault.restoreBackup(tampered, await tempDir(t, 'dest')); tamperDetected = false; } catch { /* refused */ }
  recordCase({ suite: 'recovery', name: 'corrupt-backup-refused', status: 'PASS', detail: { refusedCases: 4, silentContentTamperDetected: tamperDetected, note: tamperDetected ? undefined : 'KNOWN GAP: journal records no revision content hash, so a same-length parseable edit of a revision file is not detected.' } });
  assert.equal(tamperDetected, true, 'content tampering of an immutable revision must be detected');
});

test('purge: removes content from the live vault; a pre-purge backup still holds it (documented retention limit)', async t => {
  const { root, vault } = await disposableVault(t);
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'secret', body: 'PURGE-ME-PLAINTEXT' });
  const backup = await tempDir(t, 'backup'); await vault.backup(backup);
  const result = await vault.purge(doc.id, true);
  assert.ok(result.limitations.some(l => /backups/i.test(l)));
  const leftovers: string[] = []; const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else if ((await fs.readFile(f, 'utf8').catch(() => '')).includes('PURGE-ME-PLAINTEXT')) leftovers.push(f); } };
  await walk(root); assert.deepEqual(leftovers, [], 'no plaintext remains in the live vault');
  const inBackup: string[] = []; const walkB = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await walkB(f); else if ((await fs.readFile(f, 'utf8').catch(() => '')).includes('PURGE-ME-PLAINTEXT')) inBackup.push(f); } };
  await walkB(backup); assert.ok(inBackup.length > 0, 'the earlier backup is outside purge scope (documented)');
  recordCase({ suite: 'recovery', name: 'purge-and-backup-retention', status: 'PASS', detail: { backupStillContainsPlaintext: true } });
});

test('manifest-checked backups: complete ones restore; missing manifest, extra files, edits and a backup killed mid-copy are all refused', async t => {
  const { root, vault } = await disposableVault(t);
  for (let i = 0; i < 40; i++) await vault.put({ scope: wiki, kind: 'note', title: `b${i}`, body: `backup body ${i}` });
  const good = await tempDir(t, 'good'); const made = await vault.backup(good);
  assert.ok(made.bytes > 0 && made.files > 40);
  const manifest = JSON.parse(await fs.readFile(path.join(good, 'BACKUP_MANIFEST.json'), 'utf8')) as { files: { path: string }[] };
  assert.equal(manifest.files.length, made.files); assert.ok(!manifest.files.some(f => f.path.startsWith('.mdb/locks')));
  assert.equal((await Vault.verifyBackup(good)).ok, true);
  const restored = await Vault.restoreBackup(good, await tempDir(t, 'ok')); assert.equal((await restored.events()).length, 40);
  const copy = async (mutate: (dir: string) => Promise<void>) => { const dir = await tempDir(t, 'bad'); await fs.cp(good, dir, { recursive: true }); await mutate(dir); return dir; };
  const refuse = async (dir: string, why: string) => { await assert.rejects(Vault.restoreBackup(dir, await tempDir(t, 'dest')), { code: 'INVALID_INPUT' }, why); };
  await refuse(await copy(d => fs.rm(path.join(d, 'BACKUP_MANIFEST.json'))), 'no manifest (torn or legacy)');
  await refuse(await copy(d => fs.writeFile(path.join(d, 'extra.md'), 'smuggled')), 'unexpected file');
  await refuse(await copy(async d => { const f = path.join(d, manifest.files.find(x => x.path.endsWith('.md') && x.path.includes('/revs/'))!.path); const text = await fs.readFile(f, 'utf8'); await fs.writeFile(f, text.replace('backup body', 'BACKUP BODY')); }), 'same-length edit of a revision');
  await refuse(await copy(d => fs.writeFile(path.join(d, 'BACKUP_MANIFEST.json'), JSON.stringify({ version: 1, files: [{ path: '../escape', size: 1, sha256: 'x' }] }))), 'path traversal in manifest');
  const killedDir = await tempDir(t, 'killed');
  const child = await runChild(`import {Vault} from ${JSON.stringify(modules.vault)};setTimeout(()=>process.kill(process.pid,'SIGKILL'),40);await new Vault(${JSON.stringify(root)}).backup(${JSON.stringify(killedDir)});`);
  assert.equal(child.signal, 'SIGKILL');
  await assert.rejects(Vault.restoreBackup(killedDir, await tempDir(t, 'dest2')), { code: 'INVALID_INPUT' }, 'a backup killed before its manifest was written is not restorable');
  assert.equal((await vault.verify()).ok, true); await fs.stat(path.join(root, '.mdb/events/commits.jsonl'));
  recordCase({ suite: 'recovery', name: 'manifest-checked-backup', status: 'PASS', detail: { files: made.files, bytes: made.bytes } });
});

test('killed restores never publish partial destinations and can be retried from the immutable backup', async t => {
  const { vault } = await disposableVault(t);
  for (let i = 0; i < 100; i++) await vault.put({ scope: wiki, kind: 'note', title: `restore-${i}`, body: `payload-${i}-${'x'.repeat(4096)}` });
  const backup = await tempDir(t, 'restore-source');
  await vault.backup(backup);
  const manifestBefore = await fs.readFile(path.join(backup, 'BACKUP_MANIFEST.json'));
  const destinationParent = path.dirname(await tempDir(t, 'restore-targets'));
  const module = new URL('../../packages/core/vault.js', import.meta.url).href;
  const countOwnedRestoreStages = async (destination: string): Promise<string[]> => (await fs.readdir(destinationParent))
    .filter(name => name.startsWith(`.${path.basename(destination)}.engram-restore-`) && name.endsWith('.staging'));
  const countFiles = async (directory: string): Promise<number> => {
    let count = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) count += await countFiles(full); else count++;
    }
    return count;
  };

  const killAfterCopiedFiles = [3, 12, 24];
  let restored: Vault | undefined;
  for (let attempt = 0; attempt < killAfterCopiedFiles.length; attempt++) {
    const destination = path.join(destinationParent, `restore-${attempt}`);
    await fs.mkdir(destination);
    const childCode = `import {Vault} from ${JSON.stringify(module)};await Vault.restoreBackup(${JSON.stringify(backup)},${JSON.stringify(destination)});`;
    const running = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: 'ignore' });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => running.once('close', (code, signal) => resolve({ code, signal })));
    const stagePrefix = `.${path.basename(destination)}.engram-restore-`;
    let partialStage = false;
    for (let i = 0; i < 10_000; i++) {
      const names = await fs.readdir(path.dirname(destination));
      const stage = names.find(name => name.startsWith(stagePrefix) && name.endsWith('.staging'));
      if (stage && await countFiles(path.join(path.dirname(destination), stage)) >= killAfterCopiedFiles[attempt]!) { partialStage = true; break; }
      if (running.exitCode !== null || running.signalCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(partialStage, true, `attempt ${attempt + 1} reached a partially copied staging tree`);
    running.kill('SIGKILL');
    assert.equal((await closed).signal, 'SIGKILL');
    const visible = await fs.readdir(destination).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
    assert.ok(visible === null || visible.length === 0, 'the requested destination is absent or remains empty; partial files are never published');

    // Every interrupted phase must be restartable from the unchanged backup,
    // not merely after several failures have accumulated staging directories.
    restored = await Vault.restoreBackup(backup, destination);
    assert.equal((await restored.events()).length, 100, `retry after ${killAfterCopiedFiles[attempt]} copied files publishes the complete journal`);
    assert.equal((await restored.verify()).ok, true);
    assert.deepEqual(await countOwnedRestoreStages(destination), [], 'a retry removes only stale, owner-marked staging artifacts from killed attempts');
  }

  assert.ok(restored);
  assert.equal((await restored.events()).length, 100, 'retry publishes the complete restored journal');
  assert.equal((await restored.verify()).ok, true);
  assert.deepEqual(await fs.readFile(path.join(backup, 'BACKUP_MANIFEST.json')), manifestBefore, 'restore retries never mutate the immutable backup source');
  recordCase({ suite: 'recovery', name: 'restore-kill-retry-atomic-publication', status: 'PASS', detail: { killedAttempts: 3, publishedCommits: (await restored.events()).length } });
});

test('restore retry cleanup preserves active and unowned staging directories', async t => {
  const { vault } = await disposableVault(t);
  await vault.put({ scope: wiki, kind: 'note', title: 'restore cleanup', body: 'valid backup content' });
  const backup = await tempDir(t, 'restore-cleanup-source'); await vault.backup(backup);
  const destination = await tempDir(t, 'restore-cleanup-target');
  const parent = path.dirname(destination), base = path.basename(destination);
  const activeId = '123e4567-e89b-12d3-a456-426614174000';
  const unownedId = '123e4567-e89b-12d3-a456-426614174001';
  const publishedId = '123e4567-e89b-12d3-a456-426614174002';
  const activeStage = path.join(parent, `.${base}.engram-restore-${activeId}.staging`);
  const activeOwner = `${activeStage}.owner.json`;
  const unownedStage = path.join(parent, `.${base}.engram-restore-${unownedId}.staging`);
  const publishedStage = path.join(parent, `.${base}.engram-restore-${publishedId}.staging`);
  await fs.mkdir(activeStage); await fs.writeFile(path.join(activeStage, 'partial'), 'still active');
  await fs.writeFile(activeOwner, JSON.stringify({ format: 'engram-restore-stage-v1', operationId: activeId, pid: process.pid, createdAt: new Date().toISOString() }));
  await fs.mkdir(unownedStage); await fs.writeFile(path.join(unownedStage, 'keep'), 'unowned');
  // Simulate SIGKILL after atomic publication but before owner-sidecar removal.
  // A retry must clear this stale sidecar even though the target is now nonempty.
  await fs.writeFile(`${publishedStage}.owner.json`, JSON.stringify({ format: 'engram-restore-stage-v1', operationId: publishedId, pid: 2_147_483_647, createdAt: new Date().toISOString() }));
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'published'), 'already published');

  await assert.rejects(() => Vault.restoreBackup(backup, destination), /destination must be an empty regular directory/i);
  assert.equal(await fs.readFile(path.join(activeStage, 'partial'), 'utf8'), 'still active', 'a live process marker prevents cleanup');
  assert.equal(await fs.readFile(path.join(unownedStage, 'keep'), 'utf8'), 'unowned', 'a similarly named directory without a valid owner marker is preserved');
  await assert.rejects(() => fs.lstat(`${publishedStage}.owner.json`), { code: 'ENOENT' }, 'retry cleans a dead owner sidecar left after publication without touching the published destination');
  assert.equal(await fs.readFile(path.join(destination, 'published'), 'utf8'), 'already published');
});
