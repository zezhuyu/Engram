import { randomBytes } from 'node:crypto';
import { MDBError, type Document, type Scope, type SearchInput } from '../../core/types.js';
import { documentUri } from '../../core/vault.js';
import { Vault } from '../../core/vault.js';
import { SearchEngine } from '../../search-files/index.js';
import { searchDocuments } from '../../search-files/index.js';
import { manifestFor, type ManifestEntry } from '../../search-files/manifest.js';
import { queryError, type Expr, type QueryScope, type SearchSpec, type SortKey, type SourceName } from '../ast.js';
import { comparator, evaluate, type Row } from '../rows.js';
import type { Candidate, CandidateRequest, CandidateSource, Edge, GraphView, HydratedDocument, SearchInfo, SnapshotHandle } from './candidates.js';

const LIVE = (e: ManifestEntry) => e.status !== 'deleted' && e.status !== 'tombstone';
const SHARED_AREAS = new Set(['wiki', 'shared', 'discoveries']);

export function entryRow(e: ManifestEntry): Row {
  const row: Row = {
    id: e.id, revision: e.rev, type: e.kind, kind: e.kind, title: e.title, path: documentUri(e.id, e.scope), tags: e.tags, status: e.status,
    scope: e.sk, visibility: e.scope.type === 'global' ? (e.scope.area === 'profile' ? 'user_private' : 'global') : 'workspace',
    updatedAt: normTime(e.updated), eventTime: normTime(e.at)
  };
  if (e.scope.type === 'workspace') { row.workspace = e.scope.workspaceId; if (e.scope.collectionId) row.collection = e.scope.collectionId; } else row.area = e.scope.area;
  if (e.sid) row.sessionId = e.sid; if (e.hs) row.hostSessionId = e.hs; if (e.et) row.eventType = e.et; if (e.sp) row.speaker = e.sp;
  if (e.pk) row.preferenceKey = e.pk; if (e.ec) row.evidenceClass = e.ec; if (e.cat) row.category = e.cat; if (e.ex !== undefined) row.explicit = e.ex; if (e.dom) row.domain = e.dom;
  return row;
}
const normTime = (t: string): string => { const ms = Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toISOString() : t; };
const isObservation = (e: ManifestEntry): boolean => !!e.sid || !!e.et || e.kind === 'observation';
export function inSource(source: SourceName, e: ManifestEntry): boolean {
  switch (source) {
    case 'observations': return isObservation(e);
    case 'wiki': return e.kind === 'wiki_page' || (e.scope.type === 'global' && e.scope.area === 'wiki');
    case 'insights': return e.kind === 'user_insight' || e.kind === 'insight';
    case 'discoveries': return e.kind === 'discovery';
    default: return true;
  }
}
export function inScope(e: ManifestEntry, scope: QueryScope | undefined, source: SourceName): boolean {
  if (!scope || (!scope.workspace && scope.includeShared === undefined)) return true;
  const sc = e.scope;
  if (scope.workspace) {
    if (sc.type === 'workspace') return sc.workspaceId === scope.workspace && (!scope.collection || sc.collectionId === scope.collection);
    const shared = scope.includeShared ?? true; return shared && (SHARED_AREAS.has(sc.area) || (source === 'insights' && sc.area === 'profile'));
  }
  return scope.includeShared === false ? sc.type === 'workspace' : true;
}
function searchScopes(scope: QueryScope | undefined, source: SourceName): Scope[] | undefined {
  if (!scope?.workspace) return scope?.includeShared === false ? undefined : undefined;
  const list: Scope[] = [{ type: 'workspace', workspaceId: scope.workspace, ...(scope.collection ? { collectionId: scope.collection } : {}) }];
  if (scope.includeShared ?? true) { const areas: Array<'wiki' | 'shared' | 'discoveries' | 'profile'> = ['wiki', 'shared', 'discoveries']; if (source === 'insights') areas.push('profile'); for (const area of areas) list.push({ type: 'global', area }); }
  return list;
}
const SOURCE_KINDS: Partial<Record<SourceName, string[]>> = { wiki: ['wiki_page'], insights: ['user_insight', 'insight'], discoveries: ['discovery'] };

class Snapshot implements SnapshotHandle {
  readonly backend = 'manifest';
  private view?: GraphView; private readonly docs = new Map<string, Promise<Document | undefined>>();
  constructor(readonly token: string, readonly sequence: number, readonly vault: Vault, readonly entries: Map<string, ManifestEntry>, private readonly lookup: Map<string, ManifestEntry>, private readonly ensureLookup: () => void, private readonly manifestRefs: (e: ManifestEntry) => Iterable<[string, string]>, private readonly referencedBy: Map<string, Set<string>>, private readonly onRelease: (t: string) => void) {}
  async hydrate(row: Row): Promise<HydratedDocument | undefined> {
    const id = row.id as string, revision = row.revision as string; const e = this.entries.get(id); if (!e || e.rev !== revision) return undefined;
    let pending = this.docs.get(id); if (!pending) { pending = this.vault.get(id, revision).catch(() => undefined); this.docs.set(id, pending); }
    const doc = await pending; if (!doc) return undefined;
    return { id: doc.id, revision: doc.revisionId, body: doc.body, links: doc.links, evidence: doc.evidence, meta: doc.metadata, createdAt: doc.createdAt, createdBy: doc.createdBy, revisionNumber: doc.revisionNumber };
  }
  estimate(request: Omit<CandidateRequest, 'search'>): number {
    let n = 0; for (const e of this.entries.values()) if (inSource(request.source, e) && inScope(e, request.scope, request.source) && (!request.filters || evaluate(request.filters, entryRow(e)))) n++; return n;
  }
  graph(): GraphView {
    if (this.view) return this.view;
    this.ensureLookup();
    const live = new Map([...this.entries].filter(([, e]) => LIVE(e)));
    const resolve = (raw: string): ManifestEntry | undefined => { const t = this.lookup.get(raw); return t && live.has(t.id) ? live.get(t.id) : undefined; };
    const outgoing = (e: ManifestEntry): Array<{ type: string; to: ManifestEntry }> => {
      const seen = new Set<string>(), out: Array<{ type: string; to: ManifestEntry }> = [];
      for (const [type, raw] of this.manifestRefs(e)) { const to = resolve(raw); if (!to || to.id === e.id) continue; const k = `${type}\0${to.id}`; if (seen.has(k)) continue; seen.add(k); out.push({ type, to }); }
      return out;
    };
    const rows = new Map<string, Row>(); const node = (e: ManifestEntry): Row => { let r = rows.get(e.id); if (!r) { r = entryRow(e); rows.set(e.id, r); } return r; };
    const keysOf = (e: ManifestEntry) => [e.id, documentUri(e.id, e.scope), e.title];
    this.view = {
      node: id => { const e = live.get(id); return e ? node(e) : undefined; },
      out: id => { const e = live.get(id); return e ? outgoing(e).map(o => ({ type: o.type, to: node(o.to) })) : []; },
      in: id => {
        const target = live.get(id); if (!target) return []; const seen = new Set<string>(); const found: Array<{ type: string; from: Row }> = [];
        for (const key of keysOf(target)) { if (this.lookup.get(key)?.id !== target.id) continue; for (const sid of this.referencedBy.get(key) ?? []) { const src = live.get(sid); if (!src || src.id === target.id) continue; for (const o of outgoing(src)) if (o.to.id === target.id) { const k = `${o.type}\0${src.id}`; if (!seen.has(k)) { seen.add(k); found.push({ type: o.type, from: node(src) }); } } } }
        return found.sort((a, b) => (a.from.id as string) < (b.from.id as string) ? -1 : 1);
      },
      *edges(): Iterable<Edge> { for (const e of [...live.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) for (const o of outgoing(e)) yield { fromId: e.id, toId: o.to.id, type: o.type, fromTitle: e.title, toTitle: o.to.title, fromPath: documentUri(e.id, e.scope), toPath: documentUri(o.to.id, o.to.scope) }; }
    };
    return this.view;
  }
  release(): void { this.onRelease(this.token); }
}

const SEARCH_PAGE = 1000;
/** CandidateSource over the Vault, its derived manifest and the existing (index-backed) SearchEngine. Authorization is evaluated per query from live ACL files; indexes are never an authorization boundary. */
export class VaultCandidateSource implements CandidateSource {
  private readonly open_ = new Map<string, Snapshot>(); private readonly infos = new Map<string, SearchInfo>();
  constructor(readonly vault: Vault, readonly search: SearchEngine = new SearchEngine(vault)) {}
  private vectorReady = false; private vectorReason = '';
  async refresh(): Promise<void> { const st = await this.search.vectors.status().catch(e => ({ ready: false, reason: (e as Error).message })); this.vectorReady = st.ready; this.vectorReason = st.ready ? '' : (st.reason ?? ''); }
  capabilities() { return { honorsOrder: true, exact: true, keyword: true, regex: true, semantic: this.vectorReady, hybrid: this.vectorReady, semanticReason: this.vectorReason, auto: true, backend: process.env.MDB_NO_SQLITE === '1' ? 'filesystem' : 'filesystem+sqlite-if-enabled' }; }
  searchInfo(token: string): SearchInfo | undefined { return this.infos.get(token); }

  async open(): Promise<SnapshotHandle> {
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const allowed = await manifest.readableScopes();
    // Everything below is synchronous: the copy is a consistent cut of the manifest at `sequence`.
    const entries = new Map<string, ManifestEntry>();
    for (const sk of allowed) for (const id of manifest.byScope.get(sk) ?? []) { const e = manifest.entries.get(id); if (e && LIVE(e)) entries.set(id, e); }
    // reference resolution (id, uri, title; later objects win, same rule as links/backlinks) is only needed by graph operators: built on first use
    const lookup = new Map<string, ManifestEntry>(); let lookupBuilt = false;
    const buildLookup = () => { if (lookupBuilt) return; lookupBuilt = true; for (const e of [...entries.values()].sort((a, b) => a.first - b.first)) for (const key of [e.id, documentUri(e.id, e.scope), e.title]) lookup.set(key, e); };
    const token = `${manifest.sequence}.${randomBytes(4).toString('hex')}`;
    const snap = new Snapshot(token, manifest.sequence, this.vault, entries, lookup, buildLookup, e => e.refs, manifest.referencedBy, t => { this.open_.delete(t); this.infos.delete(t); });
    this.open_.set(token, snap); return snap;
  }

  async *candidates(request: CandidateRequest, signal?: AbortSignal): AsyncGenerator<Candidate> {
    const snap = this.open_.get(request.snapshot); if (!snap) throw queryError('SNAPSHOT_EXPIRED', 'The read snapshot is no longer available');
    const match = (e: ManifestEntry): boolean => inSource(request.source, e) && inScope(e, request.scope, request.source) && (!request.filters || evaluate(request.filters, entryRow(e)));
    if (!request.search) {
      const rows = [...snap.entries.values()].filter(match).map(e => ({ e, row: entryRow(e) }));
      rows.sort(request.order?.length ? ((cmp) => (a: { row: Row }, b: { row: Row }) => cmp(a.row, b.row))(comparator(request.order)) : (a, b) => a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0);
      for (const { e, row } of rows) { if (signal?.aborted) return; yield { objectId: e.id, revision: e.rev, row }; }
      return;
    }
    const s = request.search; const info: SearchInfo = { backend: 'filesystem', pages: 0, driftChecked: 0, loaded: 0 }; this.infos.set(request.snapshot, info);
    // semantic and hybrid run only when the SQLite-backed vector index is ready; otherwise they fail (CAPABILITY_UNAVAILABLE) unless a labelled keyword downgrade was requested
    let effective: SearchSpec['mode'] = s.mode; let downgraded = false;
    if ((s.mode === 'semantic' || s.mode === 'hybrid') && s.allowDowngrade) { const st = await this.search.vectors.status().catch(() => ({ ready: false, reason: 'unavailable' })); if (!st.ready) { effective = 'keyword'; downgraded = true; info.fallback = `${s.mode} unavailable (${st.reason ?? 'vector backend not ready'}): results are keyword matches, not ${s.mode}`; } }
    const kinds = SOURCE_KINDS[request.source];
    const input: SearchInput = {
      query: s.text, mode: effective === 'exact' || effective === 'regex' ? 'grep' : effective,
      ...(s.mode === 'regex' ? { regex: true, caseSensitive: s.caseSensitive ?? false } : s.mode === 'exact' ? { caseSensitive: s.caseSensitive ?? true } : s.caseSensitive ? { caseSensitive: true } : {}),
      ...(kinds ? { kinds } : {}), ...(searchScopes(request.scope, request.source) ? { scopes: searchScopes(request.scope, request.source)! } : {}), limit: request.limitHint !== undefined ? Math.max(1, Math.min(SEARCH_PAGE, request.limitHint)) : SEARCH_PAGE
    };
    // Objects that changed after the snapshot: the search engine may have seen a newer revision than the snapshot pinned, so they are re-verified on the pinned revision.
    const drift = new Set<string>(); for (const ev of await this.vault.journalSince(snap.sequence)) drift.add(ev.objectId);
    const emitted = new Set<string>(); let cursor: string | undefined; let total = 0;
    do {
      if (signal?.aborted) return;
      let result; try { result = await this.search.query({ ...input, ...(cursor ? { cursor } : {}) }); } catch (error) { if (error instanceof MDBError && error.code === 'CAPABILITY_UNAVAILABLE') throw queryError('CAPABILITY_UNAVAILABLE', error.message); throw error; }
      info.pages++; info.backend = result.backend; info.mode = result.mode; info.ranking = result.ranking; if (result.requestedMode) info.requestedMode = result.requestedMode; if (result.fallback && !downgraded) info.fallback = result.fallback; else if (result.fallback) info.fallback += `; ${result.fallback}`;
      const index = (result as { index?: { textPrefilter?: string; loaded?: number } }).index; if (index?.textPrefilter) info.textPrefilter = index.textPrefilter; info.loaded += index?.loaded ?? 0;
      for (const hit of result.hits) {
        const e = snap.entries.get(hit.objectId); if (!e || emitted.has(e.id)) continue;
        if (drift.has(e.id) || e.rev !== hit.revisionId) { drift.add(e.id); continue; }
        if (!match(e)) continue;
        emitted.add(e.id); total++;
        yield { objectId: e.id, revision: e.rev, row: { ...entryRow(e), score: hit.score, snippet: hit.snippet, lineStart: hit.lineStart, lineEnd: hit.lineEnd, retrievalMode: hit.retrievalMode, ...(hit.sources ? { sources: hit.sources } : {}) }, optionalSnippet: hit.snippet };
      }
      cursor = result.cursor; if (total >= SEARCH_PAGE * 100) break;
    } while (cursor);
    for (const id of info.mode === 'semantic' ? [] : [...drift].sort()) { // objects that changed after the snapshot are re-verified lexically; a semantic-only ranking has no pinned-revision check, so they are not guessed
      const e = snap.entries.get(id); if (!e || emitted.has(id) || !match(e)) continue;
      let doc: Document; try { doc = await this.vault.get(id, e.rev); } catch { continue; }
      info.driftChecked++;
      const check = searchDocuments([doc], { ...input, mode: input.mode === 'grep' ? 'grep' : 'keyword', cursor: undefined }, 'drift-check');
      const hit = check.hits[0]; if (!hit) continue;
      emitted.add(id); yield { objectId: id, revision: e.rev, row: { ...entryRow(e), score: hit.score, snippet: hit.snippet, lineStart: hit.lineStart, lineEnd: hit.lineEnd, retrievalMode: hit.retrievalMode }, optionalSnippet: hit.snippet };
    }
  }

  /** The current saved query with this name in exactly this scope, found through the manifest (no documents are listed). */
  async findSaved(name: string, scope: Scope): Promise<{ id: string; revisionId: string } | undefined> {
    const snapshot = await this.open() as Snapshot;
    try { const e = [...snapshot.entries.values()].filter(x => x.kind === 'saved_query' && x.title === name && JSON.stringify(x.scope) === JSON.stringify(scope)).sort((a, b) => b.first - a.first)[0]; return e ? { id: e.id, revisionId: e.rev } : undefined; } finally { snapshot.release(); }
  }
  /** Saved queries are ordinary versioned objects (kind saved_query) read through the Vault, so ACLs apply to them like to any document. */
  async loadSaved(name: string, _principalId: string): Promise<unknown> {
    const snapshot = await this.open(); try {
      const snap = snapshot as Snapshot; const matches = [...snap.entries.values()].filter(e => e.kind === 'saved_query' && e.title === name).sort((a, b) => b.first - a.first);
      for (const e of matches) { const doc = await this.vault.get(e.id, e.rev).catch(() => undefined); if (!doc) continue; try { return JSON.parse(doc.body); } catch { throw queryError('QUERY_INVALID', `Saved query "${name}" is not valid JSON`); } }
      throw queryError('QUERY_INVALID', `No readable saved query named "${name}"`);
    } finally { snapshot.release(); }
  }
}
export type { SortKey, Expr };
