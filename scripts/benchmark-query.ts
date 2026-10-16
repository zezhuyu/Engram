import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { Vault } from '../packages/core/vault.js';
import { SearchEngine } from '../packages/search-files/index.js';
import { buildFsIndex, fsIndexStatus } from '../packages/search-files/postings.js';
import { QueryApi } from '../packages/query/index.js';
import { Prng } from '../tests/helpers/prng.js';
import type { Scope } from '../packages/core/types.js';
import { currentSourceEvidence } from './lib/source-evidence.js';

/**
 * Usage: node dist/scripts/benchmark-query.js [documents=1000] [runs=15] [seed=20261007]
 * Env: BENCH_ROOT=dir reuses/keeps a built corpus (otherwise a temp vault is built and removed).
 * Builds a seeded corpus through the real commit protocol, then measures the query engine (typed AST) on the filesystem path and on SQLite.
 * Warm numbers only (no privileged cache purge): cold-cache is NOT_RUN. Every result is checked against counts known from corpus construction.
 */
const size = Number(process.argv[2] ?? 1000), runs = Number(process.argv[3] ?? 15), seed = Number(process.argv[4] ?? 20261007);
const keep = process.env.BENCH_ROOT; const root = keep ?? await fs.mkdtemp(path.join(os.tmpdir(), 'engram-qbench-'));
const label = size >= 1000 ? `${size / 1000}k` : String(size);
const rng = new Prng(seed);
const WS = ['w0', 'w1', 'w2', 'w3', 'w4'];
async function setSqlite(vault: Vault, enabled: boolean) { const c = await vault.config(); c.sqlite.enabled = enabled; await fs.writeFile(path.join(vault.root, 'mdb.yaml'), YAML.stringify(c)); }
const vault = new Vault(root);
const built = await fs.stat(path.join(root, 'mdb.yaml')).then(() => true, () => false);
const buildStart = performance.now(); const commits: number[] = []; let rareCount = 0, obsCount = 0, ops = 0;
const titles: string[] = [];
if (!built) {
  await vault.init({ sqlite: true }); for (const w of WS) await vault.createWorkspace(w, '', {});
  for (let i = 0; i < size; i++) {
    const w = WS[i % 5]!; const isObs = i % 10 === 0; const rare = i % 1000 === 7; const tag = ['ops', 'idea', 'bug'][i % 3]!;
    const refs = i > 5 ? [titles[rng.int(i)], titles[rng.int(i)]].map(t => `[[${t}]]`).join(' ') : '';
    const title = `Doc ${i}`; titles.push(title);
    const body = `common word ${rng.text(14)}\nline two ${i % 7 === 0 ? 'seven-multiple' : 'other'}\n${rare ? 'RARETOKEN-xyzzy' : 'filler'} ${refs}\n`;
    const scope: Scope = { type: 'workspace', workspaceId: w };
    const t0 = performance.now();
    await vault.put({ scope, kind: isObs ? 'observation' : 'note', title, body, tags: [tag], ...(isObs ? { metadata: { sessionId: `s${Math.floor(i / 50)}`, eventTime: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), eventType: 'decision' } } : {}) });
    commits.push(performance.now() - t0);
    if (rare) rareCount++; if (isObs) obsCount++;
    if (i % 500 === 0) process.stderr.write(`built ${i}/${size}\n`);
  }
  await new SearchEngine(vault).rebuild();
} else { rareCount = Math.floor((size - 8) / 1000) + 1; obsCount = Math.ceil(size / 10); }
// The filesystem path is measured with its persistent trigram index (disposable, rebuildable); its build is reported separately from the commit build.
const fsIndexBuild = (await fsIndexStatus(vault)).present ? { reused: true } : await buildFsIndex(vault);
const buildMs = performance.now() - buildStart;
void ops;
const pct = (xs: number[], q: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : 0;
const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);
interface Wl { name: string; ast: Record<string, unknown>; expectRows?: number; expectFirst?: (rows: unknown[]) => boolean }
const workloads: Wl[] = [
  { name: 'keyword-rare', ast: { from: 'documents', search: { mode: 'keyword', text: 'RARETOKEN-xyzzy' }, pipe: [{ op: 'select', fields: ['id'] }] }, expectRows: rareCount },
  { name: 'exact-rare', ast: { from: 'documents', search: { mode: 'exact', text: 'RARETOKEN-xyzzy' }, pipe: [{ op: 'select', fields: ['id'] }] }, expectRows: rareCount },
  { name: 'keyword-frequent-limit20', ast: { from: 'documents', search: { mode: 'keyword', text: 'common' }, limit: 20, pipe: [{ op: 'select', fields: ['id', 'score'] }] }, expectRows: Math.min(20, size) },
  { name: 'regex', ast: { from: 'documents', search: { mode: 'regex', text: 'seven-mul.*' }, limit: 20, pipe: [{ op: 'select', fields: ['id'] }] }, expectRows: Math.min(20, Math.ceil(size / 7)) },
  { name: 'contains-body-prefilter', ast: { from: 'documents', where: { field: 'body', op: 'contains', value: 'RARETOKEN-xyzzy' }, pipe: [{ op: 'select', fields: ['id'] }] }, expectRows: rareCount },
  { name: 'metadata-count', ast: { from: 'documents', where: { field: 'tags', op: 'contains', value: 'ops' }, pipe: [{ op: 'count' }] }, expectRows: 1 },
  { name: 'group-by-workspace', ast: { from: 'documents', groupBy: ['workspace'], aggregate: { n: { op: 'count' } } }, expectRows: 5 },
  { name: 'recent-25', ast: { from: 'observations', pipe: [{ op: 'recent', n: 25 }, { op: 'select', fields: ['id', 'eventTime'] }] }, expectRows: Math.min(25, obsCount) },
  { name: 'tail-20-matching', ast: { from: 'observations', where: { field: 'workspace', op: 'eq', value: 'w0' }, orderBy: [{ field: 'eventTime' }], pipe: [{ op: 'tail', n: 20 }, { op: 'select', fields: ['id'] }] }, expectRows: Math.min(20, obsCount) },
  { name: 'timeline-session', ast: { from: 'observations', pipe: [{ op: 'timeline', sessionId: 's1' }, { op: 'select', fields: ['id'] }] } },
  { name: 'sort-title-limit10 (blocking)', ast: { from: 'documents', orderBy: [{ field: 'title' }], limit: 10, pipe: [{ op: 'select', fields: ['title'] }] }, expectRows: Math.min(10, size) },
  { name: 'cat-head-3', ast: { from: 'documents', where: { field: 'title', op: 'eq', value: 'Doc 1' }, pipe: [{ op: 'cat' }, { op: 'head', n: 3 }] }, expectRows: 3 },
  { name: 'backlinks-hub', ast: { from: 'documents', where: { field: 'title', op: 'eq', value: 'Doc 6' }, pipe: [{ op: 'backlinks' }, { op: 'count' }] }, expectRows: 1 },
  { name: 'traverse-depth3', ast: { from: 'documents', where: { field: 'title', op: 'eq', value: `Doc ${Math.min(size - 1, 600)}` }, pipe: [{ op: 'traverse', maxDepth: 3, maxNodes: 500 }, { op: 'count' }] }, expectRows: 1 },
  { name: 'related-depth2', ast: { from: 'documents', where: { field: 'title', op: 'eq', value: `Doc ${Math.min(size - 1, 600)}` }, pipe: [{ op: 'related', depth: 2, limit: 200 }, { op: 'count' }] }, expectRows: 1 },
  { name: 'join-semi-observations', ast: { from: 'observations', pipe: [{ op: 'select', fields: ['id', 'sessionId'] }, { op: 'join', kind: 'semi', right: { from: 'observations', where: { field: 'sessionId', op: 'eq', value: 's2' }, pipe: [{ op: 'select', fields: ['sessionId'] }] }, on: { left: 'sessionId', right: 'sessionId' } }, { op: 'count' }] }, expectRows: 1 },
  { name: 'in-subquery', ast: { from: 'documents', where: { op: 'in', field: 'sessionId', value: { field: 'sessionId', subquery: { from: 'observations', where: { field: 'workspace', op: 'eq', value: 'w0' }, limit: 5 } } }, pipe: [{ op: 'count' }] }, expectRows: 1 },
  { name: 'search+cat+grep+cut', ast: { from: 'documents', search: { mode: 'exact', text: 'RARETOKEN-xyzzy' }, pipe: [{ op: 'cat' }, { op: 'grep', pattern: 'RARETOKEN' }, { op: 'cut', chars: [[1, 30]] }] }, expectRows: rareCount }
];
const result: Record<string, unknown> = {}; const failures: string[] = [];
async function measure(mode: 'filesystem' | 'sqlite') {
  await setSqlite(vault, mode === 'sqlite'); const out: Record<string, unknown> = {};
  const coldStart = performance.now(); const fresh = new QueryApi(new Vault(root)); await fresh.run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] }); const coldProcessMs = performance.now() - coldStart; // new Vault object: manifest loaded from disk
  const api = new QueryApi(new Vault(root)); await api.run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] });
  for (const wl of workloads) {
    const times: number[] = [], first: number[] = []; let last; let totalDocs = 0, maxDocs = 0;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now(); last = await api.run({ version: 1, ...wl.ast }, { maxRows: 100_000, maxBufferRows: 1_000_000, deadlineMs: 120_000 }); times.push(performance.now() - t0);
      first.push(last.stats.firstRowMs ?? performance.now() - t0); totalDocs += last.stats.documentsRead; maxDocs = Math.max(maxDocs, last.stats.documentsRead + last.stats.searchDocumentsLoaded);
    }
    const ok = wl.expectRows === undefined || last!.rows.length === wl.expectRows; if (!ok) failures.push(`${mode}/${wl.name}: ${last!.rows.length} rows, expected ${wl.expectRows}`);
    out[wl.name] = { p50Ms: +pct(times, 0.5).toFixed(2), p95Ms: +pct(times, 0.95).toFixed(2), p99Ms: +pct(times, 0.99).toFixed(2), firstRowP50Ms: +pct(first, 0.5).toFixed(2), rows: last!.rows.length, candidates: last!.stats.candidates, documentsMaterialized: maxDocs, backend: last!.stats.backend, textPrefilter: last!.stats.textPrefilter ?? null, correct: ok };
  }
  out['_coldProcess'] = { firstQueryMs: +coldProcessMs.toFixed(1), note: 'new Vault object in a warm OS cache: manifest loaded from disk and synced' }; return out;
}
result.filesystem = await measure('filesystem'); result.sqlite = await measure('sqlite');
const indexBytes = async (dir: string): Promise<number> => { let n = 0; for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = path.join(dir, e.name); n += e.isDirectory() ? await indexBytes(p) : (await fs.stat(p)).size; } return n; };
const source = await currentSourceEvidence();
const sourceBinding = { fingerprint: source.fingerprint, workingTreeSourceFingerprint: source.fingerprint, fullSourceFileCount: Object.keys(source.files).length, files: source.files };
const report = { label, documents: size, runs, seed, node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, memGiB: Math.round(os.totalmem() / 2 ** 30), run_at: new Date().toISOString(), cacheState: 'warm (no privileged purge): cold cache NOT_RUN',
  sourceBinding,
  build: { buildMs: Math.round(buildMs), fsIndexBuild, reused: built, durableCommit: commits.length ? { p50Ms: +pct(commits, 0.5).toFixed(1), p95Ms: +pct(commits, 0.95).toFixed(1), p99Ms: +pct(commits, 0.99).toFixed(1) } : null }, indexBytes: await indexBytes(path.join(root, '.mdb/indexes')), peakRssMB: rssMB(), failures, ...result };
const dir = path.resolve(process.env.BENCH_QUERY_REPORT_DIR ?? 'verification/query/benchmarks'); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${label}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ label, failures, peakRssMB: report.peakRssMB, build: report.build }, null, 1));
for (const m of ['filesystem', 'sqlite'] as const) for (const [k, v] of Object.entries(result[m] as Record<string, { p50Ms: number; documentsMaterialized: number; backend: string }>)) if (!k.startsWith('_')) console.log(`${m}/${k}: p50 ${v.p50Ms} ms, docs materialized ${v.documentsMaterialized}, ${v.backend}`);
if (!keep) await fs.rm(root, { recursive: true, force: true });
if (failures.length) process.exitCode = 1;
