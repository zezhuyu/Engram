import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('query benchmark evidence binds the exact source set consumed by release policy', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'engram-query-benchmark-evidence-'));
  t.after(async () => rm(output, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [path.resolve('dist/scripts/benchmark-query.js'), '10', '3', '17'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, BENCH_QUERY_REPORT_DIR: output }, timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(await readFile(path.join(output, '10.json'), 'utf8')) as {
    sourceBinding?: { fingerprint?: string; workingTreeSourceFingerprint?: string; fullSourceFileCount?: number; files?: Record<string, string> };
    treeState?: string;
  };
  assert.ok(['clean', 'dirty', 'no-git'].includes(report.treeState ?? ''), 'release-read benchmark reports must declare source tree state');
  assert.ok(report.sourceBinding);
  assert.equal(report.sourceBinding.fingerprint, report.sourceBinding.workingTreeSourceFingerprint);
  assert.ok((report.sourceBinding.fullSourceFileCount ?? 0) > 100);
  assert.ok(report.sourceBinding.files?.['packages/core/vault.ts']);
  assert.ok(report.sourceBinding.files?.['scripts/benchmark.ts']);
});
