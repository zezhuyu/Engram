import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS, queryError, type Expr, type QueryAst, type QueryContext, type QueryOp, type QueryPlanSummary, type QueryResult, type QueryScope, type StreamType, type SubqueryValue } from './ast.js';
import type { CandidateSource, SnapshotHandle } from './backends/candidates.js';
import { inScope } from './backends/vault.js';
import * as agg from './operators/aggregate.js';
import * as flt from './operators/filter.js';
import * as gr from './operators/graph.js';
import * as rel from './operators/relational.js';
import { sort } from './operators/sort.js';
import * as txt from './operators/text.js';
import { plan as typedPlan, rowBound, stageSummary, type Step, type TypedPlan } from './planner.js';
import { conj, evaluate, getField, comparator, type Row } from './rows.js';
import { Run, collect } from './runtime.js';
import { normalize } from './schema.js';

type S = AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const CURSOR_TTL_MS = 10 * 60_000;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const canonical = (ast: QueryAst): string => JSON.stringify({ ...ast, cursor: undefined, limit: undefined });

/** Row-level version of the scope rule, for graph rows that are not manifest entries. */
function rowInScope(row: Row, scope: QueryScope | undefined): boolean {
  if (!scope || (!scope.workspace && scope.includeShared === undefined)) return true;
  if (scope.workspace) {
    if (row.workspace !== undefined) return row.workspace === scope.workspace && (!scope.collection || row.collection === scope.collection);
    return (scope.includeShared ?? true) && ['wiki', 'shared', 'discoveries'].includes(row.area as string);
  }
  return scope.includeShared === false ? row.workspace !== undefined : true;
}

export interface EngineOptions { limits?: Partial<typeof DEFAULT_LIMITS> }
export class QueryEngine {
  constructor(readonly source: CandidateSource, readonly principalId: string, readonly options: EngineOptions = {}) {}

  contextFor(overrides: Partial<QueryContext> = {}): QueryContext {
    const l = { ...DEFAULT_LIMITS, ...this.options.limits };
    const ctx: QueryContext = { principalId: this.principalId, deadlineMs: l.deadlineMs, maxRows: l.maxRows, maxBytes: l.maxBytes, maxBufferRows: l.maxBufferRows, maxGraphNodes: l.maxGraphNodes, maxDocuments: l.maxDocuments, maxDepth: l.maxDepth, ...overrides };
    // The principal is bound by the trusted host. A different one in the context is a forgery, not a request.
    if (ctx.principalId !== this.principalId) throw queryError('SCOPE_DENIED', 'The query principal must be the authenticated host identity');
    return ctx;
  }
  async capabilities() {
    await this.source.refresh?.(); const c = this.source.capabilities();
    return { version: 1, search: { exact: c.exact, keyword: c.keyword, regex: c.regex, auto: c.auto, semantic: { available: c.semantic, reason: c.semantic ? undefined : `${(c as { semanticReason?: string }).semanticReason || 'The vector backend (SQLite index + embeddings) is not ready'}. Explicit semantic requests fail with CAPABILITY_UNAVAILABLE unless allowDowngrade is set (results are then labelled keyword).` }, hybrid: { available: c.hybrid, reason: c.hybrid ? undefined : 'Needs the vector backend (SQLite index + embeddings); allowDowngrade yields labelled keyword results.' } }, sources: ['documents', 'observations', 'wiki', 'insights', 'discoveries', 'edges'], backend: c.backend, limits: { ...DEFAULT_LIMITS, ...this.options.limits }, regex: 'JavaScript RegExp with conservative safety rules (not RE2); see docs/query.md' };
  }

  /** Streams result rows (no paging). The snapshot is held for the life of the iteration and released when it ends or is abandoned. */
  async *execute(raw: unknown, ctxOverrides: Partial<QueryContext> = {}): AsyncGenerator<unknown> {
    const ctx = this.contextFor(ctxOverrides); const ast = normalize(raw);
    const handle = await this.source.open(); const run = new Run(ctx, `${handle.sequence}`, handle.backend);
    try { for await (const row of (await this.build(ast, run, handle, ctx, 0, new Set())).rows) yield row; } finally { handle.release(); }
  }

  async run(raw: unknown, ctxOverrides: Partial<QueryContext> = {}, withPlan = false): Promise<QueryResult> {
    const ctx = this.contextFor(ctxOverrides);
    const handle = await this.source.open();
    try {
      const ast = await this.resolveSaved(normalize(raw), 0, new Set()); // a saved query's own limit is the page size too
      const run = new Run(ctx, `${handle.sequence}`, handle.backend);
      const hash = sha(canonical(ast) + '\0' + this.principalId);
      let skip = 0;
      if (ast.cursor) {
        const c = decodeCursor(ast.cursor);
        if (c.h !== hash) throw queryError('QUERY_INVALID', 'Cursor does not belong to this query and principal');
        if (Date.now() > c.e) throw queryError('SNAPSHOT_EXPIRED', 'Cursor expired; repeat the query without a cursor');
        if (c.s !== handle.sequence && !ctx.allowCursorDrift) throw queryError('SNAPSHOT_EXPIRED', 'The vault changed since this cursor was issued; repeat the query without a cursor (or allow cursor drift)');
        skip = c.o;
      }
      // The top-level limit is the page size (applied below, so a following row can reveal whether a cursor is needed), not a pipeline stage.
      const pageSize = Math.min(ast.limit ?? ctx.maxRows, ctx.maxRows);
      const built = await this.build({ ...ast, cursor: undefined, limit: undefined } as QueryAst, run, handle, ctx, 0, new Set(), skip + pageSize + 1);
      const rows: unknown[] = []; let bytes = 0, truncated: QueryResult['truncated']; let more = false, index = 0;
      for await (const row of built.rows) {
        run.check();
        if (index++ < skip) continue;
        if (rows.length >= pageSize) { more = true; break; }
        const size = Buffer.byteLength(JSON.stringify(row) ?? 'null');
        if (bytes + size > ctx.maxBytes && rows.length) { truncated = 'bytes'; more = true; break; }
        if (bytes + size > ctx.maxBytes) throw queryError('RESOURCE_LIMIT', 'A single result row exceeds the output byte budget');
        bytes += size; rows.push(row); if (run.stats.firstRowMs === null) run.stats.firstRowMs = Date.now() - run.started;
      }
      if (more && !truncated && pageSize === ctx.maxRows && (ast.limit === undefined || ast.limit > ctx.maxRows)) truncated = 'rows';
      run.stats.rowsOut = rows.length; run.stats.bytesOut = bytes; run.stats.elapsedMs = Date.now() - run.started;
      const info = this.source.searchInfo(handle.token); if (info) { run.stats.backend = info.backend; run.stats.searchPages = info.pages; run.stats.searchDocumentsLoaded = info.loaded; if (info.textPrefilter) run.stats.textPrefilter = info.textPrefilter; }
      const cursor = more ? encodeCursor({ h: hash, s: handle.sequence, o: skip + rows.length, e: Date.now() + CURSOR_TTL_MS }) : undefined;
      return { ...(ast.search && info ? { search: { requested: ast.search.mode, mode: info.mode ?? (ast.search.mode === 'exact' || ast.search.mode === 'regex' ? 'grep' : ast.search.mode), ...(info.ranking ? { ranking: info.ranking } : {}), backend: info.backend } } : {}), rows, type: built.type, ...(cursor ? { cursor } : {}), ...(truncated ? { truncated } : {}), stats: run.stats, ...(info?.fallback ? { fallback: info.fallback } : {}), ...(withPlan ? { plan: await this.planOf(ast, handle, ctx) } : {}) };
    } finally { handle.release(); }
  }

  /** Plan only: no document is read, no row content or per-row existence is revealed. Counts are of rows the principal may already read. */
  async explain(raw: unknown, ctxOverrides: Partial<QueryContext> = {}): Promise<QueryPlanSummary> {
    const ctx = this.contextFor(ctxOverrides); const ast = normalize(raw); const handle = await this.source.open();
    try { return await this.planOf(ast, handle, ctx); } finally { handle.release(); }
  }
  private async planOf(ast: QueryAst, handle: SnapshotHandle, ctx: QueryContext): Promise<QueryPlanSummary> {
    const resolved = await this.resolveSaved(ast, 0, new Set()); const p = typedPlan(resolved);
    const scope = resolved.scope ?? ctx.defaultScope; const search = resolved.search ?? (p.derivedSearch ? { mode: 'exact' as const, text: '…' } : undefined);
    const warnings = [...p.warnings]; if (resolved.search?.mode === 'semantic' || resolved.search?.mode === 'hybrid') warnings.push(`${resolved.search.mode} search is not available without an embedding provider${resolved.search.allowDowngrade ? '; the downgrade to keyword will be labelled' : ' and will fail with CAPABILITY_UNAVAILABLE'}`);
    const estimate = resolved.from === 'edges' ? null : handle.estimate({ principalId: ctx.principalId, source: resolved.from as 'documents', scope, snapshot: handle.token, ...(conj(p.pushed) ? { filters: conj(p.pushed)! } : {}) });
    const cap = this.source.capabilities();
    return { version: 1, source: resolved.from, backend: search ? `${cap.backend} (text search)` : cap.backend, scopes: scope ? 1 : 0, stages: stageSummary(p.steps), pushedDown: [...p.pushed.map(e => describe(e)), ...(p.order ? [`order by ${p.order.map(k => `${k.field} ${k.dir}`).join(', ')}`] : []), ...(p.derivedSearch ? ['text prefilter from "contains body"'] : [])], hydratesDocuments: p.hydratesDocuments, candidateEstimate: search ? null : estimate, blockingStages: p.steps.filter(s => s.blocking).map(s => s.op.op), warnings, snapshot: `${handle.sequence}` };
  }

  // ---- construction -------------------------------------------------------------------------------------------------------------
  private async resolveSaved(ast: QueryAst, depth: number, seen: Set<string>): Promise<QueryAst> {
    if (ast.from !== 'saved') return ast;
    const name = ast.saved!; if (seen.has(name) || depth > 3) throw queryError('QUERY_INVALID', 'Saved queries refer to each other in a cycle or too deeply');
    const stored = normalize(await this.source.loadSaved(name, this.principalId), 0, undefined, `saved "${name}"`);
    const base = await this.resolveSaved(stored, depth + 1, new Set([...seen, name]));
    // The caller's refinements apply on top: extra filter, extra steps, own limit and cursor. Scope and search of the saved query win unless the caller names its own.
    return { ...base, ...(ast.scope ? { scope: ast.scope } : {}), ...(ast.search ? { search: ast.search } : {}), ...(ast.where ? { where: base.where ? { op: 'and', args: [base.where, ast.where] } : ast.where } : {}), ...(ast.orderBy ? { orderBy: ast.orderBy } : {}), pipe: [...(base.pipe ?? []), ...(ast.pipe ?? [])], ...(ast.limit !== undefined ? { limit: ast.limit } : {}), ...(ast.cursor ? { cursor: ast.cursor } : {}) };
  }
  private async resolveExpr(expr: Expr, run: Run, handle: SnapshotHandle, ctx: QueryContext, depth: number, saved: Set<string>): Promise<Expr> {
    if (expr.op === 'and' || expr.op === 'or') return { op: expr.op, args: await Promise.all(expr.args.map(a => this.resolveExpr(a, run, handle, ctx, depth, saved))) };
    if (expr.op === 'not') return { op: 'not', arg: await this.resolveExpr(expr.arg, run, handle, ctx, depth, saved) };
    const cmp = expr as Extract<Expr, { field: string }>; const v = cmp.value as SubqueryValue | undefined;
    if (cmp.op === 'in' && v && !Array.isArray(v) && typeof v === 'object' && 'subquery' in v) {
      const sub = await this.build(v.subquery, run, handle, ctx, depth + 1, saved); const values = new Set<string>();
      for await (const row of sub.rows) { run.check(); const x = getField(row, v.field); if (x !== null && x !== undefined) { values.add(JSON.stringify(x)); run.buffer(values.size, 'subquery'); } }
      return { op: 'in', field: cmp.field, value: [...values].map(x => JSON.parse(x) as unknown) };
    }
    return expr;
  }

  private async build(raw: QueryAst, run: Run, handle: SnapshotHandle, ctx: QueryContext, depth: number, saved: Set<string>, pageNeed?: number): Promise<{ rows: S; type: StreamType }> {
    if (depth > 4) throw queryError('QUERY_INVALID', 'Subqueries are nested too deeply');
    const ast = await this.resolveSaved(raw, 0, saved); const p = typedPlan(ast);
    const scope = ast.scope ?? ctx.defaultScope;
    if (ast.search && (ast.search.mode === 'semantic' || ast.search.mode === 'hybrid') && !ast.search.allowDowngrade) {
      await this.source.refresh?.(); const caps = this.source.capabilities();
      if (!(ast.search.mode === 'semantic' ? caps.semantic : caps.hybrid)) throw queryError('CAPABILITY_UNAVAILABLE', `${ast.search.mode} search is unavailable: ${(caps as { semanticReason?: string }).semanticReason || 'the vector backend (SQLite index + embeddings) is not ready'}. Use keyword/exact/regex, or set allowDowngrade to accept explicitly labelled keyword results.`);
    }
    let rows: S;
    if (ast.from === 'edges') {
      const view = handle.graph();
      rows = (async function* () { for await (const e of gr.allEdges(view, run)) { const a = view.node(e.fromId as string), b = view.node(e.toId as string); if (a && b && rowInScope(a, scope) && rowInScope(b, scope)) yield e; } })();
    } else {
      const filters = conj(await Promise.all(p.pushed.map(e => this.resolveExpr(e, run, handle, ctx, depth, saved))));
      const search = ast.search ?? (p.derivedSearch ? { mode: 'exact' as const, text: p.derivedSearch, caseSensitive: true } : undefined);
      // when the pipeline can use at most N rows and the source order is the answer order, the source need not rank more than N
      const limitHint = search && !p.order ? rowBound(p.steps, pageNeed, new Set(p.steps.filter(st => st.op.op === 'filter' && !st.hydrate && st.in === 'documents').map(st => st.op))) : undefined;
      const source = this.source;
      rows = (async function* () {
        for await (const c of source.candidates({ principalId: ctx.principalId, source: ast.from as 'documents', scope, snapshot: handle.token, ...(search ? { search } : {}), ...(filters ? { filters } : {}), ...(p.order ? { order: p.order } : {}), ...(limitHint !== undefined ? { limitHint } : {}) }, ctx.abortSignal)) { run.check(); run.stats.candidates++; yield c.row; }
      })();
    }
    const honors = this.source.capabilities().honorsOrder;
    let first = true;
    for (const step of p.steps) { rows = await this.apply(step, rows, run, handle, ctx, depth, saved, first && honors && !!p.order && !(ast.search || p.derivedSearch)); first = false; }
    return { rows, type: p.out };
  }

  private async apply(step: Step, input: S, run: Run, handle: SnapshotHandle, ctx: QueryContext, depth: number, saved: Set<string>, skipSort: boolean): Promise<S> {
    const op = step.op; let rows = input;
    if (step.hydrate || ['readLines', 'cat', 'read', 'range'].includes(op.op)) rows = hydrateRows(rows, handle, run);
    switch (op.op) {
      case 'filter': { const expr = await this.resolveExpr(op.expr, run, handle, ctx, depth, saved); return flt.filter(rows, expr, run); }
      case 'sort': return skipSort ? rows : sort(rows, op.fields, run);
      case 'reverse': return flt.reverse(rows, run);
      case 'head': case 'limit': return flt.limit(rows, op.n);
      case 'tail': return txt.tail(rows, op.n, run);
      case 'offset': return flt.offset(rows, op.n);
      case 'select': case 'project': return flt.select(rows, op.fields);
      case 'pluck': return flt.pluck(rows, op.field);
      case 'rename': return flt.rename(rows, op.map);
      case 'distinct': return flt.distinct(rows, op.fields, run);
      case 'uniq': return flt.uniq(rows, op.fields, run);
      case 'count': case 'sum': case 'avg': case 'min': case 'max': return agg.single(rows, { op: op.op, ...(op.field ? { field: op.field } : {}), ...(op.coerce ? { coerce: true } : {}) }, op.as ?? op.op, run);
      case 'group': return agg.group(rows, op.fields, op.aggregates, run);
      case 'join': case 'lookup': {
        const right = (await this.build(op.right, run, handle, ctx, depth + 1, saved)).rows; const kind = op.op === 'join' ? op.kind : 'left';
        return rel.join(rows, right, op.on, kind, op.prefix ?? 'right_', run, op.op === 'lookup');
      }
      case 'union': case 'unionAll': case 'intersect': case 'except': {
        const r = await this.build(op.right, run, handle, ctx, depth + 1, saved); if (r.type !== step.in) throw queryError('QUERY_INVALID', `"${op.op}" needs both sides to produce ${step.in} rows, but the right side produces ${r.type}`);
        return rel.setOp(op.op, rows, r.rows, op.key, run);
      }
      case 'readLines': return txt.readLines(rows, row => handle.hydrate(row), run, op.from, op.to);
      case 'cat': case 'read': return txt.readLines(rows, row => handle.hydrate(row), run);
      case 'range': return txt.readLines(rows, row => handle.hydrate(row), run, op.from, op.to);
      case 'timeline': return timelineAround(rows, op, run);
      case 'related': return gr.related(rows, handle.graph(), op.depth ?? 1, Math.min(op.limit ?? 100, ctx.maxGraphNodes), run);
      case 'references': return gr.neighbours(rows, handle.graph(), 'out', op.types, !!op.edges, run);
      case 'backlinks': return gr.neighbours(rows, handle.graph(), 'in', op.types, !!op.edges, run);
      case 'traverse': {
        if (op.maxNodes > ctx.maxGraphNodes) throw queryError('RESOURCE_LIMIT', `traverse maxNodes ${op.maxNodes} exceeds the graph budget ${ctx.maxGraphNodes}`);
        if (op.maxDepth > ctx.maxDepth) throw queryError('RESOURCE_LIMIT', `traverse maxDepth ${op.maxDepth} exceeds the depth budget ${ctx.maxDepth}`);
        return gr.traverse(rows, handle.graph(), { ...(op.edgeTypes ? { edgeTypes: op.edgeTypes } : {}), direction: op.direction ?? 'out', maxDepth: op.maxDepth, maxNodes: op.maxNodes, edges: !!op.edges }, run);
      }
      default: { const t = txt.stage(op as QueryOp); if (t) return t(rows, run); throw queryError('QUERY_INVALID', `Operator "${op.op}" is not executable here`); }
    }
  }
}

/** Adds the lazy fields to document rows by reading the pinned revision, a few at a time. Rows that are no longer readable (revoked, purged) vanish. */
function hydrateRows(input: S, handle: SnapshotHandle, run: Run): S {
  return (async function* () {
    const batch: Row[] = [];
    const flush = async function* (): AsyncGenerator<Row> {
      const docs = await Promise.all(batch.map(async row => { if (Object.prototype.hasOwnProperty.call(row, 'body')) return { row, doc: undefined, done: true }; run.document(); return { row, doc: await handle.hydrate(row), done: false }; }));
      batch.length = 0;
      for (const { row, doc, done } of docs) {
        if (done) { yield row; continue; } if (!doc) continue;
        const hidden = (name: string, value: unknown) => Object.defineProperty(row, name, { value, enumerable: false, configurable: true, writable: true });
        hidden('body', doc.body); hidden('links', doc.links); hidden('evidence', doc.evidence); hidden('meta', doc.meta); hidden('createdAt', doc.createdAt); hidden('createdBy', doc.createdBy); hidden('revisionNumber', doc.revisionNumber);
        if (typeof doc.meta.agentId === 'string') hidden('agentId', doc.meta.agentId); const src = doc.meta.source ?? doc.meta.sourceRef; if (src !== undefined) hidden('source', src);
        yield row;
      }
    };
    for await (const row of input) { run.check(); if (row === null || typeof row !== 'object') { yield row; continue; } batch.push(row as Row); if (batch.length >= 16) yield* flush(); }
    yield* flush();
  })();
}

async function* timelineAround(input: S, op: Extract<QueryOp, { op: 'timeline' }>, run: Run): AsyncGenerator<Row> {
  const rows = await collect(input as AsyncIterable<Row>, run, 'timeline'); const target = rows.find(r => r.id === op.aroundId); if (!target) return;
  const same = target.sessionId !== undefined ? rows.filter(r => r.sessionId === target.sessionId) : rows;
  same.sort(comparator([{ field: 'eventTime', dir: 'asc', nulls: 'last' }]));
  const at = same.findIndex(r => r.id === op.aroundId), w = op.window ?? 5;
  for (const r of same.slice(Math.max(0, at - w), at + w + 1)) yield r;
}
const describe = (e: Expr): string => e.op === 'and' || e.op === 'or' ? `${e.op}(${e.args.map(describe).join(', ')})` : e.op === 'not' ? `not(${describe(e.arg)})` : `${(e as { field: string }).field} ${e.op}`; // field names and operators only, never values

interface CursorBody { h: string; s: number; o: number; e: number }
const encodeCursor = (b: CursorBody): string => { const payload = Buffer.from(JSON.stringify(b)).toString('base64url'); return `${payload}.${sha(payload).slice(0, 16)}`; };
function decodeCursor(token: string): CursorBody {
  const [payload, check] = token.split('.'); if (!payload || !check || sha(payload).slice(0, 16) !== check) throw queryError('QUERY_INVALID', 'Malformed cursor');
  try { const b = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorBody; if (typeof b.h !== 'string' || !Number.isSafeInteger(b.s) || !Number.isSafeInteger(b.o) || b.o < 0 || !Number.isFinite(b.e)) throw new Error(); return b; } catch { throw queryError('QUERY_INVALID', 'Malformed cursor'); }
}
export { evaluate, inScope };
