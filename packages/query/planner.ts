import { queryError, type Expr, type PlanStage, type QueryAst, type QueryOp, type SortKey, type StreamType } from './ast.js';
import { conj, fieldsOf, isLazy, splitConjuncts } from './rows.js';

/** Fields a document row carries without reading Markdown (from the derived manifest), plus search extras. */
export const MANIFEST_FIELDS = new Set(['id', 'revision', 'workspace', 'collection', 'area', 'scope', 'type', 'kind', 'title', 'path', 'tags', 'status', 'visibility', 'updatedAt', 'eventTime', 'sessionId', 'hostSessionId', 'eventType', 'speaker', 'preferenceKey', 'evidenceClass', 'category', 'explicit', 'domain', 'score', 'snippet', 'lineStart', 'lineEnd', 'retrievalMode']);
const LAZY_NAMES = ['body', 'links', 'evidence', 'meta', 'createdAt', 'createdBy', 'revisionNumber', 'agentId', 'source'];
const EDGE_FIELDS = new Set(['fromId', 'toId', 'type', 'fromTitle', 'toTitle', 'fromPath', 'toPath']);
const LINE_FIELDS = new Set(['documentId', 'revision', 'lineNumber', 'text', 'byteStart', 'byteEnd', 'truncated']);
const GRAPH_EXTRA = new Set(['depth', 'via', 'fromId']);
export const isManifestField = (f: string): boolean => MANIFEST_FIELDS.has(f);

export interface Step { op: QueryOp; in: StreamType; out: StreamType; hydrate: boolean; blocking: boolean }
export interface TypedPlan { steps: Step[]; out: StreamType; where: Expr | undefined; pushed: Expr[]; residual: Expr[]; order: SortKey[] | undefined; derivedSearch: string | undefined; warnings: string[]; hydratesDocuments: boolean }

const BLOCKING = new Set(['sort', 'reverse', 'tail', 'distinct', 'group', 'count', 'sum', 'avg', 'min', 'max', 'join', 'lookup', 'union', 'intersect', 'except', 'recent', 'latest', 'timeline', 'traverse', 'related']);
const GENERIC: StreamType[] = ['documents', 'records', 'lines', 'edges', 'groups'];
const KEEP_OK: StreamType[] = [...GENERIC, 'scalar'];

/** Rewrites memory operators (recent, before, between, session, …) into filters and sorts so a source can push them down. */
export function lower(op: QueryOp): QueryOp[] {
  switch (op.op) {
    case 'recent': case 'latest': return [{ op: 'sort', fields: [{ field: 'eventTime', dir: 'desc', nulls: 'last' }] }, ...(op.n !== undefined ? [{ op: 'limit', n: op.n } as QueryOp] : [])];
    case 'before': return [{ op: 'filter', expr: { op: 'lt', field: 'eventTime', value: op.time } }];
    case 'after': return [{ op: 'filter', expr: { op: 'gte', field: 'eventTime', value: op.time } }];
    case 'between': return [{ op: 'filter', expr: { op: 'and', args: [{ op: 'gte', field: 'eventTime', value: op.from }, { op: op.inclusive ? 'lte' : 'lt', field: 'eventTime', value: op.to }] } }];
    case 'session': return [{ op: 'filter', expr: { op: 'eq', field: 'sessionId', value: op.sessionId } }];
    case 'timeline': return op.sessionId !== undefined ? [{ op: 'filter', expr: { op: 'eq', field: 'sessionId', value: op.sessionId } }, { op: 'sort', fields: [{ field: 'eventTime', dir: 'asc', nulls: 'last' }] }] : [op];
    default: return [op];
  }
}
const needsLazy = (op: QueryOp): boolean => {
  switch (op.op) {
    case 'filter': return [...fieldsOf(op.expr)].some(isLazy);
    case 'sort': return op.fields.some(k => isLazy(k.field));
    case 'select': case 'project': return op.fields.some(isLazy);
    case 'pluck': return isLazy(op.field);
    case 'distinct': case 'uniq': return op.fields ? op.fields.some(isLazy) : false;
    case 'group': return op.fields.some(isLazy) || Object.values(op.aggregates).some(a => !!a.field && isLazy(a.field));
    case 'count': case 'sum': case 'avg': case 'min': case 'max': return !!op.field && isLazy(op.field);
    case 'join': case 'lookup': return isLazy(op.on.left);
    case 'rename': return Object.keys(op.map).some(isLazy);
    default: return false;
  }
};

function typeOf(op: QueryOp, t: StreamType, known: Set<string> | null): { out: StreamType; known: Set<string> | null } {
  const err = (m: string): never => { throw queryError('QUERY_INVALID', `Operator "${op.op}" cannot follow a ${t} stream: ${m}`); };
  const generic = () => { if (!GENERIC.includes(t)) err('it needs records'); };
  const keep = () => { if (!KEEP_OK.includes(t)) err('unsupported stream'); return { out: t, known }; };
  const unknown = (f: string, allow = known) => { if (allow && !allow.has(f) && !(f.startsWith('meta.') && allow.has('meta'))) throw queryError('QUERY_INVALID', `Unknown field "${f}" for this stream`); };
  switch (op.op) {
    case 'filter': generic(); for (const f of fieldsOf(op.expr)) unknown(f); return { out: t, known };
    case 'sort': generic(); for (const k of op.fields) unknown(k.field); return { out: t, known };
    case 'reverse': case 'head': case 'tail': case 'limit': case 'offset': return keep();
    case 'distinct': case 'uniq': if (op.fields) { generic(); op.fields.forEach(f => unknown(f)); } return keep();
    case 'select': case 'project': { generic(); op.fields.forEach(f => unknown(f)); return { out: t === 'lines' && op.fields.includes('text') ? 'lines' : 'records', known: new Set(op.fields) }; }
    case 'pluck': generic(); unknown(op.field); return { out: 'scalar', known: null };
    case 'rename': { generic(); Object.keys(op.map).forEach(f => unknown(f)); const next = known ? new Set([...known].map(f => op.map[f] ?? f)) : null; return { out: t === 'documents' ? 'records' : t, known: next }; }
    case 'count': case 'sum': case 'avg': case 'min': case 'max': { if (!KEEP_OK.includes(t)) err('unsupported stream'); if (t !== 'scalar') { if (op.field) unknown(op.field); } else if (op.field) err('a stream of plain values has no fields'); return { out: 'records', known: new Set([op.as ?? op.op]) }; }
    case 'group': { generic(); op.fields.forEach(f => unknown(f)); for (const a of Object.values(op.aggregates)) if (a.field) unknown(a.field); return { out: 'groups', known: new Set([...op.fields, ...Object.keys(op.aggregates)]) }; }
    case 'join': case 'lookup': generic(); unknown(op.on.left); return { out: op.op === 'join' && (op.kind === 'semi' || op.kind === 'anti') ? t : 'records', known: op.op === 'join' && (op.kind === 'semi' || op.kind === 'anti') ? known : null };
    case 'union': case 'unionAll': case 'intersect': case 'except': generic(); return { out: t, known };
    case 'readLines': case 'cat': case 'read': case 'range': if (t !== 'documents') err('it needs documents (start from a document source)'); return { out: 'lines', known: LINE_FIELDS };
    case 'cut': case 'trim': case 'grep': case 'regex': case 'sed': case 'replace': if (t !== 'lines') err('it needs lines (use readLines/cat first)'); return { out: 'lines', known };
    case 'split': if (t !== 'lines') err('it needs lines (use readLines/cat first)'); return { out: 'records', known: null };
    case 'recent': case 'latest': case 'before': case 'after': case 'between': case 'session': case 'timeline': if (t !== 'documents') err('it needs documents or observations'); return { out: 'documents', known };
    case 'related': case 'backlinks': case 'references': case 'traverse': {
      if (t !== 'documents') err('it needs documents'); const edges = 'edges' in op && op.edges; if (edges) return { out: 'edges', known: EDGE_FIELDS };
      return { out: 'documents', known: known ? new Set([...known, ...GRAPH_EXTRA, 'score']) : null };
    }
    default: return err('unsupported');
  }
}

export function sourceType(ast: QueryAst): { type: StreamType; known: Set<string> | null } {
  if (ast.from === 'edges') return { type: 'edges', known: EDGE_FIELDS };
  return { type: 'documents', known: new Set([...MANIFEST_FIELDS, ...LAZY_NAMES]) };
}

/** Type-checks a list of operators against a starting stream type. Also used for CLI stdin pipelines, which have no vault behind them. */
export function planOps(ops: QueryOp[], start: StreamType, startKnown: Set<string> | null = null): { steps: Step[]; out: StreamType } {
  const steps: Step[] = []; let t = start; let known = startKnown;
  for (const raw of ops) for (const op of lower(raw)) {
    const next = typeOf(op, t, known);
    steps.push({ op, in: t, out: next.out, hydrate: t === 'documents' && needsLazy(op), blocking: BLOCKING.has(op.op) });
    t = next.out; known = next.known;
  }
  return { steps, out: t };
}
/** Type-checks the pipeline, lowers memory operators, and decides what can be pushed to the candidate source. */
export function plan(ast: QueryAst): TypedPlan {
  const { type: start, known: startKnown } = sourceType(ast);
  const warnings: string[] = []; let t: StreamType = start; let known = startKnown;
  const ops: QueryOp[] = [];
  if (ast.where) { ops.push({ op: 'filter', expr: ast.where }); }
  if (ast.orderBy) ops.push({ op: 'sort', fields: ast.orderBy });
  for (const op of ast.pipe ?? []) ops.push(...lower(op));
  if (ast.limit !== undefined) ops.push({ op: 'limit', n: ast.limit });
  const typed = planOps(ops, t, known); const steps = typed.steps; t = typed.out;
  if (ast.search && start !== 'documents') throw queryError('QUERY_INVALID', 'search applies to document sources, not edges');
  // Leading filters whose fields all come from the manifest are pushed to the candidate source; they stay in the pipeline too (a source may return a superset).
  let lead: Expr[] = []; let order: SortKey[] | undefined;
  let i = 0;
  while (i < steps.length && steps[i]!.op.op === 'filter' && steps[i]!.in === 'documents') { const e = (steps[i]!.op as { expr: Expr }).expr; lead.push(...splitConjuncts(e, isManifestField).pushed); i++; }
  if (i < steps.length && steps[i]!.op.op === 'sort' && steps[i]!.in === 'documents') { const keys = (steps[i]!.op as { fields: SortKey[] }).fields; if (keys.every(k => isManifestField(k.field))) order = keys; }
  const pushed = lead; const rest: Expr[] = [];
  for (const s of steps) if (s.op.op === 'filter') rest.push(...splitConjuncts((s.op as { expr: Expr }).expr, f => !isManifestField(f)).pushed);
  // A leading `contains body "text"` becomes a text prefilter (superset) so the search index narrows candidates instead of reading every document.
  let derivedSearch: string | undefined;
  if (!ast.search && start === 'documents') for (const e of lead.length || true ? splitConjuncts(conj(steps.filter(s => s.op.op === 'filter' && s.in === 'documents').map(s => (s.op as { expr: Expr }).expr)), f => f === 'body').pushed : []) if (e.op === 'contains' && e.field === 'body' && typeof e.value === 'string' && e.value.trim() && !e.value.includes('\n')) { derivedSearch = e.value; break; }
  const hydrating = steps.some(s => s.hydrate) || steps.some(s => ['readLines', 'cat', 'read', 'range'].includes(s.op.op));
  if (hydrating && !ast.search && !derivedSearch && start === 'documents') warnings.push('Reads Markdown for every candidate that passes the metadata filters (no text index applies). Add a search or a metadata filter to narrow the candidates.');
  for (const s of steps) if (s.blocking && s.in !== 'scalar') warnings.push(`"${s.op.op}" is a blocking stage held in memory (bounded by maxBufferRows)`);
  return { steps, out: t, where: ast.where, pushed, residual: rest, order, derivedSearch, warnings: [...new Set(warnings)], hydratesDocuments: hydrating };
}

export const stageSummary = (steps: Step[]): PlanStage[] => steps.map(s => ({ op: s.op.op, in: s.in, out: s.out, blocking: s.blocking, ...(s.hydrate ? { note: 'reads Markdown for lazy fields' } : {}) }));

/**
 * How many source rows the pipeline can possibly consume (page size + skipped rows + one to learn whether another page exists), or undefined when unbounded.
 * Only steps that map one row to at most one row and are fully applied by the source may precede the bound; anything else needs every row.
 */
export function rowBound(steps: Step[], pageNeed: number | undefined, pushedFilters: Set<unknown>): number | undefined {
  let bound = Infinity; let skip = 0;
  for (const s of steps) {
    const op = s.op;
    if (op.op === 'select' || op.op === 'project' || op.op === 'rename' || op.op === 'pluck') continue;
    if (op.op === 'filter' && pushedFilters.has(op)) continue;
    if (op.op === 'offset') { skip += op.n; continue; }
    if (op.op === 'limit' || op.op === 'head') { bound = Math.min(bound, skip + op.n); continue; }
    return Number.isFinite(bound) ? bound : undefined;
  }
  if (pageNeed !== undefined) bound = Math.min(bound, pageNeed);
  return Number.isFinite(bound) ? bound : undefined;
}
