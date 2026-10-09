import type { Vault } from '../core/vault.js';
import { MDBError, type Scope } from '../core/types.js';
import type { SearchEngine } from '../search-files/index.js';
import { VaultCandidateSource } from './backends/vault.js';
import { QueryEngine, type EngineOptions } from './execute.js';
import { normalize } from './schema.js';
import { queryError, type QueryAst, type QueryContext, type QueryPlanSummary, type QueryResult } from './ast.js';
import { planOps } from './planner.js';
import { Run } from './runtime.js';
import * as txt from './operators/text.js';
import * as flt from './operators/filter.js';
import * as agg from './operators/aggregate.js';
import { sort } from './operators/sort.js';
import type { QueryOp, StreamType } from './ast.js';

export * from './ast.js';
export { normalize, LIMITS, assertSafeRegex } from './schema.js';
export { QueryEngine, type EngineOptions } from './execute.js';
export { VaultCandidateSource } from './backends/vault.js';
export type { CandidateSource, CandidateRequest, Candidate, SnapshotHandle, GraphView } from './backends/candidates.js';

/** SDK-facing facade. Identity is the Vault's trusted actor; nothing in a query can change it. */
export class QueryApi {
  readonly engine: QueryEngine; readonly source: VaultCandidateSource;
  constructor(private readonly vault: Vault, search?: SearchEngine, options?: EngineOptions) {
    this.source = new VaultCandidateSource(vault, search); this.engine = new QueryEngine(this.source, vault.actor.actorId, options);
  }
  run(query: unknown, ctx?: Partial<QueryContext>): Promise<QueryResult> { return this.engine.run(query, ctx); }
  execute(query: unknown, ctx?: Partial<QueryContext>): AsyncGenerator<unknown> { return this.engine.execute(query, ctx); }
  explain(query: unknown, ctx?: Partial<QueryContext>): Promise<QueryPlanSummary> { return this.engine.explain(query, ctx); }
  capabilities() { return this.engine.capabilities(); } // async: asks the vector backend whether it is ready
  validate(query: unknown): QueryAst { return normalize(query); }
  /** Saved queries are ordinary versioned objects (kind "saved_query"); saving again creates a new revision through Vault. */
  async save(name: string, query: unknown, scope: Scope): Promise<{ id: string; revisionId: string }> {
    if (!/^[\w .:-]{1,128}$/.test(name)) throw queryError('QUERY_INVALID', 'Saved query names are 1-128 characters of letters, digits, space and ._:-');
    const ast = normalize(query); if (ast.from === 'saved') throw queryError('QUERY_INVALID', 'A saved query cannot itself be a reference; save the resolved query');
    const body = JSON.stringify(ast, null, 2);
    const existing = await this.source.findSaved(name, scope);
    if (existing) { const doc = await this.vault.patch({ objectId: existing.id, expectedRevisionId: existing.revisionId, body }); return { id: doc.id, revisionId: doc.revisionId }; }
    const doc = await this.vault.put({ scope, kind: 'saved_query', title: name, body, tags: ['saved-query'] }); return { id: doc.id, revisionId: doc.revisionId };
  }
}

/** Runs line/record operators over rows that a previous mdb process already printed (CLI pipelines). It cannot read the vault, so there is nothing to authorize. */
export async function* runLocal(ops: QueryOp[], rows: AsyncIterable<unknown>, ctx: Partial<QueryContext> = {}): AsyncGenerator<unknown> {
  const first: unknown[] = []; const it = rows[Symbol.asyncIterator]();
  const head = await it.next(); if (!head.done) first.push(head.value);
  const sample = first[0] as Record<string, unknown> | undefined;
  const start: StreamType = sample && typeof sample === 'object' ? (typeof sample.text === 'string' && typeof sample.lineNumber === 'number' ? 'lines' : 'records') : 'scalar';
  const { steps } = planOps(ops, start);
  const run = new Run({ principalId: 'local', deadlineMs: 600_000, maxRows: 1e9, maxBytes: 1e12, maxBufferRows: 1_000_000, maxGraphNodes: 0, maxDocuments: 0, maxDepth: 0, ...ctx }, '0', 'stdin');
  const iterable = (async function* () { if (!head.done) yield head.value; for (;;) { const n = await it.next(); if (n.done) return; yield n.value; } })();
  let stream: AsyncIterable<any> = iterable; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const { op } of steps) {
    switch (op.op) {
      case 'filter': stream = flt.filter(stream, op.expr, run); break;
      case 'sort': stream = sort(stream, op.fields, run); break;
      case 'reverse': stream = flt.reverse(stream, run); break;
      case 'head': case 'limit': stream = flt.limit(stream, op.n); break;
      case 'tail': stream = txt.tail(stream, op.n, run); break;
      case 'offset': stream = flt.offset(stream, op.n); break;
      case 'select': case 'project': stream = flt.select(stream, op.fields); break;
      case 'pluck': stream = flt.pluck(stream, op.field); break;
      case 'rename': stream = flt.rename(stream, op.map); break;
      case 'distinct': stream = flt.distinct(stream, op.fields, run); break;
      case 'uniq': stream = flt.uniq(stream, op.fields, run); break;
      case 'count': case 'sum': case 'avg': case 'min': case 'max': stream = agg.single(stream, { op: op.op, ...(op.field ? { field: op.field } : {}), ...(op.coerce ? { coerce: true } : {}) }, op.as ?? op.op, run); break;
      case 'group': stream = agg.group(stream, op.fields, op.aggregates, run); break;
      default: { const t = txt.stage(op); if (!t) throw queryError('QUERY_INVALID', `"${op.op}" needs the vault and cannot run on piped input`); stream = t(stream, run); }
    }
  }
  yield* stream;
}
export { MDBError };
