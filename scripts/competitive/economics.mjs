// Index economics: build cost, size, update overhead and break-even query counts against the measured shell pipelines. Update experiments run on the disposable FS-only COPY of the corpus,
// never on the retained benchmark corpus. Usage: node scripts/competitive/economics.mjs LABEL FSCOPY
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
const label = process.argv[2] ?? 'final', fsCopy = process.argv[3] ?? '/Volumes/sambigdisk1/code/engram-audit2/competitive/fs-only-100k'; const main = '/Volumes/sambigdisk1/code/engram-audit2/bench/100k'; const out = 'verification/performance';
const du = p => { try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0]) * 1024; } catch { return null; } };
const { Vault } = await import('../../dist/packages/core/vault.js'); const { FilesystemSearch } = await import('../../dist/packages/search-files/index.js'); const { buildFsIndex } = await import('../../dist/packages/search-files/postings.js');
const manifest = JSON.parse(await fs.readFile(`${out}/competitive-100k-manifest.json`, 'utf8')); const run = JSON.parse(await fs.readFile(`${out}/raw/${label}-samples.json`, 'utf8'));
const pb = JSON.parse(await fs.readFile('/Volumes/sambigdisk1/code/engram-audit2/competitive/purpose-built.sqlite.build.json', 'utf8'));
const mainManifest = JSON.parse(await fs.readFile(path.join(main, '.engram-benchmark-manifest.json'), 'utf8'));
const sizes = { corpusMarkdownBytes: mainManifest.bodyBytes, corpusTotalBytesOnDisk: du(main), engramFsTrigramIndexBytes: du(`${fsCopy}/.mdb/indexes/fs-trigram`), engramManifestBytes: (await fs.stat(`${fsCopy}/.mdb/indexes/manifest.v4.jsonl`)).size, engramSqliteIndexBytes: du(`${main}/.mdb/indexes`) - (await fs.stat(`${main}/.mdb/indexes/manifest.v4.jsonl`).then(s => s.size, () => 0)) - (du(`${main}/.mdb/indexes/fs-trigram`) ?? 0), purposeBuiltSqliteBytes: pb.dbBytes };
// Build costs (measured now, FS copy): trigram index only; the manifest is rebuilt separately by deleting it.
const v = new Vault(fsCopy); const t0 = performance.now(); const built = await buildFsIndex(v); const buildFsIndexMs = performance.now() - t0;
await fs.rm(`${fsCopy}/.mdb/indexes/manifest.v4.jsonl`, { force: true }); const { manifestFor } = await import('../../dist/packages/search-files/manifest.js'); const t1 = performance.now(); const mf = await manifestFor(new Vault(fsCopy)); const buildManifestMs = performance.now() - t1; await mf.save();
// Update overhead: commit N new documents into the copy, then measure the query cost with the stale overlay, then rebuild.
const engine = new FilesystemSearch(new Vault(fsCopy)); const wl = manifest.workloads.filter(w => ['grep-rare', 'keyword-multi', 'metadata-tag'].includes(w.name));
const time = async w => { const s = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await engine.query(w.input); s.push(performance.now() - t); } s.sort((a, b) => a - b); return +s[2].toFixed(1); };
const before = Object.fromEntries(await Promise.all(wl.map(async w => [w.name, await time(w)])));
const writer = new Vault(fsCopy); const commitMs = []; for (let i = 0; i < 300; i++) { const t = performance.now(); await writer.put({ scope: { type: 'workspace', workspaceId: 'bench0' }, kind: 'wiki_page', title: `economics doc ${i}`, body: `# Economics ${i}\n\nrare-marker-${mainManifest.seed} document index1 cache2 ${'filler '.repeat(40)}`, tags: ['alpha'] }); commitMs.push(performance.now() - t); }
const afterWrites = {}; for (const w of wl) afterWrites[w.name] = await time(w);
const t2 = performance.now(); await buildFsIndex(new Vault(fsCopy)); const rebuildAfterWritesMs = performance.now() - t2; const afterRebuild = {}; for (const w of wl) afterRebuild[w.name] = await time(w);
commitMs.sort((a, b) => a - b);
// Break-even versus the equivalent shell pipeline (warm).
const get = (w, s) => run.rows.find(r => r.workload === w && r.system === s)?.stats; const breakeven = {};
for (const w of manifest.workloads.map(x => x.name)) { const sh = get(w, 'shell-topk'), en = get(w, 'engram-fs'); if (!sh || !en) continue; const gain = sh.p50 - en.p50; const build = buildFsIndexMs + buildManifestMs;
  breakeven[w] = { shellP50Ms: sh.p50, engramP50Ms: en.p50, gainPerQueryMs: +gain.toFixed(1), buildMs: Math.round(build), breakEvenQueries: gain > 0 ? Math.ceil(build / gain) : null, totalMsAfter: Object.fromEntries([1, 10, 100, 1000].map(n => [n, { shell: Math.round(sh.p50 * n), engram: Math.round(build + en.p50 * n) }])) }; }
const report = { label, createdAt: new Date().toISOString(), sizes, build: { engramFsTrigramIndex: { ms: Math.round(buildFsIndexMs), documents: built.documents, bytes: built.bytes }, engramManifestMs: Math.round(buildManifestMs), engramSqliteIndexMsFromCorpusManifest: mainManifest.benchmarkConfiguration.indexBuildMs, purposeBuiltSqliteMs: pb.totalBuildMs },
  update: { note: 'a commit writes no index; the filesystem index is refreshed by rebuild, and objects newer than it are candidates through the stale overlay', commitsMeasured: commitMs.length, commitP50Ms: +commitMs[150].toFixed(1), commitP95Ms: +commitMs[285].toFixed(1), queryP50BeforeMs: before, queryP50After300WritesMs: afterWrites, rebuildAfterWritesMs: Math.round(rebuildAfterWritesMs), queryP50AfterRebuildMs: afterRebuild }, breakeven };
await fs.writeFile(`${out}/raw/${label}-economics.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ sizes, build: report.build, update: report.update }, null, 1));
