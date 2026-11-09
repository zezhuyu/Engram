import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { dashboardUrl, manageClientService } from '../packages/cli/service.js';
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

test('dashboard-url safely returns first-time client links only from private notes and rewrites server links to loopback', async t => {
  const f = await fixture(t);
  const note = path.join(f.root, 'dashboard-note.txt');
  const token = 'a'.repeat(64);
  const clientNote = (password: 'set' | 'not set', url = `http://127.0.0.1:4872/#t=${token}`) => `Dashboard password: ${password}\n${url}\n`;
  const writeNote = async (text: string, mode = 0o600) => fs.writeFile(note, text, { mode }).then(() => fs.chmod(note, mode));
  const readClient = () => dashboardUrl({ home: f.home, noteFile: note }, { ...f.env, HOME: f.home });
  await writeNote(clientNote('not set'));
  const setup = await readClient();
  assert.deepEqual(setup, { url: `http://127.0.0.1:4872/#t=${token}`, firstTimeSetup: true, passwordSet: false, port: 4872, noteAvailable: true });
  assert.equal(JSON.stringify({ ...setup, url: undefined }).includes(token), false);
  const cli = spawnSync(process.execPath, [path.resolve('bin/mdb.js'), 'service', 'dashboard-url', '--home', f.home, '--note-file', note], { encoding: 'utf8', env: { ...f.env, HOME: f.home } });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout) as typeof setup;
  assert.equal(cliResult.url, setup.url);
  assert.doesNotMatch(cli.stderr, new RegExp(token));
  assert.equal(JSON.stringify({ ...cliResult, url: undefined }).includes(token), false);
  await writeNote(clientNote('set'));
  assert.deepEqual(await readClient(), { url: 'http://127.0.0.1:4872/', firstTimeSetup: false, passwordSet: true, port: 4872, noteAvailable: true });

  await fs.rm(note);
  assert.deepEqual(await readClient(), { url: 'http://127.0.0.1:4872/', firstTimeSetup: false, passwordSet: false, port: 4872, noteAvailable: false });
  await writeNote('');
  assert.equal((await readClient()).noteAvailable, false);
  await writeNote(clientNote('not set'), 0o644);
  assert.equal((await readClient()).noteAvailable, false);
  await fs.rm(note); await fs.symlink(path.join(f.root, 'target'), note);
  assert.equal((await readClient()).noteAvailable, false);
  await writeNote(clientNote('not set') + 'x'.repeat(65 * 1024));
  assert.equal((await readClient()).noteAvailable, false);
  await writeNote(clientNote('not set'));
  const stoppedBin = path.join(f.root, 'stopped-bin'); await fs.mkdir(stoppedBin);
  await fs.writeFile(path.join(stoppedBin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await dashboardUrl({ home: f.home, noteFile: note, platform: 'macos' }, { ...f.env, PATH: `${stoppedBin}:${f.env.PATH}` }), { url: 'http://127.0.0.1:4872/', firstTimeSetup: false, passwordSet: false, port: 4872, noteAvailable: false });
  for (const bad of ['http://localhost:4872/#t=' + token, 'http://127.0.0.1:4871/#t=' + token, 'https://127.0.0.1:4872/#t=' + token]) {
    await writeNote(clientNote('not set', bad));
    const ignored = await readClient();
    assert.equal(ignored.url, 'http://127.0.0.1:4872/');
    assert.equal(ignored.firstTimeSetup, false);
    assert.equal(ignored.noteAvailable, false);
  }

  const serverNote = path.join(f.root, 'server-dashboard.txt');
  await fs.writeFile(serverNote, `Dashboard password: not set\nhttp://192.168.1.20:4871/#t=${token}\n`, { mode: 0o600 });
  await fs.mkdir(path.join(f.home, '.config/engram'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.config/engram/server.env'), 'ENGRAM_DASHBOARD_PORT=4871\n', { mode: 0o600 });
  const server = await dashboardUrl({ role: 'server', home: f.home, noteFile: serverNote }, { ...f.env, HOME: f.home });
  assert.deepEqual(server, { url: `http://127.0.0.1:4871/#t=${token}`, firstTimeSetup: true, passwordSet: false, port: 4871, noteAvailable: true });
  assert.equal(JSON.stringify({ ...server, url: undefined }).includes(token), false);
});

test('user daemon install supervises both units, is idempotent, private and removable without touching real home', async t => {
  const f = await fixture(t); const options = { action: 'install', platform: 'linux' as const, home: f.home, uid: 501, url: 'https://memory.example/mcp', tokenFile: f.tokenFile };
  const dryResult = await manageClientService({ ...options, dryRun: true }, f.env) as string;
  const dry = JSON.parse(dryResult) as { outbox: string; clientDashboard: string; launcher: string };
  assert.match(dry.outbox, /Restart=on-failure/); assert.match(dry.outbox, /RestartSec=10/); assert.match(dry.outbox, /WantedBy=default.target/);
  assert.match(dry.outbox, /^\[Unit\]/); assert.match(dry.outbox, /^\[Service\]/m); assert.match(dry.outbox, /^\[Install\]/m); assert.match(dry.outbox, /service daemon --url/);
  assert.doesNotMatch(dry.outbox, /never-put-this-secret/);
  assert.match(dry.clientDashboard, /engram-client-dashboard\.service/);
  assert.match(dry.clientDashboard, /Restart=on-failure/); assert.match(dry.clientDashboard, /RestartSec=10/);
  assert.match(dry.launcher, /127\.0\.0\.1 --port 4872/); assert.match(dry.launcher, /umask 077/); assert.match(dry.launcher, /client-dashboard\.txt/); assert.match(dry.launcher, /client-dashboard\.log/);
  const { spawnSync } = await import('node:child_process');
  const analyzer = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (!analyzer.error && analyzer.status === 0) {
    const unitFixture = path.join(f.root, 'engram-outbox-watch.service'); await fs.writeFile(unitFixture, dry.outbox);
    const verified = spawnSync('systemd-analyze', ['verify', unitFixture], { encoding: 'utf8' }); assert.equal(verified.status, 0, verified.stderr);
    const dashboardFixture = path.join(f.root, 'engram-client-dashboard.service'); await fs.writeFile(dashboardFixture, dry.clientDashboard);
    const dashboardVerified = spawnSync('systemd-analyze', ['verify', dashboardFixture], { encoding: 'utf8' }); assert.equal(dashboardVerified.status, 0, dashboardVerified.stderr);
  }
  await manageClientService(options, f.env);
  const unit = path.join(f.home, '.config/systemd/user/engram-outbox-watch.service');
  const dashboardUnit = path.join(f.home, '.config/systemd/user/engram-client-dashboard.service');
  const wrapper = path.join(f.home, '.config/systemd/user/engram-client-dashboard.sh');
  assert.equal((await fs.stat(unit)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(unit, 'utf8'), /never-put-this-secret/);
  assert.equal((await fs.stat(dashboardUnit)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(wrapper)).mode & 0o777, 0o700);
  assert.match(await fs.readFile(wrapper, 'utf8'), /127\.0\.0\.1 --port 4872/);
  const repeated = await manageClientService(options, f.env) as { changed: boolean };
  assert.equal(repeated.changed, false);
  const enableCalls = (await fs.readFile(f.calls, 'utf8')).match(/enable --now/g) ?? [];
  assert.equal(enableCalls.length, 2, 'identical install must not re-run enable/start when both services already run');
  const status = await manageClientService({ action: 'status', platform: 'linux', home: f.home, uid: 501 }, f.env) as { installed: boolean; loaded: boolean; running: boolean; pid: number; serverHost: string; clientDashboard: { installed: boolean; loaded: boolean; running: boolean; port: number } };
  assert.deepEqual({ installed: status.installed, loaded: status.loaded, running: status.running, pid: status.pid, serverHost: status.serverHost }, { installed: true, loaded: true, running: true, pid: 4321, serverHost: 'memory.example' });
  assert.deepEqual(status.clientDashboard, { installed: true, loaded: true, running: true, pid: 4321, lastExit: '0', port: 4872, host: '127.0.0.1' });
  await manageClientService({ action: 'start', platform: 'linux', home: f.home, uid: 501 }, f.env);
  await manageClientService({ action: 'stop', platform: 'linux', home: f.home, uid: 501 }, f.env);
  const calls = await fs.readFile(f.calls, 'utf8'); assert.match(calls, /--user enable --now/); assert.match(calls, /--user start/); assert.match(calls, /--user stop/);
  await manageClientService({ action: 'uninstall', platform: 'linux', home: f.home, uid: 501 }, f.env);
  await assert.rejects(fs.access(unit));
  await assert.rejects(fs.access(dashboardUnit)); await assert.rejects(fs.access(wrapper));
});

test('macOS LaunchAgent definition is user scoped and root and opt-out are rejected', async t => {
  const f = await fixture(t); const common = { platform: 'macos' as const, home: f.home, uid: 501, url: 'https://memory.example/mcp', tokenFile: f.tokenFile };
  const dry = JSON.parse(await manageClientService({ ...common, action: 'install', dryRun: true }, f.env) as string) as { outbox: string; clientDashboard: string; launcher: string };
  const text = dry.outbox;
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/); assert.match(text, /<key>KeepAlive<\/key><true\/>/); assert.match(text, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(text, /client-daemon\.log/); assert.doesNotMatch(text, /never-put-this-secret/);
  assert.match(dry.clientDashboard, /dev\.engram\.client-dashboard/);
  assert.match(dry.launcher, /umask 077/); assert.match(dry.launcher, /client-dashboard\.txt/);
  if (process.platform === 'darwin') {
    const out = path.join(f.root, 'unit.plist'); await fs.writeFile(out, text);
    const result = spawnSync('plutil', ['-lint', out], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    const dashboardOut = path.join(f.root, 'dashboard.plist'); await fs.writeFile(dashboardOut, dry.clientDashboard);
    const dashboardResult = spawnSync('plutil', ['-lint', dashboardOut], { encoding: 'utf8' }); assert.equal(dashboardResult.status, 0, dashboardResult.stderr);
  }
  await manageClientService({ ...common, action: 'install' }, f.env);
  const plist = path.join(f.home, 'Library/LaunchAgents/dev.engram.outbox-watch.plist');
  const dashboardPlist = path.join(f.home, 'Library/LaunchAgents/dev.engram.client-dashboard.plist');
  const wrapper = path.join(f.home, 'Library/LaunchAgents/engram-client-dashboard.sh');
  assert.equal((await fs.stat(plist)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dashboardPlist)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(wrapper)).mode & 0o777, 0o700);
  const plistText = await fs.readFile(plist, 'utf8');
  assert.match(plistText, /<string>service<\/string><string>daemon<\/string>/);
  const installed = await manageClientService({ ...common, action: 'status' }, f.env) as { installed: boolean; loaded: boolean; running: boolean; pid: number; clientDashboard: { running: boolean; port: number } };
  assert.deepEqual({ installed: installed.installed, loaded: installed.loaded, running: installed.running, pid: installed.pid }, { installed: true, loaded: true, running: true, pid: 4321 });
  assert.equal(installed.clientDashboard.running, true); assert.equal(installed.clientDashboard.port, 4872);
  await manageClientService({ ...common, action: 'start' }, f.env);
  await manageClientService({ ...common, action: 'stop' }, f.env);
  await manageClientService({ ...common, action: 'uninstall' }, f.env);
  await assert.rejects(fs.access(plist));
  await assert.rejects(fs.access(dashboardPlist)); await assert.rejects(fs.access(wrapper));
  const launchCalls = await fs.readFile(f.calls, 'utf8');
  assert.match(launchCalls, /bootstrap gui\/501/); assert.match(launchCalls, /kickstart -k/); assert.match(launchCalls, /bootout gui\/501/);
  await assert.rejects(manageClientService({ ...common, action: 'install', uid: 0 }, f.env), /refusing to manage.*root/);
  await assert.rejects(manageClientService({ ...common, action: 'install' }, { ...f.env, ENGRAM_AUTO_RECONNECT: '0' }), /disabled/);
});

test('client dashboard port comes from client.env or environment and port changes require reinstall', async t => {
  const f = await fixture(t), options = { action: 'install', platform: 'linux' as const, home: f.home, uid: 501, url: 'https://memory.example/mcp', tokenFile: f.tokenFile };
  const unit = path.join(f.home, '.config/systemd/user/engram-outbox-watch.service');
  const envFile = path.join(f.home, '.config/engram/client.env'); await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, 'ENGRAM_CLIENT_DASHBOARD_PORT=4897\n', { mode: 0o600 });
  const dry = JSON.parse(await manageClientService({ ...options, dryRun: true }, f.env) as string) as { clientDashboard: string; launcher: string };
  assert.match(dry.launcher, /--port 4897/);
  await manageClientService(options, f.env);
  const envOverride = { ...f.env, ENGRAM_CLIENT_DASHBOARD_PORT: '4898' };
  const overridden = JSON.parse(await manageClientService({ ...options, dryRun: true }, envOverride) as string) as { launcher: string };
  assert.match(overridden.launcher, /--port 4898/);
  const previousOutbox = await fs.readFile(unit, 'utf8');
  const stalePath = previousOutbox.replace(process.execPath, `${process.execPath}.old`);
  assert.notEqual(stalePath, previousOutbox); await fs.writeFile(unit, stalePath); await fs.writeFile(f.calls, '');
  await assert.rejects(manageClientService(options, envOverride), /different settings; uninstall before changing configuration/);
  assert.equal(await fs.readFile(unit, 'utf8'), stalePath, 'a refused dashboard port change must not partially upgrade the outbox');
  assert.doesNotMatch(await fs.readFile(f.calls, 'utf8'), /(?:daemon-reload|enable|start|stop|restart|disable)/);
  await fs.writeFile(unit, previousOutbox);
  await manageClientService({ ...options, action: 'uninstall' }, f.env);
});

for (const platform of ['macos', 'linux'] as const) {
  test(`${platform} service install repairs older and path-stale installs without changing configuration`, async t => {
    const f = await fixture(t);
    const options = { action: 'install', platform, home: f.home, uid: 501, url: 'https://memory.example/mcp', tokenFile: f.tokenFile, workspace: 'personal' };
    await manageClientService(options, f.env);
    const directory = platform === 'macos' ? path.join(f.home, 'Library/LaunchAgents') : path.join(f.home, '.config/systemd/user');
    const outboxFile = path.join(directory, platform === 'macos' ? 'dev.engram.outbox-watch.plist' : 'engram-outbox-watch.service');
    const dashboardFile = path.join(directory, platform === 'macos' ? 'dev.engram.client-dashboard.plist' : 'engram-client-dashboard.service');
    const wrapper = path.join(directory, 'engram-client-dashboard.sh');

    // Old client: the outbox definition is exactly current, but the dashboard never existed.
    await fs.rm(dashboardFile); await fs.rm(wrapper);
    await fs.writeFile(f.calls, '');
    const repaired = await manageClientService(options, f.env) as { outbox: string; dashboard: string };
    assert.deepEqual({ outbox: repaired.outbox, dashboard: repaired.dashboard }, { outbox: 'unchanged', dashboard: 'installed' });
    let calls = await fs.readFile(f.calls, 'utf8');
    assert.doesNotMatch(calls, /(?:bootstrap|bootout|kickstart|enable|start|stop|restart).*dev\.engram\.outbox-watch|(?:bootstrap|bootout|kickstart|enable|start|stop|restart).*engram-outbox-watch\.service/);
    assert.match(calls, /dev\.engram\.client-dashboard|engram-client-dashboard\.service/);

    // A stale dashboard definition is replaced independently.
    await fs.writeFile(dashboardFile, 'stale dashboard unit');
    await fs.writeFile(f.calls, '');
    const stale = await manageClientService(options, f.env) as { outbox: string; dashboard: string };
    assert.deepEqual({ outbox: stale.outbox, dashboard: stale.dashboard }, { outbox: 'unchanged', dashboard: 'upgraded' });
    calls = await fs.readFile(f.calls, 'utf8');
    assert.doesNotMatch(calls, /(?:bootstrap|bootout|kickstart|enable|start|stop|restart).*dev\.engram\.outbox-watch|(?:bootstrap|bootout|kickstart|enable|start|stop|restart).*engram-outbox-watch\.service/);
    assert.match(await fs.readFile(dashboardFile, 'utf8'), /client-dashboard/);

    // Bundled path changes are a safe in-place upgrade when all user settings match.
    const originalOutbox = await fs.readFile(outboxFile, 'utf8');
    const pathChanged = originalOutbox.replace(process.execPath, `${process.execPath}.old`);
    assert.notEqual(pathChanged, originalOutbox);
    await fs.writeFile(outboxFile, pathChanged);
    await fs.writeFile(f.calls, '');
    const upgraded = await manageClientService(options, f.env) as { outbox: string; dashboard: string };
    assert.deepEqual({ outbox: upgraded.outbox, dashboard: upgraded.dashboard }, { outbox: 'upgraded', dashboard: 'unchanged' });
    assert.equal(await fs.readFile(outboxFile, 'utf8'), originalOutbox);
    calls = await fs.readFile(f.calls, 'utf8');
    assert.match(calls, platform === 'linux' ? /--user restart engram-outbox-watch\.service/ : /bootout gui\/501\/dev\.engram\.outbox-watch/);

    // A URL change remains a refusal and does not mutate either unit.
    await fs.writeFile(outboxFile, originalOutbox.replace('https://memory.example/mcp', 'https://other.example/mcp'));
    const beforeOutbox = await fs.readFile(outboxFile, 'utf8'), beforeDashboard = await fs.readFile(dashboardFile, 'utf8');
    await fs.writeFile(f.calls, '');
    await assert.rejects(manageClientService(options, f.env), /different settings; uninstall before changing configuration/);
    assert.equal(await fs.readFile(outboxFile, 'utf8'), beforeOutbox);
    assert.equal(await fs.readFile(dashboardFile, 'utf8'), beforeDashboard);
    assert.doesNotMatch(await fs.readFile(f.calls, 'utf8'), /(?:bootstrap|bootout|kickstart|daemon-reload|enable|start|stop|restart|disable)/);

    await fs.writeFile(outboxFile, originalOutbox);
    const noop = await manageClientService(options, f.env) as { outbox: string; dashboard: string; changed: boolean };
    assert.deepEqual({ outbox: noop.outbox, dashboard: noop.dashboard, changed: noop.changed }, { outbox: 'unchanged', dashboard: 'unchanged', changed: false });
  });
}
