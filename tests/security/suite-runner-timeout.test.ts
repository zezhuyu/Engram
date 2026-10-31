import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTestProcess } from '../../scripts/lib/suite.js';

test('verification suite timeout terminates only its owned process group, including a signal-resistant descendant', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-suite-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'child-wrote');
  const nested = `process.on('SIGTERM',()=>{});setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),15);`;
  const source = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},20);`;
  const result = await runTestProcess(['--eval', source], process.env, 100);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 124);
  assert.match(result.stderr, /terminating its owned process tree/);
  await new Promise(resolve => setTimeout(resolve, 2_200));
  const stoppedSize = await fs.stat(marker).then(stat => stat.size).catch(() => 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const finalSize = await fs.stat(marker).then(stat => stat.size).catch(() => 0);
  assert.equal(finalSize, stoppedSize, 'the descendant cannot continue writing after timeout escalation');
});

test('verification timeout reaps a detached signal-resistant descendant that keeps output pipes open', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-suite-detached-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'detached-child-wrote');
  const nested = `process.on('SIGTERM',()=>{});setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),15);`;
  // detached creates a new process group; inheriting stdout/stderr also
  // reproduces the condition where `close` never arrives after the parent dies.
  const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(nested)}],{detached:true,stdio:['ignore','inherit','inherit']});setInterval(()=>{},20);`;
  const result = await runTestProcess(['--eval', source], process.env, 100);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 124);
  assert.match(result.stderr, /owned process tree/);
  const stoppedSize = await fs.stat(marker).then(stat => stat.size).catch(() => 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const finalSize = await fs.stat(marker).then(stat => stat.size).catch(() => 0);
  assert.equal(finalSize, stoppedSize, 'the detached descendant cannot continue writing after timeout');
});
