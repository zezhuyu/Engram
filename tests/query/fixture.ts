import type { Candidate, CandidateRequest, CandidateSource, Edge, GraphView, HydratedDocument, SnapshotHandle } from '../../packages/query/backends/candidates.js';
import { evaluate, type Row } from '../../packages/query/rows.js';
import { queryError } from '../../packages/query/ast.js';

export interface FixtureDoc { id: string; title?: string; type?: string; workspace?: string; collection?: string; area?: string; tags?: string[]; eventTime?: string; sessionId?: string; body?: string; links?: string[]; extra?: Row; meta?: Record<string, unknown> }
export interface FixtureOptions { shuffle?: boolean; ignoreFilters?: boolean; hidden?: Set<string> }

/** In-memory CandidateSource used to test the engine independently of the vault. It deliberately returns UNORDERED supersets (ignoring filters) when asked, to prove the engine never relies on pushdown. */
export class FixtureSource implements CandidateSource {
  hydrations = 0; opened = 0; released = 0; lastRequest?: CandidateRequest; saved = new Map<string, unknown>();
  constructor(readonly docs: FixtureDoc[], readonly options: FixtureOptions = {}) {}
  private row(d: FixtureDoc): Row {
    const r: Row = { id: d.id, revision: `r-${d.id}`, type: d.type ?? 'note', kind: d.type ?? 'note', title: d.title ?? d.id, path: `mdb://fixture/${d.id}`, tags: d.tags ?? [], status: 'active', scope: d.workspace ? `workspace:${d.workspace}` : `global:${d.area ?? 'wiki'}`, visibility: d.workspace ? 'workspace' : 'global', updatedAt: d.eventTime ?? '2026-01-01T00:00:00.000Z', eventTime: d.eventTime ?? '2026-01-01T00:00:00.000Z', ...(d.extra ?? {}) };
    if (d.workspace) r.workspace = d.workspace; else r.area = d.area ?? 'wiki'; if (d.collection) r.collection = d.collection; if (d.sessionId) r.sessionId = d.sessionId; return r;
  }
  private visible(): FixtureDoc[] { return this.docs.filter(d => !this.options.hidden?.has(d.id)); }
  capabilities() { return { honorsOrder: false, exact: true, keyword: true, regex: true, semantic: false, hybrid: false, auto: true, backend: 'fixture' }; }
  searchInfo() { return undefined; }
  async loadSaved(name: string): Promise<unknown> { if (!this.saved.has(name)) throw queryError('QUERY_INVALID', `No readable saved query named "${name}"`); return this.saved.get(name); }
  async open(): Promise<SnapshotHandle> {
    this.opened++; const self = this; const visible = this.visible(); const byId = new Map(visible.map(d => [d.id, d]));
    const view: GraphView = {
      node: id => byId.has(id) ? self.row(byId.get(id)!) : undefined,
      out: id => (byId.get(id)?.links ?? []).filter(t => byId.has(t) && t !== id).map(t => ({ type: 'references', to: self.row(byId.get(t)!) })),
      in: id => visible.filter(d => d.id !== id && (d.links ?? []).includes(id)).sort((a, b) => a.id < b.id ? -1 : 1).map(d => ({ type: 'references', from: self.row(d) })),
      *edges(): Iterable<Edge> { for (const d of [...visible].sort((a, b) => a.id < b.id ? -1 : 1)) for (const t of d.links ?? []) if (byId.has(t) && t !== d.id) yield { fromId: d.id, toId: t, type: 'references', fromTitle: d.title ?? d.id, toTitle: byId.get(t)!.title ?? t, fromPath: `mdb://fixture/${d.id}`, toPath: `mdb://fixture/${t}` }; }
    };
    return {
      token: `fx.${this.opened}`, sequence: 1, backend: 'fixture',
      hydrate: async (row): Promise<HydratedDocument | undefined> => { self.hydrations++; const d = byId.get(row.id as string); if (!d) return undefined; return { id: d.id, revision: row.revision as string, body: d.body ?? '', links: [], evidence: [], meta: d.meta ?? {}, createdAt: d.eventTime ?? '2026-01-01T00:00:00.000Z', createdBy: 'fixture', revisionNumber: 1 }; },
      graph: () => view, estimate: () => visible.length, release: () => { self.released++; }
    };
  }
  async *candidates(request: CandidateRequest): AsyncGenerator<Candidate> {
    this.lastRequest = request; let list = this.visible().filter(d => request.source === 'observations' ? !!d.sessionId : true);
    if (request.search) { const q = request.search.text.toLowerCase(); list = list.filter(d => `${d.title ?? ''}\n${d.body ?? ''}`.toLowerCase().includes(q)); }
    if (!this.options.ignoreFilters && request.filters) list = list.filter(d => evaluate(request.filters!, this.row(d)));
    if (this.options.shuffle) list = [...list].reverse();
    for (const d of list) yield { objectId: d.id, revision: `r-${d.id}`, row: this.row(d) };
  }
}
export const ids = (rows: unknown[]): string[] => rows.map(r => (r as { id: string }).id);
