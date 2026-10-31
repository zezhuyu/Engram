import { createHash } from 'node:crypto';
import { MDBError, type Document, type Scope, type SearchResult } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import type { SearchEngine } from '../search-files/index.js';

export interface ConversationFilters {
  scopes?: Scope[];
  provider?: string;
  sourceAccountId?: string;
  externalProjectId?: string;
  role?: string;
  since?: string;
  until?: string;
  /** Include hidden/system/tool messages. Default conversation reads show user and assistant messages only. */
  includeNonUser?: boolean;
  limit?: number;
  cursor?: string;
  /** Search-engine continuation after the current bounded hit page is exhausted. */
  sourceCursor?: string;
}
export interface ConversationSummary { provider: string; sourceAccountId: string; externalConversationId: string; projectId?: string; title: string; messageCount: number; firstMessageAt?: string; lastMessageAt?: string; roles: string[]; workspaceId: string }
export interface ConversationPage { conversations: ConversationSummary[]; nextCursor?: string }
export interface ConversationView extends ConversationSummary { messages: Array<{ objectId: string; revisionId: string; role: string; content: string; timestamp?: string; parentMessageId?: string; branchId?: string; sourceRevision?: string }>; nextCursor?: string }

const inaccessible = () => new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Object not found or not accessible');
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const safeLimit = (value: number | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new MDBError('INVALID_INPUT', `limit must be 1-${max}`);
  return value;
};
function normalizedBoundary(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new MDBError('INVALID_INPUT', `Invalid conversation ${label} date`);
  return new Date(time).toISOString();
}
function normalizedDateFilters<T extends ConversationFilters>(filters: T): T {
  const since = normalizedBoundary(filters.since, 'since'), until = normalizedBoundary(filters.until, 'until');
  if (since && until && Date.parse(since) > Date.parse(until)) throw new MDBError('INVALID_INPUT', 'Conversation since date must not be later than until date');
  return { ...filters, ...(since ? { since } : {}), ...(until ? { until } : {}) };
}
function cursorEncode(offset: number, filterKey: string): string { return Buffer.from(JSON.stringify({ v: 1, offset, filterKey })).toString('base64url'); }
function cursorDecode(cursor: string | undefined, filterKey: string): number {
  if (!cursor) return 0;
  try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; offset?: number; filterKey?: string };
    if (value.v !== 1 || value.filterKey !== filterKey || !Number.isSafeInteger(value.offset) || (value.offset ?? -1) < 0) throw new Error();
    return value.offset!;
  } catch { throw new MDBError('INVALID_INPUT', 'Invalid or mismatched conversation cursor'); }
}
type MessageCursorKey = [string, string, string];
function messageCursorEncode(key: MessageCursorKey, filterKey: string): string { return Buffer.from(JSON.stringify({ v: 1, after: key, filterKey })).toString('base64url'); }
function messageCursorDecode(cursor: string | undefined, filterKey: string): MessageCursorKey | undefined {
  if (!cursor) return undefined;
  try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; after?: unknown; filterKey?: string };
    if (value.v !== 1 || value.filterKey !== filterKey || !Array.isArray(value.after) || value.after.length !== 3 || value.after.some(part => typeof part !== 'string' || part.length > 1024)) throw new Error();
    return value.after as MessageCursorKey;
  } catch { throw new MDBError('INVALID_INPUT', 'Invalid or mismatched message cursor'); }
}
function filterDigest(filters: ConversationFilters, query = '', mode = ''): string {
  return createHash('sha256').update(JSON.stringify({ scopes: filters.scopes ?? [], provider: filters.provider ?? '', account: filters.sourceAccountId ?? '', project: filters.externalProjectId ?? '', role: filters.role ?? '', since: filters.since ?? '', until: filters.until ?? '', includeNonUser: filters.includeNonUser === true, query, mode })).digest('hex').slice(0, 24);
}
function matches(doc: Document, filters: ConversationFilters): boolean {
  const meta = doc.metadata;
  const timestamp = Date.parse(String(meta.sourceTimestamp ?? doc.createdAt));
  return doc.kind === 'chat_message' && doc.status === 'active'
    && (filters.includeNonUser === true || (meta.hidden !== true && ['user', 'assistant'].includes(String(meta.role))))
    && (!filters.provider || meta.provider === filters.provider)
    && (!filters.sourceAccountId || meta.sourceAccountId === filters.sourceAccountId)
    && (!filters.externalProjectId || meta.externalProjectId === filters.externalProjectId)
    && (!filters.role || meta.role === filters.role)
    && (!filters.since || timestamp >= Date.parse(filters.since))
    && (!filters.until || timestamp <= Date.parse(filters.until));
}
function messageTime(doc: Document): string { return text(doc.metadata.sourceTimestamp) ?? doc.createdAt; }
function groupKey(doc: Document): string { return `${doc.metadata.provider}\0${doc.metadata.sourceAccountId}\0${doc.metadata.externalConversationId}\0${doc.scope.type === 'workspace' ? doc.scope.workspaceId : ''}`; }
function summarize(docs: Document[]): ConversationSummary {
  const first = docs[0]!, timestamps = docs.map(messageTime).sort();
  return { provider: String(first.metadata.provider), sourceAccountId: String(first.metadata.sourceAccountId), externalConversationId: String(first.metadata.externalConversationId), ...(text(first.metadata.externalProjectId) ? { projectId: text(first.metadata.externalProjectId)! } : {}), title: String(first.metadata.conversationTitle ?? first.title), messageCount: docs.length, firstMessageAt: timestamps[0], lastMessageAt: timestamps.at(-1), roles: [...new Set(docs.map(doc => String(doc.metadata.role)))].sort(), workspaceId: first.scope.type === 'workspace' ? first.scope.workspaceId : '' };
}

/** ACL is applied by Vault before the service filters, groups, paginates or emits conversation metadata. */
export class ConversationService {
  constructor(private readonly vault: Vault, private readonly searchEngine: SearchEngine) {}

  async list(filters: ConversationFilters = {}): Promise<ConversationPage> {
    filters = normalizedDateFilters(filters);
    const limit = safeLimit(filters.limit, 20, 100), digest = filterDigest(filters), offset = cursorDecode(filters.cursor, digest);
    const documents = (await this.vault.listDocuments({ scopes: filters.scopes })).filter(doc => matches(doc, filters));
    const groups = new Map<string, Document[]>();
    for (const doc of documents) { const key = groupKey(doc), group = groups.get(key) ?? []; group.push(doc); groups.set(key, group); }
    const conversations = [...groups.values()].map(group => summarize(group)).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.externalConversationId.localeCompare(b.externalConversationId) || a.sourceAccountId.localeCompare(b.sourceAccountId));
    const page = conversations.slice(offset, offset + limit);
    return { conversations: page, ...(offset + page.length < conversations.length ? { nextCursor: cursorEncode(offset + page.length, digest) } : {}) };
  }

  async get(input: ConversationFilters & { externalConversationId: string; maxMessages?: number }): Promise<ConversationView> {
    input = normalizedDateFilters(input);
    if (!input.externalConversationId || input.externalConversationId.length > 512) throw new MDBError('INVALID_INPUT', 'Invalid conversation ID');
    const maxMessages = safeLimit(input.maxMessages, 200, 1000), digest = createHash('sha256').update(`${filterDigest(input)}\0${input.externalConversationId}`).digest('hex').slice(0, 24), after = messageCursorDecode(input.cursor, digest);
    const compareKey = (doc: Document): MessageCursorKey => [messageTime(doc), String(doc.metadata.externalMessageId), doc.id];
    const compare = (a: MessageCursorKey, b: MessageCursorKey) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
    let docs = (await this.vault.listDocuments({ scopes: input.scopes })).filter(doc => matches(doc, input) && doc.metadata.externalConversationId === input.externalConversationId)
      .sort((a, b) => compare(compareKey(a), compareKey(b)));
    if (!docs.length) throw inaccessible();
    if (input.provider && docs.some(doc => doc.metadata.provider !== input.provider) || input.sourceAccountId && docs.some(doc => doc.metadata.sourceAccountId !== input.sourceAccountId)) throw inaccessible();
    if (new Set(docs.map(groupKey)).size > 1) throw new MDBError('INVALID_INPUT', 'Conversation ID is ambiguous; specify provider, source account, or workspace scope');
    const summary = summarize(docs);
    if (after) docs = docs.filter(doc => compare(compareKey(doc), after) > 0);
    const page = docs.slice(0, maxMessages), last = page.at(-1);
    return { ...summary, messageCount: summary.messageCount, messages: page.map(doc => ({ objectId: doc.id, revisionId: doc.revisionId, role: String(doc.metadata.role), content: doc.body, ...(text(doc.metadata.sourceTimestamp) ? { timestamp: text(doc.metadata.sourceTimestamp)! } : {}), ...(text(doc.metadata.parentMessageId) ? { parentMessageId: text(doc.metadata.parentMessageId)! } : {}), ...(text(doc.metadata.branchId) ? { branchId: text(doc.metadata.branchId)! } : {}), ...(text(doc.metadata.sourceRevision) ? { sourceRevision: text(doc.metadata.sourceRevision)! } : {}) })), ...(page.length < docs.length && last ? { nextCursor: messageCursorEncode(compareKey(last), digest) } : {}) };
  }

  async search(input: ConversationFilters & { query: string; mode?: 'keyword' | 'grep'; limit?: number }): Promise<{ conversations: Array<ConversationSummary & { matches: Array<{ objectId: string; revisionId: string; role: string; snippet: string; timestamp?: string }> }>; mode: string; backend: string; nextCursor?: string; requestedMode?: string; sourceCursor?: string; truncated: boolean }> {
    input = normalizedDateFilters(input);
    if (typeof input.query !== 'string' || input.query.length > 2000) throw new MDBError('INVALID_INPUT', 'Chat search query must be 1-2000 characters');
    const limit = safeLimit(input.limit, 20, 100), digest = filterDigest(input, input.query, input.mode ?? 'keyword'), offset = cursorDecode(input.cursor, digest);
    const tags = ['chat', ...(input.provider ? [`chat-provider-${input.provider}`] : []), ...(input.sourceAccountId ? [`chat-account-${createHash('sha256').update(input.sourceAccountId).digest('hex').slice(0, 32)}`] : [])];
    const result: SearchResult = await this.searchEngineQuery({ query: input.query, mode: input.mode ?? 'keyword', scopes: input.scopes, kinds: ['chat_message'], tags, since: input.since, until: input.until, limit: 500, ...(input.sourceCursor ? { cursor: input.sourceCursor } : {}), includeHistory: false });
    const grouped = new Map<string, { docs: Document[]; matches: Array<{ objectId: string; revisionId: string; role: string; snippet: string; timestamp?: string }> }>();
    for (const hit of result.hits) {
      const doc = await this.vault.get(hit.objectId);
      if (!matches(doc, input) || input.externalProjectId && doc.metadata.externalProjectId !== input.externalProjectId || input.role && doc.metadata.role !== input.role) continue;
      const key = groupKey(doc), item = grouped.get(key) ?? { docs: [], matches: [] };
      item.docs.push(doc); item.matches.push({ objectId: doc.id, revisionId: doc.revisionId, role: String(doc.metadata.role), snippet: hit.snippet.slice(0, 1200), ...(text(doc.metadata.sourceTimestamp) ? { timestamp: text(doc.metadata.sourceTimestamp)! } : {}) });
      grouped.set(key, item);
    }
    const summaries = [...grouped.values()].map(item => ({ ...summarize(item.docs), matches: item.matches }));
    const page = summaries.slice(offset, offset + limit);
    return { conversations: page, mode: result.mode, backend: result.backend, ...(offset + page.length < summaries.length ? { nextCursor: cursorEncode(offset + page.length, digest) } : {}), ...(result.cursor ? { sourceCursor: result.cursor } : {}), truncated: Boolean(result.cursor), ...(result.requestedMode ? { requestedMode: result.requestedMode } : {}) };
  }

  private searchEngineQuery(input: Parameters<SearchEngine['query']>[0]): Promise<SearchResult> { return this.searchEngine.query(input); }
}

export function accountSearchTag(sourceAccountId: string): string { return `chat-account-${createHash('sha256').update(sourceAccountId).digest('hex').slice(0, 32)}`; }
