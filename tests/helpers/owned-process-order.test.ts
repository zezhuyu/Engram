import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disposableVault } from './disposable-vault.js';
import { ownChildProcess, stopOwnedChildren } from './owned-process.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };

async function runFifoHooks(hooks: Array<() => void | Promise<void>>): Promise<void> {
  for (const hook of hooks) await hook();
}

async function childIsDead(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function startWriter(root: string) {
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs'); const p=${JSON.stringify(path.join(root, '.mdb', 'indexes'))}; setInterval(()=>{try{fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/'+Date.now()+'-'+Math.random(),'x')}catch{}},2)`], { stdio: 'ignore' });
  assert.ok(child.pid);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

test('vault cleanup stops FIFO-later owned writers before removing their root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-order-'));
  const hooks: Array<() => void | Promise<void>> = [];
  const t: Cleanup = { after: hook => hooks.push(hook) };
  let rootExists = true;
  const child = await startWriter(root);

  // Mirrors disposableVault registration followed by ownChildProcess registration.
  t.after(async () => {
    await stopOwnedChildren(t);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rootExists = false;
  });
  ownChildProcess(t, child);
  await new Promise(resolve => setTimeout(resolve, 30));
  await runFifoHooks(hooks);
  assert.equal(await childIsDead(child.pid!), true, 'owned writer must be reaped');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(rootExists && await fs.stat(root).then(() => true, () => false), false, 'removed vault must not be recreated by an orphan');
  assert.deepEqual(hooks.length, 2);
});

test('owned child is stopped even when vault removal throws and aborts later FIFO hooks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-order-'));
  const hooks: Array<() => void | Promise<void>> = [];
  const t: Cleanup = { after: hook => hooks.push(hook) };
  const child = await startWriter(root);
  t.after(async () => {
    await stopOwnedChildren(t);
    throw new Error('simulated ENOTEMPTY during vault removal');
  });
  ownChildProcess(t, child);
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(runFifoHooks(hooks), /simulated ENOTEMPTY/);
  assert.equal(await childIsDead(child.pid!), true, 'child shutdown must precede the failing removal');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('disposable vault removal retries transient directory races', async t => {
  const { root } = await disposableVault(t);
  assert.ok(root.startsWith(os.tmpdir()));
});
