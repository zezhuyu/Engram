import { queryError } from '../ast.js';
import { getField, keyOf, type Row } from '../rows.js';
import { collect, type Run } from '../runtime.js';

type S = AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Null or missing join keys never match, not even each other. Keys compare by type and value (1 and "1" differ). */
const joinKey = (row: unknown, field: string): string | undefined => { const v = getField(row, field); return v === null || v === undefined ? undefined : JSON.stringify(v); };
const asRecord = (row: unknown, op: string): Row => { if (row === null || typeof row !== 'object' || Array.isArray(row)) throw queryError('QUERY_INVALID', `"${op}" needs records on both sides`); return row as Row; };
const withPrefix = (right: Row, prefix: string): Row => Object.fromEntries(Object.entries(right).map(([k, v]) => [prefix + k, v]));

/** Hash join. The right side is built once into memory (bounded by maxBufferRows) and was authorized independently by its own execution. */
export async function* join(left: S, right: S, on: { left: string; right: string }, kind: 'inner' | 'left' | 'semi' | 'anti', prefix: string, run: Run, firstOnly = false): AsyncGenerator<Row> {
  const table = new Map<string, Row[]>(); for (const r of await collect(right, run, 'join build side')) { const rec = asRecord(r, 'join'); const k = joinKey(rec, on.right); if (k !== undefined) { const list = table.get(k); if (list) list.push(rec); else table.set(k, [rec]); } }
  for await (const l of left) {
    run.check(); const lr = asRecord(l, 'join'); const k = joinKey(lr, on.left); const matches = k === undefined ? undefined : table.get(k);
    if (kind === 'semi') { if (matches) yield lr; continue; }
    if (kind === 'anti') { if (!matches) yield lr; continue; }
    if (!matches) { if (kind === 'left') yield lr; continue; }
    for (const m of firstOnly ? matches.slice(0, 1) : matches) yield { ...lr, ...withPrefix(m, prefix) };
  }
}

export async function* setOp(kind: 'union' | 'unionAll' | 'intersect' | 'except', left: S, right: S, key: string[] | undefined, run: Run): AsyncGenerator<unknown> {
  if (kind === 'unionAll') { for await (const r of left) yield r; for await (const r of right) yield r; return; }
  if (kind === 'union') { const seen = new Set<string>(); for (const side of [left, right]) for await (const r of side) { run.check(); const k = keyOf(r, key); if (!seen.has(k)) { seen.add(k); run.buffer(seen.size, 'union'); yield r; } } return; }
  const other = new Set<string>(); for await (const r of right) { run.check(); other.add(keyOf(r, key)); run.buffer(other.size, kind); }
  const emitted = new Set<string>(); // set semantics: a duplicated left row appears once
  for await (const r of left) { run.check(); const k = keyOf(r, key); if (emitted.has(k)) continue; if (other.has(k) === (kind === 'intersect')) { emitted.add(k); run.buffer(emitted.size, kind); yield r; } }
}
