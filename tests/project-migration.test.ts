import './helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';

test('project migration helper gates apply, backs up/verifies targets, and rolls back a temp project', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'engram-project-migration-')); t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'sample'); await mkdir(project);
  await writeFile(path.join(project, 'CLAUDE.md'), '# Owner rules\n');
  const vault = path.join(base, 'vault'), backupRoot = path.join(base, 'backups');
  const env = { ...process.env, ENGRAM_DATA_DIR: vault, HOME: base, XDG_CONFIG_HOME: path.join(base, '.config'), ENGRAM_TRUST_FILE: path.join(base, '.config/trusted.json'), ENGRAM_CODEX_PROBE: '0' };
  const helper = resolve('scripts/project-migration.mjs');
  const invoke = (...argsAndStatus: Array<string | number>) => {
    const expectedStatus = typeof argsAndStatus.at(-1) === 'number' ? Number(argsAndStatus.pop()) : 0;
    const args = argsAndStatus as string[];
    const result = spawnSync(process.execPath, [helper, '--project-dir', project, '--workspace', 'sample', '--hosts', 'claude-code', '--backup-root', backupRoot, ...args], { cwd: resolve('.'), env, encoding: 'utf8' });
    assert.equal(result.status, expectedStatus, result.stderr); return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  };
  const preview = invoke(); assert.equal(preview.applyRequired, true);
  assert.equal(await readFile(path.join(project, 'CLAUDE.md'), 'utf8'), '# Owner rules\n', 'preview does not edit the project');
  const backup = String(preview.backup);
  assert.match(await readFile(path.join(backup, 'SHA256SUMS'), 'utf8'), /CLAUDE\.md/);
  const applied = invoke('--apply'); assert.equal(applied.applied, true); assert.equal(applied.workspace, 'sample');
  assert.match(applied.instructionDiffs['CLAUDE.md'], /managed-version=3/);
  assert.match(await readFile(path.join(project, 'CLAUDE.md'), 'utf8'), /managed-version=3/);
  await mkdir(path.join(project, '.omx/logs'), { recursive: true });
  await writeFile(path.join(project, 'outside-change.txt'), 'changed after apply');
  await writeFile(path.join(project, '.omx/logs/runtime.log'), 'volatile after apply');
  const rolledBack = invoke('--rollback', '--backup-dir', backup, 1); assert.equal(rolledBack.rollback, 'complete');
  assert.deepEqual(rolledBack.manifestDifferences, ['outside-change.txt']);
  assert.equal(rolledBack.runtimeIgnoredChanged, 1);
  assert.equal(await readFile(path.join(project, 'CLAUDE.md'), 'utf8'), '# Owner rules\n');
  assert.deepEqual(await readdir(project), ['.omx', 'CLAUDE.md', 'outside-change.txt']);
});

test('project migration streams a sparse >1 GiB file and reports hashing and ignore policy', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'engram-project-migration-large-')); t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'large'); await mkdir(path.join(project, '.omx/state'), { recursive: true });
  await writeFile(path.join(project, 'CLAUDE.md'), '# owner\n');
  const sparse = path.join(project, 'payload.bin'); await writeFile(sparse, Buffer.alloc(1)); await truncate(sparse, 1024 ** 3 + 17);
  await writeFile(path.join(project, '.omx/state/runtime.json'), 'changing runtime state');
  const result = spawnSync(process.execPath, [resolve('scripts/project-migration.mjs'), '--project-dir', project, '--workspace', 'large', '--hosts', 'claude-code', '--backup-root', path.join(base, 'backups'), '--size-cap', String(2 * 1024 ** 3), '--hash-limit-mb', '2048'], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  assert.ok(report.manifestStats.hashedBytes >= 1024 ** 3);
  assert.ok(report.manifestStats.streamedChunks > 1024, 'the sparse file was consumed in bounded 1 MiB streaming chunks');
  assert.ok(report.manifestStats.elapsedMs >= 0);
  assert.ok(report.runtimeIgnored.includes('.omx/state/**'));
  assert.equal(report.manifestStats.runtimeIgnored.length, 1);
});

test('project migration handles symlinks, ignore changes, help, and unknown flags', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'engram-project-migration-flags-')); t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'flags'); await mkdir(path.join(project, '.omx/logs'), { recursive: true });
  await mkdir(path.join(project, '.git/objects/aa'), { recursive: true }); await mkdir(path.join(project, '.git/refs/heads'), { recursive: true });
  await writeFile(path.join(project, 'CLAUDE.md'), '# owner\n'); await writeFile(path.join(project, 'source.txt'), 'source');
  await writeFile(path.join(project, '.git/HEAD'), 'ref: refs/heads/main\n'); await writeFile(path.join(project, '.git/refs/heads/main'), 'commit-id');
  await writeFile(path.join(project, '.git/objects/aa/commit'), 'object');
  await symlink('source.txt', path.join(project, 'source-link'));
  await writeFile(path.join(project, '.omx/logs/run.log'), 'one');
  const common = [resolve('scripts/project-migration.mjs'), '--project-dir', project, '--workspace', 'flags', '--hosts', 'claude-code', '--backup-root', path.join(base, 'backups')];
  const preview = spawnSync(process.execPath, common, { cwd: resolve('.'), encoding: 'utf8' }); assert.equal(preview.status, 0, preview.stderr);
  const report = JSON.parse(preview.stdout.trim().split('\n').at(-1)!);
  const manifest = JSON.parse(await readFile(path.join(report.backup, 'integrity-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files['source-link'], { type: 'symlink', target: 'source.txt' });
  assert.ok(manifest.files['.git/HEAD']); assert.ok(manifest.files['.git/refs/heads/main']);
  assert.equal(manifest.files['.git/objects/aa/commit'], undefined); assert.equal(manifest.stats.skippedDirs['.git/objects'], 1);
  assert.equal(manifest.stats.runtimeIgnored.length, 1);
  const help = spawnSync(process.execPath, [resolve('scripts/project-migration.mjs'), '--help'], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /--runtime-ignore/); assert.match(help.stdout, /Backup layout/);
  const unknown = spawnSync(process.execPath, [resolve('scripts/project-migration.mjs'), '--wat'], { cwd: resolve('.'), encoding: 'utf8' });
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /^Unknown flag: --wat\. Use --help/); assert.doesNotMatch(unknown.stderr, /at file:/);
});

test('project migration enforces size cap and supports extra runtime-ignore globs', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'engram-project-migration-cap-')); t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'cap'); await mkdir(project); await writeFile(path.join(project, 'CLAUDE.md'), '# owner\n'); await writeFile(path.join(project, 'scratch.tmp'), 'temporary');
  const common = [resolve('scripts/project-migration.mjs'), '--project-dir', project, '--workspace', 'cap', '--hosts', 'claude-code', '--backup-root', path.join(base, 'backups')];
  const capped = spawnSync(process.execPath, [...common, '--size-cap', '2'], { cwd: resolve('.'), encoding: 'utf8' });
  assert.notEqual(capped.status, 0); assert.match(capped.stderr, /exceeds --size-cap/);
  const ignored = spawnSync(process.execPath, [...common, '--runtime-ignore', '*.tmp'], { cwd: resolve('.'), encoding: 'utf8' }); assert.equal(ignored.status, 0, ignored.stderr);
  const report = JSON.parse(ignored.stdout.trim().split('\n').at(-1)!); assert.ok(report.runtimeIgnored.includes('*.tmp'));
  const manifest = JSON.parse(await readFile(path.join(report.backup, 'integrity-manifest.json'), 'utf8'));
  assert.equal(manifest.stats.runtimeIgnored[0], 'scratch.tmp');
});
