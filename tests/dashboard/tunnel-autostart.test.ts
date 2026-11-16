import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { controlOpenAIServices, ensureOpenAIServicesRunning, openAIAutoStart } from '../../packages/dashboard/openai-tunnel.js';
import { disposableVault } from './helpers.js';

/** Isolated HOME/XDG plus a fake launchctl that only records its arguments, so no real service is ever touched. */
async function isolatedServices(t: import('node:test').TestContext) {
  const vault = await disposableVault(), base = await mkdtemp(path.join(vault.root, 'home-')), bin = path.join(base, 'bin'), calls = path.join(base, 'calls.log');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`, { mode: 0o755 }); await chmod(path.join(bin, 'launchctl'), 0o755);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
  process.env.HOME = base; process.env.XDG_CONFIG_HOME = path.join(base, '.config'); process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  t.after(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(base, { recursive: true, force: true }); await vault.cleanup(); });
  return { vault, calls: async () => readFile(calls, 'utf8').catch(() => '') };
}

test('the tunnel starts by itself only when it is set up and the owner has not stopped it', async t => {
  const { vault, calls } = await isolatedServices(t);
  assert.equal(await openAIAutoStart(vault.root), true, 'automatic start is on by default');
  assert.equal((await ensureOpenAIServicesRunning(vault.root, vault.engram.vault, 'win32')).action, 'unsupported');
  const unconfigured = await ensureOpenAIServicesRunning(vault.root, vault.engram.vault, 'darwin');
  assert.equal(unconfigured.action, 'not-configured');
  assert.match(unconfigured.detail ?? '', /workspace row|tunnel ID|tunnel-client/);
  assert.equal(await calls(), '', 'nothing is started when setup is incomplete');

  await controlOpenAIServices(vault.root, 'stop', vault.engram.vault, 'darwin');
  assert.equal(await openAIAutoStart(vault.root), false, 'Stop is remembered');
  assert.match(await calls(), /bootout/);
  const before = await calls();
  assert.equal((await ensureOpenAIServicesRunning(vault.root, vault.engram.vault, 'darwin')).action, 'disabled');
  assert.equal(await calls(), before, 'a stopped tunnel is not brought back behind the owner\'s back');
});

test('a dashboard started with tunnel auto-start closes cleanly and leaves no timers behind', async t => {
  const { vault } = await isolatedServices(t);
  const { createDashboardServer } = await import('../../packages/dashboard/server.js');
  const dashboard = await createDashboardServer({ engram: vault.engram, idleMs: 60_000, autoStartTunnel: true });
  await dashboard.close();
});
