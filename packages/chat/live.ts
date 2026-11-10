import { createHash, randomUUID } from 'node:crypto';
import { MDBError } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { redactCaptureText } from '../memory/redact.js';
import { CHAT_PROVIDERS, PERSONAL_WORKSPACE_ID, type ChatProvider } from './projects.js';

const MAX_TURN = 20_000;
const MAX_CONVERSATION = 200_000;
const CHAT_SCOPE = { type: 'workspace' as const, workspaceId: PERSONAL_WORKSPACE_ID, collectionId: 'chat' };
const PREFERENCE_SCOPE = { type: 'workspace' as const, workspaceId: PERSONAL_WORKSPACE_ID, collectionId: 'preferences' };
const comparable = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function repeatsDreamOutput(vault: Vault, text: string): Promise<boolean> {
  const userText = comparable(text); if (userText.length < 30) return false;
  const discoveries = await vault.listDocuments().then(docs => docs.filter(doc => doc.kind === 'discovery' && doc.status !== 'deleted'));
  return discoveries.some(doc => [doc.title, doc.body].some(value => { const phrase = comparable(value).slice(0, 500); return phrase.length >= 30 && userText.includes(phrase); }));
}
const safeId = (value: unknown, label: string, max = 512): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new MDBError('INVALID_INPUT', `Invalid chat ${label}`);
  return value;
};

async function ensurePersonalCollection(vault: Vault, id: 'chat' | 'preferences'): Promise<void> {
  if (!(await vault.listWorkspaces()).some(item => item.id === PERSONAL_WORKSPACE_ID)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Personal workspace is not available');
  if (!(await vault.listCollections(PERSONAL_WORKSPACE_ID)).some(item => item.id === id)) await vault.createCollection(PERSONAL_WORKSPACE_ID, id, id === 'chat' ? 'Live chat-AI conversations' : 'Accepted user preferences and reviewed preference insights');
}

/** Store a live turn in personal/chat. Omitted IDs start a conversation; supplied IDs must already exist. */
export async function recordLiveChatTurn(vault: Vault, input: { provider: ChatProvider; conversationId?: string; role: 'user' | 'assistant' | 'tool'; text: string; turnId: string; title?: string }) {
  if (!CHAT_PROVIDERS.includes(input.provider)) throw new MDBError('INVALID_INPUT', 'Invalid chat provider');
  const starting = input.conversationId === undefined;
  const conversationId = starting ? randomUUID() : safeId(input.conversationId, 'conversation id');
  if (!['user', 'assistant', 'tool'].includes(input.role)) throw new MDBError('INVALID_INPUT', 'Invalid chat role');
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > MAX_TURN) throw new MDBError('INVALID_INPUT', `Chat turn must contain 1-${MAX_TURN} bytes`);
  const turnId = safeId(input.turnId, 'turn id');
  const title = input.title === undefined ? `Conversation ${conversationId.slice(0, 64)}` : safeId(input.title, 'title', 200);
  const bodyText = redactCaptureText(input.text, MAX_TURN);
  const key = createHash('sha256').update(`${input.provider}\0${conversationId}`).digest('hex');
  const initialTurnKey = createHash('sha256').update(`${input.provider}\0${turnId}`).digest('hex');
  const scope = CHAT_SCOPE;
  if (!(await vault.canAccess({ type: 'workspace', workspaceId: PERSONAL_WORKSPACE_ID }, 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Personal workspace write access is required');
  await ensurePersonalCollection(vault, 'chat');
  for (let attempt = 0; attempt < 4; attempt++) {
    const conversations = (await vault.listDocuments({ scopes: [scope] })).filter(doc => doc.kind === 'chat_conversation');
    const found = conversations.find(doc => doc.metadata.liveConversationKey === key);
    if (!found) {
      if (!starting) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Conversation not found or not accessible; a conversationId must identify an existing conversation');
      const replay = conversations.find(doc => doc.metadata.initialTurnKey === initialTurnKey);
      if (replay) {
        const firstTurn = Array.isArray(replay.metadata.turns) ? replay.metadata.turns[0] as { role?: string; start?: number; end?: number } | undefined : undefined;
        const priorText = firstTurn && Number.isInteger(firstTurn.start) && Number.isInteger(firstTurn.end) ? replay.body.slice(firstTurn.start, firstTurn.end) : '';
        if (firstTurn?.role !== input.role || priorText !== bodyText) throw new MDBError('CONFLICT', 'This turnId was already used with different conversation content');
        return replay;
      }
      const body = bodyText; const turn = { id: turnId, role: input.role, start: 0, end: body.length, dreamDerived: input.role === 'user' && await repeatsDreamOutput(vault, bodyText), recordedAt: new Date().toISOString() };
      try { return await vault.put({ scope, kind: 'chat_conversation', title, body, tags: ['chat', 'chat-live', `chat-provider-${input.provider}`], metadata: { actorId: vault.actor.actorId, chatSchema: 1, sourceClass: 'user_conversation', liveConversationKey: key, initialTurnKey, provider: input.provider, externalConversationId: conversationId, turns: [turn], roles: [input.role], turnIds: [turnId], turnCount: 1 }, idempotencyKey: `live-chat:first:${initialTurnKey}` }); }
      catch (error) { if (!(error instanceof MDBError) || error.code !== 'CONFLICT') throw error; continue; }
    }
    const priorTurns = Array.isArray(found.metadata.turns) ? found.metadata.turns as Array<{ id: string; role: string; start: number; end: number; recordedAt: string }> : [];
    const priorTurn = priorTurns.find(turn => turn.id === turnId);
    if (priorTurn) {
      if (priorTurn.role !== input.role || found.body.slice(priorTurn.start, priorTurn.end) !== bodyText) throw new MDBError('CONFLICT', 'This turnId was already used with different conversation content');
      return found;
    }
    const separator = found.body ? '\n\n' : ''; const start = found.body.length + separator.length; const body = `${found.body}${separator}${bodyText}`;
    const next = [...priorTurns, { id: turnId, role: input.role, start, end: body.length, dreamDerived: input.role === 'user' && await repeatsDreamOutput(vault, bodyText), recordedAt: new Date().toISOString() }];
    if (Buffer.byteLength(body) > MAX_CONVERSATION) throw new MDBError('INVALID_INPUT', 'Conversation size limit reached; start a new conversation');
    try { return await vault.patch({ objectId: found.id, expectedRevisionId: found.revisionId, title, body, tags: found.tags, metadataPatch: { actorId: vault.actor.actorId, turns: next, roles: [...new Set([...((found.metadata.roles as string[]) ?? []), input.role])], turnIds: [...((found.metadata.turnIds as string[]) ?? []), turnId], turnCount: next.length }, idempotencyKey: `live-chat:${key}:turn:${turnId}` }); }
    catch (error) { if (error instanceof MDBError && error.code === 'CONFLICT') { const latest = await vault.get(found.id); if ((latest.metadata.turnIds as string[] | undefined)?.includes(turnId)) return latest; continue; } throw error; }
  }
  throw new MDBError('CONFLICT', 'Conversation changed repeatedly; retry the turn');
}

/** Return only bounded, ACL-checked metadata from personal/chat. */
export async function listLiveChatConversations(vault: Vault, input: { query?: string; limit?: number } = {}) {
  if (!(await vault.canAccess({ type: 'workspace', workspaceId: PERSONAL_WORKSPACE_ID }, 'read'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Personal workspace read access is required');
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
  const query = input.query?.trim().toLocaleLowerCase();
  if (query && query.length > 200) throw new MDBError('INVALID_INPUT', 'Conversation query is too long');
  const docs = await vault.listDocuments({ scopes: [CHAT_SCOPE] });
  return docs.filter(doc => doc.kind === 'chat_conversation' && doc.status !== 'deleted'
    && (!query || `${doc.title}\n${userOnlyChatDocument(doc).body}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(doc => ({ conversationId: String(doc.metadata.externalConversationId ?? ''), title: doc.title.slice(0, 200), provider: String(doc.metadata.provider ?? 'unknown'), lastTurnAt: String((Array.isArray(doc.metadata.turns) ? (doc.metadata.turns.at(-1) as { recordedAt?: string } | undefined)?.recordedAt : undefined) ?? doc.updatedAt), snippet: userOnlyChatDocument(doc).body.replace(/\s+/g, ' ').trim().slice(0, 240), uri: doc.uri, revisionId: doc.revisionId }));
}

export { ensurePersonalCollection, PREFERENCE_SCOPE };

/** Keep transcript offsets intact while blanking every non-user turn before any model receives a source. */
export function userOnlyChatDocument<T extends { kind: string; body: string; metadata: Record<string, unknown> }>(doc: T): T {
  if (doc.kind !== 'chat_conversation') return doc;
  const original = doc.body.split(''), chars: string[] = original.map(char => char === '\n' || char === '\r' ? char : ' ');
  if (Array.isArray(doc.metadata.turns)) for (const raw of doc.metadata.turns as Array<{ role?: string; start?: number; end?: number; dreamDerived?: boolean }>) {
    if (raw.role !== 'user' || raw.dreamDerived === true || !Number.isInteger(raw.start) || !Number.isInteger(raw.end) || raw.start! < 0 || raw.end! < raw.start! || raw.end! > original.length) continue;
    for (let i = raw.start!; i < raw.end!; i++) chars[i] = original[i]!;
  }
  return { ...doc, body: chars.join('') };
}
