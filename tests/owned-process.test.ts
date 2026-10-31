import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ownChildProcess, stopOwnedChildProcess } from './helpers/owned-process.js';

test('test child cleanup escalates only its owned child after SIGTERM is ignored', async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  ownChildProcess(t, child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
  });
  await stopOwnedChildProcess(child, 100);
  assert.equal(child.signalCode, 'SIGKILL');
});
