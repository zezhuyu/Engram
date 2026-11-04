import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OWNER } from '../packages/core/types.js';
import { Vault } from '../packages/core/vault.js';

test('durable write reports record the source tree state used by release consistency', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'engram-durable-write-report-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const corpus = path.join(temp, 'corpus');
  const vault = new Vault(corpus, OWNER);
  await vault.init();
  await vault.createWorkspace('bench0');
  await writeFile(path.join(corpus, '.engram-benchmark-manifest.json'), JSON.stringify({ corpusId: 'test-corpus', documents: 1 }));
  const run = spawnSync(process.execPath, [path.resolve('dist/scripts/benchmark-durable-write.js'), '--root', corpus, '--commits', '3', '--warmup', '0'], { cwd: temp, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const files = await readdir(path.join(temp, 'verification/performance'));
  const report = JSON.parse(await readFile(path.join(temp, 'verification/performance', files.find(file => file.endsWith('-latest.json'))!), 'utf8')) as { treeState?: string; sourceBinding?: { fingerprint?: string } };
  assert.equal(report.treeState, 'no-git');
  assert.match(report.sourceBinding?.fingerprint ?? '', /^[a-f0-9]{64}$/);
});
