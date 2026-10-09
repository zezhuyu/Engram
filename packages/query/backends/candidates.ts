import type { Expr, QueryScope, SearchSpec, SortKey, SourceName } from '../ast.js';
import type { Row } from '../rows.js';

/**
 * The seam between the query engine and retrieval. The engine never lists documents itself: it asks a CandidateSource for candidate rows (manifest-level fields only),
 * applies the remaining operators, and reads Markdown only for rows that need body or metadata (hydrate), pinned to the snapshot revision.
 * A source MUST return a superset of the rows that match `filters`/`search` that its principal may read, and MUST NOT return anything unreadable.
 */
export interface CandidateRequest {
  principalId: string; source: SourceName; scope: QueryScope | undefined; snapshot: string;
  search?: SearchSpec; filters?: Expr; order?: SortKey[]; limitHint?: number;
}
export interface Candidate { objectId: string; /** revision id pinned by the snapshot */ revision: string; row: Row; optionalSnippet?: string }
export interface HydratedDocument { id: string; revision: string; body: string; links: unknown[]; evidence: unknown[]; meta: Record<string, unknown>; createdAt: string; createdBy: string; revisionNumber: number }
export interface Edge { fromId: string; toId: string; type: string; fromTitle: string; toTitle: string; fromPath: string; toPath: string }
/** Read-only graph over the snapshot. Only edges with two readable endpoints exist here; there is no way to ask about an unreadable object. */
export interface GraphView {
  node(id: string): Row | undefined;
  out(id: string): Array<{ type: string; to: Row }>;
  in(id: string): Array<{ type: string; from: Row }>;
  edges(): Iterable<Edge>;
  /** related(): neighbours in either direction, breadth first. */
}
export interface SnapshotHandle {
  token: string; sequence: number; backend: string;
  hydrate(row: Row): Promise<HydratedDocument | undefined>;
  graph(): GraphView;
  /** Objects readable at this snapshot that match the source and scope (authorized count only; used by explain). */
  estimate(request: Omit<CandidateRequest, 'search'>): number;
  release(): void;
}
export interface SearchInfo { /** mode that actually ran (keyword, grep, semantic, hybrid) */ mode?: string; requestedMode?: string; ranking?: string; /** Markdown documents the retrieval layer itself read to answer (its survivors), summed over pages */ loaded: number; backend: string; fallback?: string; pages: number; textPrefilter?: string; driftChecked: number }
export interface CandidateSource {
  open(): Promise<SnapshotHandle>;
  candidates(request: CandidateRequest, signal?: AbortSignal): AsyncIterable<Candidate>;
  /** Re-reads asynchronous capability facts (for example whether the vector backend is ready) before capabilities() is consulted. */
  refresh?(): Promise<void>;
  capabilities(): { honorsOrder: boolean; exact: boolean; keyword: boolean; regex: boolean; semantic: boolean; hybrid: boolean; auto: boolean; backend: string };
  /** Details of the most recent search for this request token (backend, fallback notes). */
  searchInfo(token: string): SearchInfo | undefined;
  loadSaved(name: string, principalId: string): Promise<unknown>;
}
