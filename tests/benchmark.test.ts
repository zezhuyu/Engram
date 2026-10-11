import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  const manifest = JSON.parse(await readFile(path.join(first, '.engram-benchmark-manifest.json'), 'utf8')) as { files: Array<{ path: string; sha256: string }>; workloads: unknown[] };
  assert.ok(manifest.files.length > 10);
  assert.equal(manifest.workloads.length, 12);
  const outputDir = path.join(temp, 'reports');
  const replayOutput = JSON.parse(run('replay', '--root', first, '--runs', '3', '--warmups', '0', '--output-dir', outputDir)) as { parityAll: boolean; parityComplete: boolean; corpusId: string };
  assert.equal(replayOutput.parityAll, true); assert.equal(replayOutput.parityComplete, true);
  assert.equal(replayOutput.corpusId, a.corpusId);
  const report = JSON.parse(await readFile(path.join(outputDir, (await readdir(outputDir))[0]! ), 'utf8')) as { instrumentation: Record<string, unknown>; queryPlans: unknown[]; memory: { allocatedBytes: number }; parity: Record<string, boolean | null>; parityComplete: boolean };
  assert.ok(Object.keys(report.instrumentation).some(key => key.includes('candidate.discovery')));
  assert.ok(report.queryPlans.length > 0);
  assert.ok(report.memory.allocatedBytes > 0);
  assert.ok(Object.values(report.parity).every(value => value === true)); assert.equal(report.parityComplete, true);
  assert.throws(() => run('cleanup', '--root', first, '--confirm-id', 'wrong'), /Refusing cleanup/);
  run('cleanup', '--root', first, '--confirm-id', a.corpusId);
});
