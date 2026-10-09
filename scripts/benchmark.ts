import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import YAML from 'yaml';
import { documentUri, parseDocument, Vault } from '../packages/core/vault.js';
import { OWNER, type SearchInput, type Scope } from '../packages/core/types.js';
import { FilesystemSearch } from '../packages/search-files/index.js';
import { SQLiteSearch } from '../packages/search-sqlite/index.js';
import { profileReport, resetProfile, withProfileContext } from '../packages/bench/instrumentation.js';

const GENERATOR_VERSION = '2.0.0';
const MANIFEST = '.engram-benchmark-manifest.json';
const DISTRIBUTION = '60% short (12 tokens), 30% medium (120), 10% long (600); 5% CJK; 1/250 rare marker; 1/97 phrase; 1/331 punctuation; ~30% linked notes';
type Workload = { name: string; input: SearchInput; expectedHits: number | null };
type CorpusManifest = {
  schemaVersion: 1; corpusId: string; generator: { name: string; version: string; sourceSha256: string; distribution: string };
  builtAt: string; seed: number; documents: number; workspaces: number; bodyBytes: number;
  knownHits: { rare: number; cjk: number; phrase: number; punctuation: number; tagAlpha: number; rareOrPhrase: number };
  workloads: Workload[]; files: Array<{ path: string; bytes: number; sha256: string }>; fileCount: number;
  codeRevision: string; hardware: Record<string, unknown>; runtime: Record<string, unknown>;
  benchmarkConfiguration: Record<string, unknown>;
};

function options(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const equal = arg.indexOf('=');
    if (equal >= 0) result[arg.slice(2, equal)] = arg.slice(equal + 1);
    else if (args[i + 1] && !args[i + 1]!.startsWith('--')) result[arg.slice(2)] = args[++i]!;
    else result[arg.slice(2)] = true;
  }
  return result;
}
function numberOption(opts: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = opts[key]; const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`--${key} must be an integer`);
  return number;
}
function hash(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function pct(values: number[], p: number): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0; }
function stats(values: number[]): Record<string, number> { return { p50Ms: +pct(values, .5).toFixed(2), p95Ms: +pct(values, .95).toFixed(2), p99Ms: +pct(values, .99).toFixed(2), samples: values.length }; }
function machine(): Record<string, unknown> { return { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() }; }
function runtime(): Record<string, unknown> { return { node: process.version, versions: process.versions, execArgv: process.execArgv }; }
function allocatedBytes(): number { return (v8.getHeapStatistics() as ReturnType<typeof v8.getHeapStatistics> & { total_allocated_bytes: number }).total_allocated_bytes; }
async function codeRevision(): Promise<string> {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch {
    const files: Array<{ path: string; sha256: string }> = [];
    const walk = async (dir: string) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.isFile() && full.endsWith('.ts')) files.push({ path: full.split(path.sep).join('/'), sha256: hash(await fs.readFile(full)) }); } };
    for (const dir of ['packages', 'scripts']) await walk(dir);
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) files.push({ path: file, sha256: hash(await fs.readFile(file)) });
    return `source-tree-sha256:${hash(JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path))))}`;
  }
}

const common = ['index', 'cache', 'latency', 'storage', 'agent', 'memory', 'search', 'graph'];
const tagsPool = ['alpha', 'beta', 'gamma', 'delta'];
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function buildWorkloads(seed: number, size: number, known: CorpusManifest['knownHits'], scopes: Scope[]): Workload[] {
  return [
    { name: 'grep-rare', input: { query: `rare-marker-${seed}`, mode: 'grep', limit: 1000 }, expectedHits: known.rare },
    { name: 'grep-common', input: { query: 'cache1', mode: 'grep', limit: 50 }, expectedHits: null },
    { name: 'grep-nonexistent', input: { query: 'zz-no-such-token-zz', mode: 'grep', limit: 50 }, expectedHits: 0 },
    { name: 'grep-punctuation', input: { query: 'a.b(c)', mode: 'grep', limit: 1000 }, expectedHits: known.punctuation },
    { name: 'grep-cjk', input: { query: '知识库', mode: 'grep', limit: 1000 }, expectedHits: known.cjk },
    { name: 'keyword-single-rare', input: { query: `rare-marker-${seed}`, mode: 'keyword', limit: 1000 }, expectedHits: known.rare },
    { name: 'keyword-phrase', input: { query: '"warm cache phrase"', mode: 'keyword', limit: 1000 }, expectedHits: known.phrase },
    { name: 'keyword-multi', input: { query: 'index1 cache2', mode: 'keyword', limit: 50 }, expectedHits: null },
    { name: 'keyword-boolean-not', input: { query: 'warm NOT phrase', mode: 'keyword', limit: 50 }, expectedHits: null },
    { name: 'regex-anchored-alternation', input: { query: 'rare-marker-\\d+|phrase here', mode: 'grep', regex: true, limit: 1000 }, expectedHits: known.rareOrPhrase },
    { name: 'metadata-tag', input: { query: 'document', mode: 'keyword', tags: ['alpha'], limit: 100 }, expectedHits: null },
    { name: 'metadata-kind-scope', input: { query: 'document', mode: 'keyword', kinds: ['wiki_page'], scopes: [scopes[1]!], limit: 100 }, expectedHits: null }
  ];
}

async function listCorpusFiles(root: string): Promise<CorpusManifest['files']> {
  const files: CorpusManifest['files'] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), rel = path.relative(root, full).split(path.sep).join('/');
      if (rel === MANIFEST || rel.startsWith('.mdb/indexes/') || rel.startsWith('.mdb/locks/')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Benchmark corpus may not contain symlinks: ${rel}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) { const bytes = await fs.readFile(full); files.push({ path: rel, bytes: bytes.byteLength, sha256: hash(bytes) }); }
    }
  };
  await walk(root); return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function byteSize(files: CorpusManifest['files']): Promise<number> { return files.reduce((sum, file) => sum + file.bytes, 0); }
async function readManifest(root: string): Promise<CorpusManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8')) as CorpusManifest;
  if (manifest.schemaVersion !== 1 || manifest.generator?.name !== 'engram-benchmark' || !Array.isArray(manifest.files) || !manifest.corpusId) throw new Error('Invalid benchmark corpus manifest');
  return manifest;
}
async function verifyCorpus(root: string, manifest: CorpusManifest): Promise<void> {
  const actual = await listCorpusFiles(root);
  if (actual.length !== manifest.files.length) throw new Error(`Corpus file count differs: expected ${manifest.files.length}, found ${actual.length}`);
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  for (const file of actual) { const original = expected.get(file.path); if (!original || file.sha256 !== original.sha256 || file.bytes !== original.bytes) throw new Error(`Corpus hash mismatch: ${file.path}`); }
}
function deterministicFactories(seed: number, completedDocuments = 0): { idFactory: (prefix: string) => string; now: () => Date } {
  let counter = completedDocuments * 3, tick = completedDocuments;
  return {
    idFactory: prefix => `${prefix}_${createHash('sha256').update(`${seed}:${counter++}:${prefix}`).digest('hex').slice(0, 32)}`,
    now: () => new Date(Date.UTC(2020, 0, 1) + tick++ * 1000)
  };
}
function deterministicId(seed: number, counter: number, prefix: string): string {
  return `${prefix}_${createHash('sha256').update(`${seed}:${counter}:${prefix}`).digest('hex').slice(0, 32)}`;
}

async function build(opts: Record<string, string | boolean>): Promise<void> {
  const size = numberOption(opts, 'size', 10000), seed = numberOption(opts, 'seed', 20261007);
  const stopAfter = numberOption(opts, 'stop-after', size);
  if (size < 10 || size > 100000 || seed < 0) throw new Error('size must be 10..100000; seed must be nonnegative');
  if (stopAfter < 1 || stopAfter > size || (stopAfter < size && !opts.retain)) throw new Error('--stop-after must be 1..size and requires --retain');
  const resume = opts.resume === true, retain = opts.retain === true || resume;
  if (retain && typeof opts.root !== 'string') throw new Error('Retained builds require --root <new-path>');
  if (!retain && opts.root !== undefined) throw new Error('Pass --retain when supplying --root; temporary builds choose their own path');
  const root = retain ? path.resolve(String(opts.root)) : await fs.mkdtemp(path.join(os.tmpdir(), 'engram-bench-'));
  if (retain) { const existing = await fs.lstat(root).catch(() => undefined); if (existing?.isSymbolicLink()) throw new Error('Build root may not be a symlink'); }
  const existed = await fs.stat(root).then(() => true).catch(() => false);
  if (resume && !existed) throw new Error('--resume requires an existing incomplete retained build');
  if (!resume && existed && (await fs.readdir(root)).length) throw new Error('Build target must be a new or empty directory');
  if (resume && await fs.stat(path.join(root, MANIFEST)).then(() => true).catch(() => false)) throw new Error('Cannot resume a completed corpus');
  await fs.mkdir(root, { recursive: true });
  const initialVault = new Vault(root);
  await initialVault.init({ sqlite: false });
  let completed = 0;
  let resumeEvents: Array<{ sequence: number; objectId: string; revisionId: string }> = [];
  if (resume) {
    const recovery = await initialVault.recover();
    if (recovery.orphans) throw new Error(`Cannot resume safely: recovery found ${recovery.orphans} uncommitted immutable revisions`);
    const journal = (await fs.readFile(path.join(root, '.mdb/events/commits.jsonl'), 'utf8')).trim();
    const events = journal ? journal.split('\n').map(line => JSON.parse(line) as { sequence: number; objectId: string; revisionId: string; operation: string }) : [];
    if (events.some((event, index) => event.sequence !== index + 1 || event.operation !== 'put')) throw new Error('Cannot resume safely: journal is not a contiguous generated corpus prefix');
    completed = events.length;
    if (completed >= size) throw new Error('Resume target already has all documents; manifest finalization is not inferred');
    const workspaceCount = Math.min(20, Math.max(2, Math.floor(size / 200)));
    const workspaces = await initialVault.listWorkspaces();
    if (workspaces.length !== workspaceCount || workspaces.some((workspace, index) => workspace.id !== `bench${index}`)) throw new Error('Cannot resume safely: workspace set differs from deterministic build');
    resumeEvents = events;
  }
  const factories = deterministicFactories(seed, completed);
  const vault = new Vault(root, OWNER, factories);
  const sizeOf = Math.min(20, Math.max(2, Math.floor(size / 200)));
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (!resume) for (let w = 0; w < sizeOf; w++) await vault.createWorkspace(`bench${w}`, 'synthetic');
    const scopes: Scope[] = [{ type: 'global', area: 'wiki' }, ...Array.from({ length: sizeOf }, (_, w) => ({ type: 'workspace' as const, workspaceId: `bench${w}` }))];
    const rng = random(seed), pick = <T,>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
    const filler = (length: number) => Array.from({ length }, () => `${pick(common)}${Math.floor(rng() * 40)}`).join(' ');
    const known = { rare: 0, cjk: 0, phrase: 0, punctuation: 0, tagAlpha: 0, rareOrPhrase: 0 };
    let bodyBytes = 0; const links: string[] = []; const commit: number[] = [];
    const buildMemory: Array<{ rssBytes: number; heapUsedBytes: number; externalBytes: number }> = [];
    const sampleBuildMemory = () => { const usage = process.memoryUsage(); buildMemory.push({ rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external }); };
    sampleBuildMemory(); memoryTimer = setInterval(sampleBuildMemory, 50); memoryTimer.unref();
    const started = performance.now(); const cpuStart = process.cpuUsage(); const allocationStart = allocatedBytes();
    for (let i = 0; i < stopAfter; i++) {
      const kind = rng(), length = kind < .6 ? 12 : kind < .9 ? 120 : 600;
      const rare = i % 250 === 0, cjk = rng() < .05, phrase = i % 97 === 0, punctuation = i % 331 === 0, tag = pick(tagsPool);
      let body = `# Document ${i}\n\n${filler(length)}\n`;
      if (rare) body += `rare-marker-${seed}\n`; if (cjk) body += '知识库 检索 系统\n'; if (phrase) body += 'warm cache phrase here\n'; if (punctuation) body += 'call a.b(c) now\n';
      const scope = pick(scopes), outgoing = links.length && rng() < .3 ? [{ type: 'related_to', target: pick(links) }] : [];
      const input = { scope, kind: kind < .6 ? 'note' as const : kind < .9 ? 'wiki_page' as const : 'source_note' as const, title: `Synthetic ${i}`, body, tags: [tag], links: outgoing };
      let uri: string;
      if (i < completed) {
        const objectId = deterministicId(seed, i * 3, 'obj'), revisionId = deterministicId(seed, i * 3 + 1, 'rev'), event = resumeEvents[i];
        if (!event || event.sequence !== i + 1 || event.objectId !== objectId || event.revisionId !== revisionId) throw new Error(`Cannot resume safely: journal differs from deterministic document ${i}`);
        const revisionPath = path.join(root, '.mdb/objects', objectId, 'revs', `${revisionId}.md`);
        const revision = parseDocument(Buffer.from(await fs.readFile(revisionPath)).toString('utf8'));
        if (revision.body !== body || revision.title !== input.title || revision.kind !== input.kind || JSON.stringify(revision.scope) !== JSON.stringify(scope) || JSON.stringify(revision.tags) !== JSON.stringify(input.tags) || JSON.stringify(revision.links) !== JSON.stringify(outgoing)) throw new Error(`Cannot resume safely: deterministic content differs at document ${i}`);
        uri = documentUri(objectId, scope);
      } else {
        const t0 = performance.now(); const doc = await vault.put(input); commit.push(performance.now() - t0); uri = doc.uri;
      }
      bodyBytes += Buffer.byteLength(body);
      if (rng() < .05) links.push(uri);
      if (rare) known.rare++; if (cjk) known.cjk++; if (phrase) known.phrase++; if (punctuation) known.punctuation++; if (tag === 'alpha') known.tagAlpha++; if (rare || phrase) known.rareOrPhrase++;
      if (i > 0 && i % 2000 === 0) console.error(`built ${i}/${size}`);
    }
    if (stopAfter < size) {
      const partialMs = performance.now() - started, partialCpu = process.cpuUsage(cpuStart);
      console.log(JSON.stringify({ mode: 'build-partial', root, retained: true, documents: stopAfter, targetDocuments: size, seed, buildMs: +partialMs.toFixed(2), cpu: { userMs: partialCpu.user / 1000, systemMs: partialCpu.system / 1000 }, resumeCommand: `npm run benchmark -- build --size ${size} --seed ${seed} --root ${root} --resume` }, null, 2));
      return;
    }
    const buildMs = performance.now() - started, buildCpu = process.cpuUsage(cpuStart), buildAllocationBytes = allocatedBytes() - allocationStart;
    const config = await vault.config(); config.sqlite.enabled = true; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(config));
    const indexStart = performance.now(); await new SQLiteSearch(vault).rebuild(); const sqliteBuildMs = performance.now() - indexStart;
    clearInterval(memoryTimer); memoryTimer = undefined; sampleBuildMemory();
    const workloads = buildWorkloads(seed, size, known, scopes);
    const sourcePath = path.resolve('scripts/benchmark.ts');
    const files = await listCorpusFiles(root);
    const base = {
      schemaVersion: 1 as const, generator: { name: 'engram-benchmark', version: GENERATOR_VERSION, sourceSha256: hash(await fs.readFile(sourcePath)), distribution: DISTRIBUTION },
      builtAt: new Date().toISOString(), seed, documents: size, workspaces: sizeOf, bodyBytes, knownHits: known, workloads, files, fileCount: files.length,
      codeRevision: await codeRevision(), hardware: machine(), runtime: runtime(), benchmarkConfiguration: { buildMode: resume ? 'retained-resumed' : retain ? 'retained' : 'temporary', ...(resume ? { resumedAfterDocuments: completed } : {}), durableCommits: true, sqliteIndexBuilt: true, indexBuildMs: +sqliteBuildMs.toFixed(2), commitStats: stats(commit), commitCpuUserMs: buildCpu.user / 1000, commitCpuSystemMs: buildCpu.system / 1000, buildAllocationBytes, peakRssBytes: Math.max(...buildMemory.map(item => item.rssBytes)), peakHeapUsedBytes: Math.max(...buildMemory.map(item => item.heapUsedBytes)), peakExternalBytes: Math.max(...buildMemory.map(item => item.externalBytes)), memorySamples: buildMemory.length, instrumentation: profileReport() }
    };
    const corpusId = hash(JSON.stringify({ seed, documents: size, generator: base.generator, files })).slice(0, 24);
    const manifest: CorpusManifest = { ...base, corpusId };
    await fs.writeFile(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ mode: 'build', corpusId, root, retained: retain, ...(resume ? { resumedAfterDocuments: completed } : {}), documents: size, fileCount: files.length, bodyBytes, buildMs: +buildMs.toFixed(2), sqliteBuildMs: +sqliteBuildMs.toFixed(2), cpu: { userMs: buildCpu.user / 1000, systemMs: buildCpu.system / 1000 }, allocationBytes: buildAllocationBytes, sourceSha256: base.generator.sourceSha256 }, null, 2));
  } finally { if (memoryTimer) clearInterval(memoryTimer); if (!retain) await fs.rm(root, { recursive: true, force: true }); }
}

async function queryPlans(root: string, rareQuery: string): Promise<Record<string, unknown>[]> {
  const directory = path.join(root, '.mdb/indexes'); const entries = await fs.readdir(directory, { withFileTypes: true });
  const { DatabaseSync } = await import('node:sqlite'); const plans: Record<string, unknown>[] = [];
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.sqlite'))) {
    const db = new DatabaseSync(path.join(directory, entry.name), { readOnly: true });
    try {
      const match = `"${rareQuery.replaceAll('"', '""')}"`;
      for (const table of ['documents_trigram', 'documents_fts']) {
        const sql = `SELECT d.object_id AS id, d.revision_id AS rev FROM ${table} t JOIN documents d ON d.rowid = t.rowid WHERE ${table} MATCH ?`;
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(match);
        plans.push({ database: entry.name, table, match, plan });
      }
    } finally { db.close(); }
  }
  return plans;
}

async function replay(opts: Record<string, string | boolean>): Promise<void> {
  if (typeof opts.root !== 'string') throw new Error('Replay requires --root <corpus-path>');
  const root = path.resolve(opts.root), runs = numberOption(opts, 'runs', 15), warmups = numberOption(opts, 'warmups', 2);
  if (runs < 3 || runs > 200 || warmups < 0 || warmups > 20) throw new Error('runs must be 3..200; warmups must be 0..20');
  const manifest = await readManifest(root); await verifyCorpus(root, manifest);
  const vault = new Vault(root); const engines = { filesystem: new FilesystemSearch(vault), sqlite: new SQLiteSearch(vault) }; const workloads = manifest.workloads;
  const timings: Record<string, Record<string, unknown>> = { filesystem: {}, sqlite: {} };
  const parity: Record<string, boolean> = {}; const outputs: Record<string, Record<string, string[]>> = { filesystem: {}, sqlite: {} };
  const firstPass: Record<string, Record<string, number>> = { filesystem: {}, sqlite: {} };
  const memorySamples: Array<{ at: number; rssBytes: number; heapUsedBytes: number; externalBytes: number; allocatedBytes: number }> = [];
  const sampleMemory = () => { const usage = process.memoryUsage(); memorySamples.push({ at: +performance.now().toFixed(2), rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external, allocatedBytes: allocatedBytes() }); };
  const interval = setInterval(sampleMemory, 50); interval.unref(); sampleMemory();
  const processStart = process.cpuUsage(); const allocStart = allocatedBytes();
  try {
    // Capture one post-validation first pass, then interleave warmups and timed samples by workload.
    for (let wi = 0; wi < workloads.length; wi++) {
      const workload = workloads[wi]!; const order = wi % 2 ? ['sqlite', 'filesystem'] as const : ['filesystem', 'sqlite'] as const;
      for (const backend of order) { const start = performance.now(); await withProfileContext(`firstpass.${backend}.${workload.name}`, () => engines[backend].query(workload.input)); firstPass[backend]![workload.name] = +(performance.now() - start).toFixed(2); }
      for (let warmup = 0; warmup < warmups; warmup++) for (const backend of order) await withProfileContext(`warmup.${backend}.${workload.name}`, () => engines[backend].query(workload.input));
    }
    resetProfile();
    for (let wi = 0; wi < workloads.length; wi++) {
      const workload = workloads[wi]!;
      const createBucket = () => ({ elapsed: [] as number[], cpuUser: [] as number[], cpuSystem: [] as number[], last: [] as string[], indexInfo: null as unknown, allocatedBytes: 0, heapDeltas: [] as number[] });
      const buckets = { filesystem: createBucket(), sqlite: createBucket() };
      for (let run = 0; run < runs; run++) {
        const order = (run + wi) % 2 ? ['sqlite', 'filesystem'] as const : ['filesystem', 'sqlite'] as const;
        for (const backend of order) {
          const bucket = buckets[backend], cpu = process.cpuUsage(), allocBefore = allocatedBytes(), heapBefore = process.memoryUsage().heapUsed, start = performance.now();
          const result = await withProfileContext(`${backend}.${workload.name}`, () => engines[backend].query(workload.input));
          bucket.elapsed.push(performance.now() - start); const used = process.cpuUsage(cpu); bucket.cpuUser.push(used.user / 1000); bucket.cpuSystem.push(used.system / 1000);
          bucket.allocatedBytes += allocatedBytes() - allocBefore; bucket.heapDeltas.push(process.memoryUsage().heapUsed - heapBefore);
          bucket.last = result.hits.map(hit => hit.objectId).sort(); bucket.indexInfo = (result as typeof result & { index?: unknown }).index ?? null;
        }
      }
      for (const backend of ['filesystem', 'sqlite'] as const) {
        const bucket = buckets[backend];
        if (workload.expectedHits !== null && bucket.last.length !== workload.expectedHits) throw new Error(`${backend}/${workload.name}: expected ${workload.expectedHits} hits, found ${bucket.last.length}`);
        timings[backend]![workload.name] = { ...stats(bucket.elapsed), firstPassMs: firstPass[backend]![workload.name], hits: bucket.last.length, expectedHits: workload.expectedHits, servedBy: backend, indexInfo: bucket.indexInfo,
          cpuUserMs: { ...stats(bucket.cpuUser), totalMs: +bucket.cpuUser.reduce((a, b) => a + b, 0).toFixed(2) },
          cpuSystemMs: { ...stats(bucket.cpuSystem), totalMs: +bucket.cpuSystem.reduce((a, b) => a + b, 0).toFixed(2) },
          allocatedBytes: bucket.allocatedBytes, heapDeltaBytes: { ...stats(bucket.heapDeltas), totalBytes: bucket.heapDeltas.reduce((sum, value) => sum + value, 0) } };
        outputs[backend]![workload.name] = bucket.last;
      }
    }
    for (const workload of workloads) parity[workload.name] = JSON.stringify(outputs.filesystem![workload.name]) === JSON.stringify(outputs.sqlite![workload.name]);
    if (Object.values(parity).some(value => !value)) throw new Error('Filesystem/SQLite parity failed');
    const processCpu = process.cpuUsage(processStart); sampleMemory();
    const plans = await queryPlans(root, `rare-marker-${manifest.seed}`);
    const report = {
      schemaVersion: 1, mode: 'replay', historicalComparison: false, corpus: { corpusId: manifest.corpusId, seed: manifest.seed, documents: manifest.documents, fileCount: manifest.fileCount, verifiedHashes: true, manifestPath: path.join(root, MANIFEST) },
      timestamp: new Date().toISOString(), runs, warmups, cache: { mode: 'first-pass-plus-warm-interleaved', firstPass: 'measured after hash verification; reflects a fresh query pass, not a cold OS page cache', osPageCachePurged: false, note: 'Hash verification can warm OS page cache; no cold-cache claim is made.' },
      codeRevision: await codeRevision(), hardware: machine(), runtime: runtime(), filesystem: timings.filesystem, sqlite: timings.sqlite, parity, parityAll: Object.values(parity).every(Boolean),
      instrumentation: profileReport(), queryPlans: plans, cpu: { userMs: processCpu.user / 1000, systemMs: processCpu.system / 1000 },
      memory: { startAllocatedBytes: allocStart, endAllocatedBytes: allocatedBytes(), allocatedBytes: allocatedBytes() - allocStart,
        peakRssBytes: Math.max(...memorySamples.map(sample => sample.rssBytes)), peakHeapUsedBytes: Math.max(...memorySamples.map(sample => sample.heapUsedBytes)), peakExternalBytes: Math.max(...memorySamples.map(sample => sample.externalBytes)), samples: memorySamples.length, samplingIntervalMs: 50 }
    };
    const outputDir = path.resolve(String(opts['output-dir'] ?? `verification/benchmarks/runs/${manifest.corpusId}`));
    await fs.mkdir(outputDir, { recursive: true }); const output = path.join(outputDir, `${new Date().toISOString().replaceAll(':', '-')}.json`);
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ mode: 'replay', corpusId: manifest.corpusId, output, runs, warmups, parityAll: report.parityAll,
      filesystemRare: timings.filesystem!['grep-rare'], sqliteRare: timings.sqlite!['grep-rare'], instrumentation: report.instrumentation, cpu: report.cpu, memory: report.memory }, null, 2));
  } finally { clearInterval(interval); }
}

async function cleanup(opts: Record<string, string | boolean>): Promise<void> {
  if (typeof opts.root !== 'string') throw new Error('Cleanup requires --root <corpus-path>');
  const root = path.resolve(opts.root), manifest = await readManifest(root);
  if (opts['confirm-id'] !== manifest.corpusId) throw new Error(`Refusing cleanup: pass --confirm-id ${manifest.corpusId}`);
  await verifyCorpus(root, manifest);
  await fs.rm(root, { recursive: true, force: false });
  console.log(JSON.stringify({ mode: 'cleanup', corpusId: manifest.corpusId, removed: root }, null, 2));
}

const [mode, ...args] = process.argv.slice(2); const opts = options(args);
process.env.MDB_BENCH_PROFILE = '1';
try {
  if (mode === 'build') await build(opts);
  else if (mode === 'replay') await replay(opts);
  else if (mode === 'cleanup') await cleanup(opts);
  else throw new Error('Usage: benchmark <build|replay|cleanup> [--size N --seed N --root PATH --retain]');
} catch (error) { console.error(error); process.exitCode = 1; }
