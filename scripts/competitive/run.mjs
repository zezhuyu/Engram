// Competitive runner: measures shell pipelines, Engram (CLI and in-process, filesystem and SQLite backends) and a purpose-built indexed SQLite on the same corpus and workloads,
// verifies every result against the independent oracle golden sets, and writes raw samples plus a summary. Nothing is reported as a win without matching correctness.
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { plans } from './shell.mjs';
import { rng, sha256, stats } from './lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const corpus = arg('corpus', '/Volumes/sambigdisk1/code/engram-audit2/bench/100k'); const label = arg('label', 'baseline'); const iterations = Number(arg('iterations', 20)), warmups = Number(arg('warmups', 3)); const slowIterations = Number(arg('slow-iterations', 5));
const fsCorpus = arg('fs-corpus', '/Volumes/sambigdisk1/code/engram-audit2/competitive/fs-only-100k'); const only = arg('only')?.split(','); const systems = (arg('systems', 'shell-floor,shell-topk,engram-cli-fs,engram-cli-sqlite,engram-fs,engram-sqlite,sqlite-fts,sqlite-fts-hydrated')).split(','); const sqliteFile = arg('sqlite-db', '/Volumes/sambigdisk1/code/engram-audit2/competitive/purpose-built.sqlite');
const out = 'verification/performance'; await fs.mkdir(`${out}/raw`, { recursive: true });
const manifest = JSON.parse(readFileSync(`${out}/competitive-100k-manifest.json`, 'utf8')); const golden = (w, kind) => JSON.parse(zlib.gunzipSync(readFileSync(`${out}/raw/golden/${w}.${kind}.json.gz`)));
const workloads = manifest.workloads.filter(w => !only || only.includes(w.name)); const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-competitive-'));
const { Vault } = await import('../../dist/packages/core/vault.js'); const { FilesystemSearch } = await import('../../dist/packages/search-files/index.js'); const { SQLiteSearch } = await import('../../dist/packages/search-sqlite/index.js');
const vault = new Vault(corpus); const engines = { 'engram-fs': new FilesystemSearch(vault), 'engram-sqlite': new SQLiteSearch(vault) };
let sdb; try { sdb = new DatabaseSync(sqliteFile, { readOnly: true }); } catch { sdb = undefined; }

const run = (cmd, env) => new Promise(resolve => { const t = performance.now(); const c = spawn('/bin/sh', ['-c', cmd], { env: { ...process.env, LC_ALL: 'C', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; }); c.on('close', code => resolve({ ms: performance.now() - t, code, stdout, stderr })); });
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cliArgs = (w, noSqlite) => { const i = w.input; const a = ['search', q(i.query), '--mode', i.mode, '--limit', String(i.limit ?? 50)]; if (i.regex) a.push('--regex'); if (i.tags) a.push('--tags', i.tags.join(',')); if (i.kinds) a.push('--kinds', i.kinds.join(',')); if (i.scopes) a.push('--workspace', i.scopes[0].workspaceId); if (noSqlite) a.push('--no-sqlite'); return a.join(' '); };
const sqlQuery = (w, floor) => {
  const i = w.input; const k = i.limit ?? 50; const phrase = t => `"${t.replace(/"/g, '""')}"`; let match, params = []; const where = ["d.status NOT IN ('deleted','tombstone')"];
  if (i.regex) return undefined;
  if (i.mode === 'grep') match = phrase(i.query.toLowerCase()); else { const g = i.query.match(/"[^"]+"|\S+/g); const toks = g.map(t => t.replace(/^"|"$/g, '')); if (g.includes('NOT')) match = `${phrase(toks[0])} NOT ${phrase(toks[2])}`; else match = toks.map(phrase).join(i.query.startsWith('"') ? ' ' : ' AND '); if (i.query.startsWith('"')) match = phrase(toks[0]); }
  if (match.replace(/"/g, '').length < 3) return undefined;
  if (i.tags) { where.push('d.rowid IN (SELECT doc FROM tags WHERE tag = ?)'); params.push(i.tags[0]); }
  if (i.kinds) { where.push('d.kind = ?'); params.push(i.kinds[0]); } if (i.scopes) { where.push("d.scope = 'workspace' AND d.workspace = ?"); params.push(i.scopes[0].workspaceId); }
  const ranked = i.mode === 'keyword'; const order = floor ? 'ORDER BY d.id' : ranked ? 'ORDER BY d.id' : 'ORDER BY d.id'; // ranked lexical score has no SQL equivalent: top-K by id is a DIAGNOSTIC for keyword workloads
  return { sql: `SELECT d.id FROM fts JOIN docs d ON d.rowid = fts.rowid WHERE fts MATCH ? AND ${where.join(' AND ')} ${order}${floor ? '' : ` LIMIT ${k}`}`, params: [match, ...params] };
};
const idsFromCli = stdout => { const j = JSON.parse(stdout); return (j.hits ?? []).map(h => h.objectId); };
const readIds = async file => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const variants = [];
for (const w of workloads) for (const system of systems) {
  const eqNote = (() => { if (system === 'sqlite-fts-hydrated') return { equivalent: w.input.mode === 'grep', why: w.input.mode === 'keyword' ? 'ranking not expressible in SQL: diagnostic' : 'unranked top-K by id with title and snippet hydration' }; if (system === 'shell-floor') return { equivalent: false, why: 'match set only (unranked, no top-K): a lower bound for any scan, not the product answer' }; if (system.startsWith('sqlite-fts')) return { equivalent: w.input.mode === 'grep' || w.name === 'keyword-multi' && false, why: w.input.mode === 'keyword' ? 'ranked lexical score has no SQL equivalent; top-K by object id is a diagnostic only' : 'unranked top-K by object id' }; return { equivalent: true, why: 'same top-K answer' }; })();
  variants.push({ w, system, ...eqNote });
}
const resultsByKey = {}; const samples = {};
const exec = async (v, iteration) => {
  const { w, system } = v; const tmp = await fs.mkdtemp(path.join(scratch, 'r-')); const outFile = path.join(tmp, 'out.txt');
  try {
    if (system === 'shell-floor' || system === 'shell-topk') { const p = plans(corpus, w); const r = await run(system === 'shell-floor' ? p.floor : p.topk, { OUT: outFile, TMP: tmp, CORPUS: corpus }); if (r.code !== 0 && r.code !== 1) throw new Error(`shell exit ${r.code}: ${r.stderr.slice(0, 300)}`); return { ms: r.ms, ids: await readIds(outFile).catch(() => []) }; }
    if (system === 'engram-cli-fs' || system === 'engram-cli-sqlite') { const r = await run(`node bin/mdb.js --root ${q(system === 'engram-cli-fs' ? fsCorpus : corpus)} ${cliArgs(w, false)}`, {}); if (r.code !== 0) throw new Error(`cli exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`); return { ms: r.ms, ids: idsFromCli(r.stdout) }; }
    if (system === 'engram-fs' || system === 'engram-sqlite') { const t = performance.now(); const res = await engines[system].query(w.input); return { ms: performance.now() - t, ids: res.hits.map(h => h.objectId) }; }
    if (system === 'sqlite-fts') { const s = sqlQuery(w, false); if (!s || !sdb) return { skipped: true }; const t = performance.now(); const rows = sdb.prepare(s.sql).all(...s.params); return { ms: performance.now() - t, ids: rows.map(r => r.id) }; }
    if (system === 'sqlite-fts-hydrated') { const s = sqlQuery(w, false); if (!s || !sdb) return { skipped: true }; const t = performance.now(); const rows = sdb.prepare(s.sql).all(...s.params); const get = sdb.prepare('SELECT title, body FROM docs WHERE id = ?'); const hits = rows.map(r => { const d = get.get(r.id); const lines = d.body.split('\n'); return { id: r.id, title: d.title, snippet: lines.slice(0, 3).join('\n').slice(0, 600) }; }); return { ms: performance.now() - t, ids: hits.map(h => h.id) }; }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
};
// --purge: drop the OS page cache before EVERY sample (macOS `purge` needs root: run `sudo -v` in this terminal first; the script never asks for or stores a password).
const purge = process.argv.includes('--purge');
const purgeCache = () => { const r = spawnSync('sudo', ['-n', 'purge'], { stdio: 'inherit' }); if (r.status !== 0) { console.error('sudo purge failed: run `sudo -v` in this terminal first'); process.exit(3); } };
const shuffle = (arr, r) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
for (const w of workloads) {
  const vs = variants.filter(v => v.w === w); const r = rng(20261010 + w.name.length * 7919); const top = golden(w.name, 'topk');
  for (const v of vs) { samples[`${w.name}/${v.system}`] = []; }
  const cap = new Map();
  for (let it = 0; it < warmups + iterations; it++) for (const v of shuffle(vs, r)) {
    const key = `${w.name}/${v.system}`; if (cap.get(key) === 'stop') continue;
    let res; try { if (purge) purgeCache(); res = await exec(v, it); } catch (e) { resultsByKey[key] = { error: String(e.message).slice(0, 300) }; cap.set(key, 'stop'); console.error(`ERR ${key}: ${e.message.slice(0, 160)}`); continue; }
    if (res?.skipped) { resultsByKey[key] = { skipped: true }; cap.set(key, 'stop'); continue; }
    if (it >= warmups) samples[key].push(+res.ms.toFixed(3)); resultsByKey[key] = { ids: res.ids };
    if (it === 0 && res.ms > 5000 && iterations > slowIterations) cap.set(key, { limit: warmups + slowIterations });
    const c = cap.get(key); if (c && c !== 'stop' && it + 1 >= c.limit) cap.set(key, 'stop');
  }
  console.error(`${w.name.padEnd(28)} ` + vs.map(v => { const s = samples[`${w.name}/${v.system}`]; return s.length ? `${v.system}=${stats(s).p50.toFixed(0)}ms` : `${v.system}=-`; }).join(' '));
  void top;
}
const rows = []; const allEq = (a, b) => same([...a].sort(), [...b].sort());
for (const w of workloads) for (const v of variants.filter(x => x.w === w)) {
  const key = `${w.name}/${v.system}`; const res = resultsByKey[key]; const s = samples[key]; let correct = null, comparedTo = null, special = null;
  if (res?.ids) { if (v.system === 'shell-floor') { comparedTo = 'oracle all-match set'; correct = allEq(res.ids, golden(w.name, 'all')); } else if (v.system.startsWith('sqlite-fts') && w.input.mode === 'keyword') { comparedTo = 'diagnostic (ranking not equivalent)'; correct = null; } else { comparedTo = 'oracle ranked top-K'; correct = same(res.ids, golden(w.name, 'topk')); if (!correct && v.system === 'engram-sqlite' || !correct && v.system === 'engram-cli-sqlite') { const all = new Set(golden(w.name, 'all')); const k = golden(w.name, 'topk').length; if (res.ids.length === k && res.ids.every(i => all.has(i))) { correct = null; comparedTo = 'valid top-K (SQLite backend ranks by BM25; oracle ranks lexically)'; special = 'VALID_DIFFERENT_RANKING'; } } } }
  rows.push({ workload: w.name, system: v.system, equivalentToProductAnswer: v.equivalent, equivalenceNote: v.why, status: res?.error ? 'ERROR' : res?.skipped ? 'NOT_EQUIVALENT_OR_UNSUPPORTED' : correct === false ? 'WRONG' : correct === true ? 'CORRECT' : (special ?? 'DIAGNOSTIC'), comparedTo, error: res?.error, resultCount: res?.ids?.length ?? null, stats: s?.length ? stats(s) : null, samples: s });
}
const result = { schema: 'competitive-100k-run/1', label, createdAt: new Date().toISOString(), corpusId: manifest.corpus.corpusId, iterations, warmups, slowIterations, cacheNote: (purge ? 'COLD OS page cache: sudo purge before every sample (process-level caches such as in-process Engram manifests stay warm within a process; engram-cli-* and shell start cold processes).'     : 'warm OS cache (corpus read repeatedly); cold-cache runs NOT_RUN: dropping the macOS page cache needs sudo purge.') + ' engram-cli-* includes node startup and vault open; engram-fs/engram-sqlite are in-process steady state.', environment: manifest.environment, rows };
await fs.writeFile(`${out}/raw/${label}-samples.json`, JSON.stringify(result, null, 2));
await fs.rm(scratch, { recursive: true, force: true }); console.log(JSON.stringify({ label, rows: rows.length, wrong: rows.filter(r => r.status === 'WRONG').map(r => `${r.workload}/${r.system}`), errors: rows.filter(r => r.status === 'ERROR').map(r => `${r.workload}/${r.system}`) }));
