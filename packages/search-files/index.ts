import type { ActorContext, Document, Scope, SearchIndexAdapter, SearchInput, SearchResult } from '../core/types.js';
import { readFile } from 'node:fs/promises';
import { safePath } from '../storage-local/index.js';
import { MDBError } from '../core/types.js';
import { bodyReferences, manifestFor, type ManifestEntry, type ManifestSource } from './manifest.js';
import { assertSearchIdentity, filesPrefilter, retrieve } from './retrieve.js';
import { documentBodyLineOffset } from '../core/vault.js';

export interface SearchVault extends ManifestSource {
  root: string;
  actor: ActorContext;
  config(): Promise<{ sqlite: { enabled: boolean }; postgres?: { enabled: boolean; connectionStringEnv?: string; schema?: string }; embedding?: import('../core/types.js').EmbeddingConfig }>;
  listDocuments(options?: { includeHistory?: boolean; scopes?: Scope[] }): Promise<Document[]>;
  history(id: string): Promise<Document[]>;
}

export function scopeMatches(actual: Scope, filter: Scope): boolean {
  return actual.type === filter.type && (actual.type === 'global'
    ? actual.area === (filter as Extract<Scope, { type: 'global' }>).area
    : actual.workspaceId === (filter as Extract<Scope, { type: 'workspace' }>).workspaceId && (!(filter as Extract<Scope, { type: 'workspace' }>).collectionId || actual.collectionId === (filter as Extract<Scope, { type: 'workspace' }>).collectionId));
}

export async function authorizedDocuments(vault: SearchVault, input: SearchInput, actor: ActorContext): Promise<Document[]> {
  if (input.includeHistory && !actor.permissions.includes('*') && !actor.permissions.includes('history:read')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'History search requires history:read permission');
  if (input.includeRejected && !actor.permissions.includes('*') && !actor.permissions.includes('history:read')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Rejected discovery search requires history:read permission');
  if (actor.actorId !== vault.actor.actorId || actor.permissions.some(permission => !vault.actor.permissions.includes('*') && !vault.actor.permissions.includes(permission))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Search identity must match the trusted vault identity');
  const current = await vault.listDocuments({ includeHistory: input.includeHistory, scopes: input.scopes });
  const scoped = current.filter(doc => (!input.scopes?.length || input.scopes.some(scope => scopeMatches(doc.scope, scope))));
  const documents = scoped;
  return documents.filter(doc => doc.status !== 'deleted' && doc.status !== 'tombstone'
    && (input.includeRejected === true || doc.kind !== 'discovery' || doc.status !== 'rejected')
    && (!input.kinds?.length || input.kinds.includes(doc.kind))
    && (!input.tags?.length || input.tags.every(tag => doc.tags.includes(tag)))
    && (!input.since || doc.updatedAt >= input.since)
    && (!input.until || doc.updatedAt <= input.until));
}

const bodyOffsets = new WeakMap<Document, number>();
/** Lines of front matter before the body, so line numbers refer to the stored Markdown file. Set by mapBodyLines. */
export const lineOffset = (doc: Document): number => bodyOffsets.get(doc) ?? 0;

export async function mapBodyLines(vault: SearchVault, documents: Document[]): Promise<void> {
  await Promise.all(documents.map(async doc => {
    const knownOffset = documentBodyLineOffset(doc);
    if (knownOffset !== undefined) { bodyOffsets.set(doc, knownOffset); return; }
    try {
      const text = await readFile(await safePath(vault.root, `.mdb/objects/${doc.id}/revs/${doc.revisionId}.md`), 'utf8');
      const delimiter = text.indexOf('\n---\n', 4);
      if (text.startsWith('---\n') && delimiter >= 0) {
        const start = delimiter + 5;
        bodyOffsets.set(doc, text.slice(0, start).split('\n').length - 1);
      }
    } catch { /* Synthetic test documents and unavailable current views use body lines. */ }
  }));
}

type Term = { text: string; negate: boolean };
export function keywordGroups(query: string): Term[][] {
  const tokens = query.match(/"[^"]+"|\S+/g) ?? [];
  const groups: Term[][] = [[]];
  let negate = false;
  for (const token of tokens) {
    if (token === 'OR') { groups.push([]); negate = false; }
    else if (token === 'NOT') negate = true;
    else if (token !== 'AND') {
      groups.at(-1)!.push({ text: token.replace(/^"|"$/g, '').toLocaleLowerCase(), negate });
      negate = false;
    }
  }
  return groups.filter(group => group.length);
}

/** Optional per-object facts that tighten the score bound without changing any result. */
export interface BoundHints {
  /** The title already lower-cased (avoids repeating the conversion for every candidate). */
  lowerTitle?: string;
  /** Lower-cased text of the object's Markdown headings ('' = none); absent = unknown, so the heading bonus must be assumed. */
  hd?: string;
  /** A proven upper bound on min(3, occurrences) of `term` in title + body; absent = assume 3. */
  count?: (term: string) => number | undefined;
}
export interface PreparedSearch { mode: string; /** Highest score a document with this (manifest) title can reach: exact title part plus the most the body and heading can add. Used to stop reading early. */ upperBound(title: string, hints?: BoundHints): number; score(doc: Document): SearchResult['hits'][number] | undefined }

export const idRank = (c: number): number => c === 95 ? 0 : c >= 48 && c <= 57 ? c - 47 : c >= 97 && c <= 122 ? c - 86 : -1;
/**
 * Same ordering as String.prototype.localeCompare for strings made only of [_0-9a-z] (the generated object and revision ids: '_' < digits < letters), about 20x faster.
 * Any other character falls back to localeCompare, so the contract never changes.
 */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = idRank(a.charCodeAt(i)), y = idRank(b.charCodeAt(i));
    if (x < 0 || y < 0) return Math.sign(a.localeCompare(b));
    if (x !== y) return x < y ? -1 : 1;
  }
  for (let i = n; i < a.length; i++) if (idRank(a.charCodeAt(i)) < 0) return Math.sign(a.localeCompare(b));
  for (let i = n; i < b.length; i++) if (idRank(b.charCodeAt(i)) < 0) return Math.sign(a.localeCompare(b));
  return a.length < b.length ? -1 : 1;
}

export function prepareSearch(input: SearchInput): PreparedSearch {
  const requested = input.mode ?? 'auto';
  if (requested === 'semantic' || (requested === 'hybrid' && !input.allowFallback)) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Semantic embeddings are not configured; use keyword search or allowFallback for hybrid');
  if (input.regex && requested !== 'grep') throw new MDBError('INVALID_INPUT', 'Regex requires grep mode');
  const mode = requested === 'grep' ? 'grep' : 'keyword';
  validateSearchPage(input);
  if (!input.query.trim()) return { mode, upperBound: () => 0, score: () => undefined };
  let regex: RegExp | undefined;
  if (input.regex) {
    if (input.query.length > 256 || /\)[+*{]|\\[1-9]|\(\?[=!<]/.test(input.query) || (input.query.match(/(?<!\\)[+*]|\{\d/g)?.length ?? 0) > 1) throw new MDBError('INVALID_INPUT', 'Unsafe or oversized regex');
    try { regex = new RegExp(input.query, input.caseSensitive ? '' : 'i'); } catch { throw new MDBError('INVALID_INPUT', 'Invalid regex'); }
  }
  const groups = keywordGroups(input.query);
  const positive = groups.flat().filter(term => !term.negate).map(term => term.text);
  return { mode, upperBound(title, hints) { if (mode === 'grep') return 1; const lowerTitle = hints?.lowerTitle ?? title.toLocaleLowerCase(); return positive.reduce((sum, term) => sum + (lowerTitle.includes(term) ? 5 : 0) + (hints?.hd !== undefined && !hints.hd.includes(term) ? 0 : 2) + (hints?.count?.(term) ?? 3), 0); }, score(doc) {
    const text = `${doc.title}\n${doc.body}`;
    const lower = text.toLocaleLowerCase();
    const literal = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    const matches = mode === 'grep' ? (regex ? regex.test(text) : (input.caseSensitive ? text : lower).includes(literal)) : groups.some(group => group.every(term => term.negate ? !lower.includes(term.text) : lower.includes(term.text)));
    if (!matches) return undefined;
    const lines = doc.body.split('\n');
    let index = lines.findIndex(line => mode === 'grep' ? (regex ? regex.test(line) : (input.caseSensitive ? line : line.toLocaleLowerCase()).includes(literal)) : positive.some(term => line.toLocaleLowerCase().includes(term)));
    if (index < 0) index = 0;
    let heading: string | undefined;
    for (let line = 0; line <= index; line++) if (/^#{1,6}\s/.test(lines[line] ?? '')) heading = lines[line]!.replace(/^#{1,6}\s+/, '');
    const score = mode === 'grep' ? 1 : positive.reduce((sum, term) => sum + (doc.title.toLocaleLowerCase().includes(term) ? 5 : 0) + (heading?.toLocaleLowerCase().includes(term) ? 2 : 0) + Math.min(3, lower.split(term).length - 1), 0);
    return { objectId: doc.id, uri: doc.uri, revisionId: doc.revisionId, title: doc.title, kind: doc.kind, snippet: lines.slice(index, index + 3).join('\n').slice(0, 600), lineStart: index + 1 + (bodyOffsets.get(doc) ?? 0), lineEnd: Math.min(lines.length, index + 3) + (bodyOffsets.get(doc) ?? 0), matchedHeading: heading, score, retrievalMode: requested === 'hybrid' ? 'keyword-degraded' : mode };
  } };
}

export function validateSearchPage(input: SearchInput): { limit: number; offset: number } {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new MDBError('INVALID_INPUT', 'limit must be between 1 and 1000');
  const offset = Number(input.cursor ?? '0');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new MDBError('INVALID_INPUT', 'Invalid cursor');
  return { limit, offset };
}

export function compareSearchHits(a: SearchResult['hits'][number], b: SearchResult['hits'][number]): number {
  return b.score - a.score || compareIds(a.objectId, b.objectId) || compareIds(a.revisionId, b.revisionId);
}

export function finishSearch(hits: SearchResult['hits'], input: SearchInput, backend: string, mode: string, matchedCount: number): SearchResult {
  const { limit, offset } = validateSearchPage(input);
  hits.sort(compareSearchHits);
  return { hits: hits.slice(offset, offset + limit), mode, backend,
    ...((input.mode ?? 'auto') === 'hybrid' ? { fallback: 'Semantic embeddings unavailable; explicit lexical-only fallback' } : {}),
    ...(offset + limit < matchedCount ? { cursor: String(offset + limit) } : {}) };
}

export function searchDocuments(documents: Document[], input: SearchInput, backend: string): SearchResult {
  const scorer = prepareSearch(input); const hits: SearchResult['hits'] = [];
  for (const doc of documents) { const hit = scorer.score(doc); if (hit) hits.push(hit); }
  return finishSearch(hits, input, backend, scorer.mode, hits.length);
}

/** Native lexical fallback. Documents are authorized by Vault before scoring or snippets. */
export class FilesystemSearch implements SearchIndexAdapter {
  constructor(public readonly vault: SearchVault) {}
  capabilities(): Record<string, boolean> { return { grep: true, regex: true, keyword: true, semantic: false, hybrid: false }; }
  /** Index-backed: journal catch-up, ACL scope filter, metadata filter, ripgrep / raw-file prefilter, then only the surviving candidates are read. History search still reads revisions. */
  async query(input: SearchInput, actor: ActorContext = this.vault.actor): Promise<SearchResult> {
    if (input.includeHistory) { const documents = await authorizedDocuments(this.vault, input, actor); await mapBodyLines(this.vault, documents); return searchDocuments(documents, input, 'filesystem'); }
    return retrieve(this.vault, input, actor, filesPrefilter, 'filesystem');
  }
  /** Authorized, non-deleted objects in creation order plus the reference-resolution map (id, uri and title; later objects win, as before). Built from the manifest: no document is read. */
  private async graph(): Promise<{ live: ManifestEntry[]; targets: Map<string, ManifestEntry>; uri: (e: ManifestEntry) => string; referencedBy: Map<string, Set<string>> }> {
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const allowed = await manifest.readableScopes();
    const live = [...allowed].flatMap(sk => [...(manifest.byScope.get(sk) ?? [])]).map(id => manifest.entries.get(id)!).filter(e => e.status !== 'deleted' && e.status !== 'tombstone').sort((a, b) => a.first - b.first);
    const targets = new Map<string, ManifestEntry>();
    for (const e of live) for (const key of [e.id, manifest.uri(e), e.title]) targets.set(key, e);
    return { live, targets, uri: e => manifest.uri(e), referencedBy: manifest.referencedBy };
  }
  private resolvedLinks(source: Document, targets: Map<string, { id: string }>, uri: (id: string) => string | undefined): Array<{ type: string; target: string }> {
    const links = [...source.links.map(l => ({ type: l.type, target: l.target })), ...bodyReferences(source.body).map(([type, target]) => ({ type, target }))];
    const seen = new Set<string>(); const result: Array<{ type: string; target: string }> = [];
    for (const link of links) { const target = targets.get(link.target); const targetUri = target && uri(target.id); if (!targetUri) continue; const key = `${link.type}\0${targetUri}`; if (seen.has(key)) continue; seen.add(key); result.push({ type: link.type, target: targetUri }); }
    return result;
  }
  private locate(graph: Awaited<ReturnType<FilesystemSearch['graph']>>, id: string): ManifestEntry {
    const entry = graph.live.find(e => e.id === id || graph.uri(e) === id);
    if (!entry) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found');
    return entry;
  }
  async links(id: string): Promise<Array<{ type: string; target: string }>> {
    const graph = await this.graph(); const entry = this.locate(graph, id);
    const uris = new Map(graph.live.map(e => [e.id, graph.uri(e)]));
    return this.resolvedLinks(await this.vault.get(entry.id), graph.targets, target => uris.get(target));
  }
  async backlinks(id: string): Promise<Array<{ type: string; source: string }>> {
    const graph = await this.graph(); const target = this.locate(graph, id); const targetUri = graph.uri(target);
    const uris = new Map(graph.live.map(e => [e.id, graph.uri(e)]));
    // Candidates come from the reference index: only objects that mention one of the keys that resolve to this target are read.
    const candidates = new Set<string>();
    for (const key of [target.id, targetUri, target.title]) if (graph.targets.get(key) === target) for (const source of graph.referencedBy.get(key) ?? []) candidates.add(source);
    const result: Array<{ type: string; source: string }> = [];
    for (const entry of graph.live) {
      if (!candidates.has(entry.id)) continue;
      let doc: Document; try { doc = await this.vault.get(entry.id); } catch { continue; }
      for (const link of this.resolvedLinks(doc, graph.targets, t => uris.get(t))) if (link.target === targetUri) result.push({ type: link.type, source: graph.uri(entry) });
    }
    return result;
  }
  async related(id: string, depth = 1): Promise<Document[]> {
    if (!Number.isInteger(depth) || depth < 1 || depth > 5) throw new MDBError('INVALID_INPUT', 'Graph depth must be between 1 and 5');
    const graph = await this.graph(); const source = this.locate(graph, id);
    const byUri = new Map(graph.live.map(e => [graph.uri(e), e]));
    const seen = new Set([graph.uri(source)]); let frontier = [graph.uri(source)]; const found: ManifestEntry[] = [];
    for (let level = 0; level < depth; level++) {
      const next: string[] = [];
      for (const uri of frontier) {
        const adjacent = [...(await this.links(uri)).map(link => link.target), ...(await this.backlinks(uri)).map(link => link.source)];
        for (const target of adjacent) if (!seen.has(target)) { seen.add(target); const entry = byUri.get(target); if (entry) { found.push(entry); next.push(target); } }
      }
      frontier = next;
    }
    const docs: Document[] = []; for (const entry of found) { try { docs.push(await this.vault.get(entry.id)); } catch { /* no longer readable */ } }
    return docs;
  }
  async context(input: Omit<SearchInput, 'query'> & { task?: string; query?: string; budgetTokens?: number }): Promise<{ text: string; citations: Array<{ uri: string; revisionId: string }>; estimatedTokens: number }> {
    const budget = input.budgetTokens ?? 2000;
    if (!Number.isInteger(budget) || budget < 1 || budget > 100000) throw new MDBError('INVALID_INPUT', 'Invalid context token budget');
    const result = await this.query({ ...input, query: input.query ?? input.task ?? '', limit: 100 });
    const parts: string[] = []; const citations: Array<{ uri: string; revisionId: string }> = []; let usedBytes = 0;
    for (const hit of result.hits) {
      const part = `### ${hit.title}\n[${hit.uri}@${hit.revisionId}]\n${hit.snippet}\n`;
      // UTF-8 bytes conservatively bound tokens, including CJK and punctuation.
      const partBytes = Buffer.byteLength(part, 'utf8');
      if (usedBytes + partBytes > budget) continue;
      parts.push(part); usedBytes += partBytes; citations.push({ uri: hit.uri, revisionId: hit.revisionId });
    }
    return { text: parts.join(''), citations, estimatedTokens: usedBytes };
  }
  async rebuild(_scope?: Scope): Promise<void> { /* Canonical files require no derived index. */ }
  async health(): Promise<Record<string, unknown>> { return { backend: 'filesystem', available: true, derived: false }; }
}

export { SearchEngine } from '../search-sqlite/index.js';
