import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, access, stat } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { workerLauncher, packageMacApps } from '../scripts/package-macos.mjs';

test('standalone runtime copies the keyed gateway into its private app bundle', async () => {
  const source = await readFile(new URL('../scripts/standalone.mjs', import.meta.url), 'utf8');
  assert.match(source, /scripts\/hosted\/keyed-gateway\.mjs/);
  const gateway = await readFile(new URL('../scripts/hosted/keyed-gateway.mjs', import.meta.url), 'utf8');
  assert.match(gateway, /req\.url === '\/health'/);
  assert.match(gateway, /127\.0\.0\.1/);
});

test('macOS app source installs the managed CLI on every app launch and exposes the shim in standalone runtime', async () => {
  const swift = await readFile(new URL('../macos/EngramApp.swift', import.meta.url), 'utf8');
  const standalone = await readFile(new URL('../scripts/standalone.mjs', import.meta.url), 'utf8');
  const shim = await readFile(new URL('../packages/cli/shim.ts', import.meta.url), 'utf8');
  assert.match(swift, /installCommandLineShim\(\)/);
  assert.match(swift, /"shim", "install"/);
  assert.match(swift, /FileHandle\.nullDevice/);
  assert.match(standalone, /'shim', 'install'/);
  assert.match(shim, /engram-managed-shim v1/);
});

test('both menu bar apps offer a confirmed full quit that stops every service they run, next to the quit that leaves them running', async () => {
  const swift = await readFile(new URL('../macos/EngramApp.swift', import.meta.url), 'utf8');
  assert.match(swift, /"Quit Menu Bar App \(daemon keeps running\)", #selector\(quit\)/);
  assert.match(swift, /"Quit Menu Bar App \(service keeps running\)", #selector\(quit\)/);
  assert.equal((swift.match(/"Quit Engram Completely…", #selector\(quitCompletely\)/g) ?? []).length, 2, 'client and server menus both have it');
  const body = swift.slice(swift.indexOf('@objc func quitCompletely()'), swift.indexOf('let app = NSApplication.shared'));
  assert.match(body, /alert\.runModal\(\) == \.alertFirstButtonReturn/, 'it asks first and cancel does nothing');
  assert.match(body, /mdb\("stop"\)/, 'the client daemon, dashboard and replica service are stopped');
  assert.match(body, /bootout/, 'the server worker and its helpers are stopped');
  for (const label of ['dev.engram.intelligence-worker', 'dev.engram.tunnel-client', 'dev.engram.keyed-gateway']) assert.ok(swift.includes(label), label);
  assert.match(body, /NSApp\.terminate/, 'the menu bar app itself quits last');
  assert.doesNotMatch(body, /removeItem\(at: (?!workerPlist)/, 'nothing but the worker launch definition is removed');
  assert.match(body, /system boot[\s\S]*sudo/, 'a boot-time service is not stopped without the administrator command');
  assert.match(swift, /func restoreHelperAgents\(\)[\s\S]*dev\.engram\.intelligence-worker[\s\S]*bootstrap/, 'opening the app brings back the Dream worker that a full quit stopped');
  assert.match(swift, /func startService\(\) throws \{\s*restoreHelperAgents\(\)/, 'and does so before anything else in service start');
});

async function fixture(role, config, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), 'engram mac test '));
  const home = join(root, 'home');
  const app = join(root, 'App');
  const launch = join(app, 'Contents/MacOS/engram-worker');
  await mkdir(join(home, '.config/engram'), { recursive: true });
  await mkdir(join(app, 'Contents/Resources/backend/runtime/bin'), { recursive: true });
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents/Resources/backend/runtime/bin/node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nprintf "%s|%s" "${MDB_MCP_TRANSPORT:-}" "${MDB_MCP_HTTP_HOST:-}" > "$STATE"\n', { mode: 0o755 });
  await writeFile(launch, workerLauncher(role), { mode: 0o755 });
  await writeFile(join(home, `.config/engram/${role}.env`), config, { mode });
  return { root, home, launch, env: { ...process.env, HOME: home, CAPTURE: join(root, 'args'), STATE: join(root, 'state') } };
}
const macOnly = { skip: platform() !== 'darwin' };
test('client worker passes quoted scope paths and keeps credential out of arguments', macOnly, async () => {
  const f = await fixture('client', 'ENGRAM_MCP_URL=https://memory.example/mcp\nENGRAM_MCP_TOKEN=fake-test-token\nENGRAM_WORKSPACE="project one"\nENGRAM_PROJECT_DIR="/a path/project"\n');
  try {
    const run = spawnSync('/bin/sh', [f.launch], { env: { ...f.env, ENGRAM_DASHBOARD: 'off' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const args = await readFile(f.env.CAPTURE, 'utf8');
    assert.match(args, /outbox\nwatch\n--url\nhttps:\/\/memory.example\/mcp/);
    assert.match(args, /--workspace\nproject one\n/);
    assert.match(args, /--project-dir\n\/a path\/project\n/);
    assert.doesNotMatch(args, /fake-test-token/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('client worker supervises its dashboard with private setup-token output and set-e-safe cleanup', macOnly, async () => {
  const f = await fixture('client', 'ENGRAM_MCP_URL=https://memory.example/mcp\nENGRAM_MCP_TOKEN=fake-test-token\n');
  try {
    const node = join(f.root, 'App/Contents/Resources/backend/runtime/bin/node');
    await writeFile(node, '#!/bin/sh\nprintf "ARGS:%s\\n" "$*" >> "$CAPTURE"\ncase "$*" in *dashboard*) printf "setup-token-line\\n"; exec sleep 30;; *) exec sleep 30;; esac\n', { mode: 0o755 });
    const note = join(f.root, 'client-dashboard.txt'); const log = join(f.root, 'client-dashboard.log');
    const env = { ...f.env, ENGRAM_DASHBOARD_NOTE: note, ENGRAM_CLIENT_DASHBOARD_LOG: log, ENGRAM_CLIENT_DASHBOARD_PORT: '4896' };
    const child = spawn('/bin/sh', [f.launch], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const deadline = Date.now() + 5_000; let seen = '';
    while (Date.now() < deadline) {
      seen = await readFile(f.env.CAPTURE, 'utf8').catch(() => '');
      if (/ARGS:.*dashboard --client/.test(seen) && /ARGS:.*outbox watch/.test(seen)) break;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.kill('SIGTERM');
    const exit = await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => resolve('timeout'), 5_000))]);
    assert.notEqual(exit, 'timeout', 'launcher cleanup must finish after SIGTERM');
    assert.match(seen, /dashboard --client --host 127\.0\.0\.1 --port 4896/, stderr);
    assert.match(seen, /outbox watch --url https:\/\/memory\.example\/mcp/);
    assert.equal((await stat(note)).mode & 0o777, 0o600);
    assert.match(await readFile(note, 'utf8'), /setup-token-line/);
    assert.doesNotMatch(await readFile(log, 'utf8').catch(() => ''), /setup-token-line/);
    assert.match(workerLauncher('client'), /ENGRAM_DASHBOARD:-on/);
    assert.match(workerLauncher('client'), /trap cleanup EXIT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('client worker rejects missing configuration and public-readable secret files', macOnly, async () => {
  for (const [config, mode] of [['ENGRAM_MCP_URL=\n', 0o600], ['ENGRAM_MCP_URL=https://memory.example\nENGRAM_MCP_TOKEN=fake\n', 0o644]]) {
    const f = await fixture('client', config, mode);
    try { assert.notEqual(spawnSync('/bin/sh', [f.launch], { env: f.env }).status, 0); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
test('server worker runs the bundled server with HTTP and loopback defaults', macOnly, async () => {
  const f = await fixture('server', '');
  try {
    const env = { ...f.env, ENGRAM_DASHBOARD: 'off' }; delete env.MDB_MCP_TRANSPORT; delete env.MDB_MCP_HTTP_HOST;
    assert.equal(spawnSync('/bin/sh', [f.launch], { env }).status, 0);
    assert.match(await readFile(f.env.CAPTURE, 'utf8'), /app\/bin\/mdb-mcp.js/);
    assert.equal(await readFile(f.env.STATE, 'utf8'), 'http|127.0.0.1');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('server worker also starts the dashboard on loopback by default and keeps its setup token out of shared logs', macOnly, async () => {
  const f = await fixture('server', '');
  try {
    const node = join(f.root, 'App/Contents/Resources/backend/runtime/bin/node');
    await writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CAPTURE"\nprintf "setup-token-line\\n"\ncase "$1" in *mdb-mcp.js) sleep 2;; *mdb.js) sleep 6;; esac\n', { mode: 0o755 });
    const note = join(f.root, 'dashboard.txt');
    const env = { ...f.env, ENGRAM_DASHBOARD_NOTE: note, ENGRAM_DASHBOARD_PORT: '4999' }; delete env.ENGRAM_DASHBOARD;
    assert.equal(spawnSync('/bin/sh', [f.launch], { env }).status, 0);
    const seen = await readFile(f.env.CAPTURE, 'utf8');
    assert.match(seen, /app\/bin\/mdb-mcp\.js/);
    assert.match(seen, /app\/bin\/mdb\.js dashboard --host 127\.0\.0\.1 --port 4999/);
    assert.equal((await stat(note)).mode & 0o777, 0o600);
    assert.match(await readFile(note, 'utf8'), /setup-token-line/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('native packaging fixture creates both signed app bundles and directly mountable app installers', macOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'engram app fixture '));
  try {
    const backend = join(root, 'backend'); await mkdir(backend);
    await mkdir(join(backend, 'runtime/bin'), { recursive: true }); await mkdir(join(backend, 'app/bin'), { recursive: true });
    await writeFile(join(backend, 'runtime/bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(backend, 'app/bin/mdb.js'), 'fixture CLI');
    await writeFile(join(backend, 'fixture.txt'), 'fixture backend, not a production app');
    await packageMacApps(join(root, 'output'), backend);
    for (const role of ['Client', 'Server']) {
      const contents = join(root, 'output', `Engram ${role}.app/Contents`);
      for (const file of ['MacOS/Engram', 'MacOS/engram-worker', 'Resources/Engram.icns', 'Resources/menu_bar.png']) await access(join(contents, file));
      for (const file of ['Resources/backend/runtime/bin/node', 'Resources/backend/app/bin/mdb.js']) await access(join(contents, file));
      const plist = await readFile(join(contents, 'Info.plist'), 'utf8');
      assert.match(plist, /LSUIElement/);
      assert.match(plist, new RegExp(`<key>EngramRole</key><string>${role.toLowerCase()}</string>`));
      assert.equal(spawnSync('codesign', ['--verify', '--deep', join(root, 'output', `Engram ${role}.app`)]).status, 0);
    }
    for (const role of ['Client', 'Server']) {
      const lower = role.toLowerCase(); const name = `Engram ${role}`;
      const packageDir = join(root, `release/engram-${lower}-darwin-arm64-test`);
      const app = join(root, 'output', `${name}.app`);
      await mkdir(packageDir, { recursive: true });
      await cp(app, join(packageDir, `${name}.app`), { recursive: true });
      await cp(join(root, 'output/install-macos-boot.mjs'), join(packageDir, 'install-macos-boot.mjs'));
      await cp(join(root, 'output/README.md'), join(packageDir, 'README.md'));
      const image = `${packageDir}.dmg`;
      assert.equal(spawnSync('hdiutil', ['create', '-quiet', '-ov', '-format', 'UDZO', '-volname', name, '-srcfolder', packageDir, image]).status, 0);
      const mount = join(root, `mount-${lower}`); await mkdir(mount);
      const attached = spawnSync('hdiutil', ['attach', '-quiet', '-readonly', '-nobrowse', '-noverify', '-mountpoint', mount, image]);
      assert.equal(attached.status, 0, attached.stderr?.toString());
      try {
        await access(join(mount, `${name}.app`, 'Contents/Info.plist'));
        await access(join(mount, 'install-macos-boot.mjs'));
        await access(join(mount, 'README.md'));
      } finally { spawnSync('hdiutil', ['detach', '-quiet', mount]); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
