import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageLinuxBundles } from '../scripts/package-linux.mjs';
import { buildDeb, createDebRoot } from '../scripts/package-linux-deb.mjs';
import { manageService, serviceDefinition } from '../scripts/install-linux-service.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'engram linux fixture '));
  const backend = join(root, 'input'); const home = join(root, 'home');
  await mkdir(join(backend, 'runtime/bin'), { recursive: true });
  await writeFile(join(backend, 'runtime/bin/node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nprintf "%s|%s" "${MDB_MCP_TRANSPORT:-}" "${MDB_MCP_HTTP_HOST:-}" > "$STATE"\n', { mode: 0o755 });
  await packageLinuxBundles(join(root, 'output'), backend);
  await mkdir(join(home, '.config/engram'), { recursive: true });
  for (const role of ['client', 'server']) await writeFile(join(home, `.config/engram/${role}.env`), role === 'client' ? 'ENGRAM_MCP_URL=https://memory.example/mcp\nENGRAM_MCP_TOKEN=fake-secret\nENGRAM_WORKSPACE="a project"\nENGRAM_PROJECT_DIR="/a path/project"\n' : '', { mode: 0o600 });
  return { root, home, env: { ...process.env, HOME: home, CAPTURE: join(root, 'argv'), STATE: join(root, 'state') },
    options(role, system = false) { return { role, action: 'install', bundle: join(root, `output/engram-${role}`), home, uid: process.getuid(), user: system ? 'fixtureuser' : undefined, unitDirectory: join(root, system ? 'system-units' : 'user-units'), oppositeFile: join(root, system ? 'user-units' : 'system-units', `engram-${role}.service`) }; } };
}
test('Linux fixture packages both role launchers, private runtime, installer and instructions', async () => {
  const f = await fixture();
  try {
    for (const role of ['client', 'server']) {
      const bundle = f.options(role).bundle;
      for (const path of [`engram-${role}`, 'backend/runtime/bin/node', 'install-service.mjs', 'README.md']) await access(join(bundle, path));
      assert.equal(JSON.parse(await readFile(join(bundle, 'role.json'), 'utf8')).role, role);
      assert.equal(spawnSync('/bin/sh', ['-n', join(bundle, `engram-${role}`)]).status, 0);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('Debian installer layout installs a direct app command and explicit systemd installer without enabling services', async () => {
  const f = await fixture();
  try {
    for (const role of ['client', 'server']) {
      const root = join(f.root, `deb-${role}`);
      const { packageName } = await createDebRoot({ destination: root, bundle: f.options(role).bundle, role, version: '0.1.0-ci.abcdef123456' });
      assert.equal(packageName, `engram-${role}`);
      await access(join(root, 'opt', packageName, `engram-${role}`));
      assert.equal(await readFile(join(root, 'usr', 'bin', packageName), 'utf8'), `#!/bin/sh\nexec /opt/${packageName}/${packageName} "$@"\n`);
      assert.equal(await readFile(join(root, 'usr', 'bin', `engram-${role}-service`), 'utf8'), `#!/bin/sh\nexec /opt/${packageName}/backend/runtime/bin/node /opt/${packageName}/install-service.mjs "$@"\n`);
      const control = await readFile(join(root, 'DEBIAN/control'), 'utf8');
      assert.match(control, new RegExp(`^Package: ${packageName}$`, 'm'));
      assert.match(control, /^Architecture: amd64$/m);
      assert.doesNotMatch(control, /^postinst:/m);
    }
    await assert.rejects(createDebRoot({ destination: join(f.root, 'bad'), bundle: f.options('client').bundle, role: 'client', version: 'latest' }), /Invalid Debian package version/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('Linux build emits valid directly installable Debian packages for client and server', { skip: process.platform !== 'linux' }, async t => {
  if (spawnSync('dpkg-deb', ['--version']).status !== 0) { t.skip('dpkg-deb unavailable'); return; }
  const f = await fixture();
  try {
    for (const role of ['client', 'server']) {
      const file = await buildDeb({ destination: join(f.root, 'release'), bundle: f.options(role).bundle, role, version: '0.1.0-ci.abcdef123456' });
      assert.match(file, new RegExp(`/engram-${role}_0\\.1\\.0-ci\\.abcdef123456_amd64\\.deb$`));
      const info = spawnSync('dpkg-deb', ['--info', file], { encoding: 'utf8' });
      assert.equal(info.status, 0, info.stderr);
      assert.match(info.stdout, new RegExp(`Package: engram-${role}`));
      assert.match(info.stdout, /Architecture: amd64/);
      const contents = spawnSync('dpkg-deb', ['--contents', file], { encoding: 'utf8' });
      assert.equal(contents.status, 0, contents.stderr);
      assert.match(contents.stdout, new RegExp(`opt/engram-${role}/engram-${role}`));
      assert.match(contents.stdout, new RegExp(`usr/bin/engram-${role}-service`));
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('Linux launchers retain client scope, hide token from argv and default server to loopback HTTP', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    for (const role of ['client', 'server']) {
      const env = { ...f.env }; delete env.MDB_MCP_HTTP_HOST; delete env.MDB_MCP_TRANSPORT;
      const result = spawnSync(join(f.options(role).bundle, `engram-${role}`), [], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const args = await readFile(env.CAPTURE, 'utf8');
      if (role === 'client') { assert.match(args, /outbox\nwatch\n/); assert.match(args, /--workspace\na project\n/); assert.match(args, /--project-dir\n\/a path\/project\n/); assert.doesNotMatch(args, /fake-secret/); }
      else { assert.match(args, /app\/bin\/mdb-mcp.js/); assert.equal(await readFile(env.STATE, 'utf8'), 'http|127.0.0.1'); }
    }
    await chmod(join(f.home, '.config/engram/client.env'), 0o644);
    const result = spawnSync(join(f.options('client').bundle, 'engram-client'), [], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Configuration must have mode/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('systemd definitions quote paths, escape specifiers, supervise workers and separate startup scopes', () => {
  const user = serviceDefinition({ role: 'client', bundle: '/a path/%client/$dir', home: '/home/a user' });
  assert.match(user, /ExecStart="\/a path\/%%client\/\$\$dir\/engram-client"/);
  assert.match(user, /WantedBy=default.target/); assert.match(user, /Restart=always/); assert.doesNotMatch(user, /^User=/m);
  const system = serviceDefinition({ role: 'server', bundle: '/opt/server', home: '/home/worker', user: 'worker' });
  assert.match(system, /User=worker/); assert.match(system, /WantedBy=multi-user.target/); assert.match(system, /KillMode=control-group/);
  assert.throws(() => serviceDefinition({ role: 'server', bundle: '/opt/server', home: '/root', user: 'root' }));
  assert.throws(() => serviceDefinition({ role: 'server', bundle: '/opt/\ninjected', home: '/home/a' }));
});
test('both service roles install, enable and uninstall in user and system modes without losing configuration', async () => {
  const f = await fixture();
  try {
    for (const system of [false, true]) for (const role of ['client', 'server']) {
      const calls = []; const run = (command, args) => calls.push([command, ...args]); const options = { ...f.options(role, system), run };
      await manageService(options);
      const unit = await readFile(join(options.unitDirectory, `engram-${role}.service`), 'utf8');
      assert.match(unit, /Managed by Engram/); assert.match(unit, new RegExp(`engram-${role}"`));
      assert.deepEqual(calls[1], ['systemctl', ...(system ? [] : ['--user']), 'enable', '--now', `engram-${role}.service`]);
      await assert.rejects(manageService(options), /already exists/);
      await manageService({ ...options, action: 'uninstall' });
      await assert.rejects(access(join(options.unitDirectory, `engram-${role}.service`)));
      await access(join(f.home, `.config/engram/${role}.env`));
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('installer rejects conflicting startup, unsafe secret permissions and unmanaged removal', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options('client'), run() {} };
    await mkdir(join(f.root, 'system-units')); await writeFile(options.oppositeFile, 'existing');
    await assert.rejects(manageService(options), /already exists/); await rm(options.oppositeFile);
    await chmod(join(f.home, '.config/engram/client.env'), 0o644);
    await assert.rejects(manageService(options), /mode 600/);
    await mkdir(options.unitDirectory); await writeFile(join(options.unitDirectory, 'engram-client.service'), 'unmanaged');
    await assert.rejects(manageService({ ...options, action: 'uninstall' }), /unmanaged/);
    const server = { ...f.options('server'), run() {} }; await writeFile(join(server.unitDirectory, 'engram-mcp.service'), 'legacy');
    await assert.rejects(manageService(server), /legacy/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('failed systemctl enable rolls back service and startup registration', async () => {
  const f = await fixture();
  try {
    const calls = []; const options = { ...f.options('server'), run(command, args) { calls.push(args); if (args.includes('enable')) throw new Error('fixture enable failure'); } };
    await assert.rejects(manageService(options), /enable failure/);
    await assert.rejects(access(join(options.unitDirectory, 'engram-server.service')));
    assert.ok(calls.some(args => args.includes('disable') && args.includes('--now')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('generated units pass systemd-analyze verification on Linux', { skip: process.platform !== 'linux' }, async t => {
  if (spawnSync('systemd-analyze', ['--version']).status !== 0) { t.skip('systemd-analyze unavailable'); return; }
  const f = await fixture();
  try {
    for (const role of ['client', 'server']) {
      const file = join(f.root, `engram-${role}.service`);
      await writeFile(file, serviceDefinition(f.options(role)));
      const result = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
