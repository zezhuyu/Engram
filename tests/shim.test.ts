import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { manageShim, shimSource, MANAGED_SHIM_HEADER } from '../packages/cli/shim.js';

async function temp() { return fs.mkdtemp(path.join(os.tmpdir(), 'engram-shim-')); }

test('shim install is atomic, executable, idempotent, and reports PATH guidance', async () => {
  const root = await temp(), home = path.join(root, 'home'), dir = path.join(home, '.local/bin');
  try {
    const dry = await manageShim({ action: 'install', home, dir, pathValue: '/usr/bin', dryRun: true }) as any;
    assert.equal(dry.installed, true); assert.equal(dry.onPath, false); assert.match(dry.pathSuggestion, /export PATH=/);
    assert.equal(await fs.access(dir).then(() => true, () => false), false);
    await manageShim({ action: 'install', home, dir, pathValue: `/usr/bin${path.delimiter}${dir}` });
    const file = path.join(dir, 'mdb'), before = await fs.stat(file), content = await fs.readFile(file, 'utf8');
    assert.match(content, new RegExp('^#!/bin/sh\\n' + MANAGED_SHIM_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.equal(before.mode & 0o777, 0o755);
    await new Promise(resolve => setTimeout(resolve, 15));
    await manageShim({ action: 'install', home, dir, pathValue: dir });
    assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
    assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);
    assert.equal((await manageShim({ action: 'status', home, dir, pathValue: dir }) as any).onPath, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shim refuses foreign files and remove only deletes managed shim', async () => {
  const root = await temp(), dir = path.join(root, 'bin'); await fs.mkdir(dir);
  try {
    const file = path.join(dir, 'mdb'); await fs.writeFile(file, '#!/bin/sh\necho owner-command\n');
    const result = await manageShim({ action: 'install', dir, home: root }) as any;
    assert.equal(result.managed, false); assert.match(result.reason, /left untouched/);
    await manageShim({ action: 'remove', dir, home: root });
    assert.match(await fs.readFile(file, 'utf8'), /owner-command/);
    await fs.rm(file); await manageShim({ action: 'install', dir, home: root });
    await manageShim({ action: 'remove', dir, home: root });
    assert.equal(await fs.access(file).then(() => true, () => false), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('mdb shim CLI reports isolated status as JSON', async () => {
  const root = await temp(), dir = path.join(root, 'bin');
  try {
    const result = spawnSync(process.execPath, [path.resolve('bin/mdb.js'), 'shim', 'status', '--dir', dir, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.action, 'status'); assert.equal(value.installed, false); assert.equal(value.path, path.join(dir, 'mdb'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('generated shim resolves fake app, pins Server data directory, passes arguments and exit status without logging config', async () => {
  const root = await temp(), home = path.join(root, 'home'), app = path.join(home, 'Applications/Engram Server.app/Contents/Resources/backend');
  const clientBackend = path.join(root, 'Applications/Engram Client.app/Contents/Resources/backend');
  const dir = path.join(root, 'bin'); await fs.mkdir(path.join(app, 'runtime/bin'), { recursive: true }); await fs.mkdir(path.join(app, 'app/bin'), { recursive: true }); await fs.mkdir(path.join(home, '.config/engram'), { recursive: true }); await fs.mkdir(dir);
  try {
    const capture = path.join(root, 'capture');
    await fs.mkdir(path.join(clientBackend, 'runtime/bin'), { recursive: true }); await fs.mkdir(path.join(clientBackend, 'app/bin'), { recursive: true });
    await fs.writeFile(path.join(clientBackend, 'runtime/bin/node'), '#!/bin/sh\nexit 9\n', { mode: 0o755 }); await fs.writeFile(path.join(clientBackend, 'app/bin/mdb.js'), 'client');
    await fs.writeFile(path.join(app, 'runtime/bin/node'), '#!/bin/sh\nprintf "%s\\n" "${ENGRAM_DATA_DIR-}" "$@" > "$CAPTURE"\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
    await fs.writeFile(path.join(app, 'app/bin/mdb.js'), 'fake');
    await fs.writeFile(path.join(home, '.config/engram/server.env'), 'ENGRAM_DATA_DIR="/private data/vault"\nOTHER_SECRET=must-not-print\n');
    await fs.writeFile(path.join(dir, 'mdb'), shimSource(), { mode: 0o755 });
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ENGRAM_DATA_DIR: '', PATH: `${dir}:/usr/bin:/bin`, ENGRAM_APP_SEARCH_ROOT: path.join(root, 'Applications'), CAPTURE: capture, FAKE_EXIT: '23' };
    const run = spawnSync(path.join(dir, 'mdb'), ['search', 'hello world'], { env, encoding: 'utf8' });
    assert.equal(run.status, 23); assert.doesNotMatch(run.stdout + run.stderr, /must-not-print|private data/);
    const args = await fs.readFile(capture, 'utf8');
    assert.match(args, /^\/private data\/vault\n.*app\/bin\/mdb\.js\nsearch\nhello world\n$/s);
    const supplied = spawnSync(path.join(dir, 'mdb'), ['x'], { env: { ...env, ENGRAM_DATA_DIR: '/explicit' }, encoding: 'utf8' });
    assert.equal(supplied.status, 23); assert.match(await fs.readFile(capture, 'utf8'), /^\/explicit\n/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
