// Phase 0: lock the competitive benchmark contract. Builds the independent oracle golden sets for the 12 workloads of the seeded 100k corpus and validates the oracle
// against Engram itself (a mismatch means the oracle OR Engram is wrong: stop and investigate). Writes verification/performance/competitive-100k-manifest.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadCorpus, oracle, sha256, gz, ripgrepPath } from './lib.mjs';

const corpus = process.argv[2] ?? '/Volumes/sambigdisk1/code/engram-audit2/bench/100k';
const out = 'verification/performance'; await fs.mkdir(`${out}/raw/golden`, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(corpus, '.engram-benchmark-manifest.json'), 'utf8'));
const t0 = Date.now(); const docs = await loadCorpus(corpus); console.error(`parsed ${docs.length} documents in ${Date.now() - t0} ms`);
if (docs.length !== manifest.documents) throw new Error(`oracle parsed ${docs.length} documents, corpus manifest says ${manifest.documents}`);
const { Vault } = await import('../../dist/packages/core/vault.js'); const { FilesystemSearch } = await import('../../dist/packages/search-files/index.js');
const engine = new FilesystemSearch(new Vault(corpus));
const pageAll = async input => { const ids = []; let cursor; for (let i = 0; i < 200; i++) { const r = await engine.query({ ...input, limit: 1000, ...(cursor ? { cursor } : {}) }); ids.push(...r.hits.map(h => h.objectId)); cursor = r.cursor; if (!cursor) return ids; } throw new Error('paging did not terminate'); };
const rows = [];
for (const w of manifest.workloads) {
  const hits = oracle(docs, w.input); const limit = w.input.limit ?? 50; const allIds = hits.map(h => h.id);
  const engineAll = await pageAll(w.input); const engineTop = (await engine.query(w.input)).hits.map(h => h.objectId);
  const allEqual = JSON.stringify([...allIds].sort()) === JSON.stringify([...engineAll].sort()); const topEqual = JSON.stringify(allIds.slice(0, limit)) === JSON.stringify(engineTop);
  const row = { name: w.name, input: w.input, knownCount: w.expectedHits, oracleCount: hits.length, limit, oracleMatchesKnownCount: w.expectedHits === null || w.expectedHits === hits.length,
    rankingKind: (w.input.mode === 'grep') ? 'unranked: every match scores 1, ties ordered by object id' : 'lexical score: per term title +5, heading +2, min(3, occurrences-1... see lib.oracleScore), ties by object id',
    allMatchSha256: sha256(JSON.stringify([...allIds].sort())), topKSha256: sha256(JSON.stringify(allIds.slice(0, limit))), topKIds: allIds.slice(0, Math.min(limit, 5)),
    engineAllSetEqualsOracle: allEqual, engineTopKEqualsOracle: topEqual };
  await fs.writeFile(`${out}/raw/golden/${w.name}.all.json.gz`, gz(allIds)); await fs.writeFile(`${out}/raw/golden/${w.name}.topk.json.gz`, gz(allIds.slice(0, limit)));
  rows.push(row); console.error(`${w.name.padEnd(28)} oracle ${String(hits.length).padStart(6)} known ${String(w.expectedHits).padStart(6)} engine-all ${allEqual ? 'EQ' : 'DIFF'} engine-topK ${topEqual ? 'EQ' : 'DIFF'}`);
}
const bad = rows.filter(r => !r.engineAllSetEqualsOracle || !r.engineTopKEqualsOracle || !r.oracleMatchesKnownCount);
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return null; } };
const RG = ripgrepPath();
const result = { schema: 'competitive-100k-manifest/1', createdAt: new Date().toISOString(), engramBaseSha: sh('git', ['rev-parse', 'HEAD']), corpus: { root: corpus, corpusId: manifest.corpusId, seed: manifest.seed, documents: manifest.documents, fileCount: manifest.fileCount, bodyBytes: manifest.bodyBytes, builtAt: manifest.builtAt, codeRevisionAtBuild: manifest.codeRevision },
  environment: { os: `${sh('sw_vers', ['-productVersion'])} (${os.platform()} ${os.arch()})`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, volume: 'external USB SSD, Journaled HFS+ (case-insensitive)', rg: sh(RG, ['--version']), rgPath: RG, grep: sh('grep', ['--version']), awk: sh('awk', ['--version']), sort: 'BSD sort (macOS)', sqlite3Cli: sh('sqlite3', ['--version']), postgres: 'NOT_RUN: no local server; compose container available (see baseline report)' },
  oracle: { implementation: 'scripts/competitive/lib.mjs (independent re-statement of search semantics; does not import Engram)', validatedAgainstEngram: bad.length === 0, discrepancies: bad.map(b => b.name) },
  workloads: rows };
await fs.writeFile(`${out}/competitive-100k-manifest.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ workloads: rows.length, discrepancies: bad.map(b => b.name), documents: docs.length }));
process.exitCode = bad.length ? 1 : 0;
