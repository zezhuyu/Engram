import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRoot } from '../packages/sdk/index.js';

const home = '/home/someone';
test('data directory resolution: configured ENGRAM_DATA_DIR confines --root; legacy fallback order remains stable', () => {
  assert.equal(resolveRoot(undefined, {}, home), join(home, '.Engram'));
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '', MDB_ROOT: '  ' }, home), join(home, '.Engram'), 'blank values are ignored');
  assert.equal(resolveRoot(undefined, { MDB_ROOT: '/legacy' }, home), '/legacy');
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '/data', MDB_ROOT: '/legacy' }, home), '/data');
  assert.throws(() => resolveRoot('/flag', { ENGRAM_DATA_DIR: '/data' }, home), /conflicts with ENGRAM_DATA_DIR/);
  assert.equal(resolveRoot('/data', { ENGRAM_DATA_DIR: '/data' }, home), '/data');
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '~/vaults/main' }, home), join(home, 'vaults/main'));
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '~' }, home), home);
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: 'relative/dir' }, home), resolve('relative/dir'));
});

test('CLI stores data under HOME/.Engram by default and under ENGRAM_DATA_DIR when set', async t => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'engram-home-')), custom = await mkdtemp(join(tmpdir(), 'engram-custom-'));
  t.after(() => Promise.all([rm(fakeHome, { recursive: true, force: true }), rm(custom, { recursive: true, force: true })]));
  const run = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [resolve('bin/mdb.js'), ...args, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: fakeHome, USERPROFILE: fakeHome, ...env } });
  const first = run({}, 'init', '--no-sqlite');
  assert.equal(first.status, 0, first.stderr);
  assert.ok((await stat(join(fakeHome, '.Engram', 'mdb.yaml'))).isFile());
  const second = run({ ENGRAM_DATA_DIR: custom }, 'init', '--no-sqlite');
  assert.equal(second.status, 0, second.stderr);
  assert.ok((await stat(join(custom, 'mdb.yaml'))).isFile());
  assert.equal(JSON.parse(run({ ENGRAM_DATA_DIR: custom }, 'doctor').stdout).root, custom);
  assert.equal(JSON.parse(run({}, 'doctor').stdout).root, join(fakeHome, '.Engram'));
  const rejected = run({ ENGRAM_DATA_DIR: custom }, 'init', '--no-sqlite', '--root', join(fakeHome, 'explicit'));
  assert.notEqual(rejected.status, 0, 'an explicit root cannot silently escape configured confinement');
  assert.match(rejected.stderr, /conflicts with ENGRAM_DATA_DIR/);
  const explicit = run({ ENGRAM_DATA_DIR: custom }, 'init', '--no-sqlite', '--root', custom);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.ok((await stat(join(custom, 'mdb.yaml'))).isFile(), 'an explicit root matching the configured root is accepted');
});
