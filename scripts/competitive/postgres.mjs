// PostgreSQL competitive comparator (purpose-built, independent of Engram's own index): one documents table, a tag table and a pg_trgm GIN index over lower(title || body).
// ILIKE '%term%' on a trigram index is a case-insensitive SUBSTRING test, the same match rule as Engram's grep terms. Results are checked against the independent oracle golden sets.
// Usage: node scripts/competitive/postgres.mjs --url postgres://... [--corpus DIR] [--label NAME] [--iterations 20] [--warmups 3]
// The target database is dropped and recreated (tables docs_cmp/tags_cmp only); point it at a disposable server. Nothing is sent outside the connection URL.
import { readFileSync, promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { loadCorpus, stats } from './lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const url = arg('url'); if (!url) throw new Error('--url postgres://... is required (use a disposable server)');
const corpus = arg('corpus', '/Volumes/sambigdisk1/code/engram-audit2/bench/100k'); const label = arg('label', 'postgres');
const iterations = Number(arg('iterations', 20)), warmups = Number(arg('warmups', 3));
const out = 'verification/performance';
const manifest = JSON.parse(readFileSync(`${out}/competitive-100k-manifest.json`, 'utf8'));
const golden = (w, kind) => JSON.parse(zlib.gunzipSync(readFileSync(`${out}/raw/golden/${w}.${kind}.json.gz`)).toString());

const pool = new pg.Pool({ connectionString: url, max: 1 }); const db = await pool.connect();
const version = (await db.query('SHOW server_version')).rows[0].server_version;
const t0 = performance.now(); const docs = await loadCorpus(corpus); const parseMs = performance.now() - t0;
await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm; DROP TABLE IF EXISTS tags_cmp; DROP TABLE IF EXISTS docs_cmp;');
await db.query('CREATE TABLE docs_cmp(rowid int PRIMARY KEY, id text NOT NULL, kind text, status text, workspace text, scope text, title text, body text, search text)');
await db.query('CREATE TABLE tags_cmp(doc int NOT NULL, tag text NOT NULL)');
const t1 = performance.now();
const BATCH = 1000;
for (let i = 0; i < docs.length; i += BATCH) {
  const slice = docs.slice(i, i + BATCH); const v = [], p = []; const tagRows = [];
  slice.forEach((d, j) => { const rid = i + j + 1; const o = j * 9; v.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`); p.push(rid, d.id, d.kind, d.status, d.workspaceId ?? '', d.scope, d.title, d.body, `${d.title}\n${d.body}`.toLowerCase()); for (const t of d.tags) tagRows.push([rid, t]); });
  await db.query(`INSERT INTO docs_cmp VALUES ${v.join(',')}`, p);
  if (tagRows.length) await db.query(`INSERT INTO tags_cmp VALUES ${tagRows.map((_, k) => `($${k * 2 + 1},$${k * 2 + 2})`).join(',')}`, tagRows.flat());
}
const loadMs = performance.now() - t1; const t2 = performance.now();
await db.query('CREATE INDEX docs_cmp_trgm ON docs_cmp USING gin (search gin_trgm_ops); CREATE UNIQUE INDEX docs_cmp_id ON docs_cmp(id); CREATE INDEX tags_cmp_tag ON tags_cmp(tag, doc); CREATE INDEX docs_cmp_kind ON docs_cmp(kind, workspace); ANALYZE docs_cmp; ANALYZE tags_cmp;');
const indexMs = performance.now() - t2;
const size = Number((await db.query("SELECT pg_total_relation_size('docs_cmp') + pg_total_relation_size('tags_cmp') AS s")).rows[0].s);

const like = s => `%${s.replace(/[\\%_]/g, c => `\\${c}`).toLowerCase()}%`;
function sql(w) {
  const i = w.input; const k = i.limit ?? 50; if (i.regex) return undefined;
  const where = ["d.status NOT IN ('deleted','tombstone')"], params = [];
  const add = value => { params.push(value); return `$${params.length}`; };
  if (i.mode === 'grep') where.push(`d.search LIKE ${add(like(i.query))}`);
  else {
    const groups = i.query.match(/"[^"]+"|\S+/g); const not = groups.indexOf('NOT');
    const pos = not < 0 ? groups : groups.slice(0, not), neg = not < 0 ? [] : groups.slice(not + 1);
    for (const g of pos) where.push(`d.search LIKE ${add(like(g.replace(/^"|"$/g, '')))}`);
    for (const g of neg) where.push(`d.search NOT LIKE ${add(like(g.replace(/^"|"$/g, '')))}`);
  }
  if (i.tags) where.push(`d.rowid IN (SELECT doc FROM tags_cmp WHERE tag = ${add(i.tags[0])})`);
  if (i.kinds) where.push(`d.kind = ${add(i.kinds[0])}`);
  if (i.scopes) where.push(`d.scope = 'workspace' AND d.workspace = ${add(i.scopes[0].workspaceId)}`);
  return { text: `SELECT d.id FROM docs_cmp d WHERE ${where.join(' AND ')} ORDER BY d.id LIMIT ${k}`, params };
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const rows = [];
for (const w of manifest.workloads) {
  const q = sql(w); if (!q) { rows.push({ workload: w.name, status: 'NOT_EQUIVALENT_OR_UNSUPPORTED', note: 'regex semantics differ between JavaScript and PostgreSQL' }); continue; }
  const samples = []; let ids;
  for (let it = 0; it < warmups + iterations; it++) { const t = performance.now(); const res = await db.query(q.text, q.params); const ms = performance.now() - t; if (it >= warmups) samples.push(+ms.toFixed(3)); ids = res.rows.map(r => r.id); }
  const diagnostic = w.input.mode === 'keyword'; const correct = diagnostic ? null : same(ids, golden(w.name, 'topk'));
  rows.push({ workload: w.name, status: diagnostic ? 'DIAGNOSTIC' : correct ? 'CORRECT' : 'WRONG', comparedTo: diagnostic ? 'diagnostic (ranking is not expressible in SQL)' : 'oracle ranked top-K', resultCount: ids.length, stats: stats(samples), samples });
  console.error(`${w.name.padEnd(28)} ${rows.at(-1).status.padEnd(10)} p50=${rows.at(-1).stats.p50.toFixed(1)}ms p95=${rows.at(-1).stats.p95.toFixed(1)}ms n=${ids.length}`);
}
const result = { schema: 'postgres-comparator/1', label, createdAt: new Date().toISOString(), corpusId: manifest.corpus.corpusId, postgres: version, extension: 'pg_trgm GIN over lower(title||body)', iterations, warmups, build: { documents: docs.length, parseMs: Math.round(parseMs), insertMs: Math.round(loadMs), indexMs: Math.round(indexMs), totalBuildMs: Math.round(parseMs + loadMs + indexMs), bytes: size }, environment: { os: `${os.platform()} ${os.arch()}`, cores: os.cpus().length, note: 'PostgreSQL ran in a local container (virtualized network and disk); the numbers are a comparator, not a native-server measurement. Warm cache only.' }, rows };
await fs.writeFile(`${out}/raw/${label}-samples.json`, JSON.stringify(result, null, 2));
await db.query('DROP TABLE IF EXISTS tags_cmp; DROP TABLE IF EXISTS docs_cmp;'); db.release(); await pool.end();
console.log(JSON.stringify({ label, build: result.build, wrong: rows.filter(r => r.status === 'WRONG').map(r => r.workload) }));
