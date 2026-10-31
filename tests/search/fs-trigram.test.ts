import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { SQLiteSearch } from '../../packages/search-sqlite/index.js';
import { resetFsIndexCache } from '../../packages/search-files/postings.js';
import { regexRequiredLiterals } from '../../packages/search-files/retrieve.js';
import type { Scope, SearchInput, SearchResult } from '../../packages/core/types.js';

const wiki: Scope = { type: 'global', area: 'wiki' };
const wsA: Scope = { type: 'workspace', workspaceId: 'a' };
const wsB: Scope = { type: 'workspace', workspaceId: 'b' };
const INDEX = '.mdb/indexes/fs-trigram';

async function corpus(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('a', '', { agent: ['read', 'write'] }); await vault.createWorkspace('b', '', {});
  const d: Record<string, string> = {};
  const put = async (key: string, scope: Scope, title: string, body: string, tags: string[] = []) => { d[key] = (await vault.put({ scope, kind: 'note', title, body, tags })).id; };
  await put('ascii', wiki, 'Retrieval notes', '# Retrieval\n\nA warm cache improves retrieval latency. The the the.', ['perf']);
  await put('cjk', wiki, '知识库', '知识庫 与 检索 系统。知识库 管理很重要。', ['zh']);
  await put('accent', wiki, 'Café', 'Un café très naïve, résumé of déjà vu.', ['fr']);
  await put('punct', wiki, 'Code', 'Call a.b(c) and x[0] || y && z; path C:\\temp\\file.txt', ['code']);
  await put('upper', wiki, 'Shout', 'MIXED Case Marker-Token appears HERE', []);
  await put('private', wsB, 'Private B', 'warm cache PRIVATE-B-ONLY retrieval secret', []);
  await put('workspace', wsA, 'Team A', 'warm cache team-a-only retrieval', ['team']);
  await put('deleted', wiki, 'Gone', 'tombstoned-unique-token warm cache', []);
  const gone = await vault.get(d.deleted!); await vault.delete(gone.id, gone.revisionId);
  return { root, vault, d };
}
const queries: SearchInput[] = [
  { query: 'warm cache', mode: 'grep' }, { query: 'retrieval', mode: 'keyword' }, { query: '"warm cache"', mode: 'keyword' }, { query: 'a.b(c)', mode: 'grep' }, { query: 'C:\\temp', mode: 'grep' },
  { query: '知识库', mode: 'grep' }, { query: '知识', mode: 'grep' }, { query: 'café', mode: 'grep' }, { query: 'marker-token', mode: 'grep' }, { query: 'MIXED Case', mode: 'grep', caseSensitive: true },
  { query: 'zzz-no-such-token', mode: 'grep' }, { query: 'tombstoned-unique-token', mode: 'grep' }, { query: 'warm retrieval', mode: 'keyword' }, { query: 'PRIVATE-B-ONLY', mode: 'grep' }, { query: 'ca', mode: 'grep' }
];
const signature = (r: SearchResult) => r.hits.map(h => [h.objectId, h.snippet, h.lineStart]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1);
const prefilter = (r: SearchResult) => (r as SearchResult & { index?: { textPrefilter?: string } }).index?.textPrefilter;

test('filesystem trigram index: identical results to the file scan for every query, for the owner and for a restricted agent; serves eligible terms from the index', async t => {
  const { root, vault } = await corpus(t);
  const agentVault = new Vault(root, { actorId: 'agent', permissions: ['global:wiki:read', 'workspace:a:read'] });
  const actors = { owner: new SearchEngine(vault), agent: new SearchEngine(agentVault) };
  const scan = new Map<string, unknown>();
  for (const [who, engine] of Object.entries(actors)) for (const q of queries) { const r = await engine.query({ limit: 100, ...q }); assert.notEqual(prefilter(r), 'fs-trigram'); scan.set(`${who}:${q.query}`, signature(r)); }
  await actors.owner.rebuild();
  assert.ok(((await actors.owner.health()) as { fsIndex?: { present: boolean } }).fsIndex?.present, 'health reports the index');
  const served: string[] = []; const diffs: string[] = [];
  for (const [who, engine] of Object.entries(actors)) for (const q of queries) {
    const r = await engine.query({ limit: 100, ...q }); if (prefilter(r) === 'fs-trigram') served.push(q.query);
    if (JSON.stringify(signature(r)) !== JSON.stringify(scan.get(`${who}:${q.query}`))) diffs.push(`${who}:${q.query}`);
    if (who === 'agent') assert.ok(!r.hits.some(h => h.title === 'Private B'), 'agent never sees the private workspace');
  }
  assert.deepEqual(diffs, []);
  for (const q of ['warm cache', 'retrieval', 'a.b(c)', '知识库', 'marker-token', 'MIXED Case']) assert.ok(served.includes(q), `${q} served by the trigram index`);
  for (const q of ['café', '知识', 'ca']) assert.ok(!served.includes(q), `${q} is not index-eligible and must be scanned`);
  recordCase({ suite: 'search', name: 'fs-trigram-parity', status: 'PASS', detail: { queries: queries.length, servedByIndex: new Set(served).size } });
});

test('filesystem trigram index: commits, edits and deletes after the build are never missing or resurrected', async t => {
  const { vault, d } = await corpus(t); const engine = new SearchEngine(vault); await engine.rebuild();
  const ids = async (query: string, mode: 'grep' | 'keyword' = 'grep') => (await engine.query({ query, mode, limit: 100 })).hits.map(h => h.objectId).sort();
  const fresh = await vault.put({ scope: wiki, kind: 'note', title: 'Fresh', body: 'brand-new-after-index freshtoken' });
  assert.deepEqual(await ids('freshtoken'), [fresh.id]); assert.deepEqual(await ids('freshtoken', 'keyword'), [fresh.id]);
  const old = await vault.get(d.ascii!); await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, body: 'edited-away replaced-token' });
  assert.deepEqual(await ids('latency'), [], 'old content is gone after an edit'); assert.deepEqual(await ids('replaced-token'), [old.id]);
  const up = await vault.get(d.upper!); await vault.delete(up.id, up.revisionId);
  assert.deepEqual(await ids('marker-token'), [], 'a deleted object stays hidden');
  const r = await engine.query({ query: 'freshtoken', mode: 'grep' }); assert.equal(prefilter(r), 'fs-trigram');
  recordCase({ suite: 'search', name: 'fs-trigram-stale-overlay', status: 'PASS', detail: {} });
});

test('a new large vault lazily initializes its configured search index without manual rebuild', async t => {
  const { root, vault } = await disposableVault(t);
  let target = '';
  for (let i = 0; i < 205; i++) {
    const token = `automatic-index-document-${i}`;
    await vault.put({ scope: wiki, kind: 'note', title: `Indexed ${i}`, body: `common corpus ${token}` });
    if (i === 204) target = token;
  }
  const filesystem = new SearchEngine(vault);
  const fsResult = await filesystem.query({ query: target, mode: 'grep', limit: 10 });
  assert.equal(fsResult.hits.length, 1);
  assert.equal(prefilter(fsResult), 'fs-trigram', 'filesystem backend builds its derived index on first useful owner query');
  assert.ok(((await filesystem.health()) as { fsIndex?: { present: boolean } }).fsIndex?.present);

  const config = await vault.config(); config.sqlite.enabled = true; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(config));
  const sqlite = new SQLiteSearch(vault);
  const originalSync = sqlite.sync.bind(sqlite); let releaseSync!: () => void; let startedSync!: () => void;
  const syncStarted = new Promise<void>(resolve => { startedSync = resolve; }); let syncFinished = false;
  const syncGate = new Promise<void>(resolve => { releaseSync = resolve; });
  sqlite.sync = async () => { startedSync(); await syncGate; try { return await originalSync(); } finally { syncFinished = true; } };
  const sqliteResultPromise = sqlite.query({ query: target, mode: 'grep', limit: 10 });
  const sqliteResult = await sqliteResultPromise;
  assert.equal(sqliteResult.hits.length, 1);
  assert.equal(sqliteResult.backend, 'filesystem', 'the first response remains correct while a missing SQLite index is built asynchronously');
  await syncStarted;
  assert.equal(syncFinished, false, 'search returns using the journal overlay before deferred index maintenance completes');
  releaseSync();
  const syncDeadline = Date.now() + 10_000;
  let health = await sqlite.health() as { databases?: Record<string, { ok?: boolean }> };
  while (Date.now() < syncDeadline && !Object.values(health.databases ?? {}).some(bucket => bucket.ok)) {
    await new Promise(resolve => setTimeout(resolve, 20)); health = await sqlite.health() as typeof health;
  }
  assert.ok(Object.values(health.databases ?? {}).some(bucket => bucket.ok), 'SQLite backend was initialized without an explicit rebuild');
  assert.equal((await sqlite.query({ query: target, mode: 'grep', limit: 10 })).backend, 'sqlite');

  const fresh = await vault.put({ scope: wiki, kind: 'note', title: 'Fresh post-index', body: 'automatic-index-fresh-write' });
  assert.deepEqual((await new SearchEngine(vault).query({ query: 'automatic-index-fresh-write', mode: 'grep' })).hits.map(hit => hit.objectId), [fresh.id]);
  recordCase({ suite: 'search', name: 'automatic-default-index-initialization', status: 'PASS', detail: { corpusDocuments: 205, filesystem: true, sqlite: true } });
});

test('filesystem trigram index: a corrupt shard, truncated metadata or a missing index never changes results; damage is reported', async t => {
  const { root, vault } = await corpus(t); const engine = new SearchEngine(vault); await engine.rebuild();
  const want = signature(await engine.query({ query: 'warm cache', mode: 'grep', limit: 100 }));
  const dir = path.join(root, INDEX); const shards = (await fs.readdir(dir)).filter(f => f.endsWith('.bin'));
  for (const f of shards) { const raw = await fs.readFile(path.join(dir, f)); if (raw.length > 8) { raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; await fs.writeFile(path.join(dir, f), raw); } }
  resetFsIndexCache(); const fresh = new SearchEngine(new Vault(root));
  const damaged = await fresh.query({ query: 'warm cache', mode: 'grep', limit: 100 });
  assert.deepEqual(signature(damaged), want); assert.notEqual(prefilter(damaged), 'fs-trigram'); assert.match(damaged.fallback ?? '', /trigram index unusable/);
  await fs.rm(dir, { recursive: true, force: true }); resetFsIndexCache();
  const missing = await new SearchEngine(new Vault(root)).query({ query: 'warm cache', mode: 'grep', limit: 100 });
  assert.deepEqual(signature(missing), want); assert.notEqual(prefilter(missing), 'fs-trigram');
  await engine.rebuild();
  const rebuilt = await new SearchEngine(new Vault(root)).query({ query: 'warm cache', mode: 'grep', limit: 100 });
  assert.deepEqual(signature(rebuilt), want); assert.equal(prefilter(rebuilt), 'fs-trigram');
  recordCase({ suite: 'search', name: 'fs-trigram-corruption', status: 'PASS', detail: { shards: shards.length } });
});

test('regex literal extraction: conservative, never returns a literal an alternative can match without', () => {
  const cases: Array<[string, string[] | undefined]> = [
    ['rare-marker-\\d+|phrase here', ['rare-marker-', 'phrase here']], ['foo.*bar', ['foo']], ['ab?cde', ['cde']], ['colou?r', ['colo']], ['x+yz', undefined],
    ['abc+def', ['abc']], ['(a|b)cde', undefined], ['[a-z]+hello', undefined], ['a{2}bcd', undefined], ['^start of', ['start of']], ['ab|cdef', undefined], ['', undefined], ['\\.config\\.json', ['.config.json']], ['\\d{3}-abcd', undefined]
  ];
  for (const [source, want] of cases) assert.deepEqual(regexRequiredLiterals(source), want, source);
});

test('regex narrowing: randomized patterns return exactly what a brute-force RegExp over every document returns, filesystem index and SQLite alike', async t => {
  const { vault } = await disposableVault(t); const words = ['alpha', 'beta-gamma', 'Delta', 'epsilon42', 'zeta.eta', 'theta_iota', 'KAPPA', 'lambda mu', 'nu-xi', 'omicron'];
  let seed = 20261010; const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const docs: Array<{ id: string; text: string }> = [];
  for (let i = 0; i < 70; i++) { const body = Array.from({ length: 6 + rnd(6) }, () => words[rnd(words.length)]!).join(rnd(2) ? ' ' : '\n'); const title = `Doc ${i} ${words[rnd(words.length)]}`; const doc = await vault.put({ scope: wiki, kind: 'note', title, body }); docs.push({ id: doc.id, text: `${title}\n${body}` }); }
  const atoms = ['alpha', 'beta-gamma', 'delta', 'EPSILON', 'zeta\\.eta', 'theta_iota', 'kappa', 'lambda mu', 'nu-xi', 'omi', 'a', 'x?', 'ph', '.*', '\\d+', '[a-z]', '\\w+', 'e+'];
  const patterns = new Set<string>(); while (patterns.size < 60) { const branch = () => Array.from({ length: 1 + rnd(3) }, () => atoms[rnd(atoms.length)]!).join(''); patterns.add(Array.from({ length: 1 + rnd(3) }, branch).join('|')); }
  const engines: Array<[string, SearchEngine]> = [['files+index', new SearchEngine(vault)]];
  await engines[0]![1].rebuild();
  const config = await vault.config(); config.sqlite.enabled = true; await fs.writeFile(path.join(vault.root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
  const sqlite = new SearchEngine(new Vault(vault.root)); await sqlite.rebuild(); engines.push(['sqlite', sqlite]);
  let narrowed = 0; const diffs: string[] = [];
  for (const source of patterns) for (const caseSensitive of [false, true]) {
    let regex: RegExp; try { regex = new RegExp(source, caseSensitive ? '' : 'i'); } catch { continue; }
    const want = docs.filter(d => regex.test(d.text)).map(d => d.id).sort();
    for (const [name, engine] of engines) {
      let r: SearchResult; try { r = await engine.query({ query: source, mode: 'grep', regex: true, caseSensitive, limit: 1000 }); } catch (error) { if ((error as { code?: string }).code === 'INVALID_INPUT') continue; throw error; } // the engine refuses unsafe patterns; that is not a narrowing question
      if (prefilter(r) !== 'none') narrowed++;
      const got = r.hits.map(h => h.objectId).sort(); if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${name} /${source}/${caseSensitive ? '' : 'i'}: got ${got.length} want ${want.length}`);
    }
  }
  assert.deepEqual(diffs, []); assert.ok(narrowed > 20, `the fuzz must exercise the narrowed path (narrowed ${narrowed})`);
  recordCase({ suite: 'search', name: 'regex-narrowing-fuzz', status: 'PASS', detail: { patterns: patterns.size, narrowedRuns: narrowed } });
});
