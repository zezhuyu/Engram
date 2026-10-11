// Competitive benchmark library: an INDEPENDENT oracle for Engram search semantics (re-implemented from the documented rules, not importing Engram code),
// corpus loading, statistics and hashing. Plain Node ESM, no dependencies.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const gz = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
export const pct = (values, p) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] : NaN; };
export const stats = values => ({ n: values.length, min: Math.min(...values), p50: pct(values, .5), p95: pct(values, .95), p99: pct(values, .99), max: Math.max(...values), mean: values.reduce((s, x) => s + x, 0) / Math.max(1, values.length) });
/** Seeded shuffle so run order is reproducible but not biased by workload order. */
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Document views: every .md outside .mdb whose first line is the frontmatter fence and which carries a schema_version. */
export async function listViews(root) {
  const out = [];
  const walk = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { if (e.name === '.mdb' || e.name === '.DS_Store') continue; const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name.endsWith('.md')) out.push(p); } };
  await walk(root); return out.sort();
}
export function parseDocument(text, file) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4); if (end < 0) return null;
  const front = text.slice(4, end).split('\n'); const body = text.slice(end + 5);
  const fm = { tags: [] }; let inTags = false;
  for (const line of front) {
    if (inTags) { const m = /^  - (.*)$/.exec(line); if (m) { fm.tags.push(unquote(m[1])); continue; } inTags = false; }
    const m = /^([a-z_]+):(?: (.*))?$/.exec(line); if (!m) continue;
    if (m[1] === 'tags') { if (m[2] === '[]') fm.tags = []; else inTags = true; } else fm[m[1]] = m[2] === undefined ? '' : unquote(m[2]);
  }
  if (!fm.id || !fm.title || fm.schema_version === undefined) return null;
  return { file, id: fm.id, revisionId: fm.revision_id, kind: fm.kind, title: fm.title, status: fm.status, scope: fm.scope, workspaceId: fm.workspace_id, tags: fm.tags, body };
}
const unquote = v => (v.length > 1 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) ? v.slice(1, -1) : v;
export async function loadCorpus(root) {
  const files = await listViews(root); const docs = [];
  for (let i = 0; i < files.length; i += 256) await Promise.all(files.slice(i, i + 256).map(async f => { const d = parseDocument(await fs.readFile(f, 'utf8'), path.relative(root, f)); if (d) docs.push(d); }));
  return docs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Query semantics, restated from the product documentation of search modes. */
export function keywordGroups(query) {
  const tokens = query.match(/"[^"]+"|\S+/g) ?? []; const groups = [[]]; let negate = false;
  for (const token of tokens) { if (token === 'OR') { groups.push([]); negate = false; } else if (token === 'NOT') negate = true; else if (token !== 'AND') { groups.at(-1).push({ text: token.replace(/^"|"$/g, '').toLowerCase(), negate }); negate = false; } }
  return groups.filter(g => g.length);
}
const count = (hay, needle) => hay.split(needle).length - 1;
export function oracleScore(doc, input) {
  const mode = input.mode === 'grep' ? 'grep' : 'keyword'; const text = `${doc.title}\n${doc.body}`; const lower = text.toLowerCase();
  const regex = input.regex ? new RegExp(input.query, input.caseSensitive ? '' : 'i') : undefined; const groups = keywordGroups(input.query);
  const literal = input.caseSensitive ? input.query : input.query.toLowerCase();
  const matches = mode === 'grep' ? (regex ? regex.test(text) : (input.caseSensitive ? text : lower).includes(literal)) : groups.some(g => g.every(t => t.negate ? !lower.includes(t.text) : lower.includes(t.text)));
  if (!matches) return undefined;
  if (mode === 'grep') return 1;
  const positive = groups.flat().filter(t => !t.negate).map(t => t.text); const lines = doc.body.split('\n');
  let index = lines.findIndex(line => positive.some(t => line.toLowerCase().includes(t))); if (index < 0) index = 0;
  let heading; for (let i = 0; i <= index; i++) if (/^#{1,6}\s/.test(lines[i] ?? '')) heading = lines[i].replace(/^#{1,6}\s+/, '');
  return positive.reduce((s, t) => s + (doc.title.toLowerCase().includes(t) ? 5 : 0) + (heading?.toLowerCase().includes(t) ? 2 : 0) + Math.min(3, count(lower, t)), 0);
}
export function visible(doc, input) {
  if (doc.status === 'deleted' || doc.status === 'tombstone') return false;
  if (input.kinds?.length && !input.kinds.includes(doc.kind)) return false;
  if (input.tags?.length && !input.tags.every(t => doc.tags.includes(t))) return false;
  if (input.scopes?.length && !input.scopes.some(s => s.type === 'workspace' ? doc.scope === 'workspace' && doc.workspaceId === s.workspaceId : doc.scope === s.type)) return false;
  return true;
}
/** Reference result: every matching document with its score, ranked as the product contract defines (score desc, then object id ascending). */
export function oracle(docs, input) {
  const hits = []; for (const d of docs) { if (!visible(d, input)) continue; const s = oracleScore(d, input); if (s !== undefined) hits.push({ id: d.id, revisionId: d.revisionId, score: s }); }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); return hits;
}
