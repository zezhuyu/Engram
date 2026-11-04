import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { currentSourceEvidence } from './lib/source-evidence.js';
process.env.MDB_BENCH_PROFILE = '1';
const { Vault } = await import('../packages/core/vault.js');
const { profileReport } = await import('../packages/bench/instrumentation.js');

/**
 * Durable small-write latency at corpus scale. The acknowledgment boundary is unchanged: every sample is a full Vault.put (revision fsync, journal append fsync,
 * head and view writes) acknowledged to the caller. The corpus is COPIED first, so the retained benchmark corpus and its manifest hashes are never touched.
 * Usage: node dist/scripts/benchmark-durable-write.js --root <corpus> [--commits 400] [--warmup 10] [--workspace bench0] [--keep]
 */
const args = process.argv.slice(2); const opt = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const root = opt('root'); if (!root) throw new Error('--root <corpus> is required');
const commits = Number(opt('commits', '400')), warmup = Number(opt('warmup', '10')), workspace = opt('workspace', 'bench0')!;
const manifest = JSON.parse(await fs.readFile(path.join(root, '.engram-benchmark-manifest.json'), 'utf8')) as { corpusId: string; documents: number };
const parent = path.dirname(path.resolve(root)); const work = await fs.mkdtemp(path.join(parent, '.tmp-durable-write-'));
const started = performance.now(); execFileSync('cp', ['-R', path.resolve(root) + '/.', work], { stdio: 'ignore' }); const copyMs = performance.now() - started;
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] ?? 0;
const samples: number[] = [];
try {
  const vault = new Vault(work);
  for (let i = 0; i < commits + warmup; i++) {
    const t = performance.now(); await vault.put({ scope: { type: 'workspace', workspaceId: workspace }, kind: 'note', title: `durable-write probe ${i}`, body: `probe body ${i} `.repeat(40) });
    if (i >= warmup) samples.push(performance.now() - t);
  }
  const profile = profileReport(); const stages = Object.fromEntries(Object.entries((profile as { metrics?: Record<string, { count: number; p50Ms: number; p95Ms: number; p99Ms: number }> }).metrics ?? profile).map(([k, m]) => [k, { count: m.count, p50Ms: m.p50Ms, p95Ms: m.p95Ms, p99Ms: m.p99Ms }]));
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const source = await currentSourceEvidence();
  const report = { id, corpusId: manifest.corpusId, corpusDocuments: manifest.documents, commits: samples.length, warmupDiscarded: warmup, copyMs: Math.round(copyMs), treeState: source.treeState.state, sourceBinding: { fingerprint: source.fingerprint, workingTreeSourceFingerprint: source.fingerprint, fullSourceFileCount: Object.keys(source.files).length, files: source.files }, durableWrite: { p50Ms: +pct(samples, .5).toFixed(2), p95Ms: +pct(samples, .95).toFixed(2), p99Ms: +pct(samples, .99).toFixed(2), maxMs: +Math.max(...samples).toFixed(2) }, budget: { p95Ms: 50, pass: pct(samples, .95) < 50 },
    stages, acknowledgment: 'unchanged: ack only after revision fsync + journal append fsync (commit point) + head/view writes; no fsync was removed or deferred', node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, filesystem: 'see environment', run_at: new Date().toISOString() };
  await fs.mkdir('verification/performance', { recursive: true });
  await fs.writeFile(`verification/performance/durable-write-${id}.json`, JSON.stringify(report, null, 2) + '\n'); await fs.writeFile('verification/performance/durable-write-latest.json', JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(`verification/performance/durable-write-${id}.md`, `# Durable write at ${manifest.documents} documents (${id})\n\np50 ${report.durableWrite.p50Ms} ms, **p95 ${report.durableWrite.p95Ms} ms** (budget < 50 ms: ${report.budget.pass ? 'PASS' : 'FAIL'}), p99 ${report.durableWrite.p99Ms} ms over ${samples.length} acknowledged commits.\n\n${report.acknowledgment}.\n\n| Stage | n | p50 ms | p95 ms | p99 ms |\n|---|---|---|---|---|\n${Object.entries(stages).map(([k, m]) => `| ${k} | ${m.count} | ${m.p50Ms} | ${m.p95Ms} | ${m.p99Ms} |`).join('\n')}\n\nThe corpus was copied to a scratch directory (${Math.round(copyMs / 1000)} s) and removed afterwards; the retained corpus was not modified.\n`);
  console.log(JSON.stringify({ durableWrite: report.durableWrite, budget: report.budget }));
} finally { if (!args.includes('--keep')) await fs.rm(work, { recursive: true, force: true }); }
