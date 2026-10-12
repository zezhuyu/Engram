// One fresh process: where does a CLI-like cold start spend its time? Usage: node stage-startup.mjs <vault root> <nohit|cjk>. Prints one JSON line. Read-only.
import { performance } from 'node:perf_hooks';
const [, , root, kind = 'nohit'] = process.argv; const bootMs = performance.now(); // time since the process started, before any of our code ran
const mark = []; const lap = (name) => mark.push([name, performance.now()]);
lap('start'); const { Vault } = await import('../../dist/packages/core/vault.js'); const { manifestFor } = await import('../../dist/packages/search-files/manifest.js'); const { FilesystemSearch } = await import('../../dist/packages/search-files/index.js'); lap('import');
const vault = new Vault(root); lap('vaultOpen');
await vault.journalSince(0); lap('journalParse'); // full committed-journal parse (cached afterwards)
const manifest = await manifestFor(vault); lap('manifest'); // load from disk + catch-up sync (journal already parsed)
const engine = new FilesystemSearch(vault); const q = kind === 'cjk' ? { query: '知识库', mode: 'grep', limit: 1000 } : { query: 'zz-no-such-token-zz', mode: 'grep', limit: 50 };
const first = await engine.query(q); lap('firstQuery');
const out = { kind, bootMs: +bootMs.toFixed(1), manifestEntries: manifest.entries.size, hits: first.hits.length, fastPath: first.index?.fastPath ?? null, loaded: first.index?.loaded ?? null };
for (let i = 1; i < mark.length; i++) out[mark[i][0] + 'Ms'] = +(mark[i][1] - mark[i - 1][1]).toFixed(1);
out.totalAfterBootMs = +(mark.at(-1)[1] - mark[0][1]).toFixed(1); out.rssMiB = Math.round(process.memoryUsage().rss / 2 ** 20); const cpu = process.cpuUsage(); out.cpuUserMs = Math.round(cpu.user / 1000); out.cpuSysMs = Math.round(cpu.system / 1000);
console.log(JSON.stringify(out));
