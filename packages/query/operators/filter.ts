import { type Expr, type QueryOp } from '../ast.js';
import { evaluate, getField, keyOf, type Row } from '../rows.js';
import { queryError } from '../ast.js';
import type { Run } from '../runtime.js';

type S = AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export async function* filter(input: S, expr: Expr, run: Run): AsyncGenerator<Row> { let i = 0; for await (const row of input) { if ((++i & 127) === 0) run.check(); if (evaluate(expr, row)) yield row; } }
export async function* limit(input: S, n: number): AsyncGenerator<Row> { if (n <= 0) return; let i = 0; for await (const row of input) { yield row; if (++i >= n) return; } }
export async function* offset(input: S, n: number): AsyncGenerator<Row> { let i = 0; for await (const row of input) { if (i++ >= n) yield row; } }
export async function* reverse(input: S, run: Run): AsyncGenerator<Row> { const rows: Row[] = []; for await (const row of input) { run.check(); rows.push(row); run.buffer(rows.length, 'reverse'); } for (let i = rows.length - 1; i >= 0; i--) yield rows[i]!; }

const scalarCheck = (row: unknown, op: string): void => { if (row === null || typeof row !== 'object') throw queryError('QUERY_INVALID', `"${op}" needs records, but the stream holds plain values`); };
export async function* select(input: S, fields: string[]): AsyncGenerator<Row> {
  for await (const row of input) { scalarCheck(row, 'select'); const out: Row = {}; for (const f of fields) { const v = getField(row, f); if (v !== undefined) out[f] = v; } yield out; }
}
export async function* pluck(input: S, f: string): AsyncGenerator<unknown> { for await (const row of input) { scalarCheck(row, 'pluck'); const v = getField(row, f); yield v === undefined ? null : v; } }
export async function* rename(input: S, map: Record<string, string>): AsyncGenerator<Row> {
  for await (const row of input) { scalarCheck(row, 'rename'); const out: Row = {}; for (const [k, v] of Object.entries(row as Row)) if (!(k in map)) out[k] = v; for (const [from, to] of Object.entries(map)) { const v = (row as Row)[from]; if (v !== undefined) out[to] = v; } yield out; }
}
/** Global set semantics; the seen-set is bounded by maxBufferRows (there is no silent spill). */
export async function* distinct(input: S, fields: string[] | undefined, run: Run): AsyncGenerator<unknown> {
  const seen = new Set<string>(); for await (const row of input) { run.check(); const k = keyOf(row, fields); if (seen.has(k)) continue; seen.add(k); run.buffer(seen.size, 'distinct'); yield row; }
}
/** Adjacent duplicates only, in input order, constant memory. */
export async function* uniq(input: S, fields: string[] | undefined, run: Run): AsyncGenerator<unknown> {
  let last: string | undefined; for await (const row of input) { run.check(); const k = keyOf(row, fields); if (k !== last) yield row; last = k; }
}
export const isFilterOp = (op: QueryOp): boolean => ['filter', 'limit', 'offset', 'reverse', 'select', 'project', 'pluck', 'rename', 'distinct', 'uniq'].includes(op.op);
