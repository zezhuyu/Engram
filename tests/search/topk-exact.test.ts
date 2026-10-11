import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { SearchEngine, compareIds, keywordGroups } from '../../packages/search-files/index.js';
import type { Document, Scope, SearchInput } from '../../packages/core/types.js';

const wiki: Scope = { type: 'global', area: 'wiki' };
/** Independent statement of the ranking contract (title +5, heading +2, min(3, occurrences) per positive term; ties by object id). */
function reference(docs: Document[], input: SearchInput): string[] {
  const groups = keywordGroups(input.query); const positive = groups.flat().filter(t => !t.negate).map(t => t.text); const hits: Array<{ id: string; score: number }> = [];
  for (const d of docs) {
    if (d.status === 'deleted') continue; const lower = `${d.title}\n${d.body}`.toLocaleLowerCase();
    if (!groups.some(g => g.every(t => t.negate ? !lower.includes(t.text) : lower.includes(t.text)))) continue;
    const lines = d.body.split('\n'); let index = lines.findIndex(l => positive.some(t => l.toLocaleLowerCase().includes(t))); if (index < 0) index = 0;
    let heading: string | undefined; for (let i = 0; i <= index; i++) if (/^#{1,6}\s/.test(lines[i] ?? '')) heading = lines[i]!.replace(/^#{1,6}\s+/, '');
    const score = positive.reduce((s, t) => s + (d.title.toLocaleLowerCase().includes(t) ? 5 : 0) + (heading?.toLocaleLowerCase().includes(t) ? 2 : 0) + Math.min(3, lower.split(t).length - 1), 0);
    hits.push({ id: d.id, score });
  }
  return hits.sort((a, b) => b.score - a.score || (compareIds(a.id, b.id))).map(h => h.id);
}
async function pages(engine: SearchEngine, input: SearchInput): Promise<string[]> { const out: string[] = []; let cursor: string | undefined; for (let i = 0; i < 200; i++) { const r = await engine.query({ ...input, ...(cursor ? { cursor } : {}) }); out.push(...r.hits.map(h => h.objectId)); cursor = r.cursor; if (!cursor) return out; } throw new Error('no end'); }

test('compareIds equals localeCompare for generated ids and for strings outside the fast alphabet', () => {
  let seed = 42; const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; }; const alphabet = '_0123456789abcdefghijklmnopqrstuvwxyz';
  const gen = () => 'obj_' + Array.from({ length: 1 + rnd(14) }, () => alphabet[rnd(alphabet.length)]).join('');
  for (let i = 0; i < 20000; i++) { const a = gen(), b = gen(); assert.equal(compareIds(a, b), Math.sign(a.localeCompare(b)), `${a} vs ${b}`); }
  for (const [a, b] of [['Obj_A', 'obj_a'], ['obj-1', 'obj_1'], ['é', 'e'], ['', 'a'], ['a', 'a'], ['obj_a', 'obj_a1'], ['obj_a1', 'obj_a']] as const) assert.equal(compareIds(a, b), Math.sign(a.localeCompare(b)), `${a} vs ${b}`);
});

test('exact ranked top-K: bounds from headings and trigram counts never change the order, pages or count, with and without the filesystem index, with stale and deleted objects, quoted titles, and every query shape', async t => {
  const { vault } = await disposableVault(t); let seed = 20261011; const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'index1', 'index10', 'cache2', 'warm', 'phrase'];
  const mk = (i: number) => {
    const words = Array.from({ length: 4 + rnd(40) }, () => vocab[rnd(vocab.length)]!); const headingTerm = rnd(3) === 0 ? vocab[rnd(vocab.length)]! : `section${i}`;
    const lines = [`# Document ${i}`, ...(rnd(2) ? [`## ${headingTerm} notes`] : []), words.slice(0, 8).join(' '), words.slice(8).join(' ')]; const titleTerm = rnd(4) === 0 ? vocab[rnd(vocab.length)]! : 'Synthetic';
    const title = rnd(6) === 0 ? `He said: "${titleTerm}" # not a heading ${i}` : `${titleTerm} ${i}`; return { title, body: lines.join('\n'), tags: rnd(3) === 0 ? ['alpha'] : [] };
  };
  const created: Document[] = []; for (let i = 0; i < 150; i++) { const d = mk(i); created.push(await vault.put({ scope: wiki, kind: 'note', title: d.title, body: d.body, tags: d.tags })); }
  const engine = new SearchEngine(vault); await engine.rebuild();
  // After the index build: new objects, an edit and a delete, so the overlay must keep results exact.
  for (let i = 150; i < 165; i++) { const d = mk(i); created.push(await vault.put({ scope: wiki, kind: 'note', title: d.title, body: d.body, tags: d.tags })); }
  const edit = await vault.get(created[3]!.id); created[3] = await vault.patch({ objectId: edit.id, expectedRevisionId: edit.revisionId, body: `# Edited\nalpha alpha alpha alpha beta ${'index1 '.repeat(5)}` });
  const gone = await vault.get(created[9]!.id); await vault.delete(gone.id, gone.revisionId); created[9] = await vault.get(created[9]!.id).catch(() => ({ ...gone, status: 'deleted' }) as Document);
  const live = (await vault.listDocuments()).filter(d => d.status !== 'deleted');
  const queries = ['alpha', 'alpha beta', 'index1 cache2', 'warm NOT phrase', 'alpha OR gamma', '"warm cache"', 'index1 index10', 'phrase delta epsilon', 'zzz-none', 'section7'];
  let comparisons = 0, pruned = 0;
  for (const q of queries) for (const limit of [1, 5, 20, 1000]) for (const tags of [undefined, ['alpha']]) {
    const input: SearchInput = { query: q, mode: 'keyword', limit, ...(tags ? { tags } : {}) }; const pool = tags ? live.filter(d => d.tags.includes('alpha')) : live; const want = reference(pool, input);
    const got = await pages(engine, input); assert.deepEqual(got, want, `${q} limit ${limit} tags ${tags ?? '-'}`); comparisons++;
    const first = await engine.query(input) as Awaited<ReturnType<SearchEngine['query']>> & { index?: { candidates: number; loaded: number; stoppedEarly?: boolean; textPrefilter?: string } }; if (first.index?.stoppedEarly) pruned++; assert.equal((first as { index?: { textPrefilter?: string } }).index?.textPrefilter, 'fs-trigram', 'the filesystem index served the candidates');
  }
  assert.ok(pruned > 0, 'the bounds must let at least some queries stop before reading every candidate');
  recordCase({ suite: 'search', name: 'topk-exact-bounds', status: 'PASS', detail: { comparisons, prunedQueries: pruned } });
});
