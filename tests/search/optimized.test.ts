import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DatabaseSync } from 'node:sqlite';
import { disposableVault } from '../helpers/disposable-vault.js';
import { modules, runChild } from '../helpers/child.js';
import { Prng } from '../helpers/prng.js';
import { recordCase } from '../helpers/report.js';
import { verifyInvariants } from '../helpers/invariants.js';
import { documentBodyLineOffset, parseDocument, serializeDocument, Vault } from '../../packages/core/vault.js';
import { SearchEngine, authorizedDocuments, mapBodyLines, searchDocuments } from '../../packages/search-files/index.js';
import { ripgrepAvailable } from '../../packages/search-files/retrieve.js';
import type { Scope, SearchInput } from '../../packages/core/types.js';

type T = { after(fn: () => void | Promise<void>): void };
const wiki: Scope = { type: 'global', area: 'wiki' };
const shared: Scope = { type: 'global', area: 'shared' };
async function setSqlite(vault: Vault, enabled: boolean) { const c = await vault.config(); c.sqlite.enabled = enabled; await fs.writeFile(path.join(vault.root, 'mdb.yaml'), YAML.stringify(c)); }
/** The oracle is the pre-refactor behavior: load every authorized document, then apply the shared scorer. */
async function oracle(vault: Vault, input: SearchInput) { const docs = await authorizedDocuments(vault, input, vault.actor); await mapBodyLines(vault, docs); return searchDocuments(docs, input, 'oracle').hits; }
const shape = (hits: { objectId: string; revisionId: string; snippet: string; lineStart: number; score: number }[]) => hits.map(h => `${h.objectId}|${h.revisionId}|${h.lineStart}|${h.score}|${h.snippet}`);
const member = (h: { objectId: string; revisionId: string; snippet: string; lineStart: number }) => `${h.objectId}|${h.revisionId}|${h.lineStart}|${h.snippet}`;
/**
 * Filesystem results must equal the full-corpus oracle exactly. When the SQLite index ranks keyword results with BM25 (result.ranking === 'bm25') the SET of matches, their
 * revisions, lines and snippets must still equal the oracle's, and the order must be non-increasing in the reported score; only the order/score are index relevance by design.
 */
async function same(engine: SearchEngine, vault: Vault, input: SearchInput, label: string) {
  const got = await engine.query({ limit: 1000, ...input }); const want = await oracle(vault, { limit: 1000, ...input });
  if (got.ranking !== 'bm25') { assert.deepEqual(shape(got.hits), shape(want), label); return got; }
  const full = await oracle(vault, { ...input, limit: 1000, cursor: undefined }); const fullIds = new Set(full.map(member)); const limit = input.limit ?? 1000, offset = Number(input.cursor ?? '0');
  assert.equal(got.hits.length, Math.min(limit, Math.max(0, full.length - offset)), `${label}: page size`);
  assert.equal(got.cursor !== undefined, offset + limit < full.length, `${label}: cursor`);
  for (const h of got.hits) assert.ok(fullIds.has(member(h)), `${label}: ${h.objectId} is a real match with the same revision, line and snippet`);
  for (let i = 1; i < got.hits.length; i++) assert.ok(got.hits[i - 1]!.score >= got.hits[i]!.score, `${label}: BM25 order`);
  if (offset === 0 && limit >= full.length) assert.deepEqual(got.hits.map(member).sort(), full.map(member).sort(), `${label}: same members`);
  return got;
}

async function randomCorpus(t: T, seed: number, size = 90) {
  const { root, vault } = await disposableVault(t);
  const rng = new Prng(seed);
  await vault.createWorkspace('w1', ''); await vault.createWorkspace('w2', '');
  const scopes: Scope[] = [wiki, shared, { type: 'workspace', workspaceId: 'w1' }, { type: 'workspace', workspaceId: 'w2' }];
  const ids: string[] = [];
  for (let i = 0; i < size; i++) {
    const body = Array.from({ length: 1 + rng.int(4) }, () => rng.text(4 + rng.int(8))).join('\n') + (rng.next() < 0.1 ? '\n# Heading ' + rng.word() : '') + (rng.next() < 0.1 ? '\ncall a.b(c) [x]' : '');
    const doc = await vault.put({ scope: rng.pick(scopes), kind: rng.pick(['note', 'insight', 'fact']), title: `${rng.word()} ${rng.word()} ${i}`, body, tags: rng.next() < 0.5 ? [rng.pick(['red', 'blue'])] : [] });
    ids.push(doc.id);
  }
  return { root, vault, rng, ids, scopes };
}
function randomQueries(rng: Prng): SearchInput[] {
  const qs: SearchInput[] = [];
  const w = () => rng.word();
  for (let i = 0; i < 40; i++) {
    const r = rng.int(10);
    if (r === 0) qs.push({ query: w(), mode: 'keyword' });
    else if (r === 1) qs.push({ query: `${w()} ${w()}`, mode: 'keyword' });
    else if (r === 2) qs.push({ query: `"${w()} ${w()}"`, mode: 'keyword' });
    else if (r === 3) qs.push({ query: `${w()} OR ${w()}`, mode: 'keyword' });
    else if (r === 4) qs.push({ query: `${w()} NOT ${w()}`, mode: 'keyword' });
    else if (r === 5) qs.push({ query: w().slice(0, 4), mode: 'grep' });
    else if (r === 6) qs.push({ query: w(), mode: 'grep', caseSensitive: true });
    else if (r === 7) qs.push({ query: `${w()}|${w()}`, mode: 'grep', regex: true });
    else if (r === 8) qs.push({ query: w(), mode: 'keyword', tags: [rng.pick(['red', 'blue'])] });
    else qs.push({ query: w(), mode: 'keyword', kinds: [rng.pick(['note', 'fact'])], scopes: [rng.pick([wiki, { type: 'workspace', workspaceId: 'w1' } as Scope])] });
  }
  qs.push({ query: 'a.b(c)', mode: 'grep' }, { query: 'Heading', mode: 'grep' }, { query: 'zzz-nothing-zzz', mode: 'grep' }, { query: 'NOT alpha', mode: 'keyword' });
  return qs;
}

for (const seed of [11, 4242, 90210]) {
  test(`seed ${seed}: ripgrep, raw-file scan and SQLite equal the full-corpus oracle (ids, revisions, lines, scores, snippets)`, async t => {
    const { vault, rng } = await randomCorpus(t, seed);
    const queries = randomQueries(rng);
    const files = new SearchEngine(vault);
    const originalNoRg = process.env.MDB_NO_RIPGREP;
    try {
      delete process.env.MDB_NO_RIPGREP; for (const q of queries) await same(files, vault, q, `files${ripgrepAvailable() ? '+rg' : ''}: ${JSON.stringify(q)}`);
      process.env.MDB_NO_RIPGREP = '1'; for (const q of queries) await same(files, vault, q, `scanner: ${JSON.stringify(q)}`);
      for (const q of [
        { query: 'a', mode: 'grep' as const, limit: 5, cursor: '3' },
        { query: 'index cache', mode: 'keyword' as const, limit: 7, cursor: '4' },
        { query: '[aeiou]', mode: 'grep' as const, regex: true, limit: 4, cursor: '6' }
      ]) await same(files, vault, q, `bounded page: ${JSON.stringify(q)}`);
    } finally { if (originalNoRg === undefined) delete process.env.MDB_NO_RIPGREP; else process.env.MDB_NO_RIPGREP = originalNoRg; }
    await setSqlite(vault, true); const sql = new SearchEngine(vault); await sql.rebuild();
    for (const q of queries) { const r = await same(sql, vault, q, `sqlite: ${JSON.stringify(q)}`); assert.equal(r.backend, 'sqlite'); }
    for (const q of [
      { query: 'a', mode: 'grep' as const, limit: 5, cursor: '3' },
      { query: 'index cache', mode: 'keyword' as const, limit: 7, cursor: '4' },
      { query: '[aeiou]', mode: 'grep' as const, regex: true, limit: 4, cursor: '6' }
    ]) await same(sql, vault, q, `sqlite bounded page: ${JSON.stringify(q)}`);
    recordCase({ suite: 'search-optimized', name: `oracle-parity-seed-${seed}`, status: 'PASS', seed, detail: { queries: queries.length, ripgrep: ripgrepAvailable() } });
  });
}

test('parsed immutable revisions carry exact LF/CRLF body offsets through Vault visibility', async t => {
  const { vault } = await disposableVault(t); await vault.createWorkspace('offsets');
  const doc = await vault.put({ scope: { type: 'workspace', workspaceId: 'offsets' }, kind: 'note', title: 'Line offset', body: '# Heading\noffset-marker\ntrailing' });
  const serialized = serializeDocument(doc);
  for (const separator of ['\n', '\r\n']) {
    const source = serialized.replaceAll('\n', separator); const parsed = parseDocument(source);
    const expectedOffset = source.slice(0, source.indexOf(doc.body.replaceAll('\n', separator))).split('\n').length - 1;
    assert.equal(documentBodyLineOffset(parsed), expectedOffset, `offset for ${JSON.stringify(separator)}`);
  }
  const visible = await vault.get(doc.id); const source = await fs.readFile(path.join(vault.root, `.mdb/objects/${doc.id}/revs/${doc.revisionId}.md`), 'utf8');
  const expectedOffset = source.slice(0, source.indexOf(doc.body)).split('\n').length - 1;
  assert.equal(documentBodyLineOffset(visible), expectedOffset, 'Vault visibility clone retains parsed source offset');
  const hit = (await new SearchEngine(vault).query({ query: 'offset-marker', mode: 'grep' })).hits[0]!;
  assert.equal(hit.lineStart, source.split('\n').findIndex(line => line === 'offset-marker') + 1, 'search result uses the immutable revision line');
});

test('journal overlay: create, update, tombstone, purge and restore after the checkpoint are served correctly, lag is reported, sync converges to rebuild', async t => {
  const { vault, ids, rng } = await randomCorpus(t, 77, 60);
  await setSqlite(vault, true); const engine = new SearchEngine(vault); await engine.rebuild();
  const queries = randomQueries(rng).slice(0, 25);
  const check = async (label: string, expectLag: boolean) => { let lagged = false; for (const q of queries) { const r = await same(engine, vault, q, `${label}: ${JSON.stringify(q)}`) as { fallback?: string; index?: { lagObjects?: number } }; if ((r.index?.lagObjects ?? 0) > 0 || r.fallback) lagged = true; /* a purge wipes the derived indexes by design, which is reported as a fallback */ } assert.equal(lagged, expectLag, `${label}: lag or degradation is reported`); };
  await check('fresh', false);
  const created = await vault.put({ scope: wiki, kind: 'note', title: 'overlay created', body: 'overlaycreatedtoken alpha' });
  await check('after create', true);
  assert.deepEqual((await engine.query({ query: 'overlaycreatedtoken', mode: 'keyword' })).hits.map(h => h.objectId), [created.id]);
  const target = await vault.get(ids[3]!); const updated = await vault.patch({ objectId: target.id, expectedRevisionId: target.revisionId, body: 'overlayupdatedtoken replaced text' });
  assert.deepEqual((await engine.query({ query: 'overlayupdatedtoken', mode: 'keyword' })).hits.map(h => h.revisionId), [updated.revisionId]);
  assert.equal((await engine.query({ query: target.body.split(/\s+/)[0]!, mode: 'grep', limit: 1000 })).hits.some(h => h.objectId === target.id && h.revisionId === target.revisionId), false, 'old revision text is not returned');
  const doomed = await vault.get(ids[5]!); await vault.delete(doomed.id, doomed.revisionId);
  assert.equal((await engine.query({ query: doomed.title, mode: 'grep', limit: 1000 })).hits.some(h => h.objectId === doomed.id), false, 'tombstone hides content');
  const purged = await vault.get(ids[7]!); await vault.purge(purged.id, true);
  assert.equal((await engine.query({ query: purged.title, mode: 'grep', limit: 1000 })).hits.some(h => h.objectId === purged.id), false, 'purged object is gone');
  const restored = await vault.get(ids[3]!); await vault.restore(restored.id, target.revisionId, restored.revisionId);
  await check('after update/delete/purge/restore', true);
  const synced = await engine.sync(); assert.ok(synced.objects >= 3);
  await check('after sync', false);
  const afterSync = await Promise.all(queries.map(q => engine.query({ limit: 1000, ...q })));
  await engine.rebuild();
  const afterRebuild = await Promise.all(queries.map(q => engine.query({ limit: 1000, ...q })));
  assert.deepEqual(afterSync.map(r => shape(r.hits)), afterRebuild.map(r => shape(r.hits)), 'incremental sync equals a full rebuild (members, order and BM25 scores)');
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'search-optimized', name: 'journal-overlay', status: 'PASS' });
});

test('damaged, foreign-format or inconsistent index databases degrade only their own scope, never correctness', async t => {
  const { root, vault, rng } = await randomCorpus(t, 31337, 70);
  await setSqlite(vault, true); const engine = new SearchEngine(vault); await engine.rebuild();
  const queries = randomQueries(rng).filter(q => q.mode === 'keyword').slice(0, 10);
  const dbFile = path.join(root, '.mdb/indexes/workspace-w1.sqlite');
  const damage = async (name: string, action: () => Promise<void>) => {
    await engine.rebuild(); await action();
    let degraded = 0;
    for (const q of queries) { const r = await same(new SearchEngine(vault), vault, q, `${name}: ${JSON.stringify(q)}`); if (r.fallback) { degraded++; assert.match(r.fallback, /1 scope/); assert.equal(r.backend, 'sqlite', 'other scopes are still served from the index'); } }
    assert.ok(degraded > 0, `${name}: degradation is reported`);
  };
  await damage('garbage file', () => fs.writeFile(dbFile, Buffer.from('not a database'.repeat(100))));
  await damage('missing file', () => fs.rm(dbFile, { force: true }));
  await damage('old format (no checkpoint)', async () => { const db = new DatabaseSync(dbFile); db.exec("DELETE FROM index_state WHERE key IN ('journal_sequence','schema_version')"); db.close(); });
  await damage('row revision disagrees with journal', async () => { const db = new DatabaseSync(dbFile); db.exec("UPDATE documents SET revision_id='rev_tampered'"); db.close(); });
  recordCase({ suite: 'search-optimized', name: 'per-scope-degradation', status: 'PASS' });
});

test('authorization is evaluated per query: grants and revocations apply immediately, objects skipped earlier appear after a grant, outsiders see nothing', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('team', '', {}); await vault.createWorkspace('other', '', {});
  const secret = await vault.put({ scope: { type: 'workspace', workspaceId: 'team' }, kind: 'note', title: 'Team plan', body: 'granttoken confidential roadmap' });
  const col = await vault.createCollection('team', 'narrow', '', { carol: ['read'] });
  const narrow = await vault.put({ scope: { type: 'workspace', workspaceId: 'team', collectionId: 'narrow' }, kind: 'note', title: 'Narrow', body: 'narrowtoken inside collection' });
  void col;
  for (const sqlite of [false, true]) {
    await setSqlite(vault, sqlite); if (sqlite) await new SearchEngine(vault).rebuild();
    const agent = new Vault(root, { actorId: 'agent', permissions: ['global:wiki:read'] });
    const engine = new SearchEngine(agent);                       // one engine, one cached manifest, across every step
    const hit = async (q: string) => (await engine.query({ query: q, mode: 'grep', limit: 50 })).hits.map(h => h.objectId);
    assert.deepEqual(await hit('granttoken'), [], `${sqlite}: no access yet`);
    await vault.grant('team', 'agent', ['read']);
    assert.deepEqual(await hit('granttoken'), [secret.id], `${sqlite}: appears immediately after a grant, though it was skipped while unreadable`);
    assert.deepEqual(await hit('narrowtoken'), [], `${sqlite}: collection grants narrow workspace access`);
    await vault.revoke('team', 'agent');
    assert.deepEqual(await hit('granttoken'), [], `${sqlite}: disappears immediately after revoke`);
    const carol = new SearchEngine(new Vault(root, { actorId: 'carol', permissions: [] }));
    await vault.grant('team', 'carol', ['read']);
    assert.deepEqual((await carol.query({ query: 'narrowtoken', mode: 'grep' })).hits.map(h => h.objectId), [narrow.id], `${sqlite}: collection grantee reads its collection`);
    assert.deepEqual((await carol.query({ query: 'granttoken', mode: 'grep' })).hits.map(h => h.objectId), [secret.id]);
    await vault.revoke('team', 'carol');
    const outsider = new SearchEngine(new Vault(root, { actorId: 'x', permissions: [] }));
    const r = await outsider.query({ query: 'token', mode: 'grep' });
    assert.deepEqual(r.hits, []); assert.equal(r.cursor, undefined); assert.equal(JSON.stringify(r).includes('Team plan'), false);
    await assert.rejects(outsider.backlinks(secret.id), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  }
  recordCase({ suite: 'search-optimized', name: 'acl-live-grants', status: 'PASS' });
});

test('persisted manifest is only trusted when it provably belongs to this journal; damaged or foreign files are rebuilt, not believed', async t => {
  const { root, vault } = await disposableVault(t);
  for (let i = 0; i < 12; i++) await vault.put({ scope: wiki, kind: 'note', title: `n${i}`, body: `manifesttoken ${i}` });
  const file = path.join(root, '.mdb/indexes/manifest.v4.jsonl');
  await new SearchEngine(vault).rebuild(); await fs.stat(file);
  const ask = async () => (await new SearchEngine(new Vault(root)).query({ query: 'manifesttoken', mode: 'grep', limit: 100 })).hits.length;
  assert.equal(await ask(), 12);
  const valid = await fs.readFile(file, 'utf8');
  for (const [name, content] of [['truncated', valid.slice(0, valid.length / 2)], ['garbage', 'garbage\n{{{'], ['count mismatch', valid.replace(/"count":\d+/, '"count":999')], ['wrong anchor', valid.replace(/"lastTx":"[^"]+"/, '"lastTx":"tx_forged"')], ['empty', '']] as const) {
    await fs.writeFile(file, content); assert.equal(await ask(), 12, name);
  }
  // A manifest copied from a different vault must never be believed.
  const other = await disposableVault(t); for (let i = 0; i < 12; i++) await other.vault.put({ scope: wiki, kind: 'note', title: `foreign${i}`, body: `foreigntoken ${i}` });
  await new SearchEngine(other.vault).rebuild(); await fs.copyFile(path.join(other.root, '.mdb/indexes/manifest.v4.jsonl'), file);
  assert.equal(await ask(), 12, 'foreign manifest ignored'); assert.equal((await new SearchEngine(new Vault(root)).query({ query: 'foreigntoken', mode: 'grep' })).hits.length, 0);
  // A new commit after the persisted manifest is picked up by the next process through the journal.
  await new SearchEngine(vault).rebuild(); await vault.put({ scope: wiki, kind: 'note', title: 'late', body: 'manifesttoken late' });
  const child = await runChild(`import {Vault} from ${JSON.stringify(modules.vault)};import {SearchEngine} from ${JSON.stringify(modules.search)};const r=await new SearchEngine(new Vault(${JSON.stringify(root)})).query({query:'manifesttoken',mode:'grep',limit:100});process.stdout.write(String(r.hits.length));`);
  assert.equal(child.stdout.trim(), '13');
  recordCase({ suite: 'search-optimized', name: 'manifest-trust', status: 'PASS' });
});

test('concurrent writers and readers: every committed document becomes findable, no reader errors, no unauthorized hit', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('priv', '', {}); await vault.put({ scope: { type: 'workspace', workspaceId: 'priv' }, kind: 'note', title: 'hidden', body: 'concurrenttoken PRIVATE' });
  await setSqlite(vault, true); await new SearchEngine(vault).rebuild();
  const writers = Array.from({ length: 3 }, (_, w) => runChild(`import {Vault} from ${JSON.stringify(modules.vault)};const v=new Vault(${JSON.stringify(root)});for(let i=0;i<12;i++){const d=await v.put({scope:{type:'global',area:'wiki'},kind:'note',title:'w${w}-'+i,body:'concurrenttoken w${w} item '+i});process.stdout.write('ACK '+d.id+'\\n');}`));
  const reader = new SearchEngine(new Vault(root, { actorId: 'reader', permissions: ['global:wiki:read'] }));
  const owner = new SearchEngine(vault);
  const seenMax: number[] = []; let stop = false; const errors: string[] = [];
  const loop = async (engine: SearchEngine, outsider: boolean) => { while (!stop) { try { const r = await engine.query({ query: 'concurrenttoken', mode: 'keyword', limit: 200 }); if (outsider && r.hits.some(h => h.snippet.includes('PRIVATE'))) errors.push('unauthorized hit'); if (!outsider) seenMax.push(r.hits.length); } catch (e) { errors.push(String((e as Error).message)); } } };
  const loops = [loop(reader, true), loop(owner, false), loop(owner, false)];
  const done = await Promise.all(writers); stop = true; await Promise.all(loops);
  for (const w of done) assert.equal(w.code, 0, w.stderr);
  const acked = done.flatMap(w => w.stdout.split('\n').filter(l => l.startsWith('ACK ')).map(l => l.slice(4)));
  assert.equal(acked.length, 36); assert.deepEqual(errors, []);
  const final = await new SearchEngine(vault).query({ query: 'concurrenttoken', mode: 'keyword', limit: 200 });
  assert.equal(final.hits.length, 37, '36 acknowledged writes plus the private note, all found by the owner');
  for (const id of acked) assert.ok(final.hits.some(h => h.objectId === id), 'acknowledged write is searchable');
  assert.equal((await new SearchEngine(new Vault(root, { actorId: 'reader', permissions: ['global:wiki:read'] })).query({ query: 'concurrenttoken', mode: 'keyword', limit: 200 })).hits.length, 36, 'reader never sees the private note');
  assert.ok(seenMax.some((n, i) => i > 0 && n > seenMax[0]!), 'results grew while writers were running');
  recordCase({ suite: 'search-optimized', name: 'concurrent-readers-writers', status: 'PASS', detail: { readerQueries: seenMax.length } });
});

test('killing the process during sync, rebuild or manifest save leaves canonical data intact and the next query correct', async t => {
  const { root, vault } = await disposableVault(t);
  for (let i = 0; i < 120; i++) await vault.put({ scope: wiki, kind: 'note', title: `base ${i}`, body: `killtoken base ${i} ${'pad '.repeat(30)}` });
  await setSqlite(vault, true); await new SearchEngine(vault).rebuild();
  for (let i = 0; i < 120; i++) await vault.put({ scope: shared, kind: 'note', title: `late ${i}`, body: `killtoken late ${i} ${'pad '.repeat(30)}` });
  const before = (await vault.events()).length;
  for (const [name, action] of [['sync', 'await e.sync()'], ['rebuild', 'await e.rebuild()'], ['query', "await e.query({query:'killtoken',mode:'grep',limit:5})"]] as const) {
    for (const delay of [15, 45, 90]) {
      await runChild(`import {Vault} from ${JSON.stringify(modules.vault)};import {SearchEngine} from ${JSON.stringify(modules.search)};const e=new SearchEngine(new Vault(${JSON.stringify(root)}));setTimeout(()=>process.kill(process.pid,'SIGKILL'),${delay});${action};`);
      assert.equal((await vault.events()).length, before, `${name}: canonical journal untouched`);
      assert.equal((await vault.verify()).ok, true);
      const engine = new SearchEngine(new Vault(root));
      assert.equal((await engine.query({ query: 'killtoken', mode: 'grep', limit: 1000 })).hits.length, 240, `${name}/${delay}ms: complete, correct results right after the crash`);
      assert.equal((await engine.query({ query: 'killtoken', mode: 'keyword', limit: 1000 })).hits.length, 240);
    }
  }
  const engine = new SearchEngine(vault); await engine.sync(); await engine.rebuild();
  assert.equal((await engine.query({ query: 'killtoken', mode: 'grep', limit: 1000 })).hits.length, 240);
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'search-optimized', name: 'kill-during-index-maintenance', status: 'PASS' });
});
