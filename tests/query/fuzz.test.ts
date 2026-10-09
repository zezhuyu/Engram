import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { Prng } from '../helpers/prng.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { QueryApi } from '../../packages/query/index.js';
import type { Scope } from '../../packages/core/types.js';

/** A slow, independent reference interpreter over plain arrays. It shares no code with the engine: only the documented semantics. */
interface Ref { id: string; title: string; type: string; workspace?: string; area?: string; tags: string[]; body: string; sessionId?: string; eventTime?: string; links: string[] }
type Row = Record<string, unknown>;
const present = (v: unknown) => v !== undefined && v !== null;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function refCompare(op: string, actual: unknown, expected: unknown): boolean {
  if (op === 'exists') return expected === false ? actual === undefined : actual !== undefined;
  if (op === 'isNull') return expected === false ? present(actual) : actual === null;
  if (!present(actual)) return false;
  switch (op) {
    case 'eq': return same(actual, expected);
    case 'ne': return !same(actual, expected);
    case 'in': return (expected as unknown[]).some(x => same(actual, x) || (Array.isArray(actual) && actual.some(y => same(y, x))));
    case 'contains': return typeof actual === 'string' ? actual.includes(expected as string) : Array.isArray(actual) && actual.some(y => same(y, expected));
    default: return false;
  }
}
function refEval(e: Record<string, unknown>, row: Row): boolean {
  if (e.op === 'and') return (e.args as Record<string, unknown>[]).every(a => refEval(a, row));
  if (e.op === 'or') return (e.args as Record<string, unknown>[]).some(a => refEval(a, row));
  if (e.op === 'not') return !refEval(e.arg as Record<string, unknown>, row);
  return refCompare(e.op as string, row[e.field as string], e.value);
}
const cmpStr = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function refSort(rows: Row[], keys: Array<{ field: string; dir?: string; nulls?: string }>): Row[] {
  const idx = rows.map((r, i) => ({ r, i }));
  idx.sort((x, y) => {
    for (const k of keys) {
      const a = x.r[k.field], b = y.r[k.field]; const an = !present(a), bn = !present(b);
      if (an || bn) { if (an && bn) continue; const first = k.nulls === 'first'; return an ? (first ? -1 : 1) : (first ? 1 : -1); }
      const c = typeof a === 'string' && typeof b === 'string' ? cmpStr(a, b) : JSON.stringify(a) < JSON.stringify(b) ? -1 : 1; if (c) return k.dir === 'desc' ? -c : c;
    }
    return x.i - y.i;
  });
  return idx.map(x => x.r);
}

const app: Scope = { type: 'workspace', workspaceId: 'w1' };
type Gen = { ast: Record<string, unknown>; expect: (visible: Ref[]) => unknown[]; ordered: boolean };
const FIELDS = ['type', 'workspace', 'title', 'tags', 'sessionId'];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'retrieval', 'cache', 'index', 'zeta'];

function toRow(d: Ref): Row {
  const r: Row = { id: d.id, title: d.title, type: d.type, tags: d.tags };
  if (d.workspace) r.workspace = d.workspace; if (d.sessionId) r.sessionId = d.sessionId; if (d.eventTime) r.eventTime = d.eventTime; return r;
}
function randomExpr(p: Prng, depth = 0): Record<string, unknown> {
  const roll = p.int(10);
  if (depth < 2 && roll < 3) return { and: [randomExpr(p, depth + 1), randomExpr(p, depth + 1)] };
  if (depth < 2 && roll < 5) return { or: [randomExpr(p, depth + 1), randomExpr(p, depth + 1)] };
  if (depth < 2 && roll < 6) return { not: randomExpr(p, depth + 1) };
  const field = p.pick(FIELDS);
  const op = field === 'tags' ? p.pick(['contains', 'in', 'eq', 'exists']) : p.pick(['eq', 'ne', 'in', 'exists', 'isNull', 'contains']);
  const values: Record<string, unknown[]> = { type: ['note', 'decision', 'observation', 'wiki_page'], workspace: ['w1', 'w2', 'w3'], title: ['T1', 'T7', 'T20'], tags: ['a', 'b', 'c'], sessionId: ['s1', 's2'] };
  const v = p.pick(values[field]!);
  if (op === 'exists' || op === 'isNull') return { field, op, ...(p.int(3) === 0 ? { value: false } : {}) };
  if (op === 'in') return { op, field, value: [v, p.pick(values[field]!)] };
  if (op === 'contains' && field !== 'tags' && field !== 'title') return { field: 'title', op: 'contains', value: 'T1' };
  return { field, op, value: v };
}
const norm = (e: Record<string, unknown>): Record<string, unknown> => ('and' in e || 'or' in e || 'not' in e) ? e : e; // shorthand forms are accepted by the engine; the reference evaluates the canonical form below
function canon(e: Record<string, unknown>): Record<string, unknown> {
  if ('and' in e) return { op: 'and', args: (e.and as Record<string, unknown>[]).map(canon) };
  if ('or' in e) return { op: 'or', args: (e.or as Record<string, unknown>[]).map(canon) };
  if ('not' in e) return { op: 'not', arg: canon(e.not as Record<string, unknown>) };
  return e;
}

function generate(p: Prng, visibleIds: string[]): Gen {
  const family = p.int(11);
  const filter = p.int(3) ? randomExpr(p) : undefined; const f = (rows: Row[]) => filter ? rows.filter(r => refEval(canon(filter), r)) : rows;
  const base = (rows: Ref[]) => rows.map(toRow);
  const keys = (): Array<{ field: string; dir: string; nulls: string }> => { const n = 1 + p.int(2); return [...Array.from({ length: n }, () => ({ field: p.pick(['type', 'workspace', 'title']), dir: p.pick(['asc', 'desc']), nulls: p.pick(['first', 'last']) })), { field: 'title', dir: 'asc', nulls: 'last' }]; };
  switch (family) {
    case 0: case 1: { // filter + total sort + paging
      const k = keys(); const ops: Array<Record<string, unknown>> = []; const post: Array<(r: Row[]) => Row[]> = [];
      const n = p.int(7), m = p.int(5);
      const pick = p.int(5);
      if (pick === 0) { ops.push({ op: 'head', n }); post.push(r => r.slice(0, n)); }
      if (pick === 1) { ops.push({ op: 'tail', n }); post.push(r => n === 0 ? [] : r.slice(-n)); }
      if (pick === 2) { ops.push({ op: 'offset', n: m }, { op: 'limit', n }); post.push(r => r.slice(m, m + n)); }
      if (pick === 3) { ops.push({ op: 'reverse' }); post.push(r => [...r].reverse()); }
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), orderBy: k, pipe: [...ops, { op: 'select', fields: ['title', 'type', 'workspace'] }] }, ordered: true, expect: vis => post.reduce((rows, fn) => fn(rows), refSort(f(base(vis)), k)).map(r => Object.fromEntries(['title', 'type', 'workspace'].filter(x => r[x] !== undefined).map(x => [x, r[x]]))) };
    }
    case 2: { // group + aggregates
      const by = p.pick([['type'], ['workspace'], ['type', 'workspace']]);
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), groupBy: by, aggregate: { n: { op: 'count' }, first: { op: 'min', field: 'title' }, last: { op: 'max', field: 'title' } } }, ordered: true,
        expect: vis => { const groups = new Map<string, Row[]>(); for (const r of f(base(vis))) { const key = JSON.stringify(by.map(b => r[b] ?? null)); (groups.get(key) ?? groups.set(key, []).get(key)!).push(r); }
          const out = [...groups.values()].map(rows => ({ ...Object.fromEntries(by.map(b => [b, rows[0]![b] ?? null])), n: rows.length, first: rows.map(r => r.title as string).sort(cmpStr)[0], last: rows.map(r => r.title as string).sort(cmpStr).at(-1) }));
          return refSort(out, by.map(b => ({ field: b, nulls: 'last' }))); } };
    }
    case 3: { // count / distinct / uniq
      const which = p.pick(['count', 'distinct', 'uniq']); const field = p.pick(['type', 'workspace']);
      if (which === 'count') return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), pipe: [{ op: 'count' }] }, ordered: true, expect: vis => [{ count: f(base(vis)).length }] };
      if (which === 'distinct') return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), orderBy: [{ field: 'title' }], pipe: [{ op: 'distinct', fields: [field] }, { op: 'select', fields: [field] }] }, ordered: true, expect: vis => { const seen = new Set<string>(); return refSort(f(base(vis)), [{ field: 'title' }]).filter(r => { const k = JSON.stringify(r[field] ?? null); if (seen.has(k)) return false; seen.add(k); return true; }).map(r => present(r[field]) ? { [field]: r[field] } : {}); } };
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), orderBy: [{ field }, { field: 'title' }], pipe: [{ op: 'uniq', fields: [field] }, { op: 'select', fields: [field] }] }, ordered: true, expect: vis => { let last: string | undefined; return refSort(f(base(vis)), [{ field, nulls: 'last' }, { field: 'title' }]).filter(r => { const k = JSON.stringify(r[field] ?? null); const keep = k !== last; last = k; return keep; }).map(r => present(r[field]) ? { [field]: r[field] } : {}); } };
    }
    case 4: { // search then sort
      const word = p.pick(WORDS); const mode = p.pick(['exact', 'keyword']);
      return { ast: { from: 'documents', search: { mode, text: word }, ...(filter ? { where: filter } : {}), orderBy: [{ field: 'title' }], pipe: [{ op: 'select', fields: ['title'] }] }, ordered: true,
        expect: vis => { const hit = (d: Ref) => mode === 'exact' ? `${d.title}\n${d.body}`.includes(word) : `${d.title}\n${d.body}`.toLowerCase().includes(word); return refSort(f(base(vis.filter(hit))), [{ field: 'title' }]).map(r => ({ title: r.title })); } };
    }
    case 5: { // lines: cat -> grep -> cut -> select text (multiset)
      const word = p.pick(WORDS); const lo = 1 + p.int(3), hi = lo + p.int(6); const ic = p.int(2) === 0;
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), pipe: [{ op: 'cat' }, { op: 'grep', pattern: ic ? word.toUpperCase() : word, ...(ic ? { ignoreCase: true } : {}) }, { op: 'cut', chars: [[lo, hi]] }, { op: 'select', fields: ['text'] }] }, ordered: false,
        expect: vis => f(base(vis)).flatMap(r => vis.find(d => d.id === r.id)!.body.split('\n').filter(l => l.length || false).filter(l => ic ? l.toLowerCase().includes(word) : l.includes(word)).map(l => ({ text: Array.from(l).slice(lo - 1, hi).join('') }))) };
    }
    case 6: { // sed / replace / trim on lines (multiset)
      const w = p.pick(WORDS);
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), pipe: [{ op: 'cat' }, { op: 'sed', script: `s/${w}/X/g` }, { op: 'head', n: 1000 }, { op: 'select', fields: ['text'] }] }, ordered: false,
        expect: vis => f(base(vis)).flatMap(r => vis.find(d => d.id === r.id)!.body.split('\n').filter(l => l.length).map(l => ({ text: l.split(w).join('X') }))) };
    }
    case 7: { // graph: references / backlinks by title
      const dir = p.pick(['references', 'backlinks']);
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), pipe: [{ op: dir }, { op: 'sort', fields: [{ field: 'title' }] }, { op: 'select', fields: ['title'] }] }, ordered: true,
        expect: vis => { const byTitle = new Map(vis.map(d => [d.title, d])); const start = f(base(vis)).map(r => vis.find(d => d.id === r.id)!); const out = new Map<string, Ref>();
          for (const s of start) { if (dir === 'references') for (const t of s.links) { const d = byTitle.get(t); if (d && d.id !== s.id) out.set(d.id, d); } else for (const d of vis) if (d.id !== s.id && d.links.includes(s.title)) out.set(d.id, d); }
          return refSort([...out.values()].map(toRow), [{ field: 'title' }]).map(r => ({ title: r.title })); } };
    }
    case 8: { // join (semi / anti / inner) on type
      const kind = p.pick(['semi', 'anti', 'inner']); const rf = randomExpr(p);
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), pipe: [{ op: 'select', fields: ['title', 'type'] }, { op: 'join', kind, right: { from: 'documents', where: rf, pipe: [{ op: 'select', fields: ['type', 'title'] }] }, on: { left: 'type', right: 'type' } }, { op: 'count' }] }, ordered: true,
        expect: vis => { const left = f(base(vis)), right = vis.map(toRow).filter(r => refEval(canon(rf), r)); let n = 0; for (const l of left) { const m = right.filter(r => present(l.type) && r.type === l.type).length; n += kind === 'semi' ? (m ? 1 : 0) : kind === 'anti' ? (m ? 0 : 1) : m; } return [{ count: n }]; } };
    }
    case 9: { // set operations on titles
      const op = p.pick(['union', 'unionAll', 'intersect', 'except']); const rf = randomExpr(p);
      return { ast: { from: 'documents', ...(filter ? { where: filter } : {}), pipe: [{ op: 'select', fields: ['title'] }, { op, right: { from: 'documents', where: rf, pipe: [{ op: 'select', fields: ['title'] }] } }, { op: 'sort', fields: [{ field: 'title' }] }] }, ordered: true,
        expect: vis => { const l = f(base(vis)).map(r => r.title as string), r = vis.map(toRow).filter(x => refEval(canon(rf), x)).map(x => x.title as string); const set = (a: string[]) => [...new Set(a)];
          const out = op === 'union' ? set([...l, ...r]) : op === 'unionAll' ? [...l, ...r] : op === 'intersect' ? set(l).filter(x => r.includes(x)) : set(l).filter(x => !r.includes(x)); return out.sort(cmpStr).map(title => ({ title })); } };
    }
    default: { // memory: observations with time operators
      const from = `2026-05-${String(1 + p.int(10)).padStart(2, '0')}T00:00:00Z`, to = `2026-05-${String(11 + p.int(10)).padStart(2, '0')}T00:00:00Z`; const incl = p.int(2) === 0;
      return { ast: { from: 'observations', pipe: [{ op: 'between', from, to, inclusive: incl }, { op: 'sort', fields: [{ field: 'eventTime', dir: 'desc' }, { field: 'title' }] }, { op: 'select', fields: ['title', 'eventTime'] }] }, ordered: true,
        expect: vis => refSort(vis.filter(d => d.sessionId && d.eventTime && (d.eventTime >= new Date(from).toISOString()) && (incl ? d.eventTime <= new Date(to).toISOString() : d.eventTime < new Date(to).toISOString())).map(toRow), [{ field: 'eventTime', dir: 'desc' }, { field: 'title' }]).map(r => ({ title: r.title, eventTime: r.eventTime })) };
    }
  }
  void visibleIds; void norm;
}

async function corpus(t: { after(fn: () => void | Promise<void>): void }, p: Prng, size = 34) {
  const { root, vault } = await disposableVault(t);
  for (const w of ['w1', 'w2', 'w3']) await vault.createWorkspace(w, '', {});
  const refs: Ref[] = [];
  for (let i = 0; i < size; i++) {
    const where = p.pick(['w1', 'w1', 'w2', 'w3', 'wiki']); const kind = where === 'wiki' ? 'wiki_page' : p.pick(['note', 'note', 'decision', 'observation']);
    const links = Array.from({ length: p.int(3) }, () => `T${p.int(size)}`).filter(x => x !== `T${i}`);
    const body = `${p.text(6)}\n${p.text(4)}\n${links.map(l => `[[${l}]]`).join(' ')}\n`.replace(/\n\n/g, '\n');
    const tags = ['a', 'b', 'c'].filter(() => p.int(3) === 0);
    const sessionId = kind === 'observation' ? p.pick(['s1', 's2']) : undefined; const eventTime = kind === 'observation' ? `2026-05-${String(1 + p.int(20)).padStart(2, '0')}T${String(p.int(24)).padStart(2, '0')}:00:00.000Z` : undefined;
    const scope: Scope = where === 'wiki' ? { type: 'global', area: 'wiki' } : { type: 'workspace', workspaceId: where };
    const doc = await vault.put({ scope, kind, title: `T${i}`, body, tags, ...(sessionId ? { metadata: { sessionId, eventTime } } : {}) });
    refs.push({ id: doc.id, title: `T${i}`, type: kind, ...(where === 'wiki' ? { area: 'wiki' } : { workspace: where }), tags, body: doc.body, links, ...(sessionId ? { sessionId, eventTime } : {}) });
  }
  return { root, vault, refs };
}
async function setSqlite(vault: Vault, enabled: boolean) { const c = await vault.config(); c.sqlite.enabled = enabled; await fs.writeFile(path.join(vault.root, 'mdb.yaml'), YAML.stringify(c)); }
// body as stored: lines drop only the structural trailing newline, so the reference splits the stored body exactly like the engine does
const principals = (root: string) => [
  { name: 'owner', vault: new Vault(root), visible: (_: Ref) => true },
  { name: 'agent', vault: new Vault(root, { actorId: 'agent', permissions: ['workspace:w1:read', 'global:wiki:read'] }), visible: (d: Ref) => d.workspace === 'w1' || d.area === 'wiki' },
  { name: 'stranger', vault: new Vault(root, { actorId: 'nobody', permissions: [] }), visible: (_: Ref) => false }
];

const SEEDS = Array.from({ length: Number(process.env.QUERY_FUZZ_SEEDS ?? 14) }, (_, i) => 7000 + i);
for (const seed of SEEDS) {
  test(`fuzz seed ${seed}: random ASTs equal the reference interpreter for three principals, filesystem and SQLite`, async t => {
    const p = new Prng(seed); const w = await corpus(t, p); const who = principals(w.root); let checked = 0;
    const queries = Array.from({ length: 24 }, () => generate(p, []));
    for (const sqlite of [false, true]) {
      if (sqlite) { await setSqlite(w.vault, true); await new SearchEngine(w.vault).rebuild(); }
      for (const person of who) {
        const api = new QueryApi(person.vault); const visible = w.refs.filter(person.visible);
        for (const q of queries) {
          const want = q.expect(visible); const got = (await api.run({ version: 1, ...q.ast }, { maxRows: 100_000 })).rows;
          const a = q.ordered ? got : got.map(x => JSON.stringify(x)).sort(), b = q.ordered ? want : want.map(x => JSON.stringify(x)).sort();
          assert.deepEqual(a, b, `seed ${seed} principal ${person.name} sqlite=${sqlite}\nquery ${JSON.stringify(q.ast)}`); checked++;
        }
      }
    }
    recordCase({ suite: 'query-fuzz', name: `seed-${seed}`, status: 'PASS', seed, detail: { queries: checked } });
  });
}
test('fuzz: queries racing with committed writes never mix revisions and never return an unreadable row', async t => {
  const p = new Prng(99); const w = await corpus(t, p, 20); const api = new QueryApi(w.vault); const agent = new QueryApi(new Vault(w.root, { actorId: 'agent', permissions: ['workspace:w1:read'] }));
  let stop = false; const writer = (async () => { let i = 0; while (!stop && i < 40) { const d = w.refs[p.int(w.refs.length)]!; try { const cur = await w.vault.get(d.id); await w.vault.patch({ objectId: d.id, expectedRevisionId: cur.revisionId, body: `${cur.body.split('\n')[0]}\nrev-marker-${i}\n` }); } catch { /* conflicts are fine */ } i++; } })();
  for (let i = 0; i < 25; i++) {
    const r = await api.run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'select', fields: ['documentId', 'revision', 'text'] }] }, { maxRows: 100_000 });
    const byDoc = new Map<string, Set<string>>(); for (const row of r.rows as Array<{ documentId: string; revision: string }>) (byDoc.get(row.documentId) ?? byDoc.set(row.documentId, new Set()).get(row.documentId)!).add(row.revision);
    for (const [doc, revs] of byDoc) assert.equal(revs.size, 1, `document ${doc} mixed revisions inside one query`);
    const a = await agent.run({ version: 1, from: 'documents' }); assert.ok((a.rows as Array<{ workspace?: string }>).every(x => x.workspace === 'w1'));
  }
  stop = true; await writer;
  recordCase({ suite: 'query-fuzz', name: 'concurrent-writers', status: 'PASS' });
});
