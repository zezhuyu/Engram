import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { manageClientService } from '../packages/cli/service.js';
import { spawnSync } from 'node:child_process';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mdb service test '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const bin = path.join(root, 'bin'); await fs.mkdir(home); await fs.mkdir(bin);
  const calls = path.join(root, 'calls');
  const fake = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *show*) printf 'LoadState=loaded\\nActiveState=active\\nMainPID=4321\\nExecMainStatus=0\\nResult=success\\n';; *print*) printf 'state = running\\npid = 4321\\nlast exit code = 0\\n';; esac\n`;
  for (const command of ['systemctl', 'launchctl', 'journalctl']) await fs.writeFile(path.join(bin, command), fake, { mode: 0o755 });
  const tokenFile = path.join(root, 'token'); await fs.writeFile(tokenFile, 'never-put-this-secret-in-a-unit\n', { mode: 0o600 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ENGRAM_AUTO_RECONNECT: '1' };
  return { root, home, bin, calls, tokenFile, env };
}

test('user daemon install is idempotent, private, supervised and removable without touching real home', async t => {
  const f = await fixture(t); const options = { action: 'install', platform: 'linux' as const, home: f.home, uid: 501, url: 'https://memory.example/mcp', tokenFile: f.tokenFile };
  const dry = await manageClientService({ ...options, dryRun: true }, f.env) as string;
  assert.match(dry, /Restart=on-failure/); assert.match(dry, /RestartSec=10/); assert.match(dry, /WantedBy=default.target/);
  assert.match(dry, /^\[Unit\]/); assert.match(dry, /^\[Service\]/m); assert.match(dry, /^\[Install\]/m); assert.match(dry, /service daemon --url/);
  assert.doesNotMatch(dry, /never-put-this-secret/);
  const { spawnSync } = await import('node:child_process');
  const analyzer = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (!analyzer.error && analyzer.status === 0) {
    const unitFixture = path.join(f.root, 'engram-outbox-watch.service'); await fs.writeFile(unitFixture, dry);
    const verified = spawnSync('systemd-analyze', ['verify', unitFixture], { encoding: 'utf8' }); assert.equal(verified.status, 0, verified.stderr);
  }
  await manageClientService(options, f.env);
  const unit = path.join(f.home, '.config/systemd/user/engram-outbox-watch.service');
  assert.equal((await fs.stat(unit)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(unit, 'utf8'), /never-put-this-secret/);
  const repeated = await manageClientService(options, f.env) as { changed: boolean };
  assert.equal(repeated.changed, false);
  const status = await manageClientService({ action: 'status', platform: 'linux', home: f.home, uid: 501 }, f.env) as { installed: boolean; loaded: boolean; running: boolean; pid: number; serverHost: string };
  assert.deepEqual({ installed: status.installed, loaded: status.loaded, running: status.running, pid: status.pid, serverHost: status.serverHost }, { installed: true, loaded: true, running: true, pid: 4321, serverHost: 'memory.example' });
  await manageClientService({ action: 'start', platform: 'linux', home: f.home, uid: 501 }, f.env);
  await manageClientService({ action: 'stop', platform: 'linux', home: f.home, uid: 501 }, f.env);
  const calls = await fs.readFile(f.calls, 'utf8'); assert.match(calls, /--user enable --now/); assert.match(calls, /--user start/); assert.match(calls, /--user stop/);
  await manageClientService({ action: 'uninstall', platform: 'linux', home: f.home, uid: 501 }, f.env);
  await assert.rejects(fs.access(unit));
});

test('macOS LaunchAgent definition is user scoped and root and opt-out are rejected', async t => {
  const f = await fixture(t); const common = { platform: 'macos' as const, home: f.home, uid: 501, url: 'https://memory.example/mcp', tokenFile: f.tokenFile };
  const text = await manageClientService({ ...common, action: 'install', dryRun: true }, f.env) as string;
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/); assert.match(text, /<key>KeepAlive<\/key><true\/>/); assert.match(text, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(text, /client-daemon\.log/); assert.doesNotMatch(text, /never-put-this-secret/);
  if (process.platform === 'darwin') {
    const out = path.join(f.root, 'unit.plist'); await fs.writeFile(out, text);
    const result = spawnSync('plutil', ['-lint', out], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  await manageClientService({ ...common, action: 'install' }, f.env);
  const plist = path.join(f.home, 'Library/LaunchAgents/dev.engram.outbox-watch.plist');
  assert.equal((await fs.stat(plist)).mode & 0o777, 0o600);
  const plistText = await fs.readFile(plist, 'utf8');
  assert.match(plistText, /<string>service<\/string><string>daemon<\/string>/);
  const installed = await manageClientService({ ...common, action: 'status' }, f.env) as { installed: boolean; loaded: boolean; running: boolean; pid: number };
  assert.deepEqual({ installed: installed.installed, loaded: installed.loaded, running: installed.running, pid: installed.pid }, { installed: true, loaded: true, running: true, pid: 4321 });
  await manageClientService({ ...common, action: 'start' }, f.env);
  await manageClientService({ ...common, action: 'stop' }, f.env);
  await manageClientService({ ...common, action: 'uninstall' }, f.env);
  await assert.rejects(fs.access(plist));
  const launchCalls = await fs.readFile(f.calls, 'utf8');
  assert.match(launchCalls, /bootstrap gui\/501/); assert.match(launchCalls, /kickstart -k/); assert.match(launchCalls, /bootout gui\/501/);
  await assert.rejects(manageClientService({ ...common, action: 'install', uid: 0 }, f.env), /refusing to manage.*root/);
  await assert.rejects(manageClientService({ ...common, action: 'install' }, { ...f.env, ENGRAM_AUTO_RECONNECT: '0' }), /disabled/);
});
