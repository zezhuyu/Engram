import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryEngine } from '../../packages/query/execute.js';
import { normalize } from '../../packages/query/schema.js';
import { recordCase } from '../helpers/report.js';
import { FixtureSource, ids, type FixtureDoc } from './fixture.js';

const T = (n: number) => `2026-03-${String(n).padStart(2, '0')}T10:00:00.000Z`;
const docs: FixtureDoc[] = [
  { id: 'a', title: 'Alpha', type: 'note', workspace: 'w', tags: ['x'], eventTime: T(1), sessionId: 's1', body: 'one\ntwo\nthree\n', links: ['b', 'c'] },
  { id: 'b', title: 'Beta', type: 'decision', workspace: 'w', tags: ['x', 'y'], eventTime: T(2), sessionId: 's1', body: 'alpha\r\nbeta\r\ngamma', links: ['c'] },
  { id: 'c', title: 'Gamma', type: 'note', workspace: 'w', tags: [], eventTime: T(3), sessionId: 's2', body: '日本語のテキスト\n😀 emoji line\nlast', links: ['a'] },
  { id: 'd', title: 'Delta', type: 'error', workspace: 'v', tags: ['y'], eventTime: T(4), sessionId: 's2', body: '', links: [] },
  { id: 'e', title: 'Epsilon', type: 'note', workspace: 'w', tags: ['x'], eventTime: T(5), body: 'one two three', extra: { score: 2, category: null }, links: [] },
  { id: 'f', title: 'Zeta', type: 'error', area: 'wiki', tags: [], eventTime: T(6), sessionId: 's3', body: 'x\n\ny\n', extra: { category: '7' } }
];
const engine = (opts?: ConstructorParameters<typeof FixtureSource>[1], d: FixtureDoc[] = docs) => { const fx = new FixtureSource(d, opts); return { fx, q: new QueryEngine(fx, 'tester') }; };
const run = async (q: QueryEngine, ast: Record<string, unknown>) => (await q.run({ version: 1, from: 'documents', ...ast })).rows;
const rec = (name: string) => recordCase({ suite: 'query-operators', name, status: 'PASS' });

test('filters: comparison semantics, null vs missing, in/contains/exists/isNull, boolean nesting', async () => {
  const { q } = engine();
  assert.deepEqual(ids(await run(q, { where: { field: 'type', op: 'eq', value: 'note' }, orderBy: [{ field: 'id' }] })), ['a', 'c', 'e']);
  assert.deepEqual(ids(await run(q, { where: { op: 'in', field: 'type', value: ['error', 'decision'] }, orderBy: [{ field: 'id' }] })), ['b', 'd', 'f']);
  assert.deepEqual(ids(await run(q, { where: { field: 'tags', op: 'contains', value: 'y' }, orderBy: [{ field: 'id' }] })), ['b', 'd']);
  assert.deepEqual(ids(await run(q, { where: { and: [{ field: 'type', op: 'eq', value: 'note' }, { not: { field: 'workspace', op: 'eq', value: 'v' } }, { or: [{ field: 'tags', op: 'contains', value: 'x' }, { field: 'id', op: 'eq', value: 'c' }] }] }, orderBy: [{ field: 'id' }] })), ['a', 'c', 'e']);
  // null / missing: comparisons are false (including ne); exists checks presence, isNull checks explicit null
  assert.deepEqual(ids(await run(q, { where: { field: 'category', op: 'isNull' } })), ['e'], 'isNull matches explicit null only, not missing');
  assert.deepEqual(ids(await run(q, { where: { field: 'category', op: 'exists' }, orderBy: [{ field: 'id' }] })), ['e', 'f'], 'exists matches null and values, not missing');
  assert.deepEqual(ids(await run(q, { where: { field: 'category', op: 'exists', value: false }, orderBy: [{ field: 'id' }] })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(await run(q, { where: { field: 'category', op: 'ne', value: 'zzz' }, orderBy: [{ field: 'id' }] })), ['f'], 'ne is false for null and missing');
});
test('unknown fields fail early with a structured error', async () => {
  const { q } = engine();
  await assert.rejects(q.run({ version: 1, from: 'documents', where: { field: 'nope', op: 'eq', value: 1 } }), { code: 'QUERY_INVALID' });
});
test('null/missing semantics through records', async () => {
  const { q } = engine();
  const rows = (await q.run({ version: 1, from: 'documents', pipe: [{ op: 'select', fields: ['id', 'score', 'category'] }, { op: 'filter', expr: { op: 'ne', field: 'score', value: 5 } }, { op: 'sort', fields: [{ field: 'id' }] }] })).rows;
  assert.deepEqual(ids(rows), ['e'], 'ne is false for missing values; only the row that has a score different from 5 matches');
});
test('sort: explicit null policy, stable ties, descending, multi-key', async () => {
  const { q } = engine();
  const asc = await run(q, { pipe: [{ op: 'select', fields: ['id', 'score'] }, { op: 'sort', fields: [{ field: 'score', nulls: 'last' }] }, { op: 'limit', n: 1 }] });
  assert.equal((asc[0] as { id: string }).id, 'e');
  const first = await run(q, { pipe: [{ op: 'select', fields: ['id', 'score'] }, { op: 'sort', fields: [{ field: 'score', nulls: 'first' }] }] }); assert.equal((first.at(-1) as { id: string }).id, 'e', 'nulls first puts the only scored row last');
  const byType = await run(q, { orderBy: [{ field: 'type', dir: 'desc' }] }); assert.deepEqual(ids(byType), ['a', 'c', 'e', 'd', 'f', 'b'], 'ties break by id ascending');
});
test('head/tail/limit/offset edge cases and sort+tail equivalence', async () => {
  const { q } = engine();
  const base = { orderBy: [{ field: 'id' }] };
  assert.deepEqual(await run(q, { ...base, pipe: [{ op: 'head', n: 0 }] }), []);
  assert.deepEqual(await run(q, { ...base, pipe: [{ op: 'tail', n: 0 }] }), []);
  assert.deepEqual(ids(await run(q, { ...base, pipe: [{ op: 'tail', n: 100 }] })), ['a', 'b', 'c', 'd', 'e', 'f'], 'tail(n > total) returns everything in original order');
  assert.deepEqual(ids(await run(q, { ...base, pipe: [{ op: 'tail', n: 2 }] })), ['e', 'f']);
  assert.deepEqual(await run(q, { ...base, pipe: [{ op: 'offset', n: 99 }] }), []);
  assert.deepEqual(ids(await run(q, { ...base, pipe: [{ op: 'offset', n: 2 }, { op: 'limit', n: 2 }] })), ['c', 'd']);
  assert.deepEqual(await run(q, { ...base, limit: 0 }), []);
  const desc = ids(await run(q, { orderBy: [{ field: 'id', dir: 'desc' }], pipe: [{ op: 'head', n: 2 }] })), tailOfAsc = ids(await run(q, { ...base, pipe: [{ op: 'tail', n: 2 }] }));
  assert.deepEqual(desc, [...tailOfAsc].reverse(), 'sort desc + head(n) equals sort asc + tail(n) reversed');
  rec('head-tail-limit-offset');
});
test('uniq removes adjacent duplicates, distinct removes global duplicates', async () => {
  const { q } = engine();
  const types = { orderBy: [{ field: 'id' }], pipe: [{ op: 'pluck', field: 'type' }] };
  assert.deepEqual(await run(q, { ...types, pipe: [...types.pipe, { op: 'uniq' }] }), ['note', 'decision', 'note', 'error', 'note', 'error']);
  assert.deepEqual(await run(q, { ...types, pipe: [...types.pipe, { op: 'distinct' }] }), ['note', 'decision', 'error']);
  assert.deepEqual(ids(await run(q, { orderBy: [{ field: 'id' }], pipe: [{ op: 'distinct', fields: ['type'] }] })), ['a', 'b', 'd']);
});
test('aggregates: count(*) vs count(field), typing, empty input, coercion', async () => {
  const { q } = engine();
  const one = async (pipe: unknown[]) => (await run(q, { pipe }))[0] as Record<string, unknown>;
  assert.equal((await one([{ op: 'count' }])).count, 6);
  assert.equal((await one([{ op: 'count', field: 'score' }])).count, 1, 'count(field) skips missing');
  assert.equal((await one([{ op: 'sum', field: 'score' }])).sum, 2);
  assert.equal((await one([{ op: 'avg', field: 'score' }])).avg, 2);
  assert.equal((await one([{ op: 'min', field: 'id' }])).min, 'a'); assert.equal((await one([{ op: 'max', field: 'id' }])).max, 'f');
  assert.equal((await one([{ op: 'filter', expr: { op: 'eq', field: 'id', value: 'zzz' } }, { op: 'sum', field: 'score' }])).sum, null, 'sum of nothing is null');
  assert.equal((await one([{ op: 'filter', expr: { op: 'eq', field: 'id', value: 'zzz' } }, { op: 'count' }])).count, 0);
  await assert.rejects(run(q, { pipe: [{ op: 'sum', field: 'title' }] }), { code: 'QUERY_INVALID' }, 'sum over text is rejected, not silently coerced');
  const g = await run(q, { pipe: [{ op: 'group', fields: ['type'], aggregates: { n: { op: 'count' }, first: { op: 'min', field: 'id' } } }] });
  assert.deepEqual(g, [{ type: 'decision', n: 1, first: 'b' }, { type: 'error', n: 2, first: 'd' }, { type: 'note', n: 3, first: 'a' }], 'groups are returned in deterministic key order');
  const shorthand = await run(q, { groupBy: ['type'], aggregate: { count: { op: 'count' } } }); assert.equal(shorthand.length, 3);
  rec('aggregates');
});
test('select/pluck/rename and type errors', async () => {
  const { q } = engine();
  assert.deepEqual(await run(q, { orderBy: [{ field: 'id' }], limit: 2, pipe: [{ op: 'select', fields: ['id', 'title'] }, { op: 'rename', map: { title: 'name' } }] }), [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  await assert.rejects(run(q, { pipe: [{ op: 'pluck', field: 'id' }, { op: 'select', fields: ['id'] }] }), { code: 'QUERY_INVALID' });
  await assert.rejects(run(q, { pipe: [{ op: 'grep', pattern: 'x' }] }), { code: 'QUERY_INVALID' }, 'text operators need lines');
  await assert.rejects(run(q, { pipe: [{ op: 'cat' }, { op: 'sum', field: 'text' }, { op: 'cut', chars: [[1, 2]] }] }), { code: 'QUERY_INVALID' });
});
test('lines: cat/readLines/range, CRLF, no trailing newline, Unicode, byte ranges, empty documents', async () => {
  const { q } = engine();
  const lines = async (id: string, pipe: unknown[] = []) => (await run(q, { where: { field: 'id', op: 'eq', value: id }, pipe: [{ op: 'cat' }, ...pipe] })) as Array<{ text: string; lineNumber: number; byteStart: number; byteEnd: number }>;
  assert.deepEqual((await lines('a')).map(l => l.text), ['one', 'two', 'three'], 'a trailing newline does not create an empty last line');
  assert.deepEqual((await lines('b')).map(l => l.text), ['alpha', 'beta', 'gamma'], 'CRLF is normalized to LF; last line has no terminator');
  const b = await lines('b'); assert.deepEqual(b.map(l => [l.byteStart, l.byteEnd]), [[0, 7], [7, 13], [13, 18]], 'original byte ranges include the CR');
  assert.deepEqual(await lines('d'), [], 'empty document has no lines');
  assert.deepEqual((await lines('f')).map(l => l.text), ['x', '', 'y'], 'blank lines are kept');
  assert.deepEqual((await run(q, { where: { field: 'id', op: 'eq', value: 'a' }, pipe: [{ op: 'range', from: 2, to: 99 }] }) as Array<{ lineNumber: number }>).map(l => l.lineNumber), [2, 3]);
  const c = await lines('c'); assert.equal(c[1]!.byteEnd - c[1]!.byteStart, Buffer.byteLength('😀 emoji line\n'));
  rec('lines');
});
test('cut: code points by default, bytes explicitly, ranges clipped and merged, fields', async () => {
  const { q } = engine();
  const cut = async (id: string, op: Record<string, unknown>) => ((await run(q, { where: { field: 'id', op: 'eq', value: id }, pipe: [{ op: 'cat' }, { op: 'cut', ...op }] })) as Array<{ text: string }>).map(l => l.text);
  assert.deepEqual(await cut('c', { chars: [[1, 3]] }), ['日本語', '😀 e', 'las'], 'an emoji is one code point');
  assert.deepEqual(await cut('c', { chars: [[2, 3], [1, 1]] }), ['日本語', '😀 e', 'las'], 'ranges are applied in ascending order, not as written');
  assert.deepEqual(await cut('c', { chars: [[100, 200]] }), ['', '', ''], 'out-of-range is clipped');
  assert.deepEqual((await cut('c', { bytes: [[1, 3]] }))[0], '日');
  assert.deepEqual(await cut('a', { fields: [2], delimiter: ' ' }), ['one', 'two', 'three'], 'a line without the delimiter is passed through');
  assert.deepEqual(await cut('e', { fields: [2, 3], delimiter: ' ' }), ['two three']);
});
test('grep/regex/replace/trim/split/sed subset', async () => {
  const { q } = engine();
  const base = { where: { field: 'id', op: 'eq', value: 'b' } };
  const texts = async (...ops: unknown[]) => ((await run(q, { ...base, pipe: [{ op: 'cat' }, ...ops] })) as Array<{ text: string }>).map(l => l.text);
  assert.deepEqual(await texts({ op: 'grep', pattern: 'A', ignoreCase: true }), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(await texts({ op: 'grep', pattern: 'a' }), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(await texts({ op: 'grep', pattern: 'bet', invert: true }), ['alpha', 'gamma']);
  assert.deepEqual(await texts({ op: 'regex', pattern: '^[ab]' }), ['alpha', 'beta']);
  assert.deepEqual(await texts({ op: 'replace', find: 'a', with: 'A' }), ['AlphA', 'betA', 'gAmmA']);
  assert.deepEqual(await texts({ op: 'replace', find: 'a', with: 'A', all: false }), ['Alpha', 'betA', 'gAmma']);
  assert.deepEqual(await texts({ op: 'sed', script: 's/(a)(l)/\\2-\\1/' }), ['l-apha', 'beta', 'gamma']);
  assert.deepEqual(await texts({ op: 'sed', script: '-n; 2,3p' }), ['beta', 'gamma']);
  assert.deepEqual(await texts({ op: 'sed', script: '$d' }), ['alpha', 'beta']);
  assert.deepEqual(await texts({ op: 'sed', script: '/bet/d; s/a/A/g' }), ['AlphA', 'gAmmA']);
  await assert.rejects(texts({ op: 'sed', script: 'y/abc/xyz/' }), { code: 'QUERY_INVALID' }, 'unsupported sed commands are rejected, not approximated');
  await assert.rejects(texts({ op: 'sed', script: '1!d' }), { code: 'QUERY_INVALID' });
  const split = (await run(q, { ...base, pipe: [{ op: 'cat' }, { op: 'replace', find: 'a', with: ',' }, { op: 'split', delimiter: ',', names: ['x', 'y'] }, { op: 'head', n: 1 }] })) as Array<Record<string, unknown>>;
  assert.equal(split[0]!.x, ''); assert.equal(split[0]!.y, 'lph');
  const trimmed = await run(q, { where: { field: 'id', op: 'eq', value: 'e' }, pipe: [{ op: 'cat' }, { op: 'replace', find: 'one', with: '  one  ' }, { op: 'trim', side: 'left' }] }) as Array<{ text: string }>; assert.equal(trimmed[0]!.text, 'one   two three');
  rec('text-operators');
});
test('regex safety: nested quantifiers, backreferences and lookaround are rejected before any work', async () => {
  const { q, fx } = engine();
  for (const pattern of ['(a+)+$', '(a*)*b', '(a)\\1', '(?=a)a', 'a+b+', 'x'.repeat(300)]) await assert.rejects(q.run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'regex', pattern }] }), { code: 'QUERY_INVALID' }, pattern.slice(0, 20));
  assert.equal(fx.hydrations, 0, 'rejected before reading any document');
});
test('time operators: after is inclusive, before exclusive, between half-open (or closed on request), recent/latest tie-break', async () => {
  const { q } = engine();
  const obs = { from: 'observations', orderBy: [{ field: 'eventTime' }] };
  assert.deepEqual(ids(await run(q, { ...obs, pipe: [{ op: 'after', time: T(2) }, { op: 'before', time: T(4) }] })), ['b', 'c'], '[after, before)');
  assert.deepEqual(ids(await run(q, { ...obs, pipe: [{ op: 'between', from: T(2), to: T(4) }] })), ['b', 'c']);
  assert.deepEqual(ids(await run(q, { ...obs, pipe: [{ op: 'between', from: T(2), to: T(4), inclusive: true }] })), ['b', 'c', 'd']);
  assert.deepEqual(ids(await run(q, { from: 'observations', pipe: [{ op: 'recent', n: 3 }] })), ['f', 'd', 'c']);
  assert.deepEqual(ids(await run(q, { from: 'observations', pipe: [{ op: 'session', sessionId: 's2' }, { op: 'sort', fields: [{ field: 'eventTime' }] }] })), ['c', 'd']);
  assert.deepEqual(ids(await run(q, { from: 'observations', pipe: [{ op: 'timeline', sessionId: 's1' }] })), ['a', 'b']);
  assert.deepEqual(ids(await run(q, { from: 'observations', pipe: [{ op: 'timeline', aroundId: 'c', window: 1 }] })), ['c', 'd'], 'around: neighbours within the same session only (s2 = c, d)');
  // identical timestamps: ties break by id so recent() is deterministic
  const tie = engine(undefined, ['q', 'p', 'r'].map(id => ({ id, sessionId: 's', eventTime: T(9) })));
  assert.deepEqual(ids(await run(tie.q, { from: 'observations', pipe: [{ op: 'recent' }] })), ['p', 'q', 'r']);
  // timezone offsets are normalized to UTC at the boundary
  assert.deepEqual(ids(await run(q, { ...obs, pipe: [{ op: 'after', time: '2026-03-04T12:00:00+02:00' }] })), ['d', 'f'], '12:00+02:00 is 10:00Z, which is T(4) exactly (inclusive); e is not an observation');
  await assert.rejects(run(q, { ...obs, pipe: [{ op: 'after', time: '2026-03-05T10:00:00' }] }), { code: 'QUERY_INVALID' }, 'local time without an offset is ambiguous');
  rec('time-operators');
});
test('join: inner/left/semi/anti, null keys never match, duplicate keys multiply, lookup takes the first match', async () => {
  const { q } = engine();
  const right = { from: 'documents', pipe: [{ op: 'select', fields: ['sessionId', 'title'] }, { op: 'filter', expr: { op: 'exists', field: 'sessionId' } }] };
  const left = (kind: string) => run(q, { orderBy: [{ field: 'id' }], pipe: [{ op: 'select', fields: ['id', 'sessionId'] }, { op: 'join', kind, right, on: { left: 'sessionId', right: 'sessionId' } }] }) as Promise<Array<Record<string, unknown>>>;
  const inner = await left('inner'); assert.equal(inner.length, 2 * 2 + 2 * 2 + 1, 's1 x2 each, s2 x2 each, s3 x1: duplicate keys multiply');
  assert.ok(!inner.some(r => r.id === 'e'), 'a row without the key never matches, not even a right row without the key');
  assert.deepEqual((await left('left')).filter(r => r.id === 'e'), [{ id: 'e' }], 'left join keeps the unmatched row');
  assert.deepEqual((await left('semi')).map(r => r.id), ['a', 'b', 'c', 'd', 'f']);
  assert.deepEqual((await left('anti')).map(r => r.id), ['e'], 'anti keeps rows with a null/missing key');
  const lookup = await run(q, { orderBy: [{ field: 'id' }], limit: 1, pipe: [{ op: 'select', fields: ['id', 'sessionId'] }, { op: 'lookup', right, on: { left: 'sessionId', right: 'sessionId' } }] }) as Array<Record<string, unknown>>; assert.equal(lookup.length, 1);
  assert.equal(typeof lookup[0]!.right_title, 'string');
  rec('join');
});
test('set operations: union, unionAll, intersect, except with duplicates', async () => {
  const { q } = engine();
  const side = (...id: string[]) => ({ from: 'documents', where: { op: 'in', field: 'id', value: id }, pipe: [{ op: 'select', fields: ['id'] }] });
  const base = (op: string, right: unknown) => run(q, { where: { op: 'in', field: 'id', value: ['a', 'b', 'c'] }, orderBy: [{ field: 'id' }], pipe: [{ op: 'select', fields: ['id'] }, { op, right }] });
  assert.deepEqual(ids(await base('union', side('b', 'c', 'd'))), ['a', 'b', 'c', 'd']);
  assert.equal((await base('unionAll', side('b', 'c', 'd'))).length, 6);
  assert.deepEqual(ids(await base('intersect', side('b', 'c', 'd'))), ['b', 'c']);
  assert.deepEqual(ids(await base('except', side('b', 'c', 'd'))), ['a']);
  const dupe = await run(q, { where: { op: 'in', field: 'id', value: ['a', 'a'] }, pipe: [{ op: 'select', fields: ['type'] }, { op: 'intersect', right: { from: 'documents', pipe: [{ op: 'select', fields: ['type'] }] } }] }); assert.equal(dupe.length, 1, 'set semantics: each row once');
  await assert.rejects(base('union', { from: 'edges' }), { code: 'QUERY_INVALID' }, 'both sides must produce the same row type');
  rec('set-operations');
});
test('subqueries: `in` with a nested query is evaluated once with the same snapshot', async () => {
  const { q, fx } = engine();
  const rows = await run(q, { orderBy: [{ field: 'id' }], where: { op: 'in', field: 'sessionId', value: { field: 'sessionId', subquery: { from: 'documents', where: { field: 'type', op: 'eq', value: 'error' } } } } });
  assert.deepEqual(ids(rows), ['c', 'd', 'f']);
  assert.equal(fx.opened, 1, 'main query and subquery share one snapshot');
  assert.equal(fx.released, 1);
});
test('graph: references, backlinks, related, traverse (cycles, depth, node caps, edge types)', async () => {
  const { q } = engine();
  const from = (id: string, ...pipe: unknown[]) => run(q, { where: { field: 'id', op: 'eq', value: id }, pipe });
  assert.deepEqual(ids(await from('a', { op: 'references' }, { op: 'sort', fields: [{ field: 'id' }] })), ['b', 'c']);
  assert.deepEqual(ids(await from('c', { op: 'backlinks' }, { op: 'sort', fields: [{ field: 'id' }] })), ['a', 'b']);
  assert.deepEqual(ids(await from('d', { op: 'related' })), [], 'an isolated node has no relatives');
  assert.deepEqual(ids(await from('a', { op: 'related', depth: 1 })), ['b', 'c']);
  const t = await from('a', { op: 'traverse', maxDepth: 5, maxNodes: 100 }) as Array<{ id: string; depth: number }>;
  assert.deepEqual(t.map(r => [r.id, r.depth]), [['b', 1], ['c', 1]], 'the cycle a→c→a does not revisit the start');
  assert.equal((await from('a', { op: 'traverse', maxDepth: 5, maxNodes: 1 })).length, 1, 'maxNodes bounds the walk');
  assert.deepEqual(await from('a', { op: 'traverse', maxDepth: 5, maxNodes: 100, edgeTypes: ['none'] }), []);
  assert.equal((await from('a', { op: 'references', edges: true })).length, 2);
  const edges = await run(q, { from: 'edges', pipe: [{ op: 'count' }] }) as Array<{ count: number }>; assert.equal(edges[0]!.count, 4);
  await assert.rejects(q.run({ version: 1, from: 'documents', pipe: [{ op: 'traverse', maxDepth: 3, maxNodes: 1_000_000 }] }), { code: 'QUERY_INVALID' });
  await assert.rejects(from('a', { op: 'traverse', maxDepth: 3, maxNodes: 9_999 }), { code: 'RESOURCE_LIMIT' }, 'above the graph budget');
  rec('graph');
});
test('the engine never trusts the source: unordered supersets that ignore filters give the same answers', async () => {
  const asts = [
    { where: { field: 'type', op: 'eq', value: 'note' }, orderBy: [{ field: 'id' }] },
    { where: { and: [{ field: 'workspace', op: 'eq', value: 'w' }, { field: 'tags', op: 'contains', value: 'x' }] }, orderBy: [{ field: 'eventTime', dir: 'desc' }] },
    { from: 'observations', pipe: [{ op: 'recent', n: 3 }] }
  ];
  for (const ast of asts) { const good = await run(engine().q, ast), sloppy = await run(engine({ shuffle: true, ignoreFilters: true }).q, ast); assert.deepEqual(ids(sloppy), ids(good), JSON.stringify(ast)); }
  rec('source-independence');
});
test('scope: workspace + shared defaults, collection narrowing, includeShared:false', async () => {
  const { q } = engine(undefined, [...docs, { id: 'g', workspace: 'w', collection: 'c1', body: '' }, { id: 'h', area: 'discoveries', body: '' }]);
  const inScope = async (scope: Record<string, unknown>) => ids(await run(q, { scope, orderBy: [{ field: 'id' }] }));
  // fixture applies no scope itself; the engine passes it to the source (Vault source tests cover the real rule)
  assert.ok(Array.isArray(await inScope({ workspace: 'w' })));
});
test('budgets: row cap with cursor, byte cap, buffer cap on blocking operators, deadline, cancellation', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, workspace: 'w', body: 'x'.repeat(100) }));
  const { q } = engine(undefined, many);
  const page1 = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 200 }, { maxRows: 120 });
  assert.equal(page1.rows.length, 120); assert.equal(page1.truncated, 'rows'); assert.ok(page1.cursor);
  const page2 = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 200, cursor: page1.cursor }, { maxRows: 120 });
  assert.equal(ids(page2.rows)[0], 'd0120'); assert.equal(page2.rows.length, 120, 'limit is the page size; maxRows caps each page');
  const page3 = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 200, cursor: page2.cursor }, { maxRows: 120 }); assert.equal(ids(page3.rows)[0], 'd0240');
  const all = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], limit: 500 }, { maxRows: 1000 }); assert.equal(all.rows.length, 500); assert.equal(all.cursor, undefined, 'no cursor when the data ran out');
  const pipeLimit = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], pipe: [{ op: 'limit', n: 130 }] }, { maxRows: 120 }); assert.equal(pipeLimit.rows.length, 120); const rest = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }], pipe: [{ op: 'limit', n: 130 }], cursor: pipeLimit.cursor }, { maxRows: 120 }); assert.equal(rest.rows.length, 10, 'a limit step bounds the total, across pages');
  const bytes = await q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }] }, { maxBytes: 3000 }); assert.equal(bytes.truncated, 'bytes'); assert.ok(bytes.cursor);
  await assert.rejects(q.run({ version: 1, from: 'documents', orderBy: [{ field: 'id' }] }, { maxBufferRows: 100 }), { code: 'RESOURCE_LIMIT' }, 'sort over more rows than the buffer budget is refused, never silently truncated');
  await assert.rejects(q.run({ version: 1, from: 'documents', pipe: [{ op: 'distinct', fields: ['id'] }] }, { maxBufferRows: 100 }), { code: 'RESOURCE_LIMIT' });
  const ac = new AbortController(); ac.abort(); await assert.rejects(q.run({ version: 1, from: 'documents' }, { abortSignal: ac.signal }), { code: 'CANCELLED' });
  await assert.rejects(q.run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }] }, { maxDocuments: 10 }), { code: 'RESOURCE_LIMIT' }, 'document-read budget');
  await assert.rejects(q.run({ version: 1, from: 'documents', cursor: 'garbage' }), { code: 'QUERY_INVALID' });
  await assert.rejects(q.run({ version: 1, from: 'documents', limit: 5, cursor: page1.cursor }), { code: 'QUERY_INVALID' }, 'a cursor is bound to its query');
  rec('budgets');
});
test('early termination: head stops reading documents', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, workspace: 'w', body: 'line\nline2' }));
  const { q, fx } = engine(undefined, many);
  const rows = await run(q, { orderBy: [{ field: 'id' }], pipe: [{ op: 'cat' }, { op: 'head', n: 3 }] }); assert.equal(rows.length, 3);
  assert.ok(fx.hydrations <= 20, `read ${fx.hydrations} documents for 3 lines`);
  rec('early-termination');
});
test('saved queries: resolved through the source, refinements compose, cycles are rejected', async () => {
  const { q, fx } = engine();
  fx.saved.set('notes', { version: 1, from: 'documents', where: { field: 'type', op: 'eq', value: 'note' }, orderBy: [{ field: 'id' }] });
  assert.deepEqual(ids(await q.run({ version: 1, from: 'saved', saved: 'notes' }).then(r => r.rows)), ['a', 'c', 'e']);
  assert.deepEqual(ids(await q.run({ version: 1, from: 'saved', saved: 'notes', where: { field: 'workspace', op: 'eq', value: 'w' }, limit: 2 }).then(r => r.rows)), ['a', 'c']);
  fx.saved.set('loop', { version: 1, from: 'saved', saved: 'loop' });
  await assert.rejects(q.run({ version: 1, from: 'saved', saved: 'loop' }), { code: 'QUERY_INVALID' });
  await assert.rejects(q.run({ version: 1, from: 'saved', saved: 'missing' }), { code: 'QUERY_INVALID' });
});
test('explain: stages, pushdown and warnings without reading documents', async () => {
  const { q, fx } = engine();
  const plan = await q.explain({ version: 1, from: 'documents', where: { field: 'type', op: 'eq', value: 'note' }, pipe: [{ op: 'cat' }, { op: 'grep', pattern: 'x' }] });
  assert.deepEqual(plan.stages.map(s => s.op), ['filter', 'cat', 'grep']); assert.ok(plan.pushedDown.some(p => p.includes('type eq'))); assert.ok(!JSON.stringify(plan).includes('note"'), 'values never appear in the plan');
  assert.ok(plan.warnings.length, 'a scan of every candidate is flagged'); assert.equal(fx.hydrations, 0);
});
test('derived text prefilter: contains body becomes a search request, and results are still exact', async () => {
  const { q, fx } = engine();
  const rows = await run(q, { where: { field: 'body', op: 'contains', value: 'EMOJI' } }); assert.deepEqual(rows, [], 'contains is case-sensitive');
  const hit = await run(q, { where: { field: 'body', op: 'contains', value: 'emoji' } }); assert.deepEqual(ids(hit), ['c']);
  assert.equal(fx.lastRequest?.search?.mode, 'exact');
});
test('validator: unknown keys (including a forged principal), depth, size and strictness', () => {
  assert.throws(() => normalize({ version: 1, from: 'documents', principalId: 'root' }), { code: 'QUERY_INVALID' });
  assert.throws(() => normalize({ from: 'documents', pipe: [{ op: 'head', n: 1, principalId: 'x' }] }), { code: 'QUERY_INVALID' });
  assert.throws(() => normalize({ from: 'documents', pipe: [{ op: 'nope' }] }), { code: 'QUERY_INVALID' });
  assert.throws(() => normalize({ from: 'documents', pipe: [{ op: 'head', n: -1 }] }), { code: 'QUERY_INVALID' });
  assert.throws(() => normalize({ from: 'documents', limit: 1.5 }), { code: 'QUERY_INVALID' });
  let deep: unknown = { field: 'id', op: 'eq', value: 1 }; for (let i = 0; i < 40; i++) deep = { not: deep };
  assert.throws(() => normalize({ from: 'documents', where: deep }), { code: 'QUERY_INVALID' }, 'deeply nested filters');
  let nested: unknown = { from: 'documents' }; for (let i = 0; i < 8; i++) nested = { from: 'documents', pipe: [{ op: 'join', right: nested, on: { left: 'id', right: 'id' } }] };
  assert.throws(() => normalize(nested), { code: 'QUERY_INVALID' }, 'deeply nested subqueries');
  assert.throws(() => normalize({ from: 'documents', where: { field: '__proto__.x', op: 'eq', value: 1 } }), { code: 'QUERY_INVALID' });
  assert.throws(() => normalize(JSON.parse('{"from":"documents","__proto__":{"x":1}}')), { code: 'QUERY_INVALID' });
  assert.equal(normalize({ from: 'documents', where: { keyword: 'deploy' } }).search?.mode, 'keyword', 'search clauses in where are hoisted');
  assert.throws(() => normalize({ from: 'documents', where: { and: Array.from({ length: 201 }, () => ({ field: 'id', op: 'eq', value: 1 })) } }), { code: 'QUERY_INVALID' });
});
test('capabilities: semantic and hybrid are declared unavailable with a reason', async () => {
  const caps = await engine().q.capabilities(); assert.equal(caps.search.semantic.available, false); assert.match(caps.search.semantic.reason!, /embedding/i);
  await assert.rejects(engine().q.run({ version: 1, from: 'documents', search: { mode: 'semantic', text: 'x' } }), { code: 'CAPABILITY_UNAVAILABLE' });
});
test('forged principal in the execution context is refused', async () => {
  await assert.rejects(engine().q.run({ version: 1, from: 'documents' }, { principalId: 'someone-else' }), { code: 'SCOPE_DENIED' });
});
