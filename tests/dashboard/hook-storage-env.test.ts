import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hookStorageEnv } from '../../packages/memory/user-config.js';
import { resolveStoragePath } from '../../packages/core/root.js';
import { disposableVault } from './helpers.js';

async function fakeHome(t: import('node:test').TestContext) {
  const vault = await disposableVault(), home = await mkdtemp(path.join(vault.root, 'home-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); await vault.cleanup(); });
  const place = async (env: NodeJS.ProcessEnv) => { const file = resolveStoragePath('config', env, home); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}'); };
  return { home, place };
}

test('a service without ENGRAM_DATA_DIR finds the capture config the shell hooks wrote under the default data directory', async t => {
  const { home, place } = await fakeHome(t), dataDir = path.join(home, '.Engram'), bare = { HOME: home } as NodeJS.ProcessEnv;
  assert.equal(await hookStorageEnv(bare, home), bare, 'nothing anywhere: unchanged');
  await place({ ENGRAM_DATA_DIR: dataDir });
  const found = await hookStorageEnv(bare, home);
  assert.equal(found.ENGRAM_DATA_DIR, dataDir);
  assert.equal(resolveStoragePath('config', found, home), path.join(dataDir, '.engram-runtime', 'config', 'user.json'));
  assert.equal(bare.ENGRAM_DATA_DIR, undefined, 'the caller environment is not modified');
});

test('explicit settings and an existing default-location config always win, and nothing is created', async t => {
  const { home, place } = await fakeHome(t), dataDir = path.join(home, '.Engram');
  await place({ ENGRAM_DATA_DIR: dataDir });
  const explicit = { HOME: home, ENGRAM_DATA_DIR: path.join(home, 'elsewhere') } as NodeJS.ProcessEnv;
  assert.equal(await hookStorageEnv(explicit, home), explicit);
  const userConfig = { HOME: home, ENGRAM_USER_CONFIG: path.join(home, 'custom.json') } as NodeJS.ProcessEnv;
  assert.equal(await hookStorageEnv(userConfig, home), userConfig);
  const bare = { HOME: home } as NodeJS.ProcessEnv;
  await place(bare);
  assert.equal(await hookStorageEnv(bare, home), bare, 'a config at the plain default location is used as is');
});
