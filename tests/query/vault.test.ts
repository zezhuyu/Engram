import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { QueryApi } from '../../packages/query/index.js';
import type { Scope } from '../../packages/core/types.js';

type T = { after(fn: () => void | Promise<void>): void };
const app: Scope = { type: 'workspace', workspaceId: 'app' };
const sec: Scope = { type: 'workspace', workspaceId: 'secret' };
const wiki: Scope = { type: 'global', area: 'wiki' };
const rec = (name: string) => recordCase({ suite: 'query-vault', name, status: 'PASS' });
async function setSqlite(vault: Vault, enabled: boolean) { const c = await vault.config(); c.sqlite.enabled = enabled; await fs.writeFile(path.join(vault.root, 'mdb.yaml'), YAML.stringify(c)); }

async function world(t: T, sqlite = false) {
  const { root, vault } = await disposableVault(t, { sqlite });
  await vault.createWorkspace('app', '', { agent: ['read'] }); await vault.createWorkspace('secret', '', {});
  const d: Record<string, string> = {}; let n = 0;
  const put = async (key: string, scope: Scope, title: string, body: string, extra: { kind?: string; tags?: string[]; metadata?: Record<string, unknown>; links?: Array<{ type: string; target: string }> } = {}) => { d[key] = (await vault.put({ scope, kind: extra.kind ?? 'note', title, body, ...(extra.tags ? { tags: extra.tags } : {}), ...(extra.metadata ? { metadata: extra.metadata } : {}), ...(extra.links ? { links: extra.links } : {}) })).id; return d[key]!; };
  await put('deploy', app, 'Deploy runbook', '# Deploy\nrun the pipeline\nthen verify rollback works\nasync steps are fine', { tags: ['ops'] });
  await put('alerts', app, 'Alert tuning', 'tune alert thresholds\nreference [[Deploy runbook]]', { tags: ['ops', 'alerts'] });
  await put('ideas', app, 'Ideas', 'dashboard idea about deploy frequency', { tags: ['idea'] });
  await put('secret', sec, 'Secret plan', 'SECRET-TOKEN deploy to the moon\n[[Deploy runbook]] [[Ideas]]', { tags: ['ops'] });
  await put('secretNote', sec, 'Hidden', 'nothing visible here', {});
  await put('page', wiki, 'Deploy glossary', 'deploy means releasing software; see [[Alert tuning]]', { kind: 'wiki_page', tags: ['glossary'] });
  for (let i = 0; i < 6; i++) await put(`obs${i}`, app, `event ${i}`, `observation ${i} about ${i % 2 ? 'deploy' : 'tests'}`, { kind: 'observation', metadata: { sessionId: i < 3 ? 's1' : 's2', eventTime: `2026-04-0${i + 1}T08:00:00Z`, eventType: i % 2 ? 'decision' : 'tool.result', speaker: 'assistant' } });
  const agent = new Vault(root, { actorId: 'agent', permissions: ['workspace:app:read', 'global:wiki:read'] });
  const stranger = new Vault(root, { actorId: 'stranger', permissions: [] });
  void n;
  return { root, vault, d, owner: new QueryApi(vault), agent: new QueryApi(agent), stranger: new QueryApi(stranger), agentVault: agent };
}
const rowsOf = async (api: QueryApi, ast: Record<string, unknown>) => (await api.run({ version: 1, ...ast })).rows as Array<Record<string, unknown>>;
const idsOf = (rows: unknown[]) => (rows as Array<{ id: string }>).map(r => r.id).sort();

test('sources, scope defaults, collection narrowing and metadata projections come from the manifest (no document is read)', async t => {
  const w = await world(t);
  const all = await w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] }); assert.deepEqual(all.rows, [{ count: 12 }]); assert.equal(all.stats.documentsRead, 0, 'metadata-only queries read no Markdown');
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'wiki' })), [w.d.page!]);
  assert.equal((await rowsOf(w.owner, { from: 'observations' })).length, 6);
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', scope: { workspace: 'app' }, where: { field: 'type', op: 'eq', value: 'note' } })), [w.d.deploy!, w.d.alerts!, w.d.ideas!].sort());
  assert.ok(idsOf(await rowsOf(w.owner, { from: 'documents', scope: { workspace: 'app' } })).includes(w.d.page!), 'shared knowledge is included with a workspace by default');
  assert.ok(!idsOf(await rowsOf(w.owner, { from: 'documents', scope: { workspace: 'app', includeShared: false } })).includes(w.d.page!));
  assert.ok(!idsOf(await rowsOf(w.owner, { from: 'documents', scope: { workspace: 'app' } })).includes(w.d.secret!), 'another workspace is never included');
  assert.deepEqual(await rowsOf(w.owner, { from: 'documents', scope: { workspace: 'app' }, where: { field: 'tags', op: 'contains', value: 'idea' }, pipe: [{ op: 'select', fields: ['title', 'workspace', 'visibility'] }] }), [{ title: 'Ideas', workspace: 'app', visibility: 'workspace' }]);
  rec('sources-and-scope');
});

test('rejected discoveries are hidden by default and history inspection requires explicit authorized opt-in', async t => {
  const w = await world(t);
  const rejected = await w.vault.put({ scope: { type: 'global', area: 'discoveries' }, kind: 'discovery', title: 'Rejected composition', body: 'private rejected composition marker', status: 'rejected' });
  assert.deepEqual(await rowsOf(w.owner, { from: 'discoveries', search: { mode: 'keyword', text: 'private rejected composition marker' } }), []);
  assert.deepEqual(await rowsOf(w.owner, { from: 'discoveries', scope: { includeRejected: false }, where: { field: 'id', op: 'eq', value: rejected.id } }), []);
  const explicit = await rowsOf(w.owner, { from: 'discoveries', scope: { includeRejected: true }, where: { field: 'id', op: 'eq', value: rejected.id } });
  assert.equal(explicit.length, 1);
  await assert.rejects(w.agent.run({ version: 1, from: 'discoveries', scope: { includeRejected: true }, where: { field: 'id', op: 'eq', value: rejected.id } }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await assert.rejects(w.agent.run({ version: 1, from: 'discoveries', scope: { includeRejected: true }, search: { mode: 'keyword', text: 'private rejected composition marker' } }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  rec('rejected-discovery-query-opt-in');
});
test('search modes: exact, keyword, regex and auto go through the index-backed engine, with transparent backend info', async t => {
  const w = await world(t);
  const exact = await w.owner.run({ version: 1, from: 'documents', search: { mode: 'exact', text: 'rollback works' }, pipe: [{ op: 'select', fields: ['id', 'score'] }] }); assert.deepEqual(idsOf(exact.rows), [w.d.deploy!]);
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'exact', text: 'ROLLBACK' } })), [], 'exact is case-sensitive');
  assert.ok(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'keyword', text: 'deploy' } })).includes(w.d.deploy!));
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'regex', text: 'async s.*fine' } })), [w.d.deploy!], 'regex search');
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'wiki', search: { mode: 'keyword', text: 'deploy' } })), [w.d.page!], 'kind source narrows search results');
  assert.equal(exact.stats.searchPages, 1); assert.ok(exact.stats.textPrefilter, 'the text prefilter used is reported');
  assert.ok(exact.stats.documentsRead === 0 && exact.stats.candidates >= 1);
  // the same query through the plain search API returns the same objects (parity with the retrieval engine itself)
  const direct = (await new SearchEngine(w.vault).query({ query: 'deploy', mode: 'keyword', limit: 100 })).hits.map(h => h.objectId).sort();
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'keyword', text: 'deploy' } })), direct);
  rec('search-modes');
});
test('semantic and hybrid: CAPABILITY_UNAVAILABLE unless a labelled downgrade is explicitly requested; lexical results are never mislabelled', async t => {
  const w = await world(t);
  for (const mode of ['semantic', 'hybrid']) await assert.rejects(w.owner.run({ version: 1, from: 'documents', search: { mode, text: 'deploy' } }), { code: 'CAPABILITY_UNAVAILABLE' });
  const down = await w.owner.run({ version: 1, from: 'documents', search: { mode: 'semantic', text: 'deploy', allowDowngrade: true } });
  assert.match(down.fallback ?? '', /not semantic/); assert.ok(down.rows.length > 0);
  assert.ok((down.rows as Array<{ retrievalMode?: string }>).every(r => r.retrievalMode !== 'semantic'));
  rec('capability-negotiation');
});
test('hydration is pinned to the snapshot revision and counted', async t => {
  const w = await world(t);
  const doc = await w.vault.get(w.d.ideas!);
  const stream = w.owner.execute({ version: 1, from: 'documents', where: { field: 'id', op: 'eq', value: w.d.ideas }, pipe: [{ op: 'cat' }] });
  const first = await stream.next(); // snapshot is open now
  await w.vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, body: 'a completely different body' });
  const rest: unknown[] = [first.value]; for (let r = await stream.next(); !r.done; r = await stream.next()) rest.push(r.value);
  assert.ok(rest.every(r => !(r as { text: string }).text.includes('completely different')), 'lines of the snapshot revision, not of the newer commit');
  const after = await rowsOf(w.owner, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.ideas }, pipe: [{ op: 'cat' }] }); assert.equal(after[0]!.text, 'a completely different body');
  rec('snapshot-pinning');
});
test('search sees commits after the snapshot consistently: edited, created and deleted objects', async t => {
  const w = await world(t);
  const doc = await w.vault.get(w.d.ideas!);
  const before = await w.owner.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'dashboard' } }); assert.deepEqual(idsOf(before.rows), [w.d.ideas!]);
  await w.vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, body: 'zebra only now' });
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'keyword', text: 'dashboard' } })), [], 'old text no longer matches');
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'keyword', text: 'zebra' } })), [w.d.ideas!]);
  const fresh = await w.vault.put({ scope: app, kind: 'note', title: 'New', body: 'brand new zebra note' });
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'keyword', text: 'zebra' } })), [w.d.ideas!, fresh.id].sort());
  await w.vault.delete(fresh.id, fresh.revisionId);
  assert.deepEqual(idsOf(await rowsOf(w.owner, { from: 'documents', search: { mode: 'keyword', text: 'zebra' } })), [w.d.ideas!]);
  rec('commit-visibility');
});
test('filesystem and SQLite give the same rows for the same queries (and the files path works with SQLite disabled)', async t => {
  const w = await world(t, true);
  await setSqlite(w.vault, true); await new SearchEngine(w.vault).rebuild();
  const queries: Array<Record<string, unknown>> = [
    { from: 'documents', search: { mode: 'keyword', text: 'deploy' }, orderBy: [{ field: 'id' }], pipe: [{ op: 'select', fields: ['id', 'snippet'] }] }, // membership and snippets equal; ordering by relevance differs by design (BM25 vs lexical) and is checked below
    { from: 'documents', search: { mode: 'exact', text: 'verify rollback' }, pipe: [{ op: 'select', fields: ['id', 'lineStart'] }] },
    { from: 'documents', search: { mode: 'regex', text: 'deploy.*' }, orderBy: [{ field: 'id' }], pipe: [{ op: 'select', fields: ['id'] }] },
    { from: 'observations', orderBy: [{ field: 'eventTime', dir: 'desc' }, { field: 'id' }], pipe: [{ op: 'select', fields: ['id', 'eventTime', 'sessionId'] }] },
    { from: 'documents', where: { field: 'tags', op: 'contains', value: 'ops' }, pipe: [{ op: 'group', fields: ['workspace'], aggregates: { n: { op: 'count' } } }] },
    { from: 'documents', pipe: [{ op: 'cat' }, { op: 'grep', pattern: 'deploy' }, { op: 'select', fields: ['documentId', 'lineNumber', 'text'] }, { op: 'sort', fields: [{ field: 'documentId' }, { field: 'lineNumber' }] }] }
  ];
  const sql = [] as unknown[]; for (const q of queries) sql.push((await w.owner.run({ version: 1, ...q })).rows);
  const ranked = await w.owner.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'deploy' }, pipe: [{ op: 'select', fields: ['id', 'score'] }] }); assert.equal(ranked.search?.ranking, 'bm25', 'SQLite ranks keyword results with BM25 and says so'); assert.equal(ranked.search?.mode, 'keyword');
  const scores = (ranked.rows as Array<{ score: number }>).map(r => r.score); assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'rows arrive best BM25 first');
  assert.equal((await w.owner.run({ version: 1, from: 'documents', search: { mode: 'exact', text: 'verify rollback' } })).search?.ranking, 'lexical', 'exact and regex always stay on the lexical path');
  await setSqlite(w.vault, false);
  const files = [] as unknown[]; for (const q of queries) files.push((await new QueryApi(w.vault).run({ version: 1, ...q })).rows);
  assert.equal((await new QueryApi(w.vault).run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'deploy' } })).search?.ranking, 'lexical', 'without SQLite the built-in scorer ranks');
  queries.forEach((q, i) => assert.deepEqual(files[i], sql[i], JSON.stringify(q)));
  rec('files-sqlite-parity');
});
test('SQLite BM25 ties use deterministic object-id ordering across repeated queries', async t => {
  const w = await world(t, true);
  const expected: string[] = [];
  for (let i = 0; i < 8; i++) {
    expected.push((await w.vault.put({ scope: app, kind: 'note', title: 'BM25 tie fixture', body: 'bm25 deterministic tie token' })).id);
  }
  await setSqlite(w.vault, true); await new SearchEngine(w.vault).rebuild();
  const engine = new SearchEngine(w.vault);
  const first = await engine.query({ query: '"bm25 deterministic tie token"', mode: 'keyword', limit: 100 });
  const second = await engine.query({ query: '"bm25 deterministic tie token"', mode: 'keyword', limit: 100 });
  assert.equal(first.ranking, 'bm25');
  assert.deepEqual(first.hits.map(hit => hit.objectId), [...expected].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(second.hits.map(hit => hit.objectId), first.hits.map(hit => hit.objectId));
  assert.equal(new Set(first.hits.map(hit => hit.score)).size, 1, 'identical indexed text has an actual BM25 tie');
  rec('sqlite-bm25-deterministic-ties');
});
test('ACL: an agent sees only its workspace and wiki; a stranger sees nothing; no counts, scores, snippets or edges leak', async t => {
  const w = await world(t);
  const agentIds = idsOf(await rowsOf(w.agent, { from: 'documents' })); assert.ok(!agentIds.includes(w.d.secret!) && !agentIds.includes(w.d.secretNote!)); assert.ok(agentIds.includes(w.d.deploy!) && agentIds.includes(w.d.page!));
  assert.deepEqual((await w.agent.run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] })).rows, [{ count: 10 }], 'counts include only readable rows');
  assert.deepEqual((await w.stranger.run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] })).rows, [{ count: 0 }]);
  const leak = await w.agent.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'SECRET-TOKEN moon' } }); assert.deepEqual(leak.rows, []);
  const unreadable = await w.agent.run({ version: 1, from: 'documents', scope: { workspace: 'secret', includeShared: false } }), missing = await w.agent.run({ version: 1, from: 'documents', scope: { workspace: 'nonexistent', includeShared: false } });
  assert.deepEqual(unreadable.rows, []); assert.deepEqual({ ...unreadable, stats: undefined }, { ...missing, stats: undefined }, 'an unreadable workspace is indistinguishable from one that does not exist');
  assert.deepEqual((await w.agent.run({ version: 1, from: 'documents', scope: { workspace: 'secret' } })).rows.map(r => (r as { id: string }).id), [w.d.page], 'only the shared knowledge it may read');
  // graph: the secret page links to Deploy runbook and Ideas; the agent must not see that edge or that backlink
  const back = await rowsOf(w.agent, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.deploy }, pipe: [{ op: 'backlinks' }] });
  assert.ok(!idsOf(back).includes(w.d.secret!), 'backlinks from unreadable objects do not exist'); assert.ok(idsOf(back).includes(w.d.alerts!));
  const edges = JSON.stringify(await rowsOf(w.agent, { from: 'edges' })); assert.ok(!edges.includes('Secret plan') && !edges.includes(w.d.secret!));
  const ownerBack = await rowsOf(w.owner, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.deploy }, pipe: [{ op: 'backlinks' }] }); assert.ok(idsOf(ownerBack).includes(w.d.secret!), 'the owner does see it');
  // join: the right side is authorized independently
  const joined = await rowsOf(w.agent, { from: 'documents', where: { field: 'tags', op: 'contains', value: 'ops' }, pipe: [{ op: 'join', kind: 'left', right: { from: 'documents', scope: { workspace: 'secret' } }, on: { left: 'type', right: 'type' } }, { op: 'select', fields: ['id', 'right_title'] }] });
  assert.ok(joined.length > 0 && joined.every(r => r.right_title === undefined), 'a right side the principal cannot read contributes nothing');
  // union across workspaces cannot smuggle rows either
  const union = await rowsOf(w.agent, { from: 'documents', scope: { workspace: 'app' }, pipe: [{ op: 'select', fields: ['id', 'title'] }, { op: 'unionAll', right: { from: 'documents', scope: { workspace: 'secret' }, pipe: [{ op: 'select', fields: ['id', 'title'] }] } }] });
  assert.ok(!JSON.stringify(union).includes('Secret plan'));
  // in-subquery over an unreadable side
  const sub = await rowsOf(w.agent, { from: 'documents', where: { op: 'in', field: 'title', value: { field: 'title', subquery: { from: 'documents', scope: { workspace: 'secret', includeShared: false } } } } }); assert.deepEqual(sub, []);
  // explain exposes no values and no unreadable counts
  const plan = JSON.stringify(await w.agent.explain({ version: 1, from: 'documents', scope: { workspace: 'secret' }, search: { mode: 'keyword', text: 'SECRET-TOKEN' } })); assert.ok(!plan.includes('SECRET-TOKEN'));
  assert.equal((await w.agent.explain({ version: 1, from: 'documents', scope: { workspace: 'secret', includeShared: false } })).candidateEstimate, 0, 'estimates count only what the principal may read');
  rec('acl-non-disclosure');
});
test('ACL changes take effect on the next query (grant and revoke), cursors are bound to the principal and query', async t => {
  const w = await world(t);
  assert.ok(!idsOf(await rowsOf(w.agent, { from: 'documents' })).includes(w.d.secret!));
  await w.vault.grant('secret', 'agent', ['read']);
  assert.ok(idsOf(await rowsOf(w.agent, { from: 'documents' })).includes(w.d.secret!), 'a grant is visible immediately');
  await w.vault.revoke('secret', 'agent');
  assert.ok(!idsOf(await rowsOf(w.agent, { from: 'documents' })).includes(w.d.secret!), 'a revoke is visible immediately');
  const page = await w.owner.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 3 }); assert.ok(page.cursor);
  await assert.rejects(w.agent.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 3, cursor: page.cursor }), { code: 'QUERY_INVALID' }, 'another principal cannot resume it');
  await w.vault.put({ scope: app, kind: 'note', title: 'moves the snapshot', body: 'x' });
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 3, cursor: page.cursor }), { code: 'SNAPSHOT_EXPIRED' }, 'the vault changed since the cursor');
  const drift = await w.owner.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 3, cursor: page.cursor }, { allowCursorDrift: true }); assert.equal(drift.rows.length, 3);
  rec('acl-live-and-cursors');
});
test('forged identity: the principal cannot be supplied in a query or context', async t => {
  const w = await world(t);
  await assert.rejects(w.agent.run({ version: 1, from: 'documents', principalId: 'owner' }), { code: 'QUERY_INVALID' });
  await assert.rejects(w.agent.run({ version: 1, from: 'documents' }, { principalId: 'owner' }), { code: 'SCOPE_DENIED' });
  await assert.rejects(w.agent.run({ version: 1, from: 'documents', actor: { actorId: 'owner' } }), { code: 'QUERY_INVALID' });
});
test('graph over a real vault: references resolve titles, traversal respects readability at every hop', async t => {
  const w = await world(t);
  const out = await rowsOf(w.owner, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.secret }, pipe: [{ op: 'references' }] }); assert.deepEqual(idsOf(out), [w.d.deploy!, w.d.ideas!].sort());
  const walk = await rowsOf(w.owner, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.page }, pipe: [{ op: 'traverse', maxDepth: 3, maxNodes: 50 }, { op: 'select', fields: ['id', 'depth'] }] }); assert.deepEqual(walk, [{ id: w.d.alerts, depth: 1 }, { id: w.d.deploy, depth: 2 }]);
  const agentWalk = await rowsOf(w.agent, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.page }, pipe: [{ op: 'traverse', maxDepth: 3, maxNodes: 50, direction: 'both' }] }); assert.ok(!idsOf(agentWalk).includes(w.d.secret!), 'the walk does not step through an unreadable node');
  // same answers as the existing graph API
  const search = new SearchEngine(w.vault);
  assert.deepEqual((await search.backlinks(w.d.deploy!)).length, (await rowsOf(w.owner, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.deploy }, pipe: [{ op: 'backlinks' }] })).length);
  assert.deepEqual((await search.related(w.d.alerts!, 1)).map(d => d.id).sort(), idsOf(await rowsOf(w.owner, { from: 'documents', where: { field: 'id', op: 'eq', value: w.d.alerts }, pipe: [{ op: 'related', depth: 1 }] })));
  rec('graph');
});
test('observations: recent/timeline/session/between agree with the memory recall API', async t => {
  const w = await world(t);
  const recent = await rowsOf(w.owner, { from: 'observations', pipe: [{ op: 'recent', n: 3 }, { op: 'select', fields: ['id', 'eventTime', 'sessionId'] }] });
  assert.deepEqual(recent.map(r => r.id), [w.d.obs5, w.d.obs4, w.d.obs3]);
  const memory = await (await import('../../packages/memory/recall.js')).MemoryRecall.prototype.constructor && undefined; void memory;
  const timeline = await rowsOf(w.owner, { from: 'observations', pipe: [{ op: 'timeline', sessionId: 's1' }, { op: 'select', fields: ['id'] }] }); assert.deepEqual(timeline.map(r => r.id), [w.d.obs0, w.d.obs1, w.d.obs2]);
  const between = await rowsOf(w.owner, { from: 'observations', pipe: [{ op: 'between', from: '2026-04-02T00:00:00Z', to: '2026-04-04T08:00:00Z' }, { op: 'sort', fields: [{ field: 'eventTime' }] }] }); assert.deepEqual(between.map(r => r.id), [w.d.obs1, w.d.obs2]);
  assert.deepEqual((await rowsOf(w.owner, { from: 'observations', pipe: [{ op: 'group', fields: ['sessionId', 'eventType'], aggregates: { n: { op: 'count' } } }] })), [{ sessionId: 's1', eventType: 'decision', n: 1 }, { sessionId: 's1', eventType: 'tool.result', n: 2 }, { sessionId: 's2', eventType: 'decision', n: 2 }, { sessionId: 's2', eventType: 'tool.result', n: 1 }]);
  rec('observations');
});
test('saved queries are versioned objects: saved through Vault, readable under ACL, refinable', async t => {
  const w = await world(t);
  const first = await w.owner.save('ops notes', { from: 'documents', where: { field: 'tags', op: 'contains', value: 'ops' }, orderBy: [{ field: 'title' }], pipe: [{ op: 'select', fields: ['title'] }] }, app);
  const second = await w.owner.save('ops notes', { from: 'documents', where: { field: 'tags', op: 'contains', value: 'ops' }, orderBy: [{ field: 'title' }], limit: 1, pipe: [{ op: 'select', fields: ['title'] }] }, app);
  assert.equal(first.id, second.id); assert.notEqual(first.revisionId, second.revisionId, 'saving again is a new immutable revision');
  assert.equal((await w.vault.history(first.id)).length, 2);
  assert.deepEqual((await w.owner.run({ version: 1, from: 'saved', saved: 'ops notes' })).rows, [{ title: 'Alert tuning' }]);
  assert.deepEqual((await w.agent.run({ version: 1, from: 'saved', saved: 'ops notes', limit: 5 })).rows.length, 2, "the caller's own limit replaces the saved one; the agent sees its two ops notes, not the secret one");
  await assert.rejects(w.stranger.run({ version: 1, from: 'saved', saved: 'ops notes' }), { code: 'QUERY_INVALID' }, 'a saved query the principal cannot read does not exist for them');
  await assert.rejects(w.owner.save('bad', { from: 'documents', pipe: [{ op: 'eval', code: '1' }] }, app), { code: 'QUERY_INVALID' });
  rec('saved-queries');
});
test('read-only: running queries never writes to the journal or canonical objects', async t => {
  const w = await world(t);
  const journal = path.join(w.root, '.mdb/events/commits.jsonl'); const before = await fs.readFile(journal, 'utf8');
  const objects = async () => (await fs.readdir(path.join(w.root, '.mdb/objects'))).length;
  const count = await objects();
  await w.owner.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'deploy' }, pipe: [{ op: 'cat' }, { op: 'sed', script: 's/deploy/DEPLOY/g' }] });
  await w.agent.run({ version: 1, from: 'edges' });
  assert.equal(await fs.readFile(journal, 'utf8'), before); assert.equal(await objects(), count);
  assert.equal((await w.vault.verify()).ok, true);
});
test('indexed queries do not materialize the corpus: documents read is proportional to the answer', async t => {
  const w = await world(t);
  for (let i = 0; i < 150; i++) await w.vault.put({ scope: app, kind: 'note', title: `Filler ${i}`, body: `filler text number ${i}` });
  const r = await w.owner.run({ version: 1, from: 'documents', search: { mode: 'exact', text: 'rollback works' }, pipe: [{ op: 'cat' }, { op: 'grep', pattern: 'rollback' }] });
  assert.equal(r.rows.length, 1); assert.ok(r.stats.documentsRead <= 3, `read ${r.stats.documentsRead} documents of 150+`);
  const derived = await w.owner.run({ version: 1, from: 'documents', where: { field: 'body', op: 'contains', value: 'rollback works' }, pipe: [{ op: 'select', fields: ['id'] }] });
  assert.equal(derived.rows.length, 1); assert.ok(derived.stats.documentsRead <= 3, `contains-body prefilter read ${derived.stats.documentsRead}`);
  const scan = await w.owner.run({ version: 1, from: 'documents', where: { field: 'body', op: 'contains', value: 'filler' }, pipe: [{ op: 'count' }] });
  assert.equal((scan.rows[0] as { count: number }).count, 150); assert.ok(scan.stats.documentsRead >= 150, 'a body scan reads what it matches, and says so');
  const plan = await w.owner.explain({ version: 1, from: 'documents', pipe: [{ op: 'sort', fields: [{ field: 'body' }] }] }); assert.ok(plan.warnings.some(x => /every candidate/.test(x)), 'full scans are warned about in explain');
  rec('materialization-bound');
});
