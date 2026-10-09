import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRoot } from '../packages/sdk/index.js';

const home = '/home/someone';
test('data directory resolution: flag > ENGRAM_DATA_DIR > MDB_ROOT > ~/.Engram', () => {
  assert.equal(resolveRoot(undefined, {}, home), join(home, '.Engram'));
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '', MDB_ROOT: '  ' }, home), join(home, '.Engram'), 'blank values are ignored');
  assert.equal(resolveRoot(undefined, { MDB_ROOT: '/legacy' }, home), '/legacy');
  assert.equal(resolveRoot(undefined, { ENGRAM_DATA_DIR: '/data', MDB_ROOT: '/legacy' }, home), '/data');
  assert.equal(resolveRoot('/flag', { ENGRAM_DATA_DIR: '/data' }, home), '/flag');
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
  const explicit = run({ ENGRAM_DATA_DIR: custom }, 'init', '--no-sqlite', '--root', join(fakeHome, 'explicit'));
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.ok((await stat(join(fakeHome, 'explicit', 'mdb.yaml'))).isFile(), '--root overrides the environment variable');
});
