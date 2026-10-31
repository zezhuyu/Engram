import { MDBError } from '../core/types.js';

/**
 * Typed query AST (version 1). One validated shape serves the CLI, SDK and MCP; nothing here is executable text.
 * Identity is never part of the AST: the principal is bound by the trusted host (see QueryContext).
 */
export type QueryErrorCode = 'QUERY_INVALID' | 'CAPABILITY_UNAVAILABLE' | 'SCOPE_DENIED' | 'RESOURCE_LIMIT' | 'SNAPSHOT_EXPIRED' | 'INDEX_STALE' | 'CANCELLED';
export const queryError = (code: QueryErrorCode, message: string): MDBError => new MDBError(code, message);

export const SOURCES = ['documents', 'observations', 'wiki', 'insights', 'discoveries', 'edges'] as const;
export type SourceName = (typeof SOURCES)[number];
export const SEARCH_MODES = ['exact', 'keyword', 'regex', 'semantic', 'hybrid', 'auto'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface QueryScope { workspace?: string; collection?: string; includeShared?: boolean; includeRejected?: boolean }
export type CompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists' | 'isNull';
export type Expr =
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: CompareOp; field: string; value?: unknown };
/** Value of an `in` filter that is computed by a nested query: the distinct non-null values of `field` over the subquery rows. */
export interface SubqueryValue { subquery: QueryAst; field: string }
export interface SortKey { field: string; dir?: 'asc' | 'desc'; nulls?: 'first' | 'last'; collation?: 'binary' | 'locale' }
export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export interface AggregateSpec { op: AggregateFn; field?: string; coerce?: boolean }
export interface JoinOn { left: string; right: string }

export type QueryOp =
  | { op: 'filter'; expr: Expr }
  | { op: 'sort'; fields: SortKey[] }
  | { op: 'reverse' }
  | { op: 'head' | 'tail' | 'limit' | 'offset'; n: number }
  | { op: 'select' | 'project'; fields: string[] }
  | { op: 'pluck'; field: string }
  | { op: 'rename'; map: Record<string, string> }
  | { op: 'distinct'; fields?: string[] }
  | { op: 'uniq'; fields?: string[] }
  | { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; coerce?: boolean; as?: string }
  | { op: 'group'; fields: string[]; aggregates: Record<string, AggregateSpec> }
  | { op: 'join'; right: QueryAst; on: JoinOn; kind: 'inner' | 'left' | 'semi' | 'anti'; prefix?: string }
  | { op: 'lookup'; right: QueryAst; on: JoinOn; prefix?: string }
  | { op: 'union' | 'unionAll' | 'intersect' | 'except'; right: QueryAst; key?: string[] }
  | { op: 'readLines'; from?: number; to?: number }
  | { op: 'cat' | 'read' }
  | { op: 'range'; from: number; to: number }
  | { op: 'cut'; chars?: [number, number][]; bytes?: [number, number][]; fields?: number[]; delimiter?: string }
  | { op: 'grep' | 'regex'; pattern: string; ignoreCase?: boolean; invert?: boolean; regex?: boolean }
  | { op: 'sed'; script: string }
  | { op: 'replace'; find: string; with: string; all?: boolean; ignoreCase?: boolean }
  | { op: 'split'; delimiter: string; names?: string[] }
  | { op: 'trim'; side?: 'both' | 'left' | 'right' }
  | { op: 'recent' | 'latest'; n?: number }
  | { op: 'timeline'; sessionId?: string; aroundId?: string; window?: number }
  | { op: 'before' | 'after'; time: string }
  | { op: 'between'; from: string; to: string; inclusive?: boolean }
  | { op: 'session'; sessionId: string }
  | { op: 'related'; depth?: number; limit?: number }
  | { op: 'backlinks' | 'references'; types?: string[]; edges?: boolean }
  | { op: 'traverse'; edgeTypes?: string[]; direction?: 'out' | 'in' | 'both'; maxDepth: number; maxNodes: number; edges?: boolean }
  | { op: 'text'; action: 'grep' | 'cut' | 'trim' | 'split' | 'replace'; args: Record<string, unknown> };

export interface SearchSpec { mode: SearchMode; text: string; caseSensitive?: boolean; allowDowngrade?: boolean }
export interface QueryAst {
  version: 1;
  from: SourceName | 'saved';
  /** Name of a saved query when from = "saved". */
  saved?: string;
  scope?: QueryScope;
  search?: SearchSpec;
  where?: Expr;
  orderBy?: SortKey[];
  pipe?: QueryOp[];
  limit?: number;
  cursor?: string;
}

/** Everything trusted comes from the host, never from the query. */
export interface QueryContext {
  principalId: string;
  deadlineMs: number;
  maxRows: number;
  maxBytes: number;
  /** Blocking operators (sort, group, distinct, join build side, tail) may hold at most this many rows; there is no silent spill. */
  maxBufferRows: number;
  maxGraphNodes: number;
  /** Upper bound on documents read from Markdown for one query. */
  maxDocuments: number;
  maxDepth: number;
  allowCursorDrift?: boolean;
  /** Host-assigned default scope for queries that name none (e.g. the bound workspace). Never taken from the query. */
  defaultScope?: QueryScope;
  abortSignal?: AbortSignal;
}
export const DEFAULT_LIMITS = { deadlineMs: 30_000, maxRows: 10_000, maxBytes: 8_000_000, maxBufferRows: 200_000, maxGraphNodes: 5_000, maxDocuments: 100_000, maxDepth: 8 } as const;

export interface PlanStage { op: string; in: StreamType; out: StreamType; blocking: boolean; note?: string }
export interface QueryPlanSummary {
  version: 1; source: string; backend: string; scopes: number; stages: PlanStage[];
  pushedDown: string[]; hydratesDocuments: boolean; candidateEstimate: number | null; blockingStages: string[]; warnings: string[]; snapshot: string;
}
export interface QueryStats {
  snapshot: string; backend: string; candidates: number; documentsRead: number; rowsOut: number; bytesOut: number; elapsedMs: number; firstRowMs: number | null; searchPages: number; /** documents read by the retrieval layer for text search (in addition to documentsRead, which counts the query engine's own reads) */ searchDocumentsLoaded: number; textPrefilter?: string;
}
/** What actually ran for the text search: requested is what the query asked for, mode is what executed (auto may become hybrid; a downgrade is labelled in `fallback`). */
export interface SearchReport { requested: string; mode: string; ranking?: string; backend: string }
export interface QueryResult { search?: SearchReport; rows: unknown[]; type: StreamType; cursor?: string; truncated?: 'rows' | 'bytes' | 'deadline'; stats: QueryStats; fallback?: string; plan?: QueryPlanSummary }

export type StreamType = 'documents' | 'records' | 'lines' | 'edges' | 'groups' | 'scalar' | 'hits';
