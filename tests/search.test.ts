import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemSearch, type SearchVault } from '../packages/search-files/index.js';
import { SQLiteSearch, SearchEngine } from '../packages/search-sqlite/index.js';
import { MDBError, OWNER, type Document, type ActorContext } from '../packages/core/types.js';

function document(id: string, body: string, workspaceId = 'alpha'): Document {
  return { id, revisionId: `${id}-r1`, revisionNumber: 1, scope: { type: 'workspace', workspaceId }, title: id, kind: 'note', body, tags: ['research'], links: [], evidence: [], status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-02', createdBy: 'owner', metadata: {}, path: `${id}.md`, uri: `mdb://workspaces/${workspaceId}/objects/${id}` };
}
async function fixture(actor: ActorContext = OWNER) {
  const root = await mkdtemp(join(tmpdir(), 'mdb-search-'));
  const docs = [document('a', '# Retrieval\nExact phrase and lexical retrieval.\n[[b]]'), document('b', 'Vector tools use retrieval.'), document('secret', 'Exact phrase secretword', 'protected')];
  // The fake mirrors a real vault: every committed change is a journal record, reads are access-checked, and listings only show readable scopes.
  const readable = (scope: Document['scope']) => actor.permissions.includes('*') || (scope.type === 'workspace' && scope.workspaceId === 'alpha');
  const events: Awaited<ReturnType<SearchVault['journalSince']>> = docs.map((d, i) => ({ sequence: i + 1, transactionId: `tx${i + 1}`, objectId: d.id, operation: 'put', scope: d.scope }));
  const touch = (doc: Document) => { events.push({ sequence: events.length + 1, transactionId: `tx${events.length + 1}`, objectId: doc.id, previousRevisionId: 'previous', operation: 'patch', scope: doc.scope }); };
  const vault: SearchVault = {
    root, actor, config: async () => ({ sqlite: { enabled: true } }), listDocuments: async () => docs.filter(doc => readable(doc.scope)), history: async id => docs.filter(doc => doc.id === id),
    journalSince: async sequence => events.slice(sequence), canAccess: async scope => readable(scope),
    get: async id => { const doc = docs.find(d => d.id === id); if (!doc || !readable(doc.scope)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible'); return structuredClone(doc); }
  };
  return { root, docs, vault, touch, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('native lexical query preserves phrases, boolean operators, regex and filters', async () => {
  const f = await fixture();
  try {
    const search = new FilesystemSearch(f.vault);
    assert.deepEqual((await search.query({ query: '"Exact phrase" AND lexical' })).hits.map(hit => hit.objectId), ['a']);
    assert.deepEqual((await search.query({ query: 'lexical OR Vector' })).hits.map(hit => hit.objectId).sort(), ['a', 'b']);
    assert.deepEqual((await search.query({ query: 'retrieval NOT Vector' })).hits.map(hit => hit.objectId), ['a']);
    assert.equal((await search.query({ query: 'Exact.*lexical', mode: 'grep', regex: true })).hits.length, 1);
    assert.equal((await search.query({ query: 'retrieval', kinds: ['source'] })).hits.length, 0);
    assert.equal((await search.query({ query: 'retrieval', tags: ['missing'] })).hits.length, 0);
    assert.equal((await search.query({ query: 'retrieval', since: '2027' })).hits.length, 0);
    await assert.rejects(search.query({ query: '(a+)+$', mode: 'grep', regex: true }), { code: 'INVALID_INPUT' });
    await assert.rejects(search.query({ query: 'retrieval', mode: 'semantic' }), { code: 'CAPABILITY_UNAVAILABLE' });
    await assert.rejects(search.query({ query: 'retrieval', mode: 'hybrid' }), { code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal((await search.query({ query: 'retrieval', mode: 'hybrid', allowFallback: true })).hits[0]?.retrievalMode, 'keyword-degraded');
  } finally { await f.cleanup(); }
});

test('ACL applies before matches, graph references, context and pagination', async () => {
  const f = await fixture({ actorId: 'alice', permissions: ['workspace:alpha:read'] });
  try {
    f.docs[0]!.links.push({ type: 'references', target: f.docs[2]!.uri });
    const search = new FilesystemSearch(f.vault);
    assert.equal((await search.query({ query: 'secretword', scopes: [{ type: 'workspace', workspaceId: 'protected' }] })).hits.length, 0);
    assert.deepEqual(await search.links('a'), [{ type: 'references', target: f.docs[1]!.uri }]);
    assert.equal((await search.backlinks('b'))[0]?.source, f.docs[0]!.uri);
    assert.deepEqual((await search.related('a')).map(doc => doc.id), ['b']);
    await assert.rejects(search.backlinks('secret'), { code: 'NOT_FOUND_OR_FORBIDDEN' });
    await assert.rejects(search.query({ query: 'retrieval' }, OWNER), { code: 'NOT_FOUND_OR_FORBIDDEN' });
    const context = await search.context({ task: 'retrieval', budgetTokens: 200 });
    assert.ok(Buffer.byteLength(context.text) <= 200);
    assert.ok(!context.text.includes('secretword'));
    const first = await search.query({ query: 'retrieval', limit: 1 });
    const second = await search.query({ query: 'retrieval', limit: 1, cursor: first.cursor });
    assert.notEqual(first.hits[0]!.objectId, second.hits[0]!.objectId);
  } finally { await f.cleanup(); }
});

/** Filesystem hits are the reference. When SQLite ranks with BM25 the matching set (revision, line, snippet) is identical and the order follows the reported score. */
function sameHits(actual: { hits: Array<{ objectId: string; revisionId: string; lineStart: number; snippet: string; score: number }>; ranking?: string }, reference: typeof actual.hits): void {
  if (actual.ranking !== 'bm25') { assert.deepEqual(actual.hits, reference); return; }
  const key = (h: { objectId: string; revisionId: string; lineStart: number; snippet: string }) => `${h.objectId}|${h.revisionId}|${h.lineStart}|${h.snippet}`;
  assert.deepEqual(actual.hits.map(key).sort(), reference.map(key).sort());
  for (let i = 1; i < actual.hits.length; i++) assert.ok(actual.hits[i - 1]!.score >= actual.hits[i]!.score, 'ordered by BM25 score');
}
test('SQLite parity and stale update/delete fallback preserve canonical results', async () => {
  const f = await fixture();
  try {
    const files = new FilesystemSearch(f.vault); const sqlite = new SQLiteSearch(f.vault);
    assert.equal((await sqlite.query({ query: 'retrieval' })).backend, 'filesystem');
    await sqlite.rebuild();
    for (const input of [{ query: 'retrieval' }, { query: 'Exact phrase', mode: 'grep' as const }, { query: 'Vector OR lexical' }, { query: 'retrieval', scopes: [{ type: 'workspace' as const, workspaceId: 'alpha' }] }]) {
      sameHits(await sqlite.query(input), (await files.query(input)).hits);
      assert.equal((await sqlite.query(input)).backend, 'sqlite');
    }
    f.docs[0]!.body = 'newterm'; f.docs[0]!.revisionId = 'a-r2'; f.touch(f.docs[0]!);
    const changed = await sqlite.query({ query: 'newterm' }) as Awaited<ReturnType<SQLiteSearch['query']>> & { index?: { lagObjects?: number } };
    assert.equal(changed.hits[0]!.revisionId, 'a-r2', 'a revision committed after the index checkpoint is found');
    assert.equal(changed.backend, 'sqlite'); assert.ok((changed.index?.lagObjects ?? 0) >= 1, 'served through the journal overlay, and the lag is reported');
    assert.equal((await sqlite.query({ query: 'lexical retrieval' })).hits.some(h => h.objectId === 'a'), false, 'the old text of the updated object is no longer returned');
    f.docs[1]!.status = 'deleted'; f.touch(f.docs[1]!);
    assert.equal((await sqlite.query({ query: 'Vector' })).hits.length, 0);
    await sqlite.rebuild();
    assert.equal((await sqlite.query({ query: 'newterm' })).backend, 'sqlite');
    assert.equal((await new SearchEngine(f.vault).query({ query: 'newterm' })).hits.length, 1);
  } finally { await f.cleanup(); }
});

test('generated navigation preserves authored content and canonical snippet lines', async () => {
  const { Vault } = await import('../packages/core/vault.js');
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'mdb-navigation-'));
  try {
    const vault = new Vault(root); await vault.init({ sqlite: true }); await vault.createWorkspace('notes');
    const doc = await vault.put({ scope: { type: 'workspace', workspaceId: 'notes' }, kind: 'note', title: 'Navigation', body: '# Heading\nUnique searchable phrase' });
    await writeFile(join(root, 'MAIN_INDEX.md'), '# My authored navigation\nKeep my notes.\n');
    const engine = new SearchEngine(vault); await engine.rebuild();
    const main = await readFile(join(root, 'MAIN_INDEX.md'), 'utf8');
    assert.ok(main.includes('Keep my notes.')); assert.ok(main.includes('MDB:GENERATED:START'));
    assert.ok((await readFile(join(root, 'workspaces/notes/INDEX.md'), 'utf8')).includes(doc.uri));
    const hit = (await engine.query({ query: 'Unique searchable', mode: 'grep' })).hits[0]!;
    const canonical = await readFile(join(root, '.mdb/objects', doc.id, 'revs', `${doc.revisionId}.md`), 'utf8');
    assert.equal(canonical.split('\n')[hit.lineStart - 1], 'Unique searchable phrase');
    await engine.rebuild(); assert.equal(await readFile(join(root, 'MAIN_INDEX.md'), 'utf8'), main);
    const restricted = new SearchEngine(new Vault(root, { actorId: 'agent', permissions: ['workspace:notes:read'] }));
    await assert.rejects(restricted.rebuild(), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FTS trigram path preserves substring, short term and quoted punctuation parity', async () => {
  const f = await fixture();
  try {
    f.docs[0]!.body = 'preRetrievalPost x a+b punctuation!!!';
    const files = new FilesystemSearch(f.vault); const sqlite = new SQLiteSearch(f.vault); await sqlite.rebuild();
    for (const query of ['retrieval', 'x', '"a+b"', '"punctuation!!!"', 'NOT secretword', 'retrieval OR x']) {
      const actual = await sqlite.query({ query });
      sameHits(actual, (await files.query({ query })).hits);
      assert.equal(actual.backend, 'sqlite');
    }
    assert.match(String((await sqlite.health()).strategy), /FTS5 MATCH\/trigram candidate selection/);
  } finally { await f.cleanup(); }
});
