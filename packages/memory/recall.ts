import { MDBError, type Document, type Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { manifestFor, type ManifestEntry } from '../search-files/manifest.js';
import { scopeMatches } from '../search-files/index.js';
import { SearchEngine } from '../search-sqlite/index.js';
import { profileAsync, profileSync } from '../bench/instrumentation.js';

export const MEMORY_KINDS = ['observation', 'note', 'decision', 'finding', 'insight', 'reflection', 'session', 'working_memory', 'procedure', 'analysis'];
export type RecallMode = 'recent' | 'timeline' | 'time_range' | 'grep' | 'regex' | 'keyword' | 'semantic' | 'hybrid' | 'links' | 'auto';
export interface MemorySearchRequest {
  /** Accepted only if it equals the transport-bound identity; never used for authorization. */
  principalId?: string;
  scope?: 'current_collection' | 'workspace' | 'shared' | 'authorized_all'; workspaceId?: string; collectionId?: string;
  mode: RecallMode; query?: string; from?: string; to?: string; types?: string[]; sessionId?: string; aroundId?: string; window?: number;
  limit?: number; cursor?: string; detail?: 'index' | 'snippet' | 'full'; tokenBudget?: number;
}
export interface MemoryItem { id: string; uri: string; revisionId: string; kind: string; eventType?: string; speaker?: string; at: string; title: string; sessionId?: string; hostSessionId?: string; scope: Scope; snippet?: string; body?: string; relevance?: number }
export interface MemoryPage { items: MemoryItem[]; cursor?: string; truncated: boolean; mode: string; backend?: string; fallback?: string; note?: string; estimatedTokens: number }
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3); // conservative for CJK-heavy text
const fail = (code: string, message: string): never => { throw new MDBError(code, message); };
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
/** Date-only values mean the start of that UTC day; times without an offset are rejected so timezone meaning is never guessed. */
export function parseWhen(value: string | undefined, name: string, endOfDay = false): string | undefined {
  if (!value) return undefined;
  if (!ISO.test(value)) fail('INVALID_INPUT', `${name} must be ISO 8601`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { const ms = Date.parse(`${value}T00:00:00.000Z`); if (!Number.isFinite(ms)) fail('INVALID_INPUT', `${name} is not a valid date`); return new Date(endOfDay ? ms + 86_399_999 : ms).toISOString(); }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) fail('INVALID_INPUT', `${name} needs a UTC offset (for example Z or +02:00)`);
  const ms = Date.parse(value.replace(' ', 'T')); if (!Number.isFinite(ms)) fail('INVALID_INPUT', `${name} is not a valid time`);
  return new Date(ms).toISOString();
}
const encode = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
function decode(cursor: string | undefined): [string, string] | undefined { if (!cursor) return undefined; try { const v = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]]; } catch { /* fall through */ } return fail('INVALID_INPUT', 'Invalid cursor'); }
const byTimeDesc = (a: ManifestEntry, b: ManifestEntry) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const byTimeAsc = (a: ManifestEntry, b: ManifestEntry) => byTimeDesc(b, a);

export class MemoryRecall {
  private readonly search: SearchEngine;
  constructor(private readonly vault: Vault, search?: SearchEngine) { this.search = search ?? new SearchEngine(vault); }

  private scopes(req: MemorySearchRequest): Scope[] | undefined {
    switch (req.scope ?? 'authorized_all') {
      case 'current_collection': if (!req.workspaceId || !req.collectionId) return fail('INVALID_INPUT', 'current_collection needs workspaceId and collectionId'); return [{ type: 'workspace', workspaceId: req.workspaceId, collectionId: req.collectionId }];
      case 'workspace': if (!req.workspaceId) return fail('INVALID_INPUT', 'workspace scope needs workspaceId'); return [{ type: 'workspace', workspaceId: req.workspaceId }];
      case 'shared': return [{ type: 'global', area: 'shared' }, { type: 'global', area: 'wiki' }];
      case 'authorized_all': return undefined;
      default: return fail('INVALID_INPUT', 'Unknown scope');
    }
  }
  private async entries(req: MemorySearchRequest, options: { defaultTypes?: boolean } = {}): Promise<ManifestEntry[]> {
    if (req.principalId !== undefined && req.principalId !== this.vault.actor.actorId) fail('NOT_FOUND_OR_FORBIDDEN', 'Identity is bound by the transport and cannot be asserted');
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const allowed = await manifest.readableScopes(); const filters = this.scopes(req);
    const from = parseWhen(req.from, 'from'), to = parseWhen(req.to, 'to', true);
    const types = req.types?.length ? new Set(req.types) : options.defaultTypes === false ? undefined : new Set(MEMORY_KINDS);
    const out: ManifestEntry[] = [];
    for (const sk of allowed) for (const id of manifest.byScope.get(sk) ?? []) {
      const e = manifest.entries.get(id)!;
      if (e.status === 'deleted' || e.status === 'tombstone') continue;
      if (filters && !filters.some(s => scopeMatches(e.scope, s))) continue;
      if (types && !types.has(e.kind) && !(e.et && types.has(e.et))) continue;
      if ((from && e.at < from) || (to && e.at > to)) continue;
      out.push(e);
    }
    return out;
  }
  private async materialize(entries: ManifestEntry[], req: MemorySearchRequest, base: { mode: string; truncatedBy?: 'limit' }): Promise<MemoryPage> {
    const detail = req.detail ?? 'index'; const budget = req.tokenBudget; let used = 0, truncated = false; const items: MemoryItem[] = [];
    for (const e of entries) {
      let item: MemoryItem = { id: e.id, uri: this.uriOf(e), revisionId: e.rev, kind: e.kind, ...(e.et ? { eventType: e.et } : {}), ...(e.sp ? { speaker: e.sp } : {}), at: e.at, title: e.title, ...(e.sid ? { sessionId: e.sid } : {}), ...(e.hs ? { hostSessionId: e.hs } : {}), scope: e.scope };
      if (detail !== 'index') {
        let doc: Document; try { doc = await this.vault.get(e.id); } catch { continue; } // no longer readable: never returned
        item = detail === 'full' ? { ...item, revisionId: doc.revisionId, body: doc.body } : { ...item, revisionId: doc.revisionId, snippet: doc.body.replace(/\s+/g, ' ').slice(0, 240) };
      }
      const cost = estimateTokens(JSON.stringify(item));
      if (budget !== undefined && used + cost > budget) { truncated = true; break; }
      used += cost; items.push(item);
    }
    return { items, truncated, mode: base.mode, estimatedTokens: used, ...(truncated && !items.length ? { note: 'tokenBudget is smaller than a single record at this detail level; raise it or use detail=index' } : {}) };
  }
  private uriOf(e: ManifestEntry): string { return e.scope.type === 'global' ? `mdb://${e.scope.area}/objects/${e.id}` : `mdb://workspaces/${e.scope.workspaceId}${e.scope.collectionId ? `/collections/${e.scope.collectionId}` : ''}/objects/${e.id}`; }
  private page(sorted: ManifestEntry[], req: MemorySearchRequest, cursorCompare: (e: ManifestEntry, c: [string, string]) => boolean): { slice: ManifestEntry[]; next?: string } {
    const limit = req.limit ?? 20; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_INPUT', 'limit must be 1..200');
    const cursor = decode(req.cursor), slice: ManifestEntry[] = [];
    for (const entry of sorted) {
      if (cursor && !cursorCompare(entry, cursor)) continue;
      if (slice.length === limit) return { slice, next: encode(slice.at(-1)!.at, slice.at(-1)!.id) };
      slice.push(entry);
    }
    return { slice };
  }
  private indexedPage(ordered: readonly ManifestEntry[], eligible: Set<string>, req: MemorySearchRequest, cursorCompare: (e: ManifestEntry, c: [string, string]) => boolean): { slice: ManifestEntry[]; next?: string } {
    const limit = req.limit ?? 20; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_INPUT', 'limit must be 1..200');
    const cursor = decode(req.cursor), slice: ManifestEntry[] = [];
    for (const entry of ordered) {
      if (!eligible.has(entry.id) || (cursor && !cursorCompare(entry, cursor))) continue;
      if (slice.length === limit) return { slice, next: encode(slice.at(-1)!.at, slice.at(-1)!.id) };
      slice.push(entry);
    }
    return { slice };
  }

  /** Newest first by event time, ties broken by id. No model, no index required beyond the journal-synced manifest. */
  async recent(req: Omit<MemorySearchRequest, 'mode'>): Promise<MemoryPage> {
    const entries = await profileAsync('memory.recent.entry_discovery', () => this.entries({ ...req, mode: 'recent' }));
    const manifest = await manifestFor(this.vault); const eligible = new Set(entries.map(entry => entry.id));
    const { slice, next } = profileSync('memory.recent.sort', () => this.indexedPage(manifest.orderedByTime(), eligible, { ...req, mode: 'recent' }, (e, c) => e.at < c[0] || (e.at === c[0] && e.id < c[1])));
    const page = await profileAsync('memory.recent.materialization', () => this.materialize(slice, { ...req, mode: 'recent' }, { mode: 'recent' }));
    return { ...page, ...(next && !page.truncated ? { cursor: next } : page.truncated && page.items.length ? { cursor: encode(page.items.at(-1)!.at, page.items.at(-1)!.id) } : {}) };
  }
  /** Chronological order (oldest first) between two instants. */
  async timeRange(req: Omit<MemorySearchRequest, 'mode'>): Promise<MemoryPage> {
    if (!req.from && !req.to) fail('INVALID_INPUT', 'time_range needs from and/or to');
    const entries = await this.entries({ ...req, mode: 'time_range' });
    const manifest = await manifestFor(this.vault); const eligible = new Set(entries.map(entry => entry.id));
    const { slice, next } = profileSync('memory.time_range.sort', () => this.indexedPage(manifest.orderedByTime(false), eligible, { ...req, mode: 'time_range' }, (e, c) => e.at > c[0] || (e.at === c[0] && e.id > c[1])));
    const page = await this.materialize(slice, { ...req, mode: 'time_range' }, { mode: 'time_range' });
    return { ...page, ...(next && !page.truncated ? { cursor: next } : page.truncated && page.items.length ? { cursor: encode(page.items.at(-1)!.at, page.items.at(-1)!.id) } : {}) };
  }
  /** One session in order, or the neighbours of one record. Raw chronological records, never summaries. */
  async timeline(req: Omit<MemorySearchRequest, 'mode'>): Promise<MemoryPage> {
    const all = await this.entries({ ...req, mode: 'timeline', types: req.types?.length ? req.types : undefined }, { defaultTypes: !req.types?.length });
    let sessionKey = req.sessionId;
    if (req.aroundId) { const anchor = all.find(e => e.id === req.aroundId); if (!anchor) return { items: [], truncated: false, mode: 'timeline', estimatedTokens: 0 }; sessionKey = anchor.sid ?? anchor.id; }
    if (!sessionKey) fail('INVALID_INPUT', 'timeline needs sessionId or aroundId');
    const inSession = all.filter(e => e.sid === sessionKey || e.hs === sessionKey || e.id === sessionKey).sort(byTimeAsc);
    let slice = inSession;
    if (req.aroundId) { const i = inSession.findIndex(e => e.id === req.aroundId); const w = Math.min(50, Math.max(0, req.window ?? 5)); slice = inSession.slice(Math.max(0, i - w), i + w + 1); }
    const { slice: paged, next } = this.page(slice, { ...req, mode: 'timeline' }, (e, c) => e.at > c[0] || (e.at === c[0] && e.id > c[1]));
    const page = await this.materialize(paged, { ...req, mode: 'timeline' }, { mode: 'timeline' });
    return { ...page, ...(next && !page.truncated ? { cursor: next } : page.truncated && page.items.length ? { cursor: encode(page.items.at(-1)!.at, page.items.at(-1)!.id) } : {}) };
  }
  /** Batch fetch of identified objects, bounded by a token budget. Unreadable and missing ids are indistinguishable. */
  async get(ids: string[], options: { tokenBudget?: number } = {}): Promise<{ items: MemoryItem[]; unavailable: string[]; truncated: boolean; estimatedTokens: number }> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) fail('INVALID_INPUT', 'Provide 1..50 ids');
    const items: MemoryItem[] = [], unavailable: string[] = []; let used = 0, truncated = false;
    for (const id of ids) {
      let doc: Document; try { doc = await this.vault.get(id); } catch { unavailable.push(id); continue; }
      const item: MemoryItem = { id: doc.id, uri: doc.uri, revisionId: doc.revisionId, kind: doc.kind, ...(typeof doc.metadata.eventType === 'string' ? { eventType: doc.metadata.eventType } : {}), ...(typeof doc.metadata.speaker === 'string' ? { speaker: doc.metadata.speaker } : {}), at: typeof doc.metadata.eventTime === 'string' ? doc.metadata.eventTime : doc.createdAt, title: doc.title, ...(typeof doc.metadata.sessionId === 'string' ? { sessionId: doc.metadata.sessionId } : {}), scope: doc.scope, body: doc.body };
      const cost = estimateTokens(JSON.stringify(item)); if (options.tokenBudget !== undefined && used + cost > options.tokenBudget) { truncated = true; unavailable.push(id); continue; }
      used += cost; items.push(item);
    }
    return { items, unavailable, truncated, estimatedTokens: used };
  }

  /** One entry point for every mode. Lexical modes use the same engine (filesystem or SQLite) as everything else; semantic and hybrid are honest about being unavailable. */
  async query(req: MemorySearchRequest): Promise<MemoryPage> {
    const mode = req.mode === 'auto' ? (req.query ? 'keyword' : 'recent') : req.mode;
    if (mode === 'recent') return this.recent(req);
    if (mode === 'time_range') return this.timeRange(req);
    if (mode === 'timeline') return this.timeline(req);
    if (!req.query?.trim() && mode !== 'links') fail('INVALID_INPUT', `${mode} needs a query`);
    if (req.principalId !== undefined && req.principalId !== this.vault.actor.actorId) fail('NOT_FOUND_OR_FORBIDDEN', 'Identity is bound by the transport and cannot be asserted');
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const from = parseWhen(req.from, 'from'), to = parseWhen(req.to, 'to', true);
    const types = req.types?.length ? new Set(req.types) : undefined;
    const keep = (e: ManifestEntry | undefined): e is ManifestEntry => !!e && (!from || e.at >= from) && (!to || e.at <= to) && (!types || types.has(e.kind) || (!!e.et && types.has(e.et)));
    let ordered: ManifestEntry[] = []; let backend: string | undefined; let fallback: string | undefined; let relevance = new Map<string, number>();
    if (mode === 'links') { ordered = (await this.search.related(String(req.query), 1)).map(d => manifest.entries.get(d.id)).filter(keep); }
    else {
      const filters = this.scopes(req); const kinds = types ? [...types].filter(t => MEMORY_KINDS.includes(t) || !t.includes('.')) : undefined;
      const result = await this.search.query({ query: req.query!, mode: req.mode === 'auto' && mode === 'keyword' ? 'auto' : mode === 'keyword' || mode === 'semantic' || mode === 'hybrid' ? mode : 'grep', ...(mode === 'regex' ? { regex: true } : {}), ...(filters ? { scopes: filters } : {}), ...(kinds?.length ? { kinds } : {}), limit: 1000 });
      backend = result.backend; fallback = result.fallback; relevance = new Map(result.hits.map(h => [h.objectId, h.score]));
      ordered = result.hits.map(h => manifest.entries.get(h.objectId)).filter(keep);
    }
    const limit = req.limit ?? 20; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_INPUT', 'limit must be 1..200');
    const offset = Number(req.cursor ?? '0'); if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_INPUT', 'Invalid cursor');
    const slice = ordered.slice(offset, offset + limit);
    const page = await this.materialize(slice, { ...req, detail: req.detail ?? 'snippet' }, { mode });
    page.items.forEach(i => { const r = relevance.get(i.id); if (r !== undefined) i.relevance = r; });
    const consumed = page.items.length;
    return { ...page, ...(backend ? { backend } : {}), ...(fallback ? { fallback } : {}), ...(offset + consumed < ordered.length ? { cursor: String(offset + consumed) } : {}) };
  }

  /** Searches user insights with their evidence. Superseded and rejected items are hidden unless asked for by status. Respects the same access rules as every other read. */
  async insights(input: { query?: string; category?: string; status?: string; evidenceClass?: string; scopeLabel?: string; limit?: number }): Promise<MemoryPage & { insights: Array<{ id: string; claim: string; category?: string; status: string; evidenceClass?: string; confidence?: string; scope: string; sources: unknown[]; supersededBy?: string }> }> {
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const limit = input.limit ?? 20; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'limit must be 1..100');
    let entries: ManifestEntry[];
    if (input.query?.trim()) { const result = await this.search.query({ query: input.query, mode: 'keyword', kinds: ['user_insight'], limit: 200 }); entries = result.hits.map(h => manifest.entries.get(h.objectId)).filter((e): e is ManifestEntry => !!e); }
    else { const allowed = await manifest.readableScopes(); entries = [...manifest.entries.values()].filter(e => e.kind === 'user_insight' && allowed.has(e.sk)).sort(byTimeDesc); }
    const items: MemoryItem[] = []; const insights = [];
    for (const e of entries) {
      if (e.status === 'deleted' || (input.status ? e.status !== input.status : ['superseded', 'rejected'].includes(e.status))) continue;
      if (input.category && e.cat !== input.category) continue;
      let doc: Document; try { doc = await this.vault.get(e.id); } catch { continue; }
      if (input.evidenceClass && doc.metadata.evidenceClass !== input.evidenceClass) continue;
      if (input.scopeLabel && (typeof doc.metadata.scopeLabel === 'string' ? doc.metadata.scopeLabel : 'global') !== input.scopeLabel) continue;
      items.push({ id: doc.id, uri: doc.uri, revisionId: doc.revisionId, kind: doc.kind, at: doc.updatedAt, title: doc.title, scope: doc.scope, snippet: doc.body.replace(/\s+/g, ' ').slice(0, 300) });
      insights.push({ id: doc.id, claim: doc.body, ...(typeof doc.metadata.category === 'string' ? { category: doc.metadata.category } : {}), status: doc.status, ...(typeof doc.metadata.evidenceClass === 'string' ? { evidenceClass: doc.metadata.evidenceClass } : {}), ...(typeof doc.metadata.confidenceLabel === 'string' ? { confidence: doc.metadata.confidenceLabel } : {}), scope: typeof doc.metadata.scopeLabel === 'string' ? doc.metadata.scopeLabel : doc.scope.type === 'global' ? 'global' : doc.scope.workspaceId, sources: Array.isArray(doc.metadata.sources) ? doc.metadata.sources : [], ...(typeof doc.metadata.supersededBy === 'string' ? { supersededBy: doc.metadata.supersededBy } : {}) });
      if (items.length >= limit) break;
    }
    return { items, insights, truncated: false, mode: 'insight', estimatedTokens: estimateTokens(JSON.stringify(items)) };
  }
}
