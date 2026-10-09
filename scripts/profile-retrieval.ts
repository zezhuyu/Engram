import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { OWNER } from '../packages/core/types.js';
import { Vault } from '../packages/core/vault.js';
import { MemoryRecall } from '../packages/memory/recall.js';
import { FilesystemSearch } from '../packages/search-files/index.js';
import { SQLiteSearch } from '../packages/search-sqlite/index.js';
import { profileReport, resetProfile, withProfileContext } from '../packages/bench/instrumentation.js';
import type { SearchInput } from '../packages/core/types.js';

type Manifest = { corpusId: string; seed: number; documents: number; fileCount: number; codeRevision: string; files: { path: string; bytes: number; sha256: string }[] };
const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const stats = (values: number[]) => ({ p50Ms: +pct(values, .5).toFixed(2), p95Ms: +pct(values, .95).toFixed(2), p99Ms: +pct(values, .99).toFixed(2), samples: values.length });
const byteStats = (values: number[]) => ({ p50Bytes: pct(values, .5), p95Bytes: pct(values, .95), p99Bytes: pct(values, .99), samples: values.length });
const allocatedBytes = () => (v8.getHeapStatistics() as ReturnType<typeof v8.getHeapStatistics> & { total_allocated_bytes: number }).total_allocated_bytes;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

async function currentRevision(): Promise<string> {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch {
    const files: Array<{ path: string; sha256: string }> = [];
    const walk = async (dir: string) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile() && file.endsWith('.ts')) files.push({ path: file.split(path.sep).join('/'), sha256: sha(await fs.readFile(file)) }); } };
    for (const dir of ['packages', 'scripts']) await walk(dir);
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) try { files.push({ path: file, sha256: sha(await fs.readFile(file)) }); } catch { /* lockfile is optional */ }
    return `source-tree-sha256:${sha(JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path))))}`;
  }
}

async function verify(root: string, manifest: Manifest): Promise<void> {
  const expected = new Map(manifest.files.map(file => [file.path, file])); const actual = new Set<string>();
  const walk = async (dir: string) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name), rel = path.relative(root, full).split(path.sep).join('/');
    if (rel === '.engram-benchmark-manifest.json' || rel.startsWith('.mdb/indexes/') || rel.startsWith('.mdb/locks/')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in corpus: ${rel}`);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) { actual.add(rel); const wanted = expected.get(rel); const data = await fs.readFile(full); if (!wanted || wanted.bytes !== data.byteLength || wanted.sha256 !== sha(data)) throw new Error(`Corpus mismatch: ${rel}`); }
  } };
  await walk(root); if (actual.size !== expected.size) throw new Error(`Corpus file count mismatch: ${actual.size}/${expected.size}`);
}

function command(cwd: string, bin: string, args: string[], stdin?: Buffer): Promise<{ stdout: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const start = performance.now(), child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] }); const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk)); child.once('error', reject);
    child.once('close', code => { const stdout = Buffer.concat(chunks).toString('utf8'); if (code !== 0 && code !== 1 && code !== 123) reject(new Error(`${bin} exit ${code}`)); else resolve({ stdout, ms: performance.now() - start }); });
    child.stdin.end(stdin);
  });
}

async function phaseProbes(root: string, manifest: Manifest, runs: number): Promise<Record<string, unknown>> {
  const heads = manifest.files.filter(f => /^\.mdb\/objects\/[^/]+\/revs\/[^/]+\.md$/.test(f.path)).map(f => f.path);
  const allPaths: number[] = [], allCounts: number[] = [];
  for (let i = 0; i < runs; i++) { const result = await command(root, 'rg', ['--files', '--hidden', '--no-ignore', '--glob', '*.md', '--', '.mdb/objects']); allPaths.push(result.ms); allCounts.push(result.stdout.split('\n').filter(Boolean).length); }
  const traversalFiles = allCounts.at(-1) ?? 0;
  const pathInput = Buffer.from(`${heads.join('\0')}\0`);
  const scan: Record<string, { ms: number[]; matched: number[] }> = {};
  for (const query of [`rare-marker-${manifest.seed}`, 'cache1']) {
    scan[query] = { ms: [], matched: [] };
    for (let i = 0; i < runs; i++) {
      const result = await command(root, 'xargs', ['-0', '-s', '180000', 'rg', '-l', '-F', '-i', '--no-messages', '--no-config', '--hidden', '--no-ignore', '--glob', '*.md', '-e', query, '--'], pathInput);
      scan[query]!.ms.push(result.ms); scan[query]!.matched.push(result.stdout.split('\n').filter(Boolean).length);
    }
  }
  const currentHeadPaths = new Set(heads);
  const revisionMd = (await fs.readdir(path.join(root, '.mdb', 'objects'))).length;
  const expectedHits = { rare: 40, common: null };
  return {
    directoryTraversal: { latency: stats(allPaths), filesDiscoveredP50: pct(allCounts, .5), filesDiscovered: traversalFiles, markdownRevisionFilesFromRg: traversalFiles,
      currentHeadRevisionFiles: heads.length, historicalRevisionFiles: Math.max(0, traversalFiles - currentHeadPaths.size), note: 'Traversal probe uses rg --files and its timing includes subprocess launch and path output.' },
    explicitHeadScan: Object.fromEntries(Object.entries(scan).map(([query, result]) => [query, { latency: stats(result.ms), candidatesP50: pct(result.matched, .5), pathsProvided: heads.length, estimatedRgChildren: Math.ceil(pathInput.byteLength / 180000), note: 'Uses xargs to pass only manifest head revision paths; timings include xargs/rg launch and scan, but no recursive directory traversal.' }])),
    expectedHits, objectDirectories: revisionMd
  };
}

function queryPlans(root: string, seed: number): Record<string, unknown>[] {
  const plans: Record<string, unknown>[] = [];
  for (const name of ['global.sqlite', 'workspace-bench0.sqlite']) {
    const file = path.join(root, '.mdb', 'indexes', name); let database: DatabaseSync;
    try { database = new DatabaseSync(file, { readOnly: true }); } catch { continue; }
    try {
      const match = `"rare-marker-${seed}"`;
      for (const table of ['documents_trigram', 'documents_fts']) {
        const sql = `SELECT d.object_id AS id FROM ${table} t JOIN documents d ON d.rowid=t.rowid WHERE ${table} MATCH ?`;
        plans.push({ database: name, table, match, plan: database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(match) });
      }
    } finally { database.close(); }
  }
  return plans;
}

async function run(root: string, runs: number, warmups: number): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.engram-benchmark-manifest.json'), 'utf8')) as Manifest;
  if (manifest.corpusId !== '4e43f472288a4ecfa1678727') throw new Error(`Expected immutable baseline 4e43f472288a4ecfa1678727, got ${manifest.corpusId}`);
  await verify(root, manifest);
  const vault = new Vault(root, OWNER), filesystem = new FilesystemSearch(vault), sqlite = new SQLiteSearch(vault), memory = new MemoryRecall(vault);
  const queries: Array<{ name: string; input: SearchInput; expectedHits?: number }> = [
    { name: 'rare', input: { query: `rare-marker-${manifest.seed}`, mode: 'grep', limit: 1000 }, expectedHits: 40 },
    { name: 'common', input: { query: 'cache1', mode: 'grep', limit: 50 } },
    { name: 'regex', input: { query: 'rare-marker-[0-9]+|phrase here', mode: 'grep', regex: true, limit: 1000 }, expectedHits: 143 },
    { name: 'bounded-head', input: { query: `rare-marker-${manifest.seed}`, mode: 'grep', limit: 5 }, expectedHits: 5 },
    { name: 'bounded-tail', input: { query: `rare-marker-${manifest.seed}`, mode: 'grep', limit: 5, cursor: '35' }, expectedHits: 5 }
  ];
  const memoryRecent = { scope: 'authorized_all' as const, limit: 20, detail: 'index' as const };
  const results: Record<string, unknown> = {}; const parity: Record<string, boolean> = {};
  const samples: Array<{ at: number; rss: number; heap: number }> = [];
  const timer = setInterval(() => { const m = process.memoryUsage(); samples.push({ at: performance.now(), rss: m.rss, heap: m.heapUsed }); }, 50); timer.unref();
  const cpuStart = process.cpuUsage(), allocationStart = allocatedBytes();
  try {
    for (const workload of queries) {
      const byBackend: Record<string, { times: number[]; cpuUser: number[]; cpuSystem: number[]; allocations: number[]; counts: number[]; ids: string[]; index: unknown }> = {};
      const outputs: Record<string, string[]> = {};
      for (const backend of ['filesystem', 'sqlite'] as const) {
        const engine = backend === 'filesystem' ? filesystem : sqlite;
        for (let i = 0; i < warmups; i++) await withProfileContext(`warmup.${backend}.${workload.name}`, () => engine.query(workload.input));
        resetProfile(); const bucket = { times: [] as number[], cpuUser: [] as number[], cpuSystem: [] as number[], allocations: [] as number[], counts: [] as number[], ids: [] as string[], index: null as unknown };
        for (let i = 0; i < runs; i++) {
          const beforeCpu = process.cpuUsage(), beforeAlloc = allocatedBytes(), start = performance.now();
          const result = await withProfileContext(`${backend}.${workload.name}`, () => engine.query(workload.input));
          bucket.times.push(performance.now() - start); const cpu = process.cpuUsage(beforeCpu); bucket.cpuUser.push(cpu.user / 1000); bucket.cpuSystem.push(cpu.system / 1000); bucket.allocations.push(allocatedBytes() - beforeAlloc);
          bucket.counts.push(result.hits.length); bucket.ids = result.hits.map(h => h.objectId); bucket.index = (result as typeof result & { index?: unknown }).index ?? null;
        }
        outputs[backend] = bucket.ids;
        if (workload.expectedHits !== undefined && bucket.ids.length !== workload.expectedHits) throw new Error(`${backend}/${workload.name}: expected ${workload.expectedHits}, got ${bucket.ids.length}`);
        results[`${backend}.${workload.name}`] = { latency: stats(bucket.times), cpuUser: stats(bucket.cpuUser), cpuSystem: stats(bucket.cpuSystem), allocatedBytesPerQuery: byteStats(bucket.allocations), resultCounts: { min: Math.min(...bucket.counts), max: Math.max(...bucket.counts) }, index: bucket.index, instrumentation: profileReport() };
      }
      parity[workload.name] = JSON.stringify(outputs.filesystem) === JSON.stringify(outputs.sqlite);
      if (!parity[workload.name]) throw new Error(`Filesystem/SQLite parity failed for ${workload.name}`);
    }
    resetProfile();
    for (let i = 0; i < warmups; i++) await withProfileContext('warmup.memory.recent', () => memory.recent(memoryRecent));
    const recentTimes: number[] = [], recentCpuUser: number[] = [], recentCpuSystem: number[] = [], recentAlloc: number[] = []; let recentCount = 0;
    for (let i = 0; i < runs; i++) {
      const beforeCpu = process.cpuUsage(), beforeAlloc = allocatedBytes(), start = performance.now();
      const page = await withProfileContext('memory.recent', () => memory.recent(memoryRecent));
      recentTimes.push(performance.now() - start); const cpu = process.cpuUsage(beforeCpu); recentCpuUser.push(cpu.user / 1000); recentCpuSystem.push(cpu.system / 1000); recentAlloc.push(allocatedBytes() - beforeAlloc); recentCount = page.items.length;
    }
    results['memory.recent'] = { latency: stats(recentTimes), cpuUser: stats(recentCpuUser), cpuSystem: stats(recentCpuSystem), allocatedBytesPerQuery: byteStats(recentAlloc), returnedItems: recentCount, indexEntriesScanned: manifest.documents, revisionFilesRead: 0, instrumentation: profileReport() };
  } finally { clearInterval(timer); }
  const cpu = process.cpuUsage(cpuStart), usage = process.memoryUsage();
  return { corpusId: manifest.corpusId, sourceCorpusRoot: '/Volumes/sambigdisk1/code/Engram/verification/benchmarks/corpora/10k-seed20261007-v2', measuredCopyRoot: root, verifiedCanonicalHashes: true, baselineCodeRevision: manifest.codeRevision, currentCodeRevision: await currentRevision(), runs, warmups, cache: 'After hash verification/warmups; not cold-cache data', hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() }, runtime: { node: process.version }, parity, results, queryPlans: queryPlans(root, manifest.seed),
    process: { cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, allocatedBytes: allocatedBytes() - allocationStart, peakRssBytes: Math.max(usage.rss, ...samples.map(s => s.rss)), peakHeapBytes: Math.max(usage.heapUsed, ...samples.map(s => s.heap)) } };
}

const root = path.resolve(process.argv[2] ?? ''); const runs = Number(process.argv[3] ?? 15), warmups = Number(process.argv[4] ?? 2);
if (!root || !Number.isSafeInteger(runs) || runs < 3 || !Number.isSafeInteger(warmups) || warmups < 0) throw new Error('Usage: node dist/scripts/profile-retrieval.js <scratch-copy-of-baseline> [runs=15] [warmups=2]');
process.env.MDB_BENCH_PROFILE = '1';
const result = await run(root, runs, warmups); result['phaseProbes'] = await phaseProbes(root, JSON.parse(await fs.readFile(path.join(root, '.engram-benchmark-manifest.json'), 'utf8')) as Manifest, runs);
const outDir = path.resolve('verification/benchmarks/profiles/4e43f472288a4ecfa1678727'); await fs.mkdir(outDir, { recursive: true });
const out = path.join(outDir, `${new Date().toISOString().replaceAll(':', '-')}.json`); await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: out, corpusId: result['corpusId'], parity: result['parity'], results: result['results'], phaseProbes: result['phaseProbes'], process: result['process'] }, null, 2));
