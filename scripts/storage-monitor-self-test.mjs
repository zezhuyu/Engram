#!/usr/bin/env node
/** Destructive-to-its-own-disposable-root monitor tests; never run without explicit root confirmation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeRoots, logicalGrowth, allocatedFileGrowth, allocatedFilePositiveGrowth, fileChanges, duAllocatedGrowth, filesystemGrowth, aggregateCampaignGrowth, diskSnapshot, parseLsofFiles, classifyOpenPath, engramStorageScopes } from './storage-live-monitor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mib = 1024 ** 2;

function inventory(rows) {
  return { files: new Map(rows.map(([name, device, inode, logicalBytes, allocatedBytes, mtimeMs = 1]) => [name, { path: name, device, inode, logicalBytes, allocatedBytes, mtimeMs }])) };
}

function accountingSelfTest() {
  assert.deepEqual(normalizeRoots(['/tmp/a', '/tmp/a/nested', '/tmp/b']), ['/tmp/a', '/tmp/b']);
  const before = inventory([['/a/same', 'd', 1, 4, 4096], ['/b/deleted', 'd', 2, 8, 4096]]);
  const after = inventory([['/a/same', 'd', 1, 12, 8192], ['/b/new', 'd', 3, 32, 8192]]);
  assert.equal(logicalGrowth(before, after), 32);
  assert.equal(allocatedFileGrowth(before, after), 8192, 'net allocation includes deletion');
  assert.equal(allocatedFilePositiveGrowth(before, after), 12288, 'positive allocation does not let deletions hide growth');
  assert.deepEqual(fileChanges(before, after).map(change => change.type).sort(), ['created', 'deleted', 'grew']);
  assert.deepEqual(fileChanges(before, after, ['/b']).map(change => change.type), ['grew']);
  const replacementBefore = inventory([['/r/item', 'd', 9, 8, 4096]]);
  const replacementAfter = inventory([['/r/item', 'd', 10, 12, 8192]]);
  assert.deepEqual(fileChanges(replacementBefore, replacementAfter).map(change => change.type), ['replaced']);
  const hardlinks = inventory([['/h/one', 'd', 11, 8, 4096], ['/h/two', 'd', 11, 8, 4096]]);
  assert.equal(allocatedFileGrowth(inventory([]), hardlinks), 4096, 'hard links count one inode allocation');
  const duBefore = { complete: true, directories: { '/tmp/a': { duAllocatedBytes: 100, complete: true, usable: true }, '/tmp/a/child': { duAllocatedBytes: 40, complete: true, usable: true }, '/tmp/b': { duAllocatedBytes: 200, complete: true, usable: true } } };
  const duAfter = { complete: true, directories: { '/tmp/a': { duAllocatedBytes: 130, complete: true, usable: true }, '/tmp/a/child': { duAllocatedBytes: 50, complete: true, usable: true }, '/tmp/b': { duAllocatedBytes: 210, complete: true, usable: true } } };
  assert.deepEqual(duAllocatedGrowth(duBefore, duAfter, ['/tmp/a', '/tmp/a/child', '/tmp/b']), { complete: true, usable: true, bytes: 40, excludedPaths: [], coverage: 'COMPLETE' });
  const partialDu = { complete: false, excludedPaths: [{ path: '/private/tmp/devio_semaphore_USB_Receiver@08330000', reason: 'authorized exact exclusion' },], directories: { '/private/tmp': { duAllocatedBytes: 100, complete: false, usable: true } } };
  const partialDuAfter = { ...partialDu, directories: { '/private/tmp': { duAllocatedBytes: 110, complete: false, usable: true } } };
  const partialDelta = duAllocatedGrowth(partialDu, partialDuAfter, ['/private/tmp']);
  assert.equal(partialDelta.usable, true);
  assert.equal(partialDelta.complete, false, 'known exclusions must never be called complete');
  assert.equal(partialDelta.bytes, 10);
  assert.equal(partialDelta.coverage, 'PARTIAL_EXACT_PATH_EXCLUSION');
  const unreadableDu = { directories: { '/private/tmp': { complete: false, usable: false } } };
  assert.equal(duAllocatedGrowth(unreadableDu, unreadableDu, ['/private/tmp']).usable, false, 'unexpected unreadable paths remain fail-closed');
  const disk = used => ({ complete: true, devices: [{ device: 'd', usedBytes: used }] });
  assert.deepEqual(filesystemGrowth(disk(100), disk(125)), { complete: true, netBytes: 25, positiveGrowthBytes: 25 });
  assert.equal(filesystemGrowth(disk(125), disk(100)).positiveGrowthBytes, 0);
  assert.equal(aggregateCampaignGrowth(100, 1_000, 1_250), 350);
  assert.equal(aggregateCampaignGrowth(100, 1_250, 1_000), 100, 'disk usage reductions cannot refund campaign growth');
  const lsof = parseLsofFiles('p123\nf cwd\na\ntDIR\nn/Users/example/run\nf12\na w\ntREG\nn/Users/example/run/data/file\nf13\na r\ntREG\nn/Users/example/private\n');
  assert.deepEqual(lsof.map(({ fd, accessMode, writable, type, name }) => ({ fd, accessMode, writable, type, name })), [
    { fd: 'cwd', accessMode: '', writable: false, type: 'DIR', name: '/Users/example/run' },
    { fd: '12', accessMode: 'w', writable: true, type: 'REG', name: '/Users/example/run/data/file' },
    { fd: '13', accessMode: 'r', writable: false, type: 'REG', name: '/Users/example/private' },
  ]);
  const scopes = engramStorageScopes('/Users/example/run', ['/Users/example/run/data'], ['/private/tmp', '/Users/example/run/tmp'], {
    ENGRAM_STATE_DIR: '/Users/example/run/state', ENGRAM_CACHE_DIR: '/Users/example/run/cache', ENGRAM_OUTBOX: '/Users/example/run/outbox',
    ENGRAM_REMOTE_SPOOL: '/Users/example/run/spool', ENGRAM_USER_CONFIG: '/Users/example/run/config/user.json', TMPDIR: '/Users/example/run/tmp',
  }, '/Users/example');
  assert.equal(classifyOpenPath('/Users/example/run/data/doc.md', scopes), 'CONFIGURED_DATA_ROOT');
  assert.equal(classifyOpenPath('/Users/example/run/state/state.json', scopes), 'CONFIGURED_ENGRAM_SIDE_STORAGE');
  assert.equal(classifyOpenPath('/Users/example/run/tmp/work', scopes), 'CONFIGURED_ENGRAM_TEMP');
  assert.equal(classifyOpenPath('/Users/example/.cache/engram/cache.db', scopes), 'LEGACY_HOME_XDG');
  assert.equal(classifyOpenPath('/Users/example/private/file', scopes), 'OUTSIDE_APPROVED_ROOTS');
  assert.equal(classifyOpenPath('/private/tmp/engram-job-123/scratch', scopes), 'ENGRAM_TEMP');
}

const args = process.argv.slice(2);
if (args.includes('--accounting-only')) {
  accountingSelfTest();
  process.stdout.write('storage accounting self-test: PASS\n');
  process.exit(0);
}

const rootArg = args.indexOf('--root');
if (rootArg < 0 || !args[rootArg + 1] || !args.includes('--confirm-disposable-root')) {
  process.stderr.write('Usage: node scripts/storage-monitor-self-test.mjs --root EXISTING_DISPOSABLE_ROOT --confirm-disposable-root\nNo directories are created without both arguments.\n');
  process.exit(2);
}
const approvedRoot = path.resolve(args[rootArg + 1]);
const rootStat = await fs.lstat(approvedRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(approvedRoot) !== approvedRoot) throw new Error('Self-test root must be an existing real directory, not a symlink');
if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) throw new Error('Self-test root must be owned by the current user');
const existingEntries = await fs.readdir(approvedRoot);
if (existingEntries.some(entry => !entry.startsWith('storage-monitor-self-test-'))) throw new Error('Self-test root contains non-self-test entries; refusing to mix with existing data');
const runRoot = path.join(approvedRoot, `storage-monitor-self-test-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
await fs.mkdir(runRoot, { mode: 0o700 });
process.stdout.write(`self-test artifacts retained at ${runRoot}; no cleanup is performed\n`);
const suiteStartedAt = new Date().toISOString();
const aggregateBaseline = await diskSnapshot([runRoot]);
if (!aggregateBaseline.complete) throw new Error(`aggregate self-test disk baseline incomplete: ${JSON.stringify(aggregateBaseline.errors)}`);
if (aggregateBaseline.devices.length !== 1) throw new Error('aggregate self-test guard currently requires exactly one filesystem volume');
// Count all completed monitored test-case positive deltas conservatively toward
// the owner's aggregate cap; failed preflight/harness attempts added no payloads
// except the explicitly recorded first-case and two-directory growth cases.
const priorObservedGrowthBytes = 1_524_593_664; // Highest documented campaign peak; never reset the approved aggregate guard.
let aggregatePeakBytes = priorObservedGrowthBytes;
async function enforceAggregateGuard() {
  const current = await diskSnapshot([runRoot]);
  const growth = filesystemGrowth(aggregateBaseline, current);
  if (!growth.complete) throw new Error(`aggregate self-test disk sample incomplete: ${growth.error}`);
  aggregatePeakBytes = Math.max(aggregatePeakBytes, aggregateCampaignGrowth(priorObservedGrowthBytes, aggregateBaseline.devices[0].usedBytes, current.devices[0].usedBytes));
  const free = Math.min(...current.devices.map(device => device.availableBytes));
  if (aggregatePeakBytes >= 2 * 1024 ** 3) throw new Error(`aggregate synthetic growth reached 2 GiB cap: ${aggregatePeakBytes}`);
  if (free <= 40 * 1024 ** 3) throw new Error(`available space reached 40 GiB floor: ${free}`);
}
await enforceAggregateGuard();

const monitor = path.join(here, 'storage-live-monitor.mjs');
const node = process.execPath;
const cases = [];
async function runCase(name, script, { budget = 2, expectAbort = false, expectedAbortText, commandArgs = [] } = {}) {
  const caseRoot = path.join(runRoot, name); const dataRoot = path.join(caseRoot, 'data'); const tmpRoot = path.join(caseRoot, 'tmp'); const diagDir = path.join(caseRoot, 'diagnostics');
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const command = [node, '-e', script, dataRoot, ...commandArgs];
  const invocation = [monitor, '--test-root', caseRoot, '--diag-dir', diagDir, '--data-root', dataRoot,
    '--approved-budget-gib', String(budget), '--min-free-gib', '40', '--interval-seconds', '2', '--du-interval-seconds', '10',
    '--campaign-baseline-used-bytes', String(aggregateBaseline.devices[0].usedBytes), '--prior-aggregate-growth-bytes', String(priorObservedGrowthBytes),
    '--scenario', name, '--', ...command];
  const result = spawnSync(node, invocation, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, cwd: process.cwd(),
    env: { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot } });
  if (result.error) throw result.error;
  const output = result.stdout.trim().split('\n').at(-1);
  let summary;
  try { summary = JSON.parse(output); } catch { throw new Error(`${name}: monitor returned no JSON summary (status=${result.status}); stdout=${result.stdout}; stderr=${result.stderr}`); }
  const logs = [];
  for (const entry of await fs.readdir(diagDir)) if (entry.endsWith('.jsonl') || /\.jsonl\.\d+$/.test(entry)) logs.push(...(await fs.readFile(path.join(diagDir, entry), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const record = { name, monitorExitCode: result.status, summary, logs, stderr: result.stderr };
  cases.push(record);
  aggregatePeakBytes = Math.max(aggregatePeakBytes, summary.peakCampaignAggregateGrowthBytes ?? 0);
  await enforceAggregateGuard();
  if (!summary.monitorComplete) throw new Error(`${name}: monitor reported incomplete: ${JSON.stringify(summary.monitorErrors)}`);
  const baseline = logs.find(log => log.type === 'baseline');
  assert(baseline, `${name}: monitor omitted its baseline record`);
  const baselineExclusions = baseline.excludedPaths ?? [];
  const currentExclusions = summary.excludedPaths ?? [];
  assert.deepEqual(currentExclusions.map(item => item.path).sort(), baselineExclusions.map(item => item.path).sort(), `${name}: exclusion set changed during the run`);
  const semaphore = baselineExclusions.filter(item => item.path === '/private/tmp/devio_semaphore_USB_Receiver@08330000');
  assert(semaphore.length <= 1, 'the specifically authorized path may appear at most once');
  if (semaphore.length) {
    assert.equal(summary.filesystemAccountingComplete, false, 'the approved exclusion must be reported as partial coverage');
    assert.equal(semaphore[0].notTraversed, true, 'the exact approved path must not be traversed');
    assert.equal(baselineExclusions.length, 1, 'only the approved exact path may be excluded');
  } else {
    assert.equal(summary.filesystemAccountingComplete, true, 'when the approved path is absent, filesystem coverage should be complete');
    assert.deepEqual(baselineExclusions, [], 'no other path may be excluded');
  }
  if (expectedAbortText) assert(summary.abortReason?.includes(expectedAbortText), `${name}: unexpected abort reason: ${summary.abortReason}`);
  if (expectAbort ? !summary.abortReason : (result.status !== 0 || summary.abortReason)) throw new Error(`${name}: unexpected result: ${JSON.stringify(summary)}`);
  return record;
}

const fiftyMiB = await runCase('file-create-and-growth', `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),f=p.join(process.argv[1],'payload');fs.writeFileSync(f,c.randomBytes(25*1024*1024));setTimeout(()=>{fs.appendFileSync(f,c.randomBytes(25*1024*1024));setTimeout(()=>{},2600)},2600);`);
assert(fiftyMiB.summary.watchedFileLogicalNetDeltaBytes >= 50 * mib);
assert(fiftyMiB.summary.watchedFileAllocatedNetDeltaBytes >= 45 * mib);
assert(fiftyMiB.logs.some(log => log.type === 'sample' && log.fileChanges.some(change => change.path.endsWith('/payload') && change.type === 'grew')));

const independent = await runCase('two-independent-directories', `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');for(const d of ['one','two']){fs.mkdirSync(p.join(process.argv[1],d));fs.writeFileSync(p.join(process.argv[1],d,'payload'),c.randomBytes(10*1024*1024));}setTimeout(()=>{},2600);`);
assert(independent.summary.watchedFileLogicalNetDeltaBytes >= 20 * mib);
assert(independent.summary.fileChanges.filter(change => change.type === 'created').length >= 2);

const transient = await runCase('create-replace-delete', `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),f=p.join(process.argv[1],'transient');fs.writeFileSync(f,c.randomBytes(1024*1024));setTimeout(()=>{const t=f+'.replacement';fs.writeFileSync(t,c.randomBytes(2*1024*1024));fs.renameSync(t,f);setTimeout(()=>{fs.unlinkSync(f);setTimeout(()=>{},2600)},2600)},2600);`);
assert(transient.logs.some(log => log.type === 'sample' && log.fileChanges.some(change => change.path.endsWith('/transient') && change.type === 'created')));
assert(transient.logs.some(log => log.type === 'sample' && log.fileChanges.some(change => change.path.endsWith('/transient') && change.type === 'replaced')));
assert(transient.logs.some(log => log.type === 'sample' && log.fileChanges.some(change => change.path.endsWith('/transient') && change.type === 'deleted')));

const sparse = await runCase('sparse-file', `const fs=require('node:fs'),p=require('node:path'),fd=fs.openSync(p.join(process.argv[1],'sparse'),'w');fs.ftruncateSync(fd,50*1024*1024);fs.closeSync(fd);setTimeout(()=>{},2600);`);
const sparseFile = sparse.summary.residualFiles.find(file => file.path.endsWith('/sparse'));
assert(sparseFile && sparseFile.logicalBytes >= 50 * mib);
assert(sparseFile.allocatedBytes < sparseFile.logicalBytes / 2, `expected sparse allocation, got ${sparseFile.allocatedBytes}/${sparseFile.logicalBytes}`);

const nested = await runCase('nested-child-termination', `const cp=require('node:child_process'),p=require('node:path');const child=cp.spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],require('node:crypto').randomBytes(2*1024*1024));setInterval(()=>{},1000)",p.join(process.argv[1],'child-file')],{stdio:'ignore'});child.unref();setTimeout(()=>{},2600);`, { expectAbort: true, expectedAbortText: 'wrapped command exited while owned process group still had descendants' });
assert(nested.logs.some(log => log.type === 'sample' && log.processes?.filter(proc => proc.pgid === log.ownedProcessGroupId).length >= 2), 'expected both owned parent and nested child in the process-group snapshot');
assert(nested.logs.some(log => log.type === 'process_group_signal' && log.signal === 'SIGINT'));
assert.equal(nested.summary.processGroupEmpty, true);

const ignoring = await runCase('signal-resistant-owned-group', `const cp=require('node:child_process'),fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');cp.spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(p.join(process.argv[1],'breach'),c.randomBytes(12*1024*1024));setInterval(()=>{},1000);`, { budget: 0.01, expectAbort: true });
assert(ignoring.logs.some(log => log.type === 'process_group_signal' && log.signal === 'SIGINT'));
assert(ignoring.logs.some(log => log.type === 'process_group_signal' && log.signal === 'SIGTERM'));
assert(ignoring.logs.some(log => log.type === 'process_group_signal' && log.signal === 'SIGKILL'));
assert.equal(ignoring.summary.processGroupEmpty, true);

const unwatchedDir = path.join(runRoot, 'unwatched-sibling'); await fs.mkdir(unwatchedDir, { mode: 0o700 });
const closedExternal = await runCase('closed-outside-root-write-is-attribution-only', `const fs=require('node:fs'),c=require('node:crypto');fs.writeFileSync(process.argv[2],c.randomBytes(8*1024*1024));setTimeout(()=>{},5000);`, { budget: 0.1, commandArgs: [path.join(unwatchedDir, 'closed-payload')] });
assert.equal(closedExternal.summary.abortReason, null, 'a whole-volume discrepancy below the safety budget is attribution evidence, not an automatic abort');
assert(closedExternal.summary.unexplainedFilesystemGrowthBytes >= 0);
assert(!closedExternal.logs.at(-1).approvedRootFileChanges.some(change => change.path.endsWith('/closed-payload')), 'the closed external file remains outside the approved attribution roots');
const escaped = await runCase('unwatched-sibling-growth', `const fs=require('node:fs'),c=require('node:crypto');const fd=fs.openSync(process.argv[2],'w');fs.writeSync(fd,c.randomBytes(8*1024*1024));setTimeout(()=>{fs.closeSync(fd)},5000);setInterval(()=>{},1000);`, { budget: 0.1, commandArgs: [path.join(unwatchedDir, 'payload')], expectAbort: true, expectedAbortText: 'writable file references outside approved storage roots' });
assert(escaped.logs.some(log => log.type === 'sample' && log.outsideWritableReferences?.some(ref => ref.path === path.join(unwatchedDir, 'payload'))), 'outside-root open write must be attributed to the owned process');
assert(escaped.summary.unexplainedFilesystemGrowthBytes >= 0, 'whole-volume discrepancy must remain separately reported');

const evidence = { status: 'PASS', root: runRoot, startedAt: suiteStartedAt, completedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()}`, node: process.version,
  safety: { maximumGrowthGiB: 2, minimumFreeGiB: 40, strictSubtestBudgetGiB: 0.01, priorObservedGrowthBytesIncluded: priorObservedGrowthBytes, aggregatePeakBytes: aggregatePeakBytes },
  cases: cases.map(({ name, monitorExitCode, summary, logs }) => ({ name, monitorExitCode, summary, eventTypes: [...new Set(logs.map(log => log.type))], processActivityComplete: logs.filter(log => log.type === 'sample').every(log => log.processActivityComplete === true) })) };
await fs.writeFile(path.join(runRoot, 'self-test-summary.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`storage monitor synthetic scenarios: PASS (${cases.length}); evidence ${path.join(runRoot, 'self-test-summary.json')}\n`);
