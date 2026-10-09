import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { fakeEmbedder, type FakeEmbedder } from '../helpers/embedder.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { QueryApi } from '../../packages/query/index.js';
import { Engram } from '../../packages/sdk/index.js';
import type { Scope, SearchInput } from '../../packages/core/types.js';

type T = { after(fn: () => void | Promise<void>): void };
const ws: Scope = { type: 'workspace', workspaceId: 'w' }, secret: Scope = { type: 'workspace', workspaceId: 'secret' }, wiki: Scope = { type: 'global', area: 'wiki' };
const rec = (name: string) => recordCase({ suite: 'semantic', name, status: 'PASS' });
async function configure(vault: Vault, patch: { sqlite?: boolean; embedding?: Record<string, unknown> | null }) {
  const c = await vault.config() as unknown as Record<string, unknown>;
  if (patch.sqlite !== undefined) (c.sqlite as { enabled: boolean }).enabled = patch.sqlite;
  if (patch.embedding === null) delete c.embedding; else if (patch.embedding) c.embedding = patch.embedding;
  await fs.writeFile(path.join(vault.root, 'mdb.yaml'), YAML.stringify(c));
}
async function world(t: T, options: { sqlite?: boolean; embedder?: FakeEmbedder; embedding?: Record<string, unknown> } = {}) {
  const { root, vault } = await disposableVault(t, { sqlite: options.sqlite ?? true }); await vault.createWorkspace('w', '', { agent: ['read'] }); await vault.createWorkspace('secret', '', {});
  const d: Record<string, string> = {};
  const put = async (k: string, scope: Scope, title: string, body: string, kind = 'note') => { d[k] = (await vault.put({ scope, kind, title, body })).id; };
  await put('car', ws, 'Garage notes', 'The car needs an oil change and new tires.');
  await put('deploy', ws, 'Runbook', 'Steps to ship the release: build, rollout to staging, then publish.');
  await put('cat', ws, 'Pets', 'My kitten is a playful feline who loves boxes.');
  await put('invoice', ws, 'Finance', 'The billing system sends each payment receipt by email.');
  await put('zebra', ws, 'Misc', 'A single mention of zebra crossings appears in this note.');
  await put('wiki', wiki, 'Glossary', 'A vehicle is a machine for driving people around.', 'wiki_page');
  await put('secretCar', secret, 'Secret garage', 'The secret automobile is hidden in a locked sedan garage.');
  if (options.embedding !== undefined || options.embedder) await configure(vault, { embedding: options.embedding ?? { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused' } });
  const embedder = options.embedder; const engine = new SearchEngine(vault, embedder ? { embedder } : {});
  const agentVault = new Vault(root, { actorId: 'agent', permissions: ['workspace:w:read', 'global:wiki:read'] });
  return { root, vault, d, engine, embedder, agent: new SearchEngine(agentVault, embedder ? { embedder } : {}), agentVault };
}
const ids = (r: { hits: Array<{ objectId: string }> }) => r.hits.map(h => h.objectId);

test('disabled by default: semantic and hybrid are unavailable, keyword/grep/regex/auto work, and the mode that ran is reported', async t => {
  const w = await world(t);
  for (const mode of ['semantic', 'hybrid'] as const) await assert.rejects(w.engine.query({ query: 'automobile', mode }), { code: 'CAPABILITY_UNAVAILABLE' });
  const fallback = await w.engine.query({ query: 'garage', mode: 'hybrid', allowFallback: true }); assert.ok(fallback.hits.length > 0); assert.match(fallback.fallback ?? '', /lexical-only/); assert.equal(fallback.mode, 'keyword', 'a lexical result is never labelled hybrid'); assert.equal(fallback.requestedMode, 'hybrid');
  const auto = await w.engine.query({ query: 'garage' }); assert.equal(auto.mode, 'keyword'); assert.equal(auto.requestedMode, undefined);
  assert.ok(ids(await w.engine.query({ query: 'garage', mode: 'keyword' })).includes(w.d.car!)); assert.ok(ids(await w.engine.query({ query: 'oil change', mode: 'grep' })).includes(w.d.car!)); assert.ok(ids(await w.engine.query({ query: 'oil.*tires', mode: 'grep', regex: true })).includes(w.d.car!));
  const status = await w.engine.vectors.status(); assert.equal(status.ready, false); assert.match(status.reason!, /No embedding provider/);
  rec('disabled-by-default');
});
test('semantic and hybrid REQUIRE the SQLite index: without it they are disabled even with an embedding provider, while keyword and grep stay fully functional', async t => {
  const e = fakeEmbedder(); const w = await world(t, { sqlite: false, embedder: e });
  const status = await w.engine.vectors.status(); assert.equal(status.ready, false); assert.match(status.reason!, /SQLite/);
  await assert.rejects(w.engine.query({ query: 'automobile', mode: 'semantic' }), (err: Error & { code?: string }) => err.code === 'CAPABILITY_UNAVAILABLE' && /SQLite/.test(err.message));
  await assert.rejects(w.engine.query({ query: 'automobile', mode: 'hybrid' }), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(w.engine.embedSync(), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal((await w.engine.query({ query: 'garage' })).mode, 'keyword'); assert.ok(ids(await w.engine.query({ query: 'tires', mode: 'grep' })).includes(w.d.car!));
  assert.equal(e.calls.length, 0, 'the embedding provider was never called');
  rec('requires-sqlite');
});
test('SQLite on but no vectors yet: not ready until "embed sync"; then semantic finds what no keyword shares; keyword matches are unaffected', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild();
  assert.equal((await w.engine.vectors.status()).ready, false); await assert.rejects(w.engine.query({ query: 'automobile', mode: 'semantic' }), /embed sync/);
  assert.equal((await w.engine.query({ query: 'garage' })).mode, 'keyword', 'auto stays lexical until the vector backend is ready');
  const report = await w.engine.embedSync(); assert.ok(report.embeddedObjects >= 6); assert.equal(report.skippedPrivate, 0);
  const status = await w.engine.vectors.status(); assert.equal(status.ready, true); assert.equal(status.backend, 'sqlite-blob-scan'); assert.equal(status.model, 'fake-concepts-v1');
  assert.deepEqual(ids(await w.engine.query({ query: 'truck', mode: 'keyword' })), [], 'no keyword overlap');
  const sem = await w.engine.query({ query: 'truck', mode: 'semantic', limit: 3 }); assert.equal(sem.mode, 'semantic'); assert.equal(sem.ranking, 'similarity'); assert.deepEqual(ids(sem).slice().sort(), [w.d.car!, w.d.wiki!, w.d.secretCar!].sort(), 'the three vehicle notes (the owner may read all) rank first'); assert.ok(sem.hits.every(h => h.retrievalMode === 'semantic'));
  assert.ok(sem.vector && sem.vector.model === 'fake-concepts-v1' && sem.vector.lagObjects === 0);
  const unrelated = await w.engine.query({ query: 'quantum chromodynamics', mode: 'semantic', limit: 5 }); assert.equal(unrelated.hits.length, 5, 'there is no similarity threshold: the nearest objects are returned, however weak');
  rec('semantic-basic');
});
test('hybrid fuses keyword and semantic rankings by reciprocal rank fusion; an exact keyword match is never suppressed; auto becomes hybrid when ready', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync();
  for (let i = 0; i < 30; i++) await w.vault.put({ scope: ws, kind: 'note', title: `Car ${i}`, body: `car vehicle driving note ${i}` }); await w.engine.sync(); await w.engine.embedSync();
  // the query's one rare word occurs in a semantically unrelated note; thirty car notes are semantically much closer to the rest of the query
  const hybrid = await w.engine.query({ query: 'automobile OR zebra', mode: 'hybrid', limit: 6 });
  assert.equal(hybrid.mode, 'hybrid'); assert.equal(hybrid.ranking, 'rrf'); assert.ok(hybrid.hits.every(h => h.retrievalMode === 'hybrid' && h.sources?.length));
  assert.ok(ids(hybrid).includes(w.d.zebra!), 'the only exact keyword match ranks within the first page despite 30 closer semantic neighbours');
  const both = hybrid.hits.find(h => h.objectId === w.d.zebra)!; assert.ok(both.sources!.includes('keyword'));
  assert.ok(hybrid.hits.some(h => h.sources!.includes('semantic')));
  const full = await w.engine.query({ query: 'zebra crossings', mode: 'hybrid', limit: 50 }); assert.ok(ids(full).includes(w.d.zebra!));
  const auto = await w.engine.query({ query: 'automobile OR zebra', limit: 6 }); assert.equal(auto.mode, 'hybrid'); assert.equal(auto.requestedMode, 'auto'); assert.deepEqual(ids(auto), ids(hybrid), 'auto runs exactly the hybrid pipeline');
  for (const mode of ['keyword', 'grep'] as const) { const r = await w.engine.query({ query: 'zebra', mode }); assert.equal(r.mode, mode === 'grep' ? 'grep' : 'keyword'); assert.deepEqual(ids(r), [w.d.zebra!]); }
  await configure(w.vault, { embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', autoHybrid: false } });
  assert.equal((await w.engine.query({ query: 'automobile OR zebra' })).mode, 'keyword', 'embedding.autoHybrid:false keeps auto lexical');
  // pagination through the fused ranking is stable and complete
  await configure(w.vault, { embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused' } });
  const seen: string[] = []; let cursor: string | undefined; do { const page = await w.engine.query({ query: 'automobile', mode: 'hybrid', limit: 7, ...(cursor ? { cursor } : {}) }); seen.push(...ids(page)); cursor = page.cursor; } while (cursor);
  assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages'); assert.ok(seen.length >= 31);
  rec('hybrid-rrf');
});

test('regex and exact grep never touch the vector backend; keyword is lexical when SQLite is off, BM25 when on', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync(); const before = e.calls.length;
  for (const q of [{ query: 'oil.*tires', mode: 'grep' as const, regex: true }, { query: 'oil change', mode: 'grep' as const }]) { const r = await w.engine.query(q); assert.equal(r.mode, 'grep'); assert.equal(r.ranking, 'lexical'); assert.deepEqual(ids(r), [w.d.car!]); }
  assert.equal((await w.engine.query({ query: 'garage', mode: 'keyword' })).ranking, 'bm25');
  assert.equal(e.calls.length, before, 'grep, regex and keyword made no embedding call');
  await configure(w.vault, { sqlite: false }); assert.equal((await w.engine.query({ query: 'garage', mode: 'keyword' })).ranking, 'lexical');
  rec('lexical-paths');
});
test('ACL: semantic and hybrid never return unreadable objects, never let them influence ranking, and report lag only for readable objects', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync();
  for (const mode of ['semantic', 'hybrid'] as const) { const r = await w.agent.query({ query: 'automobile sedan garage', mode, limit: 20 }); assert.ok(!ids(r).includes(w.d.secretCar!), mode); assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('locked'), 'no snippet, title or note leaks'); }
  const ownerView = ids(await w.engine.query({ query: 'automobile sedan garage', mode: 'semantic', limit: 20 })); assert.ok(ownerView.includes(w.d.secretCar!), 'the owner does see it');
  const agentSem = await w.agent.query({ query: 'automobile', mode: 'semantic', limit: 20 });
  // the same corpus without the hidden document ranks and scores the readable ones identically
  const lone = await world(t, { embedder: fakeEmbedder() }); await lone.vault.delete(lone.d.secretCar!, (await lone.vault.get(lone.d.secretCar!)).revisionId); await lone.engine.rebuild(); await lone.engine.embedSync();
  const loneAgent = new SearchEngine(lone.agentVault, { embedder: fakeEmbedder() }); const loneSem = await loneAgent.query({ query: 'automobile', mode: 'semantic', limit: 20 });
  assert.deepEqual(agentSem.hits.map(h => [h.title, h.score]), loneSem.hits.map(h => [h.title, h.score]), 'hidden documents do not change readable results');
  assert.equal(agentSem.vector!.lagObjects, 0);
  const stranger = new SearchEngine(new Vault(w.root, { actorId: 'nobody', permissions: [] }), { embedder: e }); assert.deepEqual((await stranger.query({ query: 'automobile', mode: 'semantic' })).hits, []);
  rec('acl');
});
test('revision consistency: stale vectors are ignored and reported as lag, new text is found by keyword at once and by meaning after sync, deletes vanish', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync();
  const cur = await w.vault.get(w.d.car!); await w.vault.patch({ objectId: cur.id, expectedRevisionId: cur.revisionId, body: 'This note is now about a kitten and a feline friend.' });
  const stale = await w.engine.query({ query: 'automobile', mode: 'semantic', limit: 10 }); assert.ok(!ids(stale).includes(w.d.car!), 'the vector of the previous revision is not used'); assert.equal(stale.vector!.lagObjects, 1); assert.match(stale.vector!.note ?? '', /embed sync/);
  const hyb = await w.engine.query({ query: 'kitten', mode: 'hybrid', limit: 10 }); assert.ok(ids(hyb).includes(w.d.car!), 'hybrid still finds the edited note through keyword matching'); assert.ok(hyb.fallback?.includes('no current vectors'));
  await w.engine.sync(); await w.engine.embedSync(); const fresh = await w.engine.query({ query: 'feline', mode: 'semantic', limit: 3 }); assert.ok(ids(fresh).includes(w.d.car!)); assert.equal(fresh.vector!.lagObjects, 0);
  const gone = await w.vault.get(w.d.cat!); await w.vault.delete(gone.id, gone.revisionId); assert.ok(!ids(await w.engine.query({ query: 'feline', mode: 'semantic', limit: 10 })).includes(w.d.cat!), 'deleted objects never appear');
  const created = await w.vault.put({ scope: ws, kind: 'note', title: 'Fresh', body: 'automobile automobile sedan' }); assert.ok(!ids(await w.engine.query({ query: 'automobile', mode: 'semantic', limit: 20 })).includes(created.id)); assert.ok(ids(await w.engine.query({ query: 'automobile', mode: 'hybrid', limit: 20 })).includes(created.id), 'a new document is found by keyword in hybrid');
  rec('revisions');
});
test('privacy: a remote embedding service never receives workspace text unless allowed; the skipped objects are counted, global knowledge is embedded', async t => {
  const e = fakeEmbedder({ locality: 'remote' }); const w = await world(t, { embedder: e }); await w.engine.rebuild();
  const report = await w.engine.embedSync(); assert.ok(report.skippedPrivate >= 6, `skipped ${report.skippedPrivate}`);
  const sent = e.calls.flat().join('\n'); assert.ok(!sent.includes('oil change') && !sent.includes('secret automobile'), 'workspace text was not sent'); assert.ok(sent.includes('vehicle is a machine'), 'wiki text was');
  const sem = await w.engine.query({ query: 'vehicle', mode: 'semantic', limit: 10 }); assert.deepEqual(ids(sem), [w.d.wiki!]);
  await configure(w.vault, { embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', allowPrivateContentToRemote: true } }); const again = await w.engine.embedSync(); assert.equal(again.skippedPrivate, 0); assert.ok(e.calls.flat().join('\n').includes('oil change'));
  rec('privacy');
});
test('failure handling: embedding outage makes semantic/hybrid fail with a sanitized error, auto degrades to a labelled keyword result, partial sync leaves a consistent index, a model change never mixes vectors', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync(); e.fail = true;
  await assert.rejects(w.engine.query({ query: 'automobile', mode: 'semantic' }), (err: Error & { code?: string }) => err.code === 'CAPABILITY_UNAVAILABLE' && !err.message.includes('secret-api-key'));
  await assert.rejects(w.engine.query({ query: 'garage', mode: 'hybrid' }), { code: 'CAPABILITY_UNAVAILABLE' });
  const deg = await w.engine.query({ query: 'garage', mode: 'hybrid', allowFallback: true }); assert.equal(deg.mode, 'keyword'); assert.equal(deg.requestedMode, 'hybrid'); assert.match(deg.fallback ?? '', /unavailable/); assert.ok(ids(deg).includes(w.d.car!));
  const auto = await w.engine.query({ query: 'garage' }); assert.equal(auto.mode, 'keyword'); assert.equal(auto.requestedMode, 'auto'); assert.match(auto.fallback ?? '', /Semantic retrieval unavailable/); assert.ok(!JSON.stringify(auto).includes('secret-api-key'));
  e.fail = false;
  // partial sync: the provider dies after the first batch; documents are committed whole or not at all, queries stay correct, and a later sync completes
  const t2 = fakeEmbedder(); const x = await world(t, { embedder: t2 }); await x.engine.rebuild(); for (let i = 0; i < 40; i++) await x.vault.put({ scope: ws, kind: 'note', title: `Bulk ${i}`, body: `car number ${i}` }); await x.engine.sync();
  t2.failAfterBatches = 2; await assert.rejects(x.engine.embedSync(), /simulated outage/); t2.failAfterBatches = undefined;
  const mid = await x.engine.vectors.status(); assert.equal(mid.ready, true, 'the committed part is usable'); const midSem = await x.engine.query({ query: 'car', mode: 'semantic', limit: 100 }); assert.ok(midSem.vector!.lagObjects > 0 && midSem.hits.length > 0 && midSem.hits.length < 47);
  await x.engine.embedSync(); assert.equal((await x.engine.query({ query: 'car', mode: 'semantic', limit: 100 })).vector!.lagObjects, 0);
  // changing the model purges the old vectors instead of mixing them
  const other = fakeEmbedder({ modelId: 'other-model' }); const y = new SearchEngine(x.vault, { embedder: other }); assert.equal((await y.vectors.status()).ready, false); await y.embedSync(); assert.equal((await y.vectors.status()).ready, true); assert.equal((await y.vectors.status()).model, 'other-model');
  rec('failure-handling');
});
test('immutability and cleanup: embedding and searching never change the journal or revisions; purge removes vectors', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild();
  const journal = path.join(w.root, '.mdb/events/commits.jsonl'); const before = await fs.readFile(journal, 'utf8'); const objects = await fs.readdir(path.join(w.root, '.mdb/objects'));
  await w.engine.embedSync(); await w.engine.query({ query: 'automobile', mode: 'hybrid' }); await w.engine.query({ query: 'automobile', mode: 'semantic' });
  assert.equal(await fs.readFile(journal, 'utf8'), before); assert.deepEqual(await fs.readdir(path.join(w.root, '.mdb/objects')), objects); assert.equal((await w.vault.verify()).ok, true);
  assert.equal((await new Vault(w.root, { actorId: 'agent', permissions: ['workspace:w:read'] }).config().then(() => 'readable')), 'readable');
  await assert.rejects(w.agent.embedSync(), { code: 'NOT_FOUND_OR_FORBIDDEN' }); await assert.rejects(w.agent.vectors.clear(), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await w.engine.vectors.clear(); assert.equal((await w.engine.vectors.status()).ready, false); assert.ok((await w.engine.query({ query: 'garage', mode: 'keyword' })).hits.length > 0);
  rec('immutability');
});
test('corrupt or foreign vector data is ignored, never trusted: garbage rows, wrong dimensions and a damaged database fall back to keyword with an honest status', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync();
  const { DatabaseSync } = await import('node:sqlite'); const file = path.join(w.root, '.mdb/indexes/workspace-w.sqlite');
  const db = new DatabaseSync(file); db.prepare("UPDATE vec_chunks SET vec = x'0102' WHERE object_id IN (SELECT DISTINCT object_id FROM vec_chunks LIMIT 2)").run(); db.close();
  const sem = await w.engine.query({ query: 'automobile', mode: 'semantic', limit: 10 }); assert.ok(sem.hits.length > 0, 'unusable rows are skipped'); assert.ok(sem.vector!.lagObjects >= 1, 'and reported as missing vectors');
  await fs.writeFile(file, 'this is not a sqlite database'); assert.ok(ids(await w.engine.query({ query: 'garage', mode: 'keyword' })).includes(w.d.car!), 'keyword survives a destroyed index (filesystem fallback)');
  await w.engine.rebuild(); await w.engine.embedSync(); assert.ok(ids(await w.engine.query({ query: 'automobile', mode: 'semantic' })).includes(w.d.car!), 'rebuild + sync restores semantic search');
  rec('corruption');
});
test('query engine: semantic/hybrid/auto through the typed AST report the mode that ran; unavailable without the backend unless a labelled downgrade is requested', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); const client = new Engram(w.root, undefined, undefined, { embedder: e }); await client.search.rebuild();
  await assert.rejects(client.queries.run({ version: 1, from: 'documents', search: { mode: 'semantic', text: 'automobile' } }), { code: 'CAPABILITY_UNAVAILABLE' });
  const down = await client.queries.run({ version: 1, from: 'documents', search: { mode: 'semantic', text: 'garage', allowDowngrade: true } }); assert.equal(down.search?.mode, 'keyword'); assert.equal(down.search?.requested, 'semantic'); assert.match(down.fallback ?? '', /not semantic/);
  assert.equal((await client.queries.capabilities()).search.semantic.available, false);
  await client.search.embedSync(); const caps = await client.queries.capabilities(); assert.equal(caps.search.semantic.available, true); assert.equal(caps.search.hybrid.available, true);
  const sem = await client.queries.run({ version: 1, from: 'documents', search: { mode: 'semantic', text: 'automobile' }, limit: 3, pipe: [{ op: 'select', fields: ['title', 'score', 'retrievalMode'] }] }); assert.equal(sem.search?.mode, 'semantic'); assert.equal(sem.rows.length, 3); assert.ok((sem.rows as Array<{ retrievalMode: string }>).every(r => r.retrievalMode === 'semantic'));
  const auto = await client.queries.run({ version: 1, from: 'documents', search: { mode: 'auto', text: 'automobile zebra' }, limit: 5, pipe: [{ op: 'select', fields: ['title'] }] }); assert.equal(auto.search?.mode, 'hybrid'); assert.equal(auto.search?.requested, 'auto');
  const regex = await client.queries.run({ version: 1, from: 'documents', search: { mode: 'regex', text: 'oil.*tires' }, pipe: [{ op: 'select', fields: ['title'] }] }); assert.equal(regex.search?.mode, 'grep'); assert.equal(regex.search?.ranking, 'lexical'); assert.deepEqual(regex.rows, [{ title: 'Garage notes' }]);
  const cap = (await client.capabilities()) as { search: { vector: { available: boolean } }; recall: { modes: { semantic: { available: boolean } } } }; assert.equal(cap.search.vector.available, true); assert.equal(cap.recall.modes.semantic.available, true);
  const recall = await client.memory.query({ mode: 'semantic', query: 'automobile', scope: 'authorized_all' } as never); assert.ok(recall.items.length > 0);
  rec('query-engine');
});

const vecPath = (): string | undefined => { const p = process.env.ENGRAM_SQLITE_VEC; return p && existsSync(p) ? p : undefined; };
import { existsSync } from 'node:fs';
test('optional sqlite-vec acceleration returns the same ranking as the portable scan; when the extension is absent the portable scan is used and reported', async t => {
  const e = fakeEmbedder(); const w = await world(t, { embedder: e }); await w.engine.rebuild(); await w.engine.embedSync();
  const plain = await w.engine.query({ query: 'automobile', mode: 'semantic', limit: 10 }); assert.equal(plain.vector!.backend, 'sqlite-blob-scan');
  await configure(w.vault, { embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', sqliteVec: '/nonexistent/vec0.so' } });
  const missing = await w.engine.query({ query: 'automobile', mode: 'semantic', limit: 10 }); assert.equal(missing.vector!.backend, 'sqlite-blob-scan', 'a missing extension never breaks search'); assert.deepEqual(ids(missing), ids(plain));
  const ext = vecPath();
  if (!ext) { recordCase({ suite: 'semantic', name: 'sqlite-vec', status: 'PASS', detail: { notRun: 'set ENGRAM_SQLITE_VEC to the sqlite-vec loadable library to run the accelerated path' } }); return; }
  await configure(w.vault, { embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', sqliteVec: ext } });
  const fast = await w.engine.query({ query: 'automobile', mode: 'semantic', limit: 10 }); assert.equal(fast.vector!.backend, 'sqlite-vec'); assert.deepEqual(ids(fast), ids(plain));
  fast.hits.forEach((h, i) => assert.ok(Math.abs(h.score - plain.hits[i]!.score) < 1e-4, 'same similarity'));
  rec('sqlite-vec');
});
