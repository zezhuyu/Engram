import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import v8 from 'node:v8';

const runner = path.resolve('dist/scripts/benchmark.js');
const run = (...args: string[]) => execFileSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 120_000 });

test('benchmark corpus build is deterministic, replay verifies hashes, and cleanup requires the manifest id', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'engram-benchmark-test-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const first = path.join(temp, 'first'), second = path.join(temp, 'second');
  const a = JSON.parse(run('build', '--size', '10', '--seed', '17', '--root', first, '--retain')) as { corpusId: string };
  const b = JSON.parse(run('build', '--size', '10', '--seed', '17', '--root', second, '--retain')) as { corpusId: string };
  assert.equal(a.corpusId, b.corpusId, 'identical seed/configuration generates identical canonical corpus hashes');
  const partial = path.join(temp, 'partial');
  const partialResult = JSON.parse(run('build', '--size', '10', '--seed', '17', '--root', partial, '--retain', '--stop-after', '5')) as { mode: string; documents: number };
  assert.equal(partialResult.mode, 'build-partial'); assert.equal(partialResult.documents, 5);
  await assert.rejects(stat(path.join(partial, '.engram-benchmark-manifest.json')));
  const resumed = JSON.parse(run('build', '--size', '10', '--seed', '17', '--root', partial, '--resume')) as { corpusId: string };
  assert.equal(resumed.corpusId, a.corpusId, 'resuming a verified deterministic prefix yields the same corpus hash as a clean build');
  const interruptedFinalization = path.join(temp, 'finalization');
  const completedBuild = JSON.parse(run('build', '--size', '10', '--seed', '17', '--root', interruptedFinalization, '--retain')) as { corpusId: string };
  await rm(path.join(interruptedFinalization, '.engram-benchmark-manifest.json'));
  const finalized = JSON.parse(run('build', '--size', '10', '--seed', '17', '--root', interruptedFinalization, '--resume')) as { corpusId: string };
  assert.equal(finalized.corpusId, completedBuild.corpusId, 'a full committed deterministic journal can safely recover an interrupted manifest finalization');
  const manifestPath = path.join(first, '.engram-benchmark-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { documents: number; files: Array<{ path: string; sha256: string }>; workloads: unknown[]; treeState: string; sourceBinding: { fingerprint: string; workingTreeSourceFingerprint: string; fullSourceFileCount: number; files: Record<string, string> } };
  assert.ok(manifest.files.length > 10);
  assert.equal(manifest.workloads.length, 12);
  assert.ok(['clean', 'dirty', 'no-git'].includes(manifest.treeState));
  assert.equal(manifest.sourceBinding.fingerprint, manifest.sourceBinding.workingTreeSourceFingerprint);
  assert.ok(manifest.sourceBinding.fullSourceFileCount > 100);
  const outputDir = path.join(temp, 'reports');
  const replayOutput = JSON.parse(run('replay', '--root', first, '--runs', '3', '--warmups', '0', '--output-dir', outputDir)) as { parityAll: boolean; parityComplete: boolean; corpusId: string };
  assert.equal(replayOutput.parityAll, true); assert.equal(replayOutput.parityComplete, true);
  assert.equal(replayOutput.corpusId, a.corpusId);
  const report = JSON.parse(await readFile(path.join(outputDir, (await readdir(outputDir))[0]! ), 'utf8')) as { treeState: string; instrumentation: Record<string, unknown>; queryPlans: unknown[]; memory: { allocatedBytes: number | null; startAllocatedBytes: number | null; endAllocatedBytes: number | null; allocationCounter: string }; parity: Record<string, boolean | null>; parityComplete: boolean; filesystem: Record<string, { hits: number; expectedHits: number | null; correct: boolean | null }>; sourceBinding: { fingerprint: string; workingTreeSourceFingerprint: string; fullSourceFileCount: number }; corpusProvenance: { generatorMatchesCurrent: boolean; verifiedFiles: number; verifiedJournalEvents: number; manifestSha256: string } };
  assert.ok(['clean', 'dirty', 'no-git'].includes(report.treeState));
  assert.ok(Object.keys(report.instrumentation).some(key => key.includes('candidate.discovery')));
  assert.ok(report.queryPlans.length > 0);
  // V8's allocation counter does not exist on every Node line (it is absent on Node 22): the report must then say so and carry no allocation numbers at all.
  if (report.memory.allocationCounter === 'v8.total_allocated_bytes') { assert.ok(Number.isFinite(report.memory.allocatedBytes) && report.memory.allocatedBytes! > 0); assert.ok(report.memory.endAllocatedBytes! > report.memory.startAllocatedBytes!); }
  else { assert.equal(report.memory.allocationCounter, 'unavailable'); assert.equal(report.memory.allocatedBytes, null); assert.equal(report.memory.startAllocatedBytes, null); assert.equal(report.memory.endAllocatedBytes, null); assert.equal('v8' in process.versions && 'total_allocated_bytes' in v8.getHeapStatistics(), false, 'unavailable is only valid when this Node really lacks the counter'); }
  assert.ok(Object.values(report.parity).every(value => value === true)); assert.equal(report.parityComplete, true);
  assert.equal(report.filesystem['grep-rare']!.correct, true, 'known-count results are checked against the deterministic oracle');
  assert.equal(report.filesystem['grep-common']!.correct, null, 'an unknown expected count stays unverified instead of inheriting a pass boolean');
  assert.equal(report.sourceBinding.fingerprint, manifest.sourceBinding.fingerprint);
  assert.equal(report.sourceBinding.fingerprint, report.sourceBinding.workingTreeSourceFingerprint);
  assert.ok(report.sourceBinding.fullSourceFileCount > 100);
  assert.equal(report.corpusProvenance.generatorMatchesCurrent, true);
  assert.equal(report.corpusProvenance.verifiedFiles, manifest.files.length);
  assert.equal(report.corpusProvenance.verifiedJournalEvents, manifest.documents);
  assert.match(report.corpusProvenance.manifestSha256, /^[a-f0-9]{64}$/);
  const tamperedManifest = structuredClone(manifest); tamperedManifest.files[0]!.sha256 = '0'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(tamperedManifest)}\n`);
  assert.throws(() => run('replay', '--root', first, '--runs', '3', '--warmups', '0', '--output-dir', outputDir), /Corpus hash mismatch/);
  assert.throws(() => run('cleanup', '--root', first, '--confirm-id', 'wrong'), /Refusing cleanup/);
  // Restore the manifest source binding so the explicit cleanup validates this generated corpus.
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  run('cleanup', '--root', first, '--confirm-id', a.corpusId);
});
