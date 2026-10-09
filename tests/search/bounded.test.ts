import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { Prng } from '../helpers/prng.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine, authorizedDocuments, mapBodyLines, searchDocuments } from '../../packages/search-files/index.js';
import { QueryApi } from '../../packages/query/index.js';
import type { Scope, SearchInput } from '../../packages/core/types.js';

const ws: Scope = { type: 'workspace', workspaceId: 'w' };
type T = { after(fn: () => void | Promise<void>): void };
/** The oracle scores every authorized document; bounded retrieval must return exactly the same page, cursor included, while reading fewer of them. */
async function oracle(vault: Vault, input: SearchInput) { const docs = await authorizedDocuments(vault, input, vault.actor); await mapBodyLines(vault, docs); return searchDocuments(docs, input, 'oracle'); }
async function corpus(t: T, size: number, seed = 5) {
  const { vault } = await disposableVault(t); await vault.createWorkspace('w', ''); const p = new Prng(seed);
  for (let i = 0; i < size; i++) {
    const title = i % 17 === 0 ? `common title ${i}` : i % 5 === 0 ? `note ${i} about index` : `Doc ${i}`;
    const body = `${i % 3 === 0 ? '# Heading common\n' : ''}common ${'common '.repeat(p.int(4))}word ${p.text(6)}\n${i % 11 === 0 ? 'rare-needle ' : ''}tail line ${i}\n`;
    await vault.put({ scope: ws, kind: 'note', title, body });
  }
  return vault;
}
const same = (a: unknown, b: unknown, label: string) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), label);

test('bounded retrieval equals scoring everything (hits, order, snippets, cursor) for common terms, phrases, regex, offsets and tiny/large limits', async t => {
  const vault = await corpus(t, 220); const engine = new SearchEngine(vault); let early = 0, compared = 0;
  const queries: SearchInput[] = [
    { query: 'common', mode: 'keyword' }, { query: 'common word', mode: 'keyword' }, { query: 'common OR index', mode: 'keyword' }, { query: 'common -rare-needle', mode: 'keyword' }, { query: 'index', mode: 'keyword' },
    { query: 'common', mode: 'grep' }, { query: 'tail line', mode: 'grep' }, { query: 'common.*word', mode: 'grep', regex: true }, { query: 'Doc [0-9]+5$', mode: 'grep', regex: true }, { query: 'COMMON', mode: 'grep', caseSensitive: true }, { query: 'rare-needle', mode: 'keyword' }
  ];
  for (const q of queries) for (const [limit, cursor] of [[1, undefined], [5, undefined], [20, undefined], [20, '20'], [7, '3'], [1000, undefined], [30, '210'], [30, '400']] as const) {
    const input = { ...q, limit, ...(cursor ? { cursor } : {}) }; const got = await engine.query(input); const want = await oracle(vault, input);
    same({ hits: got.hits, cursor: got.cursor }, { hits: want.hits, cursor: want.cursor }, JSON.stringify(input)); compared++;
    if ((got as { index?: { stoppedEarly?: boolean } }).index?.stoppedEarly) early++;
  }
  assert.ok(early >= 20, `bounded reading stopped early in ${early} of ${compared} comparisons`);
  recordCase({ suite: 'search', name: 'bounded-equals-full-scoring', status: 'PASS', detail: { compared, early } });
});
test('a frequent term with a small limit reads a small fraction of the matching documents; rare terms and large limits still read what they must', async t => {
  const vault = await corpus(t, 400); const engine = new SearchEngine(vault);
  const loaded = async (input: SearchInput) => ((await engine.query(input)) as { index?: { loaded: number; candidates: number } }).index!;
  const keyword = await loaded({ query: 'common', mode: 'keyword', limit: 10 }); assert.ok(keyword.candidates >= 390 && keyword.loaded <= 100, `keyword: ${keyword.loaded} of ${keyword.candidates}`);
  const grep = await loaded({ query: 'common', mode: 'grep', limit: 10 }); assert.ok(grep.loaded <= 40, `grep: ${grep.loaded} of ${grep.candidates}`);
  const regex = await loaded({ query: 'common.*word', mode: 'grep', regex: true, limit: 10 }); assert.ok(regex.loaded <= 40, `regex: ${regex.loaded} of ${regex.candidates}`);
  const all = await loaded({ query: 'common', mode: 'keyword', limit: 1000 }); assert.ok(all.loaded >= 390, 'asking for everything reads everything');
  const rare = await loaded({ query: 'rare-needle', mode: 'keyword', limit: 10 }); assert.ok(rare.candidates <= 40 && rare.loaded <= rare.candidates);
  recordCase({ suite: 'search', name: 'bounded-reads', status: 'PASS', detail: { keyword: keyword.loaded, grep: grep.loaded, regex: regex.loaded } });
});
test('exact page boundary: with exactly `limit` matches there is no cursor, with one more there is', async t => {
  const vault = await corpus(t, 60); const engine = new SearchEngine(vault);
  const total = (await oracle(vault, { query: 'rare-needle', mode: 'keyword', limit: 1000 })).hits.length;
  const exact = await engine.query({ query: 'rare-needle', mode: 'keyword', limit: total }); assert.equal(exact.cursor, undefined); assert.equal(exact.hits.length, total);
  const short = await engine.query({ query: 'rare-needle', mode: 'keyword', limit: total - 1 }); assert.equal(short.cursor, String(total - 1));
  const next = await engine.query({ query: 'rare-needle', mode: 'keyword', limit: total - 1, cursor: short.cursor }); assert.equal(next.hits.length, 1); assert.equal(next.cursor, undefined);
});
test('query engine pushes the page bound down to retrieval and returns the same rows', async t => {
  const vault = await corpus(t, 300); const api = new QueryApi(vault);
  const bounded = await api.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'common' }, limit: 10, pipe: [{ op: 'select', fields: ['id', 'score'] }] });
  assert.equal(bounded.rows.length, 10); assert.ok(bounded.cursor); assert.ok(bounded.stats.searchDocumentsLoaded <= 120, `loaded ${bounded.stats.searchDocumentsLoaded}`);
  const want = (await new SearchEngine(vault).query({ query: 'common', mode: 'keyword', limit: 10 })).hits.map(h => h.objectId); same((bounded.rows as Array<{ id: string }>).map(r => r.id), want, 'same ranking as the search API');
  const second = await api.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'common' }, limit: 10, cursor: bounded.cursor, pipe: [{ op: 'select', fields: ['id', 'score'] }] }); assert.equal(second.rows.length, 10);
  const unbounded = await api.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'common' }, orderBy: [{ field: 'title' }], limit: 10, pipe: [{ op: 'select', fields: ['id'] }] }); assert.ok(unbounded.stats.searchDocumentsLoaded >= 290, 'a re-sort needs every match, and the plan does not pretend otherwise');
  const head = await api.run({ version: 1, from: 'documents', search: { mode: 'regex', text: 'common' }, pipe: [{ op: 'head', n: 3 }, { op: 'select', fields: ['id'] }] }); assert.equal(head.rows.length, 3); assert.ok(head.stats.searchDocumentsLoaded <= 60);
  recordCase({ suite: 'search', name: 'query-limit-pushdown', status: 'PASS' });
});
