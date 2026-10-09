import { queryError, type CompareOp, type Expr, type SortKey } from './ast.js';

export type Row = Record<string, unknown>;
/** Fields that need the document body/metadata (a Markdown read of the pinned revision). Everything else comes from the derived manifest. */
export const LAZY_FIELDS = new Set(['body', 'links', 'evidence', 'meta', 'createdAt', 'createdBy', 'revisionNumber', 'agentId', 'source']);
export const isLazy = (path: string): boolean => LAZY_FIELDS.has(path.split('.')[0]!);

export function getField(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined; // never reach prototype members
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
export const isMissing = (v: unknown): boolean => v === undefined;
const kindOf = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (kindOf(a) !== kindOf(b) || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every(k => deepEqual((a as Row)[k], (b as Row)[k]));
}
/** Code-point order (UTF-8 byte order), not UTF-16 code unit order. */
export function compareBinary(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x !== y) { const xs = x >= 0xd800 && x <= 0xdfff, ys = y >= 0xd800 && y <= 0xdfff; return xs !== ys ? (xs ? 1 : -1) : x - y; }
  }
  return a.length - b.length;
}
const rank = (v: unknown): number => { const k = kindOf(v); return k === 'boolean' ? 0 : k === 'number' ? 1 : k === 'string' ? 2 : 3; };
/** Total order used by sort: boolean < number < string < structured; nulls and missing values are placed by the caller. */
export function compareValues(a: unknown, b: unknown, collation: 'binary' | 'locale' = 'binary'): number {
  const ra = rank(a), rb = rank(b); if (ra !== rb) return ra - rb;
  if (ra === 0) return Number(a) - Number(b);
  if (ra === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 2) return collation === 'locale' ? (a as string).localeCompare(b as string, 'en') : compareBinary(a as string, b as string);
  return compareBinary(JSON.stringify(a), JSON.stringify(b));
}
/** Ordering comparison (gt/gte/lt/lte): only values of the same scalar type compare; anything else, including null and missing, is false. */
function order(a: unknown, b: unknown): number | undefined {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return compareBinary(a, b);
  return undefined;
}
export function compare(op: CompareOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'exists': return expected === false ? actual === undefined : actual !== undefined;
    case 'isNull': return expected === false ? actual !== null && actual !== undefined : actual === null;
    default: break;
  }
  if (actual === undefined || actual === null) return false; // comparisons with null/missing are false, including ne
  switch (op) {
    case 'eq': return deepEqual(actual, expected);
    case 'ne': return expected !== null && !deepEqual(actual, expected);
    case 'in': return Array.isArray(expected) && expected.some(x => x !== null && (deepEqual(actual, x) || (Array.isArray(actual) && actual.some(item => deepEqual(item, x)))));
    case 'contains': return typeof actual === 'string' ? typeof expected === 'string' && actual.includes(expected) : Array.isArray(actual) && actual.some(x => deepEqual(x, expected));
    default: { if (expected === null) return false; const c = order(actual, expected); if (c === undefined) return false; return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0; }
  }
}
export function evaluate(expr: Expr, row: unknown): boolean {
  switch (expr.op) {
    case 'and': return expr.args.every(a => evaluate(a, row));
    case 'or': return expr.args.some(a => evaluate(a, row));
    case 'not': return !evaluate(expr.arg, row);
    default: return compare(expr.op, getField(row, expr.field), expr.value);
  }
}
export function fieldsOf(expr: Expr, into: Set<string> = new Set()): Set<string> {
  if (expr.op === 'and' || expr.op === 'or') for (const a of expr.args) fieldsOf(a, into); else if (expr.op === 'not') fieldsOf(expr.arg, into); else into.add((expr as { field: string }).field);
  return into;
}
/** Splits a conjunction into the conjuncts that satisfy `pred` on every field and the rest. Or/not are kept whole. */
export function splitConjuncts(expr: Expr | undefined, pred: (field: string) => boolean): { pushed: Expr[]; rest: Expr[] } {
  const pushed: Expr[] = [], rest: Expr[] = []; if (!expr) return { pushed, rest };
  const visit = (e: Expr) => { if (e.op === 'and') e.args.forEach(visit); else ([...fieldsOf(e)].every(pred) ? pushed : rest).push(e); };
  visit(expr); return { pushed, rest };
}
export const conj = (parts: Expr[]): Expr | undefined => parts.length === 0 ? undefined : parts.length === 1 ? parts[0]! : { op: 'and', args: parts };

/** Stable comparator with explicit null policy and id tie-break. */
export function comparator(keys: SortKey[], tieField = 'id'): (a: unknown, b: unknown) => number {
  return (a, b) => {
    for (const k of keys) {
      const x = getField(a, k.field), y = getField(b, k.field); const xn = x === undefined || x === null, yn = y === undefined || y === null;
      const sign = k.dir === 'desc' ? -1 : 1;
      if (xn || yn) { if (xn && yn) continue; const first = k.nulls === 'first'; return xn ? (first ? -1 : 1) : (first ? 1 : -1); }
      const c = compareValues(x, y, k.collation); if (c) return c * sign;
    }
    const x = getField(a, tieField), y = getField(b, tieField);
    return typeof x === 'string' && typeof y === 'string' ? compareBinary(x, y) : 0;
  };
}
export function keyOf(row: unknown, fields: string[] | undefined): string {
  if (!fields) return JSON.stringify(row, (_k, v) => v === undefined ? null : v);
  return JSON.stringify(fields.map(f => { const v = getField(row, f); return v === undefined ? null : v; }));
}
export function need<T>(value: T | undefined, message: string): T { if (value === undefined) throw queryError('QUERY_INVALID', message); return value; }
