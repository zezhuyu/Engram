import { queryError, type QueryContext, type QueryStats } from './ast.js';

export type Stage = (input: AsyncIterable<any>, run: Run) => AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Per-execution budgets and counters. Every blocking or long-running loop calls check(); every buffer is sized through buffer(). */
export class Run {
  readonly started = Date.now(); readonly deadlineAt: number;
  readonly stats: QueryStats;
  private docs = 0;
  constructor(readonly ctx: QueryContext, snapshot: string, backend: string) {
    this.deadlineAt = this.started + ctx.deadlineMs;
    this.stats = { snapshot, backend, candidates: 0, documentsRead: 0, rowsOut: 0, bytesOut: 0, elapsedMs: 0, firstRowMs: null, searchPages: 0, searchDocumentsLoaded: 0 };
  }
  check(): void {
    if (this.ctx.abortSignal?.aborted) throw queryError('CANCELLED', 'Query cancelled');
    if (Date.now() > this.deadlineAt) throw queryError('RESOURCE_LIMIT', `Query exceeded its ${this.ctx.deadlineMs} ms deadline`);
  }
  buffer(size: number, what: string): void { if (size > this.ctx.maxBufferRows) throw queryError('RESOURCE_LIMIT', `${what} would hold more than ${this.ctx.maxBufferRows} rows in memory (no silent spill: narrow the query or raise the budget)`); }
  document(): void { if (++this.docs > this.ctx.maxDocuments) throw queryError('RESOURCE_LIMIT', `Query would read more than ${this.ctx.maxDocuments} documents`); this.stats.documentsRead = this.docs; }
}
export async function collect<T>(input: AsyncIterable<T>, run: Run, what: string): Promise<T[]> {
  const rows: T[] = []; for await (const row of input) { run.check(); rows.push(row); run.buffer(rows.length, what); } return rows;
}
export async function* from<T>(rows: Iterable<T>, run: Run): AsyncGenerator<T> { let i = 0; for (const row of rows) { if ((++i & 255) === 0) run.check(); yield row; } }
