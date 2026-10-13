import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerLauncher, packageMacApps } from '../scripts/package-macos.mjs';

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
    const run = spawnSync('/bin/sh', [f.launch], { env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const args = await readFile(f.env.CAPTURE, 'utf8');
    assert.match(args, /outbox\nwatch\n--url\nhttps:\/\/memory.example\/mcp/);
    assert.match(args, /--workspace\nproject one\n/);
    assert.match(args, /--project-dir\n\/a path\/project\n/);
    assert.doesNotMatch(args, /fake-test-token/);
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
    const env = { ...f.env }; delete env.MDB_MCP_TRANSPORT; delete env.MDB_MCP_HTTP_HOST;
    assert.equal(spawnSync('/bin/sh', [f.launch], { env }).status, 0);
    assert.match(await readFile(f.env.CAPTURE, 'utf8'), /app\/bin\/mdb-mcp.js/);
    assert.equal(await readFile(f.env.STATE, 'utf8'), 'http|127.0.0.1');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('native packaging fixture creates both signed app bundles with supplied icons and independent workers', macOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'engram app fixture '));
  try {
    const backend = join(root, 'backend'); await mkdir(backend);
    await writeFile(join(backend, 'fixture.txt'), 'fixture backend, not a production app');
    await packageMacApps(join(root, 'output'), backend);
    for (const role of ['Client', 'Server']) {
      const contents = join(root, 'output', `Engram ${role}.app/Contents`);
      for (const file of ['MacOS/Engram', 'MacOS/engram-worker', 'Resources/Engram.icns', 'Resources/menu_bar.png']) await access(join(contents, file));
      const plist = await readFile(join(contents, 'Info.plist'), 'utf8');
      assert.match(plist, /LSUIElement/);
      assert.match(plist, new RegExp(`<key>EngramRole</key><string>${role.toLowerCase()}</string>`));
      assert.equal(spawnSync('codesign', ['--verify', '--deep', join(root, 'output', `Engram ${role}.app`)]).status, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
