import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listCodexHooks } from '../../packages/memory/codex-trust.js';
import { recordCase } from '../helpers/report.js';

/**
 * Regression for the Node 22/25 teardown flake in the Codex trust tests (ENOTEMPTY while removing the Codex home): Engram killed its `codex app-server` child with SIGTERM and returned at once,
 * so the child, still shutting down, kept writing into the Codex home while the caller removed the directory. The fake Codex below shuts down slowly (300 ms after SIGTERM) and keeps writing
 * into `$CODEX_HOME/.tmp` the whole time, which reproduces it deterministically.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), readline = require('readline');
const home = process.env.CODEX_HOME, tmp = path.join(home, '.tmp'); fs.mkdirSync(tmp, { recursive: true }); fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
let n = 0; const writer = setInterval(() => { try { fs.writeFileSync(path.join(tmp, 'f' + n++), 'x'); } catch {} }, 3);
readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'hooks/list' ? { data: [{ hooks: [] }] } : {} }) + '\\n'); });
process.on('SIGTERM', () => { setTimeout(() => { clearInterval(writer); process.exit(0); }, 300); });
`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the Codex child is gone before listCodexHooks returns, so its home can be removed immediately, every time', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'engram-cxtd-')); t.after(() => rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const bin = path.join(base, 'bin'); await mkdir(bin); await writeFile(path.join(bin, 'codex'), FAKE); await chmod(path.join(bin, 'codex'), 0o755);
  const saved = { path: process.env.PATH, home: process.env.CODEX_HOME, pid: process.env.FAKE_PID_FILE }; t.after(() => { for (const [k, v] of [['PATH', saved.path], ['CODEX_HOME', saved.home], ['FAKE_PID_FILE', saved.pid]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ''}`;
  for (let round = 1; round <= 12; round++) {
    const home = path.join(base, `home-${round}`); await mkdir(home); const pidFile = path.join(base, `pid-${round}`); process.env.CODEX_HOME = home; process.env.FAKE_PID_FILE = pidFile;
    const hooks = await listCodexHooks(base, 5000); assert.deepEqual(hooks, []);
    const pid = Number(await readFile(pidFile, 'utf8')); assert.equal(alive(pid), false, `round ${round}: the Codex process had already exited when listCodexHooks returned`);
    await rm(home, { recursive: true }); // NO retries: this is exactly what used to fail with ENOTEMPTY
  }
  recordCase({ suite: 'memory', name: 'codex-child-exits-before-teardown', status: 'PASS' });
});

test('a Codex that ignores SIGTERM is still ended (SIGKILL after the grace period) and the call does not hang', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'engram-cxtd2-')); t.after(() => rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const bin = path.join(base, 'bin'); await mkdir(bin); await writeFile(path.join(bin, 'codex'), FAKE.replace("process.on('SIGTERM', () => { setTimeout(() => { clearInterval(writer); process.exit(0); }, 300); });", "process.on('SIGTERM', () => {}); // ignores it")); await chmod(path.join(bin, 'codex'), 0o755);
  const saved = { path: process.env.PATH, home: process.env.CODEX_HOME, pid: process.env.FAKE_PID_FILE }; t.after(() => { for (const [k, v] of [['PATH', saved.path], ['CODEX_HOME', saved.home], ['FAKE_PID_FILE', saved.pid]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const home = path.join(base, 'home'); await mkdir(home); const pidFile = path.join(base, 'pid'); process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ''}`; process.env.CODEX_HOME = home; process.env.FAKE_PID_FILE = pidFile;
  const started = Date.now(); await listCodexHooks(base, 5000); const took = Date.now() - started; const pid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(alive(pid), false, 'killed after the grace period'); assert.ok(took < 6000, `returned after ${took} ms`); await rm(home, { recursive: true });
});
