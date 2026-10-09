import { queryError, SEARCH_MODES, SOURCES, type AggregateSpec, type Expr, type QueryAst, type QueryOp, type SearchSpec, type SortKey, type StreamType } from './ast.js';

/**
 * Strict validator and normalizer. Accepts the canonical AST plus the documented shorthand (where {and:[…]}, {keyword:"x"}, groupBy/aggregate),
 * rejects unknown keys everywhere (so a forged "principalId" or a smuggled option is an error, not ignored) and caps size, depth and string length.
 * Nothing in a query is ever evaluated as code.
 */
export const LIMITS = { nodes: 600, exprDepth: 12, subqueryDepth: 3, string: 4096, pattern: 256, list: 5000, pipe: 64, fieldDepth: 4, limit: 100_000 } as const;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,3}$/;
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class Budget { nodes = 0; tick(): void { if (++this.nodes > LIMITS.nodes) throw queryError('QUERY_INVALID', `Query is too large (more than ${LIMITS.nodes} nodes)`); } }
const bad = (message: string): never => { throw queryError('QUERY_INVALID', message); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function only(value: Record<string, unknown>, allowed: string[], where: string): void { for (const key of Object.keys(value)) if (BANNED_KEYS.has(key) || !allowed.includes(key)) bad(`${where}: unknown key "${key.slice(0, 40)}"`); }
const str = (v: unknown, where: string, max: number = LIMITS.string): string => { if (typeof v !== 'string' || v.length > max) bad(`${where} must be a string of at most ${max} characters`); return v as string; };
const int = (v: unknown, where: string, min = 0, max: number = LIMITS.limit): number => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) bad(`${where} must be an integer between ${min} and ${max}`); return v as number; };
const bool = (v: unknown, where: string): boolean => { if (typeof v !== 'boolean') bad(`${where} must be a boolean`); return v as boolean; };
const oneOf = <T extends string>(v: unknown, values: readonly T[], where: string): T => { if (typeof v !== 'string' || !values.includes(v as T)) bad(`${where} must be one of ${values.join('|')}`); return v as T; };
export const field = (v: unknown, where: string): string => { const f = str(v, where, 128); if (!FIELD.test(f) || f.split('.').some(p => BANNED_KEYS.has(p))) bad(`${where}: invalid field name`); return f; };
const fieldList = (v: unknown, where: string, min = 0): string[] => { if (!Array.isArray(v) || v.length > 64 || v.length < min) bad(`${where} must be a list of ${min}..64 field names`); return (v as unknown[]).map(f => field(f, where)); };

/** ISO 8601 with an explicit offset (or Z) only; normalized to UTC. Local times are ambiguous and rejected. */
export function isoTime(v: unknown, where: string): string {
  const text = str(v, where, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) bad(`${where} must be an ISO 8601 timestamp with a time-zone offset`);
  return new Date(text).toISOString();
}
/** Same conservative rules as the search layer (no nested quantifiers, backreferences or lookaround; one repetition operator). JavaScript has no linear-time engine; see docs/query.md. */
export function assertSafeRegex(pattern: string, flags: string): RegExp {
  if (pattern.length === 0 || pattern.length > LIMITS.pattern || /\)[+*{]|\\[1-9]|\(\?[=!<]/.test(pattern) || (pattern.match(/(?<!\\)[+*]|\{\d/g)?.length ?? 0) > 1) bad('Unsafe or oversized regular expression');
  try { return new RegExp(pattern, flags); } catch { return bad('Invalid regular expression'); }
}

const TIME_FIELDS = new Set(['createdAt', 'updatedAt', 'eventTime']);
function value(v: unknown, f: string, where: string): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return TIME_FIELDS.has(f) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? isoTime(v, where) : str(v, where);
  return bad(`${where}: unsupported value`);
}
function expr(raw: unknown, depth: number, budget: Budget, where = 'where', qd = 0): Expr {
  budget.tick(); if (depth > LIMITS.exprDepth) bad('Filter expression is nested too deeply');
  if (!isObject(raw)) return bad(`${where} must be an object`);
  if ('and' in raw || 'or' in raw) { const k = ('and' in raw ? 'and' : 'or') as 'and' | 'or'; only(raw, [k], where); const args = raw[k]; if (!Array.isArray(args) || !args.length || args.length > 200) bad(`${where}.${k} must be a non-empty list`); return { op: k, args: (args as unknown[]).map(a => expr(a, depth + 1, budget, where, qd)) }; }
  if ('not' in raw) { only(raw, ['not'], where); return { op: 'not', arg: expr(raw.not, depth + 1, budget, where, qd) }; }
  const op = raw.op;
  if (op === 'and' || op === 'or') { only(raw, ['op', 'args'], where); const args = raw.args; if (!Array.isArray(args) || !args.length || args.length > 200) bad(`${where}.args must be a non-empty list`); return { op, args: (args as unknown[]).map(a => expr(a, depth + 1, budget, where, qd)) }; }
  if (op === 'not') { only(raw, ['op', 'arg'], where); return { op: 'not', arg: expr(raw.arg, depth + 1, budget, where, qd) }; }
  const cmp = oneOf(op, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists', 'isNull'] as const, `${where}.op`);
  only(raw, ['op', 'field', 'value'], where); const f = field(raw.field, `${where}.field`);
  if (cmp === 'exists' || cmp === 'isNull') { if (raw.value !== undefined && typeof raw.value !== 'boolean') bad(`${where}.value must be boolean`); return raw.value === undefined ? { op: cmp, field: f } : { op: cmp, field: f, value: raw.value }; }
  if (raw.value === undefined) bad(`${where}: "${cmp}" needs a value`);
  if (cmp === 'in') {
    if (isObject(raw.value)) { only(raw.value, ['subquery', 'field'], `${where}.value`); if (qd >= LIMITS.subqueryDepth) bad('Subqueries are nested too deeply'); return { op: 'in', field: f, value: { subquery: normalize(raw.value.subquery, qd + 1, budget, `${where}.value.subquery`), field: field(raw.value.field, `${where}.value.field`) } }; }
    if (!Array.isArray(raw.value) || raw.value.length > LIMITS.list) bad(`${where}: "in" needs a list of at most ${LIMITS.list} values`);
    return { op: 'in', field: f, value: (raw.value as unknown[]).map(x => value(x, f, `${where}.value`)) };
  }
  if ((cmp === 'gt' || cmp === 'gte' || cmp === 'lt' || cmp === 'lte') && raw.value === null) bad(`${where}: ordering comparison with null is never true; use isNull`);
  return { op: cmp, field: f, value: value(raw.value, f, `${where}.value`) };
}
const sortKeys = (raw: unknown, where: string): SortKey[] => {
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) bad(`${where} must be a list of 1..8 sort keys`);
  return (raw as unknown[]).map(k => { if (!isObject(k)) return bad(`${where}: sort key must be an object`); only(k, ['field', 'dir', 'nulls', 'collation'], where); return { field: field(k.field, where), dir: k.dir === undefined ? 'asc' : oneOf(k.dir, ['asc', 'desc'] as const, `${where}.dir`), nulls: k.nulls === undefined ? 'last' : oneOf(k.nulls, ['first', 'last'] as const, `${where}.nulls`), collation: k.collation === undefined ? 'binary' : oneOf(k.collation, ['binary', 'locale'] as const, `${where}.collation`) }; });
};
const ranges = (raw: unknown, where: string): [number, number][] => {
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) bad(`${where} must be a list of ranges`);
  return (raw as unknown[]).map(r => { if (!Array.isArray(r) || r.length !== 2) return bad(`${where}: a range is [from, to] (1-based, inclusive)`); const a = int(r[0], where, 1, 1e9), b = int(r[1], where, 1, 1e9); if (b < a) bad(`${where}: range end before start`); return [a, b] as [number, number]; });
};
const aggregate = (raw: unknown, where: string): AggregateSpec => {
  if (!isObject(raw)) return bad(`${where} must be an object`); only(raw, ['op', 'field', 'coerce'], where);
  const op = oneOf(raw.op, ['count', 'sum', 'avg', 'min', 'max'] as const, `${where}.op`);
  if (op !== 'count' && raw.field === undefined) bad(`${where}: "${op}" needs a field`);
  return { op, ...(raw.field !== undefined ? { field: field(raw.field, where) } : {}), ...(raw.coerce !== undefined ? { coerce: bool(raw.coerce, `${where}.coerce`) } : {}) };
};
const aggregates = (raw: unknown, where: string): Record<string, AggregateSpec> => {
  if (!isObject(raw) || !Object.keys(raw).length || Object.keys(raw).length > 32) return bad(`${where} must name 1..32 aggregates`);
  return Object.fromEntries(Object.entries(raw).map(([name, spec]) => [field(name, `${where} name`), aggregate(spec, `${where}.${name}`)]));
};
const sub = (raw: unknown, depth: number, budget: Budget, where: string): QueryAst => { if (depth >= LIMITS.subqueryDepth) bad('Subqueries are nested too deeply'); return normalize(raw, depth + 1, budget, where); };
const joinOn = (raw: unknown, where: string): { left: string; right: string } => { if (!isObject(raw)) return bad(`${where}.on must be {left, right}`); only(raw, ['left', 'right'], `${where}.on`); return { left: field(raw.left, `${where}.on.left`), right: field(raw.right, `${where}.on.right`) }; };

function op(raw: unknown, depth: number, budget: Budget): QueryOp {
  budget.tick(); if (!isObject(raw)) return bad('pipe steps must be objects');
  const name = str(raw.op, 'pipe.op', 40); const where = `pipe.${name}`;
  const keys = (...allowed: string[]) => only(raw, ['op', ...allowed], where);
  switch (name) {
    case 'filter': keys('expr'); return { op: 'filter', expr: expr(raw.expr, 0, budget, `${where}.expr`, depth) };
    case 'sort': keys('fields'); return { op: 'sort', fields: sortKeys(raw.fields, where) };
    case 'reverse': keys(); return { op: 'reverse' };
    case 'head': case 'tail': case 'limit': case 'offset': keys('n'); return { op: name, n: int(raw.n, `${where}.n`) };
    case 'select': case 'project': keys('fields'); return { op: name, fields: fieldList(raw.fields, where, 1) };
    case 'pluck': keys('field'); return { op: 'pluck', field: field(raw.field, where) };
    case 'rename': { keys('map'); if (!isObject(raw.map) || !Object.keys(raw.map).length || Object.keys(raw.map).length > 64) bad(`${where}.map must map old names to new names`); return { op: 'rename', map: Object.fromEntries(Object.entries(raw.map as Record<string, unknown>).map(([a, b]) => [field(a, where), field(b, where)])) }; }
    case 'distinct': case 'uniq': keys('fields'); return raw.fields === undefined ? { op: name } : { op: name, fields: fieldList(raw.fields, where, 1) };
    case 'count': case 'sum': case 'avg': case 'min': case 'max': keys('field', 'coerce', 'as'); if (name !== 'count' && raw.field === undefined) bad(`${where} needs a field`); return { op: name, ...(raw.field !== undefined ? { field: field(raw.field, where) } : {}), ...(raw.coerce !== undefined ? { coerce: bool(raw.coerce, where) } : {}), ...(raw.as !== undefined ? { as: field(raw.as, where) } : {}) };
    case 'group': keys('fields', 'aggregates'); return { op: 'group', fields: fieldList(raw.fields, where, 1), aggregates: aggregates(raw.aggregates, `${where}.aggregates`) };
    case 'join': keys('right', 'on', 'kind', 'prefix'); return { op: 'join', right: sub(raw.right, depth, budget, `${where}.right`), on: joinOn(raw.on, where), kind: raw.kind === undefined ? 'inner' : oneOf(raw.kind, ['inner', 'left', 'semi', 'anti'] as const, `${where}.kind`), ...(raw.prefix !== undefined ? { prefix: field(raw.prefix, where) } : {}) };
    case 'lookup': keys('right', 'on', 'prefix'); return { op: 'lookup', right: sub(raw.right, depth, budget, `${where}.right`), on: joinOn(raw.on, where), ...(raw.prefix !== undefined ? { prefix: field(raw.prefix, where) } : {}) };
    case 'union': case 'unionAll': case 'intersect': case 'except': keys('right', 'key'); return { op: name, right: sub(raw.right, depth, budget, `${where}.right`), ...(raw.key !== undefined ? { key: fieldList(raw.key, where, 1) } : {}) };
    case 'readLines': keys('from', 'to'); return { op: 'readLines', ...(raw.from !== undefined ? { from: int(raw.from, where, 1, 1e9) } : {}), ...(raw.to !== undefined ? { to: int(raw.to, where, 1, 1e9) } : {}) };
    case 'cat': case 'read': keys(); return { op: name };
    case 'range': { keys('from', 'to'); const from = int(raw.from, where, 1, 1e9), to = int(raw.to, where, 1, 1e9); if (to < from) bad(`${where}: end before start`); return { op: 'range', from, to }; }
    case 'cut': {
      keys('chars', 'bytes', 'fields', 'delimiter');
      const modes = ['chars', 'bytes', 'fields'].filter(k => raw[k] !== undefined); if (modes.length !== 1) bad(`${where} needs exactly one of chars, bytes or fields`);
      if (raw.fields !== undefined) { if (!Array.isArray(raw.fields) || !raw.fields.length || raw.fields.length > 64) bad(`${where}.fields must be a list`); return { op: 'cut', fields: (raw.fields as unknown[]).map(n => int(n, where, 1, 1e6)), delimiter: raw.delimiter === undefined ? '\t' : str(raw.delimiter, where, 8) }; }
      return raw.chars !== undefined ? { op: 'cut', chars: ranges(raw.chars, where) } : { op: 'cut', bytes: ranges(raw.bytes, where) };
    }
    case 'grep': case 'regex': keys('pattern', 'ignoreCase', 'invert', 'regex'); return { op: name, pattern: str(raw.pattern, `${where}.pattern`, LIMITS.pattern), ...(raw.ignoreCase !== undefined ? { ignoreCase: bool(raw.ignoreCase, where) } : {}), ...(raw.invert !== undefined ? { invert: bool(raw.invert, where) } : {}), ...(raw.regex !== undefined ? { regex: bool(raw.regex, where) } : {}) };
    case 'sed': keys('script'); return { op: 'sed', script: str(raw.script, `${where}.script`, 512) };
    case 'replace': keys('find', 'with', 'all', 'ignoreCase'); return { op: 'replace', find: str(raw.find, where, LIMITS.pattern), with: str(raw.with, where, LIMITS.string), ...(raw.all !== undefined ? { all: bool(raw.all, where) } : {}), ...(raw.ignoreCase !== undefined ? { ignoreCase: bool(raw.ignoreCase, where) } : {}) };
    case 'split': keys('delimiter', 'names'); return { op: 'split', delimiter: str(raw.delimiter, where, 8), ...(raw.names !== undefined ? { names: fieldList(raw.names, where, 1) } : {}) };
    case 'trim': keys('side'); return { op: 'trim', ...(raw.side !== undefined ? { side: oneOf(raw.side, ['both', 'left', 'right'] as const, where) } : {}) };
    case 'recent': case 'latest': keys('n'); return { op: name, ...(raw.n !== undefined ? { n: int(raw.n, where, 1) } : {}) };
    case 'timeline': keys('sessionId', 'aroundId', 'window'); if ((raw.sessionId === undefined) === (raw.aroundId === undefined)) bad(`${where} needs exactly one of sessionId or aroundId`); return { op: 'timeline', ...(raw.sessionId !== undefined ? { sessionId: str(raw.sessionId, where, 128) } : {}), ...(raw.aroundId !== undefined ? { aroundId: str(raw.aroundId, where, 128) } : {}), ...(raw.window !== undefined ? { window: int(raw.window, where, 0, 500) } : {}) };
    case 'before': case 'after': keys('time'); return { op: name, time: isoTime(raw.time, `${where}.time`) };
    case 'between': { keys('from', 'to', 'inclusive'); const from = isoTime(raw.from, where), to = isoTime(raw.to, where); if (to < from) bad(`${where}: end before start`); return { op: 'between', from, to, ...(raw.inclusive !== undefined ? { inclusive: bool(raw.inclusive, where) } : {}) }; }
    case 'session': keys('sessionId'); return { op: 'session', sessionId: str(raw.sessionId, where, 128) };
    case 'related': keys('depth', 'limit'); return { op: 'related', ...(raw.depth !== undefined ? { depth: int(raw.depth, where, 1, 4) } : {}), ...(raw.limit !== undefined ? { limit: int(raw.limit, where, 1, 1000) } : {}) };
    case 'backlinks': case 'references': keys('types', 'edges'); return { op: name, ...(raw.types !== undefined ? { types: fieldList(raw.types, where, 1) } : {}), ...(raw.edges !== undefined ? { edges: bool(raw.edges, where) } : {}) };
    case 'traverse': keys('edgeTypes', 'direction', 'maxDepth', 'maxNodes', 'edges'); return { op: 'traverse', ...(raw.edgeTypes !== undefined ? { edgeTypes: fieldList(raw.edgeTypes, where, 1) } : {}), ...(raw.direction !== undefined ? { direction: oneOf(raw.direction, ['out', 'in', 'both'] as const, where) } : {}), maxDepth: int(raw.maxDepth, `${where}.maxDepth`, 1, 8), maxNodes: int(raw.maxNodes, `${where}.maxNodes`, 1, 100_000), ...(raw.edges !== undefined ? { edges: bool(raw.edges, where) } : {}) };
    case 'text': { // RFC shape: {op:'text', action, args}; folded into the specific operator so there is one implementation
      keys('action', 'args'); const action = oneOf(raw.action, ['grep', 'cut', 'trim', 'split', 'replace'] as const, `${where}.action`); if (!isObject(raw.args)) bad(`${where}.args must be an object`);
      return op({ op: action, ...(raw.args as Record<string, unknown>) }, depth, budget);
    }
    default: return bad(`Unknown operator "${name.slice(0, 40)}"`);
  }
}

const SEARCH_KEYS = ['keyword', 'exact', 'regex', 'semantic', 'hybrid', 'auto'];
function searchSpec(raw: unknown): SearchSpec {
  if (!isObject(raw)) return bad('search must be an object'); only(raw, ['mode', 'text', 'caseSensitive', 'allowDowngrade'], 'search');
  const mode = oneOf(raw.mode, SEARCH_MODES, 'search.mode'); const text = str(raw.text, 'search.text', 1024); if (!text.trim()) bad('search.text must not be empty');
  if (mode === 'regex') assertSafeRegex(text, '');
  return { mode, text, ...(raw.caseSensitive !== undefined ? { caseSensitive: bool(raw.caseSensitive, 'search') } : {}), ...(raw.allowDowngrade !== undefined ? { allowDowngrade: bool(raw.allowDowngrade, 'search') } : {}) };
}

/** Validates and normalizes an untrusted query value into the canonical AST. */
export function normalize(raw: unknown, depth = 0, budget = new Budget(), where = 'query'): QueryAst {
  budget.tick(); if (!isObject(raw)) return bad(`${where} must be a JSON object`);
  only(raw, ['version', 'from', 'saved', 'scope', 'search', 'where', 'orderBy', 'pipe', 'limit', 'cursor', 'groupBy', 'aggregate', 'select'], where);
  if (raw.version !== undefined && raw.version !== 1) bad('Unsupported query version');
  const from = oneOf(raw.from, [...SOURCES, 'saved'] as const, `${where}.from`);
  const ast: QueryAst = { version: 1, from };
  if (from === 'saved') { if (raw.saved === undefined) bad('from "saved" needs a saved query name'); ast.saved = str(raw.saved, 'saved', 128); } else if (raw.saved !== undefined) bad('"saved" is only valid with from "saved"');
  if (raw.scope !== undefined) {
    if (!isObject(raw.scope)) bad('scope must be an object'); const s = raw.scope as Record<string, unknown>; only(s, ['workspace', 'collection', 'includeShared'], 'scope');
    ast.scope = { ...(s.workspace !== undefined ? { workspace: str(s.workspace, 'scope.workspace', 128) } : {}), ...(s.collection !== undefined ? { collection: str(s.collection, 'scope.collection', 128) } : {}), ...(s.includeShared !== undefined ? { includeShared: bool(s.includeShared, 'scope.includeShared') } : {}) };
    if (ast.scope.collection && !ast.scope.workspace) bad('scope.collection needs scope.workspace');
  }
  if (raw.search !== undefined) ast.search = searchSpec(raw.search);
  let w = raw.where;
  if (isObject(w)) { // {keyword:"x"} (alone or inside a top-level "and") is a search, not a filter
    const hoist = (o: Record<string, unknown>): boolean => { const k = SEARCH_KEYS.filter(x => x in o); if (!k.length) return false; if (k.length > 1 || Object.keys(o).length > 1) bad('where: a search clause must stand alone'); if (ast.search) bad('Both "search" and a search clause in "where"'); ast.search = searchSpec({ mode: k[0], text: o[k[0]!] }); return true; };
    if (hoist(w)) w = undefined;
    else if (Array.isArray(w.and)) { const rest = (w.and as unknown[]).filter(x => !(isObject(x) && hoist(x))); w = rest.length ? { and: rest } : undefined; }
  }
  if (w !== undefined) ast.where = expr(w, 0, budget, 'where', depth);
  if (raw.orderBy !== undefined) ast.orderBy = sortKeys(raw.orderBy, 'orderBy');
  const pipe: QueryOp[] = [];
  if (raw.pipe !== undefined) { if (!Array.isArray(raw.pipe) || raw.pipe.length > LIMITS.pipe) bad(`pipe must be a list of at most ${LIMITS.pipe} steps`); for (const step of raw.pipe as unknown[]) pipe.push(op(step, depth, budget)); }
  if ((raw.groupBy !== undefined) !== (raw.aggregate !== undefined) && raw.groupBy !== undefined) bad('groupBy needs aggregate');
  if (raw.aggregate !== undefined) {
    if (raw.groupBy !== undefined) pipe.push({ op: 'group', fields: fieldList(raw.groupBy, 'groupBy', 1), aggregates: aggregates(raw.aggregate, 'aggregate') });
    else { const a = aggregates(raw.aggregate, 'aggregate'); pipe.push({ op: 'group', fields: [], aggregates: a }); }
  }
  if (raw.select !== undefined) pipe.push({ op: 'select', fields: fieldList(raw.select, 'select', 1) });
  if (pipe.length) ast.pipe = pipe;
  if (raw.limit !== undefined) ast.limit = int(raw.limit, 'limit', 0);
  if (raw.cursor !== undefined) ast.cursor = str(raw.cursor, 'cursor', 2048);
  return ast;
}
export const typeName = (t: StreamType): string => t;
