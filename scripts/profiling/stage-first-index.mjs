import { performance } from 'node:perf_hooks';
const root = process.argv[2]; const t0 = performance.now();
const { Vault } = await import('../../dist/packages/core/vault.js'); const { manifestFor } = await import('../../dist/packages/search-files/manifest.js'); const { buildFsIndex } = await import('../../dist/packages/search-files/postings.js');
const t1 = performance.now(); const vault = new Vault(root); const t2 = performance.now();
const manifest = await manifestFor(vault); const t3 = performance.now();
const index = await buildFsIndex(vault); const t4 = performance.now();
console.log(JSON.stringify({ moduleImportMs: Math.round(t1 - t0), vaultConstructMs: Math.round(t2 - t1), manifestBuildMs: Math.round(t3 - t2), manifestEntries: manifest.entries.size, loadedFromDisk: manifest.loadedFromDisk, trigramBuildMs: Math.round(t4 - t3), trigram: index, totalMs: Math.round(t4 - t0), heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 2 ** 20) }));
