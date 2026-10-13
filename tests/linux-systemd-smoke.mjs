// Explicitly run only in a disposable Linux systemd environment as root.
// Never set ENGRAM_TEST_SYSTEMD on a production machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, chown, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageLinuxBundles } from '../scripts/package-linux.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout.trim();
}
async function waitFor(check) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for fixture worker');
}
test('live Linux systemd installs, supervises and removes both background roles', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.ENGRAM_TEST_SYSTEMD !== '1',
}, async () => {
  const username = 'engramfixture';
  // Refuse existing accounts or units; this test owns only disposable fixtures.
  assert.notEqual(spawnSync('getent', ['passwd', username]).status, 0);
  for (const role of ['client', 'server']) assert.notEqual(spawnSync('systemctl', ['cat', `engram-${role}.service`]).status, 0);
  run('useradd', ['--create-home', username]);
  const fields = run('getent', ['passwd', username]).split(':');
  const uid = Number(fields[2]); const gid = Number(fields[3]); const home = fields[5];
  const root = await mkdtemp(join(tmpdir(), 'engram live fixture '));
  const installed = [];
  try {
    await chmod(root, 0o755);
    const backend = join(root, 'backend');
    await mkdir(join(backend, 'runtime/bin'), { recursive: true });
    await mkdir(join(backend, 'app/bin'), { recursive: true });
    await symlink(process.execPath, join(backend, 'runtime/bin/node'));
    const worker = `import fs from 'node:fs';\nfs.appendFileSync(process.env.HOME + '/worker-starts', JSON.stringify({ uid: process.getuid(), pid: process.pid, args: process.argv.slice(2), transport: process.env.MDB_MCP_TRANSPORT }) + '\\n');\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n`;
    for (const file of ['mdb.js', 'mdb-mcp.js']) await writeFile(join(backend, 'app/bin', file), worker);
    await writeFile(join(backend, 'app/package.json'), '{"type":"module"}');
    await packageLinuxBundles(join(root, 'output'), backend);
    await mkdir(join(home, '.config/engram'), { recursive: true });
    for (const role of ['client', 'server']) {
      const config = join(home, `.config/engram/${role}.env`);
      await writeFile(config, role === 'client' ? 'ENGRAM_MCP_URL=https://fixture.invalid/mcp\nENGRAM_MCP_TOKEN=fake-fixture-token\n' : '', { mode: 0o600 });
      await chown(config, uid, gid);
      const bundle = join(root, `output/engram-${role}`);
      run(process.execPath, [join(bundle, 'install-service.mjs'), 'install', 'system', username]);
      installed.push({ role, bundle });
      const name = `engram-${role}.service`;
      assert.equal(run('systemctl', ['is-enabled', name]), 'enabled');
      assert.equal(run('systemctl', ['is-active', name]), 'active');
      await waitFor(async () => { try { return (await readFile(join(home, 'worker-starts'), 'utf8')).includes(role === 'client' ? 'outbox' : 'http'); } catch { return false; } });
      const first = run('systemctl', ['show', '--property=MainPID', '--value', name]);
      run('systemctl', ['kill', '--signal=SIGKILL', name]);
      await waitFor(async () => {
        const result = spawnSync('systemctl', ['show', '--property=MainPID', '--value', name], { encoding: 'utf8' });
        return result.stdout.trim() !== '0' && result.stdout.trim() !== first;
      });
      assert.equal(run('systemctl', ['is-active', name]), 'active');
      // A separate installer process has exited; the worker remains supervised.
      run('systemctl', ['restart', name]);
    }
    const starts = (await readFile(join(home, 'worker-starts'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(starts.every(event => event.uid === uid));
    assert.ok(starts.every(event => !JSON.stringify(event.args).includes('fake-fixture-token')));
    for (const { role, bundle } of installed) {
      run(process.execPath, [join(bundle, 'install-service.mjs'), 'uninstall', 'system', username]);
      assert.notEqual(spawnSync('systemctl', ['is-active', `engram-${role}.service`]).status, 0);
    }
    installed.length = 0;
  } finally {
    for (const { role } of installed) {
      spawnSync('systemctl', ['disable', '--now', `engram-${role}.service`]);
      await rm(`/etc/systemd/system/engram-${role}.service`, { force: true });
    }
    spawnSync('systemctl', ['daemon-reload']);
    await rm(root, { recursive: true, force: true });
    run('userdel', ['--remove', username]);
  }
});
