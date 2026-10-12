import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { manifestFor } from '../../packages/search-files/manifest.js';
import { buildFsIndex, resetFsIndexCache } from '../../packages/search-files/postings.js';
import type { Scope, SearchInput, SearchResult } from '../../packages/core/types.js';

const wiki: Scope = { type: 'global', area: 'wiki' };
const wsA: Scope = { type: 'workspace', workspaceId: 'a' };
const wsB: Scope = { type: 'workspace', workspaceId: 'b' };
const INDEX = '.mdb/indexes/fs-trigram';
type Info = { fastPath?: string; textPrefilter?: string; candidates?: number; entries?: number };
const info = (r: SearchResult): Info => (r as SearchResult & { index?: Info }).index ?? {};
const ids = (r: SearchResult) => r.hits.map(h => h.objectId).sort();

async function corpus(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('a', '', { agent: ['read', 'write'] }); await vault.createWorkspace('b', '', {});
  const d: Record<string, string> = {};
  const put = async (key: string, scope: Scope, title: string, body: string, tags: string[] = []) => { d[key] = (await vault.put({ scope, kind: 'note', title, body, tags })).id; };
  await put('ascii', wiki, 'Retrieval notes', '# Retrieval\n\nA warm cache improves retrieval latency.', ['perf']);
  await put('cjk', wiki, '知识库', '知识庫 与 检索 系统。知识库 管理很重要。', ['zh']);
  await put('hangul', wiki, '한국어 제목', '검색 시스템 설명', ['ko']);
  await put('titleonly', wiki, 'Quoted "title": with # hash and ünï', 'body without the title words', []);
  await put('upper', wiki, 'Shout', 'MIXED Case Marker-Token appears HERE', []);
  await put('private', wsB, 'Private B', 'warm cache PRIVATE-B-ONLY retrieval secret', []);
  await put('team', wsA, 'Team A', 'warm cache team-a-only retrieval', ['team']);
  await put('deleted', wiki, 'Gone', 'tombstoned-unique-token warm cache', []);
  const gone = await vault.get(d.deleted!); await vault.delete(gone.id, gone.revisionId);
  return { root, vault, d };
}
const queries: SearchInput[] = [
  { query: 'zz-no-such-token', mode: 'grep' }, { query: 'zz-no-such-token', mode: 'keyword' }, { query: 'zz-no-such-token' }, { query: 'warm cache', mode: 'grep' }, { query: 'retrieval', mode: 'keyword' },
  { query: 'warm zz-absent', mode: 'keyword' }, { query: 'warm -zzabsent', mode: 'keyword' }, { query: '知识库', mode: 'grep' }, { query: '知识库zz', mode: 'grep' }, { query: '한국어', mode: 'grep' }, { query: '한국어 없는말', mode: 'grep' },
  { query: 'MIXED Case', mode: 'grep', caseSensitive: true }, { query: 'mixed case', mode: 'grep', caseSensitive: true }, { query: 'marker-token', mode: 'grep' }, { query: 'quoted "title"', mode: 'grep' }, { query: 'with # hash', mode: 'grep' }, { query: 'ünï', mode: 'grep' },
  { query: 'tombstoned-unique-token', mode: 'grep' }, { query: 'PRIVATE-B-ONLY', mode: 'grep' }, { query: 'team-a-only', mode: 'grep' }, { query: 'zz-no.*such', mode: 'grep', regex: true }, { query: 'warm c.che', mode: 'grep', regex: true },
];
const sig = (r: SearchResult) => JSON.stringify(r.hits.map(h => [h.objectId, h.snippet, h.lineStart, h.score]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1));

test('negative fast path: results are identical to the unindexed file scan for every query and actor, and only provable negatives take the fast path', async t => {
  const { root, vault } = await corpus(t);
  const agentVault = () => new Vault(root, { actorId: 'agent', permissions: ['global:wiki:read', 'workspace:a:read'] });
  const scan = new Map<string, string>();
  for (const [who, make] of [['owner', () => new Vault(root)], ['agent', agentVault]] as const) for (const q of queries) { const r = await new SearchEngine(make()).query({ limit: 100, ...q }); assert.notEqual(info(r).fastPath, 'no-candidates'); scan.set(`${who}:${JSON.stringify(q)}`, sig(r)); }
  await new SearchEngine(vault).rebuild(); resetFsIndexCache();
  let fast = 0; const diffs: string[] = [];
  for (const [who, make] of [['owner', () => new Vault(root)], ['agent', agentVault]] as const) { const engine = new SearchEngine(make()); for (const q of queries) {
    const r = await engine.query({ limit: 100, ...q }); if (info(r).fastPath === 'no-candidates') { fast++; assert.equal(r.hits.length, 0); assert.equal(info(r).candidates, 0); }
    if (sig(r) !== scan.get(`${who}:${JSON.stringify(q)}`)) diffs.push(`${who}:${q.query}`);
  } }
  assert.deepEqual(diffs, []);
  const owner = new SearchEngine(new Vault(root));
  for (const q of ['zz-no-such-token', '知识库zz', '한국어 없는말']) assert.equal(info(await owner.query({ query: q, mode: 'grep' })).fastPath, 'no-candidates', q);
  for (const q of ['warm cache', '知识库', 'quoted "title"', 'with # hash', 'ünï', 'marker-token']) assert.notEqual(info(await owner.query({ query: q, mode: 'grep' })).fastPath, 'no-candidates', `${q} must not be rejected`);
  assert.ok(fast >= 6, `fast path exercised (${fast})`);
  recordCase({ suite: 'search', name: 'negative-fast-path-parity', status: 'PASS', detail: { queries: queries.length, fastPathRuns: fast } });
});

test('negative fast path: filters, regex and unservable terms never use it; the reported entry count equals the regular pipeline', async t => {
  const { root, vault } = await corpus(t); const engine = new SearchEngine(vault); await engine.rebuild();
  assert.notEqual(info(await engine.query({ query: 'zz-no-such-token', mode: 'grep', regex: true })).fastPath, 'no-candidates');
  assert.notEqual(info(await engine.query({ query: 'zz', mode: 'grep' })).fastPath, 'no-candidates', 'a two-character term is not index-servable');
  assert.notEqual(info(await engine.query({ query: 'zz-no-such-token', mode: 'grep', kinds: ['note'] })).fastPath, 'no-candidates');
  assert.notEqual(info(await engine.query({ query: 'zz-no-such-token', mode: 'grep', scopes: [wiki] })).fastPath, 'no-candidates');
  const fast = info(await engine.query({ query: 'zz-no-such-token', mode: 'grep' }));
  const slow = info(await engine.query({ query: 'zz-no-such-token', mode: 'grep', kinds: ['note'] })); // same entry set (all notes), full pipeline
  assert.equal(fast.entries, slow.entries); void root;
});

test('negative fast path: writes, deletes, torn-tail recovery and index rebuilds are visible immediately', async t => {
  const { root, vault, d } = await corpus(t); const engine = new SearchEngine(vault); await engine.rebuild();
  assert.equal(info(await engine.query({ query: 'fresh-after-build', mode: 'grep' })).fastPath, 'no-candidates');
  const fresh = await vault.put({ scope: wiki, kind: 'note', title: 'Fresh', body: 'contains fresh-after-build token' });
  assert.deepEqual(ids(await engine.query({ query: 'fresh-after-build', mode: 'grep' })), [fresh.id]);
  assert.deepEqual(ids(await engine.query({ query: 'fresh-after-build', mode: 'keyword' })), [fresh.id]);
  const titled = await vault.put({ scope: wiki, kind: 'note', title: 'zz-title-after-build', body: 'x' });
  assert.deepEqual(ids(await engine.query({ query: 'zz-title-after-build', mode: 'grep' })), [titled.id], 'a title-only match written after the build is found');
  await vault.delete(fresh.id, fresh.revisionId);
  assert.deepEqual(ids(await engine.query({ query: 'fresh-after-build', mode: 'grep' })), [], 'deleted stays hidden');
  const up = await vault.get(d.ascii!); await vault.patch({ objectId: up.id, expectedRevisionId: up.revisionId, body: 'rewritten zz-edited-token' });
  assert.deepEqual(ids(await engine.query({ query: 'zz-edited-token', mode: 'grep' })), [up.id]);
  assert.deepEqual(ids(await engine.query({ query: 'latency', mode: 'grep' })), [], 'old content gone');
  // a torn, unterminated journal tail from a crash must not hide or invent anything after reopening
  await fs.appendFile(path.join(root, '.mdb/events/commits.jsonl'), '{"sequence":99999,"torn":');
  resetFsIndexCache(); const reopened = new SearchEngine(new Vault(root));
  assert.deepEqual(ids(await reopened.query({ query: 'zz-edited-token', mode: 'grep' })), [up.id]);
  const after = await new Vault(root).put({ scope: wiki, kind: 'note', title: 'After crash', body: 'post-recovery-token' });
  resetFsIndexCache(); assert.deepEqual(ids(await new SearchEngine(new Vault(root)).query({ query: 'post-recovery-token', mode: 'grep' })), [after.id]);
  await new SearchEngine(new Vault(root)).rebuild(); resetFsIndexCache();
  const rebuilt = new SearchEngine(new Vault(root));
  assert.deepEqual(ids(await rebuilt.query({ query: 'post-recovery-token', mode: 'grep' })), [after.id]);
  assert.equal(info(await rebuilt.query({ query: 'zz-still-absent', mode: 'grep' })).fastPath, 'no-candidates');
  recordCase({ suite: 'search', name: 'negative-fast-path-freshness', status: 'PASS', detail: {} });
});

test('negative fast path: a damaged, partial or misleading index never produces a false empty result', async t => {
  const { root, vault, d } = await corpus(t); const engine = new SearchEngine(vault); await engine.rebuild();
  const dir = path.join(root, INDEX); const want = ids(await engine.query({ query: 'team-a-only', mode: 'grep' })); assert.equal(want.length, 1);
  const damage: Array<[string, () => Promise<void>]> = [
    ['shard checksum', async () => { for (const f of (await fs.readdir(dir)).filter(f => f.endsWith('.bin'))) { const raw = await fs.readFile(path.join(dir, f)); if (raw.length > 8) { raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; await fs.writeFile(path.join(dir, f), raw); } } }],
    ['missing meta', async () => { await fs.rm(path.join(dir, 'meta.json')); }],
    ['truncated docs list', async () => { const lines = (await fs.readFile(path.join(dir, 'docs.tsv'), 'utf8')).split('\n').filter(Boolean); await fs.writeFile(path.join(dir, 'docs.tsv'), lines.slice(0, -1).join('\n') + '\n'); }],
    ['index removed', async () => { await fs.rm(dir, { recursive: true, force: true }); }],
  ];
  for (const [name, hurt] of damage) {
    await engine.rebuild(); await hurt(); resetFsIndexCache(); const fresh = new SearchEngine(new Vault(root));
    const r = await fresh.query({ query: 'team-a-only', mode: 'grep' }); assert.deepEqual(ids(r), want, name); assert.notEqual(info(r).fastPath, 'no-candidates', name);
    const miss = await fresh.query({ query: 'zz-no-such-token', mode: 'grep' }); assert.equal(miss.hits.length, 0, name); assert.notEqual(info(miss).fastPath, 'no-candidates', `${name}: an unusable index must not prove absence`);
  }
  // a revision that cannot be read while the index is built must stay a candidate, not become an indexed empty document
  await engine.rebuild(); await fs.rm(dir, { recursive: true, force: true });
  const target = await vault.get(d.team!); const file = path.join(root, `.mdb/objects/${target.id}/revs/${target.revisionId}.md`); const bytes = await fs.readFile(file);
  await fs.chmod(file, 0); await buildFsIndex(new Vault(root)); await fs.chmod(file, 0o600); assert.deepEqual(await fs.readFile(file), bytes);
  resetFsIndexCache(); const after = new SearchEngine(new Vault(root));
  assert.deepEqual(ids(await after.query({ query: 'team-a-only', mode: 'grep' })), want, 'the unreadable-at-build document is still found');
  assert.notEqual(info(await after.query({ query: 'team-a-only', mode: 'grep' })).fastPath, 'no-candidates');
  recordCase({ suite: 'search', name: 'negative-fast-path-damage', status: 'PASS', detail: { cases: damage.length + 1 } });
});

test('negative fast path: authorization is unchanged; a forbidden term and a missing term look identical, and revocation is immediate', async t => {
  const { root, vault } = await corpus(t); await new SearchEngine(vault).rebuild(); resetFsIndexCache();
  const agent = () => new SearchEngine(new Vault(root, { actorId: 'agent', permissions: ['global:wiki:read', 'workspace:a:read'], credentialBound: true } as never));
  const forbidden = await agent().query({ query: 'PRIVATE-B-ONLY', mode: 'grep' }); const missing = await agent().query({ query: 'zz-nothing-here-at-all', mode: 'grep' });
  assert.equal(forbidden.hits.length, 0); assert.equal(missing.hits.length, 0);
  assert.equal((forbidden as { total?: number }).total, (missing as { total?: number }).total);
  assert.equal(ids(await agent().query({ query: 'team-a-only', mode: 'grep' })).length, 1);
  await vault.revoke('a', 'agent');
  assert.deepEqual(ids(await agent().query({ query: 'team-a-only', mode: 'grep' })), [], 'revocation applies to the very next query');
  await vault.grant('a', 'agent', ['read']);
  assert.equal(ids(await agent().query({ query: 'team-a-only', mode: 'grep' })).length, 1, 'a grant applies immediately');
  const warm = agent(); assert.equal(ids(await warm.query({ query: 'team-a-only', mode: 'grep' })).length, 1); await vault.revoke('a', 'agent');
  assert.deepEqual(ids(await warm.query({ query: 'team-a-only', mode: 'grep' })), [], 'a long-lived engine sees the revocation too');
  recordCase({ suite: 'search', name: 'negative-fast-path-authorization', status: 'PASS', detail: {} });
});

test('manifest title scan: titleIds equals the per-entry filter for tricky titles, both case modes, after updates', async t => {
  const { vault } = await disposableVault(t);
  const titles = ['Istanbul İstanbul', 'ΟΔΟΣ Σίσυφος', 'Straße STRASSE', 'plain title', 'with\u0000nul', 'ünï cödé', '知识库 管理', 'UPPER lower Mixed', 'x', 'dotless ı I'];
  const put: string[] = []; for (const title of titles) put.push((await vault.put({ scope: wiki, kind: 'note', title, body: 'b' })).id);
  const manifest = await manifestFor(vault); await manifest.sync();
  const brute = (term: string, cs: boolean) => new Set([...manifest.entries.values()].filter(e => (cs ? e.title : e.title.toLocaleLowerCase()).includes(term)).map(e => e.id));
  const terms = ['title', 'istanbul', 'İ', 'i̇', 'οδοσ', 'σ', 'ς', 'straße', 'strasse', 'ünï', '知识', 'upper', 'UPPER', 'Mixed', 'x', 'ı', 'nul', 'with\u0000', 'zz-none', 'e'];
  for (const cs of [false, true]) for (const term of terms) assert.deepEqual([...manifest.titleIds(term, cs)].sort(), [...brute(term, cs)].sort(), `${cs ? 'cs' : 'ci'}:${JSON.stringify(term)}`);
  const extra = await vault.put({ scope: wiki, kind: 'note', title: 'added later title', body: 'b' }); await manifest.sync();
  assert.ok(manifest.titleIds('added later', false).has(extra.id)); assert.equal(put.length, titles.length);
  const gone = await vault.get(extra.id); await vault.delete(gone.id, gone.revisionId); await manifest.sync();
  assert.equal(manifest.activeCount([...manifest.byScope.keys()]), titles.length, 'activeCount excludes tombstoned entries');
  assert.ok(!manifest.titleIds('added later', false).has(extra.id) || ['deleted', 'tombstone'].includes(manifest.entries.get(extra.id)?.status ?? ''));
});
