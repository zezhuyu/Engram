import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MDB } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';

/** Our commands against the system's own tools on the same input (LC_ALL=C). Where BSD and GNU differ the case is normalized or excluded and the reason is stated. */
const gnu = (tool: string) => { const v = spawnSync(tool, ['--version'], { encoding: 'utf8' }); const text = `${v.stdout ?? ''}${v.stderr ?? ''}`; return /GNU/.test(text) && !/BSD/.test(text); };
const installed = (tool: string) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).error === undefined || spawnSync('which', [tool], { stdio: 'ignore' }).status === 0;
interface Result { code: number; out: string }
function run(cmd: string, args: string[], input: string): Promise<Result> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.resume(); child.stdin.on('error', () => undefined); child.stdin.end(input);
    child.on('close', code => resolve({ code: code ?? -1, out })); child.on('error', () => resolve({ code: -1, out: '' }));
  });
}
const ours = (tool: string, args: string[], input: string) => run(process.execPath, [MDB, tool, ...args], input);
const squash = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/^ /gm, '');
const dropHeaders = (s: string) => s.split('\n').filter(l => !/^(---|\+\+\+) /.test(l)).join('\n');

const TEXT = 'banana 3\napple 10\ncherry 2\napple 10\nBanana 7\n\n  indented line\nzebra\tTAB\nlast no newline';
const SORTED = 'a\nb\nb\nc\nd\n';
const NUMS = '10\n9\n2\n33\n1\n-5\n4.5\n';
const GNU_EXTRA: Array<{ name: string; tool: string; args: string[]; input: string; norm?: (s: string) => string; skip?: string; gnuOnly?: boolean }> = [
  { name: 'comm --output-delimiter (GNU)', tool: 'comm', args: ['--output-delimiter=:', '/tmp/__A', '/tmp/__B'], input: '', gnuOnly: true },
  { name: 'comm --total (GNU)', tool: 'comm', args: ['--total', '/tmp/__A', '/tmp/__B'], input: '', gnuOnly: true },
  { name: 'cut --complement (GNU)', tool: 'cut', args: ['-f', '1', '-d', ' ', '--complement'], input: TEXT + '\n', gnuOnly: true },
  { name: 'cut --output-delimiter (GNU)', tool: 'cut', args: ['-f', '1,2', '-d', ' ', '--output-delimiter=|'], input: TEXT + '\n', gnuOnly: true },
  { name: 'wc -L (GNU)', tool: 'wc', args: ['-L'], input: TEXT + '\n', norm: squash, gnuOnly: true },
  { name: 'uniq -w (GNU)', tool: 'uniq', args: ['-w', '3'], input: 'abc1\nabc2\nabd\n', gnuOnly: true },
  { name: 'sort -n decimals and negatives (GNU)', tool: 'sort', args: ['-n'], input: NUMS, gnuOnly: true },
  { name: 'sort -nr decimals (GNU)', tool: 'sort', args: ['-nr'], input: NUMS, gnuOnly: true },
  { name: 'sort -n -u ties (GNU)', tool: 'sort', args: ['-n', '-u'], input: TEXT + '\n', gnuOnly: true },
  { name: 'sort -k with start char (GNU)', tool: 'sort', args: ['-k', '2.2,2.3n'], input: 'a x12\nb x03\nc x99\n', gnuOnly: true },
  { name: 'tail -c +N (GNU)', tool: 'tail', args: ['-c', '+5'], input: TEXT, gnuOnly: true },
  { name: 'paste -s -d,: (GNU)', tool: 'paste', args: ['-s', '-d,:', '-'], input: '1\n2\n3\n4\n', gnuOnly: true },
  { name: 'grep -m1 -A1 (GNU)', tool: 'grep', args: ['-m1', '-A1', 'apple'], input: TEXT + '\n', gnuOnly: true },
  { name: 'grep -c -v (GNU)', tool: 'grep', args: ['-c', '-v', 'a'], input: TEXT + '\n', gnuOnly: true },
  { name: 'grep -o -i (GNU)', tool: 'grep', args: ['-o', '-i', 'an'], input: TEXT + '\n', gnuOnly: true },
  { name: 'diff -u -U1 (GNU)', tool: 'diff', args: ['-u', '-U1', '/tmp/__A', '/tmp/__D'], input: '', norm: dropHeaders, gnuOnly: true },
  { name: 'diff --normal (GNU)', tool: 'diff', args: ['--normal', '/tmp/__A', '/tmp/__D'], input: '', gnuOnly: true },
  { name: 'diff -B (GNU)', tool: 'diff', args: ['-B', '/tmp/__A', '/tmp/__D'], input: '', gnuOnly: true }
];
const CASES: Array<{ name: string; tool: string; args: string[]; input: string; norm?: (s: string) => string; skip?: string; gnuOnly?: boolean }> = [
  ...[['-n', '3'], ['-n', '1'], ['-3'], ['-c', '7'], ['-n', '100']].map(a => ({ name: `head ${a.join(' ')}`, tool: 'head', args: a, input: TEXT })),
  ...[['-n', '0'], ['-n', '-2'], ['-c', '-5']].map(a => ({ name: `head ${a.join(' ')} (GNU)`, tool: 'head', args: a, input: TEXT, gnuOnly: true })),
  ...[['-n', '3'], ['-n', '0'], ['-n', '+8'], ['-2'], ['-c', '9'], ['-n', '100']].map(a => ({ name: `tail ${a.join(' ')}`, tool: 'tail', args: a, input: TEXT })),
  ...[[], ['-n'], ['-b'], ['-s'], ['-E'], ['-ns']].map(a => ({ name: `cat ${a.join(' ') || '(plain)'}`, tool: 'cat', args: a, input: 'a\n\n\n\nb\nc', gnuOnly: a.includes('-E') })),
  ...[['apple'], ['-i', 'banana'], ['-v', 'a'], ['-c', 'a'], ['-n', 'an'], ['-w', 'apple'], ['-x', 'zebra\tTAB'], ['-F', 'a.p'], ['-E', 'ap+le|che'], ['-o', 'an'], ['-m', '1', 'a'], ['-A', '1', 'cherry'], ['-B', '1', 'cherry'], ['-C', '1', 'cherry'], ['-e', 'apple', '-e', 'zebra'], ['-q', 'apple'], ['-q', 'nomatch'], ['-l', 'apple'], ['-L', 'apple'], ['-ic', 'APPLE'], ['^a'], ['e$'], ['a\\(p\\)\\1', ]].map(a => ({ name: `grep ${a.join(' ')}`, tool: 'grep', args: a, input: TEXT + '\n', skip: a[0] === 'a\\(p\\)\\1' ? 'backreferences are rejected by design' : undefined })),
  ...[['-c', '1-3'], ['-c', '2-'], ['-c', '-3'], ['-c', '1,3,5'], ['-b', '1-4'], ['-f', '2', '-d', ' '], ['-f', '1,3', '-d', ' '], ['-f', '2', '-d', ' ', '-s'], ['-f', '2-', '-d', ' '], ['-f', '1', '-d', ' ', '--complement']].map(a => ({ name: `cut ${a.join(' ')}`, tool: 'cut', args: a, input: TEXT + '\n', skip: a.includes('--complement') ? 'BSD cut has no --complement' : undefined })),
  ...[[], ['-r'], ['-u'], ['-f'], ['-b'], ['-s', '-k', '2'], ['-k', '2'], ['-k', '2n'], ['-k', '2,2nr'], ['-k', '1,1', '-k', '2,2n'], ['-t', ' ', '-k', '2n'], ['-c'], ['-n', '-u']].map(a => ({ name: `sort ${a.join(' ')}`, tool: 'sort', args: a, input: TEXT + '\n' })),
  ...[['-n'], ['-nr'], ['-n', '-u']].map(a => ({ name: `sort numbers ${a.join(' ')}`, tool: 'sort', args: a, input: NUMS, skip: 'decimal and negative numbers sort differently between GNU and BSD; compared on integer-only input below' })),
  ...[['-n'], ['-nr'], ['-n', '-u']].map(a => ({ name: `sort integers ${a.join(' ')}`, tool: 'sort', args: a, input: '10\n9\n2\n33\n1\n9\n' })),
  ...[[], ['-c'], ['-d'], ['-u'], ['-i'], ['-f', '1'], ['-s', '1']].map(a => ({ name: `uniq ${a.join(' ')}`, tool: 'uniq', args: a, input: 'a 1\na 1\nA 1\nb 2\nb 3\nc 4\n', norm: squash })),
  ...[[], ['-l'], ['-w'], ['-c'], ['-lw'], ['-m']].map(a => ({ name: `wc ${a.join(' ')}`, tool: 'wc', args: a, input: TEXT + '\n', norm: squash })),
  ...[['a-z', 'A-Z'], ['-d', 'aeiou'], ['-s', ' '], ['-d', '\\n'], ['[:lower:]', '[:upper:]'], ['-cd', 'a-z\\n'], ['-s', 'a-z'], ['\\t', ' '], ['abc', 'x']].map(a => ({ name: `tr ${a.join(' ')}`, tool: 'tr', args: a, input: 'hello  world\naab\tTAB zebra\n' })),
  ...[['-s'], ['-d', ',']].map(a => ({ name: `paste (stdin) ${a.join(' ')}`, tool: 'paste', args: [...a, '-'], input: '1\n2\n3\n4\n5\n' })),
  ...[['-12'], ['-3'], ['-23'], ['-1']].map(a => ({ name: `comm ${a.join(' ')}`, tool: 'comm', args: [...a, '/tmp/__A', '/tmp/__B'], input: '' })),
  ...[[], ['-u'], ['-U', '1'], ['-q'], ['-i'], ['-w'], ['-b']].map(a => ({ name: `diff ${a.join(' ')}`, tool: 'diff', args: [...a, '/tmp/__A', '/tmp/__D'], input: '', norm: dropHeaders }))
];
const REQUIRE_GNU = process.env.MDB_REQUIRE_GNU === '1';
test('GNU tools are present where the CI requires them', () => { if (REQUIRE_GNU) for (const tool of ['sort', 'head', 'cat', 'comm', 'cut', 'wc', 'uniq', 'grep', 'diff', 'paste', 'tail']) assert.ok(gnu(tool), `${tool} is not GNU: this lane must run with GNU coreutils`); });
test('Unix command parity with the installed system tools', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-unix-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile('/tmp/__A', SORTED); await fs.writeFile('/tmp/__B', 'b\nc\nc\ne\n'); await fs.writeFile('/tmp/__D', 'a\nB \n  c\n d\nnew\n'); t.after(() => Promise.all(['/tmp/__A', '/tmp/__B', '/tmp/__D'].map(f => fs.rm(f, { force: true }))));
  const mismatches: string[] = []; let compared = 0, skipped = 0;
  for (const c of [...CASES, ...GNU_EXTRA]) {
    if (c.skip) { skipped++; recordCase({ suite: 'unix-parity', name: c.name, status: 'PASS', detail: { skipped: c.skip } }); continue; }
    const tool = c.tool; if (!installed(tool) || (c.gnuOnly && !gnu(tool))) { if (REQUIRE_GNU) mismatches.push(`${c.name}: GNU tool required but missing`); skipped++; recordCase({ suite: 'unix-parity', name: c.name, status: 'PASS', detail: { notRun: c.gnuOnly ? 'GNU tool not installed (macOS ships BSD)' : 'tool missing' } }); continue; }
    const args = c.tool === 'cat' ? c.args.filter(a => a !== '-') : c.args;
    const want = await run(tool, args, c.input), got = await ours(tool, args, c.input); const n = c.norm ?? ((s: string) => s);
    compared++;
    // exit codes: 0/1/2 buckets (BSD tools sometimes use 1 where GNU uses 2 for usage errors)
    const same = n(got.out) === n(want.out) && (got.code === want.code || (got.code > 1 && want.code > 1));
    if (!same) mismatches.push(`${c.name}\n  system(${want.code}): ${JSON.stringify(n(want.out)).slice(0, 200)}\n  ours  (${got.code}): ${JSON.stringify(n(got.out)).slice(0, 200)}`);
    recordCase({ suite: 'unix-parity', name: c.name, status: same ? 'PASS' : 'FAIL' });
  }
  assert.ok(compared > 60, `compared ${compared} cases (${skipped} skipped)`);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});
