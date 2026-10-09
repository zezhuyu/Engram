import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { disposableVault, sleep } from '../helpers/disposable-vault.js';
import { modules, runChild } from '../helpers/child.js';
import { recordCase } from '../helpers/report.js';
import { withVaultLock } from '../../packages/storage-local/index.js';

const contender = (root: string, holdMs: number) => `import {withVaultLock} from ${JSON.stringify(modules.storage)};
const start=Date.now();try{await withVaultLock(${JSON.stringify(root)},async()=>{console.log('ACQ '+JSON.stringify({start,acq:Date.now(),pid:process.pid}));await new Promise(r=>setTimeout(r,${holdMs}));});}catch(e){console.log('ERR '+e.message);process.exitCode=2;}`;
const parse = (out: string) => out.split('\n').filter(l => l.startsWith('ACQ ')).map(l => JSON.parse(l.slice(4)) as { start: number; acq: number; pid: number });

test('60 contenders: every one acquires, in FIFO order of arrival, with bounded waiting', async t => {
  const { root } = await disposableVault(t);
  const runs = await Promise.all(Array.from({ length: 60 }, (_, i) => sleep(i * 25).then(() => runChild(contender(root, 20)))));
  for (const r of runs) { assert.equal(r.code, 0, r.stdout + r.stderr.slice(0, 300)); }
  const acquisitions = runs.flatMap(r => parse(r.stdout)); assert.equal(acquisitions.length, 60);
  const byAcq = [...acquisitions].sort((a, b) => a.acq - b.acq);
  // Contenders that began waiting clearly earlier (>400 ms, beyond process-start jitter) must not be overtaken.
  let overtakes = 0; for (let i = 0; i < byAcq.length; i++) for (let j = i + 1; j < byAcq.length; j++) if (byAcq[i]!.start > byAcq[j]!.start + 400) overtakes++;
  assert.equal(overtakes, 0, 'no contender was overtaken by one that arrived much later');
  const waits = acquisitions.map(a => a.acq - a.start); const max = Math.max(...waits);
  assert.ok(max < 8000, `longest wait ${max} ms`);
  recordCase({ suite: 'isolation', name: 'lock-fifo-60', status: 'PASS', detail: { maxWaitMs: max, p50WaitMs: waits.sort((a, b) => a - b)[30] } });
});

test('CPU oversubscription (2x cores of busy processes plus 40 contenders): zero lock timeouts', async t => {
  const { root } = await disposableVault(t);
  const burners = Array.from({ length: os.cpus().length * 2 }, () => spawn(process.execPath, ['-e', 'const end=Date.now()+9000;while(Date.now()<end){}'], { stdio: 'ignore' }));
  t.after(() => { for (const b of burners) b.kill('SIGKILL'); });
  const runs = await Promise.all(Array.from({ length: 40 }, () => runChild(contender(root, 25))));
  const timeouts = runs.filter(r => r.stdout.includes('ERR '));
  assert.equal(timeouts.length, 0, `${timeouts.length} of 40 timed out`);
  assert.equal(runs.flatMap(r => parse(r.stdout)).length, 40);
  recordCase({ suite: 'isolation', name: 'lock-oversubscribed', status: 'PASS', detail: { contenders: 40, burners: burners.length } });
});

test('a waiter killed with SIGKILL, and a frozen (SIGSTOP) waiter, do not block the queue', async t => {
  const { root } = await disposableVault(t);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const holder = withVaultLock(root, () => hold);
  await sleep(150);
  const dying = spawn(process.execPath, ['--input-type=module', '-e', contender(root, 10)], { stdio: 'ignore' });
  await sleep(200); dying.kill('SIGKILL');
  const frozen = spawn(process.execPath, ['--input-type=module', '-e', contender(root, 10)], { stdio: 'ignore' });
  await sleep(300); frozen.kill('SIGSTOP');
  t.after(() => { frozen.kill('SIGCONT'); frozen.kill('SIGKILL'); });
  const live = runChild(contender(root, 10));
  await sleep(200); release(); await holder;
  const started = Date.now(); const r = await live;
  assert.equal(r.code, 0, r.stdout + r.stderr.slice(0, 200));
  assert.ok(Date.now() - started < 6000, 'dead and frozen tickets are skipped within the heartbeat window');
  recordCase({ suite: 'isolation', name: 'lock-dead-and-frozen-waiters', status: 'PASS', detail: { waitedMs: Date.now() - started } });
});

test('a lock holder killed mid-critical-section is reclaimed and the queue continues', async t => {
  const { root } = await disposableVault(t);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import {withVaultLock} from ${JSON.stringify(modules.storage)};await withVaultLock(${JSON.stringify(root)},async()=>{console.log('HELD');await new Promise(()=>{});});`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>(resolve => holder.stdout!.once('data', () => resolve()));
  const waiting = runChild(contender(root, 10));
  await sleep(200); holder.kill('SIGKILL');
  const r = await waiting; assert.equal(r.code, 0, r.stdout + r.stderr.slice(0, 200));
  recordCase({ suite: 'isolation', name: 'lock-killed-holder-with-queue', status: 'PASS' });
});
