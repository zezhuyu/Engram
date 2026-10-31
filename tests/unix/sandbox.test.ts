import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { toolStatus } from '../../packages/unix/index.js';

/** Sandboxed execution of installed programmable tools through `mdb filter`. On Linux CI (MDB_REQUIRE_GNU=1) gawk and GNU sed must exist, so nothing here may silently skip. */
const REQUIRE = process.env.MDB_REQUIRE_GNU === '1';
const status = Object.fromEntries(toolStatus().map(t => [t.tool, t]));
const gone = async (f: string) => { try { await fs.stat(f); return false; } catch { return true; } };
const mdbFilter = (tool: string, args: string[], input = 'a b\nc d\n') => run(['filter', tool, ...args], { input });

test('required tools are present on the Linux lane', () => {
  if (!REQUIRE) { recordCase({ suite: 'unix-sandbox', name: 'tools-required', status: 'PASS', detail: { notRun: 'MDB_REQUIRE_GNU not set' } }); return; }
  for (const t of ['jq', 'awk', 'sed']) assert.ok(status[t]?.usable, `${t}: ${status[t]?.reason}`);
  recordCase({ suite: 'unix-sandbox', name: 'tools-required', status: 'PASS' });
});
test('awk: gawk --sandbox runs programs but cannot run commands, redirect, pipe, or read program files', { skip: !REQUIRE && !status.awk?.usable ? 'gawk not installed (NOT_RUN)' : false }, async () => {
  const marker = path.join(os.tmpdir(), `engram-awk-${process.pid}`); await fs.rm(marker, { force: true });
  assert.equal((await mdbFilter('awk', ['{ print $2 }'])).stdout, 'b\nd\n');
  assert.equal((await mdbFilter('awk', ['-F', ' ', '-v', 'x=1', '{ print $1 x }'])).stdout, 'a1\nc1\n');
  for (const program of [`BEGIN { system("touch ${marker}") }`, `{ print > "${marker}" }`, `BEGIN { "echo hi" | getline x; print x }`, `{ print | "cat" }`, `BEGIN { getline < "/etc/passwd"; print }`, `@include "x"`, `BEGIN { print ENVIRON["HOME"] }`]) {
    const r = await mdbFilter('awk', [program]); assert.notEqual(r.code, 0, program); assert.ok(!r.stdout.includes('root:') && !r.stdout.includes('/'), `no data from ${program}`);
  }
  assert.ok(await gone(marker), 'no command ran and no file was created');
  for (const bad of [['-f', '/etc/hosts'], ['-i', 'inplace', '{print}'], ['{print}', '/etc/passwd'], ['--lint', '{print}']]) assert.notEqual((await mdbFilter('awk', bad)).code, 0, bad.join(' '));
  recordCase({ suite: 'unix-sandbox', name: 'gawk', status: 'PASS' });
});
test('sed: GNU sed --sandbox runs scripts but cannot execute, read or write files', { skip: !REQUIRE && !status.sed?.usable ? 'GNU sed not installed (NOT_RUN)' : false }, async () => {
  const marker = path.join(os.tmpdir(), `engram-sed-${process.pid}`); await fs.rm(marker, { force: true });
  assert.equal((await mdbFilter('sed', ['s/a/X/'])).stdout, 'X b\nc d\n');
  assert.equal((await mdbFilter('sed', ['-n', '-e', '2p'])).stdout, 'c d\n');
  assert.equal((await mdbFilter('sed', ['-E', 's/(a) (b)/\\2 \\1/'])).stdout, 'b a\nc d\n');
  for (const script of ['1e touch ' + marker, `s/a/b/e`, `w ${marker}`, `s/a/b/w ${marker}`, 'r /etc/passwd', 'R /etc/passwd', 'W ' + marker]) { const r = await mdbFilter('sed', [script]); assert.notEqual(r.code, 0, script); assert.ok(!r.stdout.includes('root:'), script); }
  assert.ok(await gone(marker), 'sandbox refused every file and command feature');
  for (const bad of [['-i', 's/a/b/'], ['-f', '/etc/hosts'], ['s/a/b/', '/etc/passwd'], ['-s', 's/a/b/'], ['--follow-symlinks', 's/a/b/']]) assert.notEqual((await mdbFilter('sed', bad)).code, 0, bad.join(' '));
  recordCase({ suite: 'unix-sandbox', name: 'gnu-sed', status: 'PASS' });
});
test('the bridge never uses a shell: metacharacters in arguments are data', { skip: !status.jq?.usable ? 'jq unavailable (NOT_RUN)' : false }, async () => {
  const marker = path.join(os.tmpdir(), `engram-meta-${process.pid}`); await fs.rm(marker, { force: true });
  const r = await run(['filter', 'jq', '-r', `"x; touch ${marker}; $(touch ${marker}) \`touch ${marker}\`"`], { input: 'null' }); assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('touch'), 'printed as a string'); assert.ok(await gone(marker));
  const env = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }); void env;
  const leak = await run(['filter', 'jq', '-n', '$ENV | length'], { input: '' }); assert.notEqual(leak.code, 0, '$ENV is refused'); 
  recordCase({ suite: 'unix-sandbox', name: 'no-shell', status: 'PASS' });
});
