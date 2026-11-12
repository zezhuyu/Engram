import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { disposableVault } from './helpers.js';

const repoRoot = process.cwd();
async function startDashboard(vaultRoot: string, extraEnv: NodeJS.ProcessEnv = {}, extraArgs: string[] = []) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'bin/mdb.js'), 'dashboard', '--root', vaultRoot, ...extraArgs], {
    cwd: repoRoot, env: { ...process.env, MDB_DASHBOARD_AUTH_FILE: path.join(vaultRoot, '.test-auth', 'auth.json'), ...extraEnv, MDB_DASHBOARD_ALERT: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errorOutput = '';
  child.stderr!.on('data', chunk => { errorOutput += String(chunk); });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`dashboard URL was not printed: ${output}`)), 10_000);
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      const found = /http:\/\/(?:\[[^\]]+\]|[\d.]+):\d+\/#t=[a-f0-9]{64}/.exec(output);
      if (found) { clearTimeout(timeout); resolve(found[0]); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      if (!/http:\/\/(?:\[[^\]]+\]|[\d.]+):\d+\/#t=/.test(output)) { clearTimeout(timeout); reject(new Error(`dashboard exited (${code}): ${output}`)); }
    });
  });
  return { child, url, get errorOutput() { return errorOutput; } };
}
async function waitExit(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try { const [code] = await once(child, 'exit') as [number | null]; return code; }
  finally { clearTimeout(timeout); }
}

test('mdb dashboard prints its URL, serves the UI, protects status, stays running, and exits on SIGINT', async t => {
  const v = await disposableVault(); let child: ChildProcess | undefined;
  t.after(async () => { if (child && child.exitCode === null) { child.kill('SIGKILL'); await waitExit(child); } await v.cleanup(); });
  const running = await startDashboard(v.root, { NODE_ENV: 'test' }); child = running.child;
  assert.equal(child.exitCode, null, 'the CLI stays alive after printing its URL');
  assert.match(running.errorOutput, /Dashboard password file: .*\.test-auth\/auth\.json/);
  assert.match(running.errorOutput, /Dashboard password: not set/);
  const origin = new URL(running.url).origin;
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Engram dashboard/);
  assert.equal((await fetch(`${origin}/api/status`)).status, 401, 'status rejects a missing token');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, 'the CLI remains alive while the server is idle briefly');
  child.kill('SIGINT');
  assert.equal(await waitExit(child), 0, 'SIGINT exits cleanly');
});

test('mdb dashboard exits after the opt-in idle timeout', async t => {
  const v = await disposableVault(); let child: ChildProcess | undefined;
  t.after(async () => { if (child && child.exitCode === null) { child.kill('SIGKILL'); await waitExit(child); } await v.cleanup(); });
  const running = await startDashboard(v.root, { MDB_DASHBOARD_IDLE_MINUTES: '0.0042' }); child = running.child;
  assert.match(running.url, /#t=/);
  assert.equal(await waitExit(child, 5000), 0, 'idle timeout closes the listener and exits the process');
});

test('dashboard host and port flags override environment defaults', async t => {
  const v = await disposableVault(); let child: ChildProcess | undefined;
  t.after(async () => { if (child && child.exitCode === null) { child.kill('SIGKILL'); await waitExit(child); } await v.cleanup(); });
  const running = await startDashboard(v.root, { MDB_DASHBOARD_HOST: '0.0.0.0', MDB_DASHBOARD_PORT: '1' }, ['--host', '127.0.0.1', '--port', '0']); child = running.child;
  assert.equal(new URL(running.url).hostname, '127.0.0.1');
  assert.notEqual(new URL(running.url).port, '1');
  child.kill('SIGINT');
  assert.equal(await waitExit(child), 0);
});
