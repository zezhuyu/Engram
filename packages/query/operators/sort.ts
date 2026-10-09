import type { SortKey } from '../ast.js';
import { comparator, type Row } from '../rows.js';
import type { Run } from '../runtime.js';

/** Blocking, stable. Ties break by id (when present) and then input order. Bounded by maxBufferRows. */
export async function* sort(input: AsyncIterable<any>, keys: SortKey[], run: Run): AsyncGenerator<Row> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows: Row[] = []; for await (const row of input) { run.check(); rows.push(row); run.buffer(rows.length, 'sort'); }
  const cmp = comparator(keys); const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => cmp(a.row, b.row) || a.i - b.i);
  for (const { row } of indexed) yield row;
}
