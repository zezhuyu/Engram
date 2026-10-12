// In-process steady-state and first-query measurements on an FS corpus. Usage: node stage-queries.mjs <root> <workload> <iterations>
import { performance } from 'node:perf_hooks';
const [, , root, name, iters = '100'] = process.argv; const t0 = performance.now();
const { Vault } = await import('../../dist/packages/core/vault.js'); const { FilesystemSearch } = await import('../../dist/packages/search-files/index.js'); const t1 = performance.now();
const W = { 'grep-nonexistent': { query: 'zz-no-such-token-zz', mode: 'grep', limit: 50 }, 'grep-cjk': { query: '知识库', mode: 'grep', limit: 1000 }, 'grep-rare': { query: 'rare-marker-20261008', mode: 'grep', limit: 1000 }, 'keyword-single-rare': { query: 'rare-marker-20261008', mode: 'keyword', limit: 1000 } }[name];
const engine = new FilesystemSearch(new Vault(root)); const t2 = performance.now();
const first = await engine.query(W); const t3 = performance.now(); const samples = []; let last = first;
for (let i = 0; i < Number(iters); i++) { const s = performance.now(); last = await engine.query(W); samples.push(performance.now() - s); }
samples.sort((a, b) => a - b); const q = p => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
console.log(JSON.stringify({ workload: name, moduleImportMs: Math.round(t1 - t0), vaultAndEngineMs: Math.round(t2 - t1), firstQueryMs: Math.round(t3 - t2), steady: { n: samples.length, p50: samples.length ? Number(q(0.5).toFixed(1)) : null, p95: samples.length ? Number(q(0.95).toFixed(1)) : null, p99: samples.length ? Number(q(0.99).toFixed(1)) : null, min: samples.length ? Number(samples[0].toFixed(1)) : null }, rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20), hits: first.hits.length, index: last.index ?? null }));
