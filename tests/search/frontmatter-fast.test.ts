import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { parseFrontmatterFast } from '../../packages/core/frontmatter-fast.js';
import { parseDocument, serializeDocument } from '../../packages/core/vault.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

/** Reference result of the full parser, or 'throws'. */
const reference = (text: string): unknown => { try { return YAML.parse(text); } catch { return 'throws'; } };
/** The fast parser must either decline or return exactly (including key order) what the full parser returns. */
function check(text: string): 'fast' | 'declined' {
  const fast = parseFrontmatterFast(text); if (fast === undefined) return 'declined';
  const want = reference(text);
  assert.notEqual(want, 'throws', `fast path accepted text the full parser rejects:\n${text}`);
  assert.deepEqual(fast, want, `value differs for:\n${text}`); assert.equal(JSON.stringify(fast), JSON.stringify(want), `key order or types differ for:\n${text}`);
  return 'fast';
}

test('front matter fast path: the exact shape the writer produces is parsed and equals the YAML parser', () => {
  const text = 'schema_version: 1\nid: obj_x\nrevision_id: rev_x\nrevision_number: 2\nscope: workspace\nworkspace_id: w\nkind: note\ntitle: Plain title\ntags:\n  - a\n  - b c\nrelations: []\nprovenance:\n  evidence: []\nstatus: active\ncreated_at: 2020-01-01T17:51:12.000Z\nmetadata: {}\nflag: true\nnothing: null\nnested:\n  deep:\n    count: 3\n    list:\n      - 1\n      - two\npath: p/q.md\nuri: mdb://x';
  assert.equal(check(text), 'fast');
  for (const t of ['a:\n  - k: v', 'a:\n  - type: references\n    target: mdb://x/y\n  - type: related_to\n    target: z\nb: 1', 'a:\n  - quote: q\n    nested:\n      x: 1\n      ys:\n        - p\n        - q\n    z: null', 'a:\n  - k:\n      v: 1', 'p:\n  evidence:\n    - quote: q\n      source: s']) assert.equal(check(t), 'fast', t);
  for (const t of ['a:\n  - k: v\n   w: 1', 'a:\n  - k: v\n      w: 1', 'a:\n  - k: v\n  w: 1', 'a:\n  - k: v\n  - - x', 'a:\n  - yes: v', 'a:\n  - k: "q"', 'a:\n  - k: 1\n    k: 2', 'a:\n  - : v']) { check(t); assert.equal(parseFrontmatterFast(t) === undefined || reference(t) !== 'throws', true, t); }
});

test('front matter fast path: everything outside the safe subset is declined, never guessed', () => {
  const declined = [
    'a: "quoted"', "a: 'single'", 'a: |\n  block', 'a: >\n  folded', 'a: &x 1\nb: *x', 'a: !!str 1', 'a: !!js/function "function(){}"', '# comment\na: 1', 'a: 1 # trailing', 'a: [1, 2]', 'a: {b: 1}', 'a: x\n\nb: y',
    'a:\tx', 'a: x\r\nb: y', 'a: 1\na: 2', 'a: yes', 'a: No', 'a: on', 'a: ~', 'a: True', 'a: NULL', 'a: 1.5', 'a: 1e3', 'a: 0x1f', 'a: 0o7', 'a: 012', 'a: -1', 'a: +1', 'a: .5', 'a: .inf', 'a: 2020-01-01', 'a: 12abc',
    'a: x: y', 'a: x:', 'a: - x', 'a:\n- x', 'a:\n    - x', 'a:\n  - x\n - y', 'a:\n  - - x', 'a: very\n  continued', 'a: b\n  c: d', ' a: 1', 'a:  1', 'a:1', 'a: 1\n b: 2', 'true: 1', 'null: 1', '__proto__: 1', '1a: 1', 'a b: 1', 'a: x\u00a0y', 'a: x\u2028y', 'a: \u00a0x',
    'a: x ', 'a: x\n', '\na: x', 'a:', 'a:\nb: 1', '- a', 'a', ': x', '? a\n: b', '<<: *x', 'a: ] x', 'a: , x', 'a: @x', 'a: `x', 'a: %x', 'a: |x', 'a: !x', 'a: &x', 'a: *x', 'a: ?x', 'a: -x', 'a: #x', 'a: x #y',
  ];
  for (const text of declined) assert.equal(parseFrontmatterFast(text), undefined, JSON.stringify(text));
});

test('front matter fast path: Unicode, long and punctuated values either match the YAML parser or are declined', () => {
  const values = ['知识库', '한국어 제목', 'Café résumé', '日本語のタイトル', 'emoji 😀 title', 'مرحبا', 'тест', 'a,b', 'a;b', 'a|b', 'a>b', "it's", 'say "hi"', 'path/to/file.md', 'a\\b', 'x [y] z', 'x {y} z', 'a - b', 'a-b', 'a:b', 'a # b', 'a#b', 'x'.repeat(200), ('word ' + 'é').repeat(60).trim(), '0', '10', '123456789012345', '1234567890123456', '3D', 'v1.2.3', '1:2', 'yes please', 'nope', 'nullable', 'trueish', 'n', 'y', 'Y', 'null', 'a.b', '_x', 'x_', '-', '--', '---', '...', '\u200bzero', 'tab\there'];
  let fast = 0; for (const v of values) for (const text of [`title: ${v}`, `tags:\n  - ${v}`, `metadata:\n  note: ${v}`, `${YAML.stringify({ title: v })}`.trimEnd(), `${YAML.stringify({ tags: [v, v + '2'] })}`.trimEnd()]) if (check(text) === 'fast') fast++;
  assert.ok(fast > 100, `the fast path handles the plain majority (${fast})`);
});

function rng(seed: number) { let s = seed >>> 0; return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; }; }
const pieces = ['alpha', 'Beta', 'gamma delta', '知识库', '한국어', 'ünï', '😀', 'x:y', 'a: b', ' #c', 'q"q', "it's", '- dash', '[br]', '{cb}', 'yes', 'No', 'null', '~', 'true', 'FALSE', '123', '0123', '1e3', '0x1f', '.5', '-1', '2020-01-01', '2020-01-01T10:00:00.000Z', '\n', '\n\n', '  lead', 'trail  ', '\t', '|', '>', '&a', '*a', '!t', '%p', '@a', '`b', '?', ',', '.', '_', 'x'.repeat(90), 'long '.repeat(30), '\u00a0', '\u2028', '\r'];
function value(r: (n: number) => number, depth: number): unknown {
  const k = r(depth > 2 ? 6 : 9);
  if (k === 0) return r(100000) - (r(4) === 0 ? 50000 : 0); if (k === 1) return r(2) === 0; if (k === 2) return null; if (k === 3 || k === 4) return Array.from({ length: r(4) }, () => piece(r)).join(r(2) ? ' ' : '');
  if (k === 5) return piece(r); if (k === 6) return Array.from({ length: r(4) }, () => value(r, depth + 1)); if (k === 7) return Object.fromEntries(Array.from({ length: r(4) }, (_, i) => [['k', 'key_' + i, 'eventTime', 'x-y', 'true', 'No', '1x', 'a b', 'ключ'][r(9)]! + i, value(r, depth + 1)]));
  return {};
}
const piece = (r: (n: number) => number) => pieces[r(pieces.length)]!;

test('front matter fast path: randomized documents produced by the real serializer are parsed identically or declined', () => {
  const r = rng(20261012); let fast = 0, declined = 0;
  for (let i = 0; i < 4000; i++) {
    const meta = { schema_version: 1, id: `obj_${i}`, title: value(r, 3), tags: Array.from({ length: r(4) }, () => value(r, 3)), relations: r(3) ? [] : [{ type: 'references', target: piece(r) }], provenance: { evidence: r(3) ? [] : [{ quote: piece(r) }] }, status: 'active', created_at: '2020-01-01T17:51:12.000Z', metadata: value(r, 0) };
    const text = YAML.stringify(meta).replace(/\n$/, ''); if (check(text) === 'fast') fast++; else declined++;
  }
  assert.ok(fast > 150 && declined > 400, `both outcomes exercised (fast ${fast}, declined ${declined})`);
  recordCase({ suite: 'search', name: 'frontmatter-fast-fuzz', status: 'PASS', detail: { documents: 4000, fast, declined } });
});

test('front matter fast path: randomly corrupted text is never accepted when the YAML parser disagrees', () => {
  const r = rng(77); let fast = 0;
  const seeds = Array.from({ length: 60 }, (_, i) => YAML.stringify({ schema_version: 1, id: `obj_${i}`, title: i % 2 ? `Plain title ${i}` : value(r, 2), tags: [piece(r), piece(r)], provenance: { evidence: [] }, metadata: i % 3 ? { eventTime: '2020-01-01T00:00:00.000Z', flag: true, count: i, nested: { a: [1, 'two'] } } : value(r, 0), status: 'active' }).replace(/\n$/, ''));
  for (let i = 0; i < 60000; i++) {
    let t = seeds[r(seeds.length)]!; const edits = 1 + r(3);
    for (let e = 0; e < edits; e++) { const at = r(t.length + 1); const op = r(5); t = op === 0 ? t.slice(0, at) + t.slice(at + 1 + r(3)) : op === 1 ? t.slice(0, at) + piece(r) + t.slice(at) : op === 2 ? t.slice(0, at) + ' '.repeat(1 + r(3)) + t.slice(at) : op === 3 ? t.slice(0, at) + '\n' + t.slice(at) : t.slice(0, at) + ':' + t.slice(at); }
    if (check(t) === 'fast') fast++;
  }
  assert.ok(fast > 200, `some corruptions stay valid and are still checked (${fast})`);
});

test('front matter fast path: serialized documents round-trip identically through parseDocument; malformed documents still fail the same way', async t => {
  const { vault } = await disposableVault(t); await vault.createWorkspace('w', '', {});
  const titles = ['Plain', 'With: colon', '知识库 notes', 'x'.repeat(150), '123', 'yes', "it's \"quoted\"", ' leading', 'ünï ' + '😀'];
  for (const [i, title] of titles.entries()) {
    const doc = await vault.put({ scope: { type: 'workspace', workspaceId: 'w' }, kind: 'note', title, body: `# ${title}\n\nbody ${i}\n---\nnot front matter`, tags: ['a', 'yes', '1', 'ü'], metadata: { n: i, flag: i % 2 === 0, nested: { text: title, list: [1, 'two'] } } });
    const text = serializeDocument(doc); const parsed = parseDocument(text);
    assert.deepEqual({ ...parsed }, { ...doc }, title); const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)!; check(m[1]!);
  }
  for (const bad of ['no front matter', '---\nid: [\n---\nbody', '---\nschema_version: 2\nid: a\n---\nb', '---\n---\nb', '---\na: "unterminated\n---\nb']) assert.throws(() => parseDocument(bad), /INVALID_INPUT|Invalid|frontmatter|schema/i, JSON.stringify(bad));
});
