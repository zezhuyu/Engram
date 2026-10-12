// Mutation check for the F (negative fast path) and C (YAML fast path) safety conditions.
// Each mutation breaks ONE condition in a COPY of dist/ (the real dist is never touched) and the dedicated tests must then fail; a mutation that no test notices is reported as SURVIVED.
// Usage: node scripts/profiling/mutation-check.mjs [output.json]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..'); const out = process.argv[2] ?? path.join(repo, 'verification/performance/raw/opt/final/mutation-results.json');
const TESTS = ['dist/tests/search/negative-fast-path.test.js', 'dist/tests/search/frontmatter-fast.test.js', 'dist/tests/search/fs-trigram.test.js'];
const P = 'dist/packages/';
const sub = (re, to) => tail => { if (!(re instanceof RegExp ? re.test(tail) : tail.includes(re))) throw new Error('mutation target not found: ' + re); return tail.replace(re, to); };
const mutations = [
  { id: 'F1', what: 'the stale/unindexed ids are no longer added to every term set', file: P + 'search-files/postings.js', apply: s => sub('for (const id of stale) {', 'for (const id of []) {')(s) },
  { id: 'F2', what: 'the probe ignores manifest titles', file: P + 'search-files/retrieve.js', apply: null },
  { id: 'F3', what: 'the probe answers "no candidates" when the index lookup throws', file: P + 'search-files/retrieve.js', apply: null },
  { id: 'F4', what: 'an unreadable revision at build time is listed as indexed again (the original bug)', file: P + 'search-files/postings.js', apply: s => sub("unreadable.has(ordinal) ? '-' : e.rev", 'e.rev')(s) },
  { id: 'F5', what: 'activeCount counts deleted and tombstoned entries', file: P + 'search-files/manifest.js', apply: s => sub('- (this.inactive.get(sk) ?? 0)', '- 0')(s) },
  { id: 'F6', what: 'the fast path ignores explicit scope filters', file: P + 'search-files/retrieve.js', apply: s => sub('if (!filters && prefilter.probe', 'if (prefilter.probe')(s) },
  { id: 'F7', what: 'the lower-cased title blob is built from raw titles', file: P + 'search-files/manifest.js', apply: s => sub('.map(e => e.title.toLocaleLowerCase())', '.map(e => e.title)')(s) },
  { id: 'F8', what: 'the fast path ignores kind filters', file: P + 'search-files/retrieve.js', apply: s => sub('!input.kinds?.length && ', '')(s) },
  { id: 'C1', what: 'the fast parser accepts values that start with a double quote', file: P + 'core/frontmatter-fast.js', apply: s => sub("'^[A-Za-z0-9_\\u00A1-\\uFFFF]'", "'^[\"A-Za-z0-9_\\u00A1-\\uFFFF]'")(s) },
  { id: 'C2', what: 'duplicate keys are accepted', file: P + 'core/frontmatter-fast.js', apply: s => sub(' || Object.hasOwn(object, key)', '')(s) },
  { id: 'C3', what: 'digit-leading non-integers (floats, versions) are returned as strings', file: P + 'core/frontmatter-fast.js', apply: s => sub('return TIMESTAMP.test(text) ? text : undefined;', 'return text;')(s) },
  { id: 'C4a', what: 'only the per-scalar continuation check is removed (the block-end and top-level checks enforce the same condition, so this is expected to be an EQUIVALENT mutant)', equivalent: true, file: P + 'core/frontmatter-fast.js', apply: s => sub(/if \(i < lines\.length && lines\[i\]\.indent > indent\)\s*\n\s*return undefined; \/\/ a deeper line after a scalar[^\n]*/, '')(s) },
  { id: 'C4', what: 'all three continuation checks are removed (per scalar, at block end, and the top-level end-of-input check): a folded or continued scalar is no longer rejected', file: P + 'core/frontmatter-fast.js', apply: s => { const re = /if \(i < lines\.length && lines\[i\]\.indent > indent\)\s*\n?\s*return undefined;[^\n]*/g; if (!re.test(s) || !s.includes('parsed.next !== lines.length ||')) throw new Error('C4 target not found'); return s.replace(/if \(i < lines\.length && lines\[i\]\.indent > indent\)\s*\n?\s*return undefined;[^\n]*/g, '').replace('parsed.next !== lines.length ||', ''); } },
  { id: 'C5', what: '__proto__ is accepted as a key', file: P + 'core/frontmatter-fast.js', apply: s => sub('|__proto__', '')(s) },
];
// F2 and F3 act inside the probe function only (the text after `filesPrefilter.probe =`)
function inProbe(text, find, to) { const at = text.indexOf('filesPrefilter.probe ='); if (at < 0) throw new Error('probe not found'); const tail = text.slice(at); const hit = find instanceof RegExp ? tail.match(find)?.[0] : (tail.includes(find) ? find : undefined); if (!hit) throw new Error('probe mutation target not found: ' + find); return text.slice(0, at) + tail.replace(hit, to); }
mutations.find(m => m.id === 'F2').apply = s => inProbe(s, 'for (const id of manifest.titleIds(term, spec.caseSensitive))', 'for (const id of [])');
mutations.find(m => m.id === 'F3').apply = s => inProbe(s, /catch \{\s*return false;/, 'catch { return true;');
const run = (root) => { const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...TESTS], { cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 28 }); const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]); return { status: r.status, failed }; };
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-')); const results = [];
try {
  const prepare = () => { fs.rmSync(path.join(work, 'dist'), { recursive: true, force: true }); fs.cpSync(path.join(repo, 'dist'), path.join(work, 'dist'), { recursive: true }); fs.copyFileSync(path.join(repo, 'package.json'), path.join(work, 'package.json')); if (!fs.existsSync(path.join(work, 'node_modules'))) fs.symlinkSync(path.join(repo, 'node_modules'), path.join(work, 'node_modules')); };
  prepare(); const control = run(work); results.push({ id: 'control', what: 'unmodified copy of dist', status: control.status, failedTests: control.failed });
  if (control.status !== 0) throw new Error('control run fails; mutation results would be meaningless: ' + JSON.stringify(control.failed));
  for (const m of mutations) {
    prepare(); const file = path.join(work, m.file); const before = fs.readFileSync(file, 'utf8'); const after = m.apply(before); if (after === before) throw new Error(m.id + ' did not change the file');
    fs.writeFileSync(file, after); const r = run(work); results.push({ id: m.id, what: m.what, status: r.status === 0 ? (m.equivalent ? 'EQUIVALENT' : 'SURVIVED') : 'KILLED', failedTests: r.failed });
  }
} finally { fs.rmSync(work, { recursive: true, force: true }); }
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2));
for (const r of results) console.log(r.id.padEnd(8), String(r.status).padEnd(9), r.what, r.failedTests?.length ? `(${r.failedTests.length} failing)` : '');
process.exitCode = results.some(r => r.status === 'SURVIVED') ? 2 : 0;
