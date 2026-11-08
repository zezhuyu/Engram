import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MDBError, type Document, type Scope } from '../core/types.js';
import { Vault } from '../core/vault.js';
import { IntelligenceEngine } from '../intelligence/index.js';
import { DEFAULT_CAPTURE, DEFAULT_TOOL_ALLOWLIST, parseMemoryEvent, type MemoryEvent, type MemoryEventType, type Registration } from './types.js';
import { ChatProjectRegistry, type ChatProvider, type ProjectMembership } from '../chat/projects.js';
import { CAPTURE_TEXT_LIMIT, redactCaptureText } from './redact.js';
import { atomicWrite, safePath } from '../storage-local/index.js';
import { assertAvailableStorage } from '../core/storage-lifecycle.js';

const DIR = '.mdb/capture';
const dir = (root: string, ...parts: string[]) => path.join(root, DIR, ...parts);
export const queueCap = (): number => (Number(process.env.MDB_CAPTURE_QUEUE_CAP) > 0 ? Number(process.env.MDB_CAPTURE_QUEUE_CAP) : 5000);
const LOW_VALUE: MemoryEventType[] = ['tool.result', 'assistant.message'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const CAPTURE_QUEUE_TEMP = /^(\d{14}-[hl]-[a-f0-9]{8}\.json)\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;
const CAPTURE_TEMP_SWEEP_LIMIT = 128;

// ---- registrations -------------------------------------------------------------------------------------------------------------------
export async function readRegistration(root: string, id: string): Promise<Registration | undefined> {
  if (!SAFE.test(id)) return undefined;
  try { const r = JSON.parse(await fs.readFile(dir(root, 'registrations', `${id}.json`), 'utf8')) as Registration; return r.id === id && !r.revoked ? r : undefined; } catch { return undefined; }
}
export async function listRegistrations(root: string): Promise<Registration[]> {
  const out: Registration[] = []; for (const f of await fs.readdir(dir(root, 'registrations')).catch(() => [] as string[])) if (f.endsWith('.json')) { const r = await readRegistration(root, f.slice(0, -5)); if (r) out.push(r); }
  return out;
}
/** Owner-only. Creates the identity binding that every later event is checked against, and grants that principal workspace access (the ACL still applies at every write). */
export async function createRegistration(owner: Vault, input: { host: string; principalId: string; workspaceId: string; collectionId?: string; capture?: MemoryEventType[]; toolAllowlist?: string[]; excludePatterns?: string[]; consentPolicyId?: string; consent: boolean; chatSource?: { provider: ChatProvider; sourceAccountId: string } }): Promise<Registration> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Owner access is required to create a capture registration');
  if (input.consent !== true) throw new MDBError('INVALID_INPUT', 'Capture requires explicit consent');
  if (!SAFE.test(input.host) || !SAFE.test(input.principalId) || !SAFE.test(input.workspaceId)) throw new MDBError('INVALID_INPUT', 'Invalid host, principal or workspace');
  if ((input.host === 'engram-chat-client') !== Boolean(input.chatSource)) throw new MDBError('INVALID_INPUT', 'Owned chat client registrations must bind a source account, and other hosts cannot claim one');
  if (input.chatSource) {
    if (!['chatgpt', 'claude', 'gemini', 'generic'].includes(input.chatSource.provider) || !SAFE.test(input.chatSource.sourceAccountId)) throw new MDBError('INVALID_INPUT', 'Invalid chat source identity');
    if (input.workspaceId !== 'personal') throw new MDBError('INVALID_INPUT', 'Owned chat registrations use Personal as their registration scope; project routing is resolved per turn');
    await new ChatProjectRegistry(owner).ensurePersonalWorkspace();
    const account = (await new ChatProjectRegistry(owner).listSourceAccounts()).find(item => item.provider === input.chatSource!.provider && item.sourceAccountId === input.chatSource!.sourceAccountId && item.status === 'active');
    if (!account) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Chat source account must be actively provisioned by the owner');
    const expectedCapture: MemoryEventType[] = ['user.message', 'assistant.message'];
    if (input.capture && expectedCapture.some(type => !input.capture!.includes(type))) throw new MDBError('INVALID_INPUT', 'Owned chat client must capture both user and assistant turns');
  }
  for (const pattern of input.excludePatterns ?? []) { if (pattern.length > 200) throw new MDBError('INVALID_INPUT', 'Exclude pattern too long'); try { new RegExp(pattern); } catch { throw new MDBError('INVALID_INPUT', 'Invalid exclude pattern'); } }
  const workspaces = await owner.listWorkspaces(); if (!workspaces.some(w => w.id === input.workspaceId)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Workspace not found');
  if (input.collectionId) await owner.listCollections(input.workspaceId).then(list => { if (!list.some(c => c.id === input.collectionId)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Collection not found'); });
  await owner.grant(input.workspaceId, input.principalId, ['read', 'write']);
  await owner.setConfig(c => { c.capture.enabled = true; if (!c.capture.allowedSources.includes(input.host)) c.capture.allowedSources.push(input.host); });
  const registration: Registration = { id: `reg_${randomBytes(8).toString('hex')}`, host: input.host, principalId: input.principalId, workspaceId: input.workspaceId, ...(input.collectionId ? { collectionId: input.collectionId } : {}), capture: input.capture ?? (input.chatSource ? ['user.message', 'assistant.message'] : DEFAULT_CAPTURE), toolAllowlist: input.toolAllowlist ?? DEFAULT_TOOL_ALLOWLIST, excludePatterns: input.excludePatterns ?? [], consentPolicyId: input.consentPolicyId ?? 'owner-consent-v1', createdAt: new Date().toISOString(), ...(input.chatSource ? { chatSource: input.chatSource } : {}), permissions: [] };
  await fs.mkdir(dir(owner.root, 'registrations'), { recursive: true, mode: 0o700 });
  await fs.writeFile(dir(owner.root, 'registrations', `${registration.id}.json`), JSON.stringify(registration, null, 1), { mode: 0o600 });
  return registration;
}
export async function revokeRegistration(root: string, id: string): Promise<void> {
  const r = await readRegistration(root, id); if (!r) return;
  await fs.writeFile(dir(root, 'registrations', `${id}.json`), JSON.stringify({ ...r, revoked: true }, null, 1), { mode: 0o600 });
}

// ---- host payload -> MemoryEvent ----------------------------------------------------------------------------------------------------
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
function toolSummary(payload: Record<string, unknown>): string {
  const name = str(pick(payload, 'tool_name', 'toolName')) ?? 'tool'; const input = pick(payload, 'tool_input', 'toolInput') as Record<string, unknown> | string | undefined;
  const command = typeof input === 'string' ? input : str(input?.command) ?? str(input?.file_path) ?? str((input as Record<string, unknown> | undefined)?.path) ?? '';
  const response = pick(payload, 'tool_response', 'toolResponse'); let output = '';
  if (typeof response === 'string') output = response; else if (response && typeof response === 'object') { const r = response as Record<string, unknown>; output = [str(r.stdout), str(r.stderr), str(r.output), str(r.content)].filter(Boolean).join('\n'); if (r.interrupted === true) output += '\n[interrupted]'; }
  return `[tool ${name}]${command ? ` ${command.slice(0, 500)}` : ''}${output ? `\n${output.slice(0, 800)}` : ''}`;
}
/** Maps a documented host hook payload to a MemoryEvent. Identity, workspace and consent come ONLY from the registration. Returns undefined for events that are not to be recorded. */
export function eventFromHostPayload(registration: Registration, payload: Record<string, unknown>, now = new Date()): MemoryEvent | undefined {
  const name = str(pick(payload, 'hook_event_name', 'hookEventName', 'event')); const sessionId = str(pick(payload, 'session_id', 'sessionId', 'thread_id', 'threadId'));
  if (!name || !sessionId || !SAFE.test(sessionId.replace(/[^A-Za-z0-9_.-]/g, '_'))) return undefined;
  const table: Record<string, MemoryEventType> = { SessionStart: 'session.start', UserPromptSubmit: 'user.message', PostToolUse: 'tool.result', Stop: 'assistant.message', SessionEnd: 'session.end' };
  const type = table[name]; if (!type || !registration.capture.includes(type)) return undefined;
  let content = '', title = '';
  if (type === 'user.message') { content = str(pick(payload, 'prompt', 'user_prompt', 'userPrompt')) ?? ''; title = 'User message'; if (!content.trim()) return undefined; }
  else if (type === 'assistant.message') { content = str(pick(payload, 'last_assistant_message', 'lastAssistantMessage')) ?? ''; title = 'Assistant message'; if (!content.trim()) return undefined; }
  else if (type === 'tool.result') { const tool = str(pick(payload, 'tool_name', 'toolName')) ?? ''; if (!registration.toolAllowlist.includes(tool)) return undefined; content = toolSummary(payload); title = `Tool result: ${tool}`; }
  else if (type === 'session.start') { title = 'Session start'; content = `source=${str(payload.source) ?? 'unknown'}`; }
  else { title = 'Session end'; content = `reason=${str(payload.reason) ?? 'unknown'}`; }
  const cwd = str(payload.cwd) ?? '';
  for (const pattern of registration.excludePatterns) { const re = new RegExp(pattern, 'i'); if (re.test(content) || re.test(cwd)) return undefined; }
  const redacted = redactCaptureText(content);
  const truncated = content.length > CAPTURE_TEXT_LIMIT;
  const discriminator = str(pick(payload, 'prompt_id', 'turn_id', 'turnId', 'tool_use_id')) ?? '';
  const capturedAt = str(payload._engramCapturedAt);
  const timestamp = capturedAt && Number.isFinite(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : now.toISOString();
  const event: MemoryEvent = {
    eventId: sha([registration.host, sessionId, type, discriminator, sha(redacted)].join('\0')).slice(0, 32), timestamp, host: registration.host, sessionId: sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_'),
    workspaceId: registration.workspaceId, ...(registration.collectionId ? { collectionId: registration.collectionId } : {}), principalId: registration.principalId, type,
    ...(str(payload.transcript_path) ? { sourceRef: String(payload.transcript_path).slice(0, 500) } : {}), contentHash: sha(redacted), classification: type === 'user.message' ? 'user_private' : 'workspace_private',
    consentPolicyId: registration.consentPolicyId, schemaVersion: 1, content: redacted, title,
    ...(cwd || truncated ? { metadata: { ...(cwd ? { project: path.basename(cwd).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80) || 'root', cwdHash: sha(cwd).slice(0, 12) } : {}), ...(truncated ? { truncated: true, originalCharacters: content.length } : {}) } } : {})
  };
  return event;
}

/** Captures both sides of one turn from an Engram-controlled/instrumented chat client.
 * The registration pins the provider account and destination authority; the client
 * supplies only conversation/project identity and message text. Events use the
 * existing durable spool and are journaled by the ordinary capture drain.
 */
export interface OwnedChatTurnInput {
  conversationId: string; turnId: string; membership: ProjectMembership; externalProjectId?: string;
  title?: string; userText: string; assistantText: string; timestamp?: string;
}
export async function captureOwnedChatTurn(root: string, registrationId: string, input: OwnedChatTurnInput): Promise<{ accepted: number; queued: number; route: 'routed' | 'pending' | 'review_required'; workspaceId?: string }> {
  const registration = await readRegistration(root, registrationId);
  if (!registration?.chatSource || registration.host !== 'engram-chat-client') throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Unknown, revoked, or non-chat capture registration');
  if (!registration.capture.includes('user.message') || !registration.capture.includes('assistant.message')) throw new MDBError('INVALID_INPUT', 'Owned chat registration must capture both turn roles');
  if (!SAFE.test(input.conversationId.replace(/[^A-Za-z0-9_.-]/g, '_')) || !SAFE.test(input.turnId.replace(/[^A-Za-z0-9_.-]/g, '_')) || input.conversationId.length > 500 || input.turnId.length > 240 || (input.externalProjectId?.length ?? 0) > 500) throw new MDBError('INVALID_INPUT', 'Invalid owned chat conversation, turn, or project ID');
  if (!['member', 'standalone', 'unknown'].includes(input.membership)) throw new MDBError('INVALID_INPUT', 'Invalid chat project membership');
  if (input.membership === 'member' && !input.externalProjectId || input.membership === 'standalone' && input.externalProjectId) throw new MDBError('INVALID_INPUT', 'Project identity and membership do not agree');
  const timestamp = input.timestamp && Number.isFinite(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : new Date().toISOString();
  if (input.timestamp && !Number.isFinite(Date.parse(input.timestamp))) throw new MDBError('INVALID_INPUT', 'Invalid chat event timestamp');
  const conversationId = input.conversationId, turnId = input.turnId;
  const metadataBase: Record<string, string | number | boolean> = {
    chatProvider: registration.chatSource.provider, chatSourceAccountId: registration.chatSource.sourceAccountId,
    chatMembership: input.membership, externalConversationId: conversationId, conversationTitle: (input.title ?? '').slice(0, 500), turnId,
    ...(input.externalProjectId ? { externalProjectId: input.externalProjectId } : {})
  };
  let accepted = 0;
  for (const [speaker, type, raw] of [['user', 'user.message', input.userText], ['assistant', 'assistant.message', input.assistantText]] as const) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 100_000) throw new MDBError('INVALID_INPUT', 'Owned chat turns require non-empty messages no larger than 100000 characters');
    const content = redactCaptureText(raw);
    const event: MemoryEvent = {
      eventId: sha([registration.id, conversationId, turnId, speaker, sha(content)].join('\0')).slice(0, 32), timestamp,
      host: registration.host, sessionId: sha([registration.id, conversationId].join('\0')).slice(0, 40),
      workspaceId: registration.workspaceId, principalId: registration.principalId, type,
      classification: speaker === 'user' ? 'user_private' : 'workspace_private', consentPolicyId: registration.consentPolicyId,
      schemaVersion: 1, content, title: `${speaker === 'user' ? 'User' : 'Assistant'} chat message`, contentHash: sha(content),
      metadata: { ...metadataBase, speaker, externalMessageId: `${turnId}:${speaker}`, eventTime: timestamp }
    };
    if (await enqueueEvent(root, { registrationId, event }) === 'queued') accepted++;
  }
  if (accepted !== 2) return { accepted, queued: (await spoolStats(root)).queued, route: input.membership === 'unknown' ? 'review_required' : input.membership === 'member' ? 'pending' : 'routed' };
  // Do not perform registry/vault reads in the producer path. A live client must
  // durably enqueue promptly during a writer outage; the ordinary capture drain
  // performs route resolution and retains unresolved entries for a later retry.
  return {
    accepted, queued: (await spoolStats(root)).queued,
    route: input.membership === 'unknown' ? 'review_required' : input.membership === 'member' ? 'pending' : 'routed',
    ...(input.membership === 'standalone' ? { workspaceId: 'personal' } : {})
  };
}

/** An explicitly saved note, decision, finding or task completion (not a hook). Same registration checks, redaction and queue as passive events. */
export async function recordExplicit(root: string, registrationId: string, input: { type: 'note.created' | 'decision' | 'finding' | 'task.completed'; sessionId: string; text: string; title?: string; speaker?: 'user' | 'assistant' }): Promise<'queued' | 'dropped'> {
  const registration = await readRegistration(root, registrationId); if (!registration) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Unknown or revoked registration');
  if (!registration.capture.includes(input.type)) throw new MDBError('INVALID_INPUT', `This registration does not capture ${input.type}; reinstall with --capture including it`);
  if (!SAFE.test(input.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')) || !input.text.trim()) throw new MDBError('INVALID_INPUT', 'A session id and text are required');
  const content = redactCaptureText(input.text);
  const truncated = input.text.length > CAPTURE_TEXT_LIMIT;
  const event: MemoryEvent = { eventId: sha([registration.host, input.sessionId, input.type, sha(content)].join('\0')).slice(0, 32), timestamp: new Date().toISOString(), host: registration.host, sessionId: input.sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_'), workspaceId: registration.workspaceId, ...(registration.collectionId ? { collectionId: registration.collectionId } : {}), principalId: registration.principalId, type: input.type, contentHash: sha(content), classification: input.speaker === 'user' ? 'user_private' : 'workspace_private', consentPolicyId: registration.consentPolicyId, schemaVersion: 1, content, title: input.title ?? input.type, metadata: { speaker: input.speaker ?? 'assistant', ...(truncated ? { truncated: true, originalCharacters: input.text.length } : {}) } };
  return enqueueEvent(root, { registrationId: registration.id, event });
}

// ---- durable bounded spool -----------------------------------------------------------------------------------------------------------
export interface SpoolRecord { registrationId: string; event: MemoryEvent }
/** A full queue rejects only the new event, reports that rejection to its caller, and never evicts accepted capture. */
export async function enqueueEvent(root: string, record: SpoolRecord): Promise<'queued' | 'dropped'> {
  const bytes = Buffer.byteLength(JSON.stringify(record)) + 4096;
  await assertAvailableStorage(root, process.env, bytes);
  const queue = dir(root, 'queue'); await fs.mkdir(queue, { recursive: true, mode: 0o700 }); await fs.mkdir(dir(root, 'dropped'), { recursive: true, mode: 0o700 });
  const high = !LOW_VALUE.includes(record.event.type);
  await recoverCaptureQueueTemps(root);
  const names = await fs.readdir(queue);
  if (names.filter(n => n.endsWith('.json')).length >= queueCap()) {
    const dropped = dir(root, 'dropped');
    if ((await fs.readdir(dropped)).length < 1000) await fs.writeFile(dir(root, 'dropped', `${Date.now()}-${randomBytes(3).toString('hex')}`), record.event.type, { flag: 'wx', mode: 0o600 });
    return 'dropped'; // explicit rejection; preserve all already accepted queue entries
  }
  const name = `${String(Date.now()).padStart(14, '0')}-${high ? 'h' : 'l'}-${randomBytes(4).toString('hex')}.json`;
  await atomicWrite(root, `${DIR}/queue/${name}`, JSON.stringify(record), undefined, process.pid);
  return 'queued';
}
export async function spoolStats(root: string): Promise<{ queued: number; dropped: number; rejected: number }> {
  const names = async (d: string) => (await fs.readdir(dir(root, d)).catch(() => [] as string[])).filter(n => !n.startsWith('.'));
  return { queued: (await names('queue')).filter(n => n.endsWith('.json')).length, dropped: (await names('dropped')).length, rejected: (await names('rejected')).length };
}

/** Reclaim only atomic queue temps tagged with a process that is certainly gone.
 * Legacy UUID-only temp files are deliberately left untouched because their owner
 * cannot be established. The bounded scan avoids turning recovery into unbounded I/O.
 */
export async function recoverCaptureQueueTemps(root: string): Promise<{ inspected: number; removed: number }> {
  const queue = dir(root, 'queue');
  const candidates = (await fs.readdir(queue).catch(() => [] as string[])).filter(name => CAPTURE_QUEUE_TEMP.test(name)).slice(0, CAPTURE_TEMP_SWEEP_LIMIT);
  let removed = 0;
  for (const name of candidates) {
    const match = CAPTURE_QUEUE_TEMP.exec(name); if (!match) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    try {
      const target = await safePath(root, `${DIR}/queue/${name}`);
      const stat = await fs.lstat(target);
      if (stat.isFile() && !stat.isSymbolicLink()) { await fs.unlink(target); removed++; }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return { inspected: candidates.length, removed };
}

// ---- ingest ----------------------------------------------------------------------------------------------------------------------------
export type IngestOutcome = { status: 'ingested' | 'duplicate'; objectId: string } | { status: 'rejected'; reason: string };
const scopeOf = (r: Registration): Scope => ({ type: 'workspace', workspaceId: r.workspaceId, ...(r.collectionId ? { collectionId: r.collectionId } : {}) });
async function ensureSession(vault: Vault, registration: Registration, event: MemoryEvent): Promise<Document> {
  const scope = scopeOf(registration);
  for (let segment = 1; segment < 50; segment++) {
    const key = `memory:session:${event.host}:${event.sessionId}${segment > 1 ? `:${segment}` : ''}`;
    const existing = await vault.byIdempotencyKey(key, scope);
    if (!existing) return vault.put({ scope, kind: 'session', title: `${event.host} session ${event.sessionId.slice(0, 12)}`, body: '', tags: ['memory', event.host], metadata: { lifecycle: 'open', source: event.host, hostSessionId: event.sessionId, memory: true, startedAt: event.timestamp, eventTime: event.timestamp }, idempotencyKey: key });
    if (existing.metadata.lifecycle !== 'closed') return existing;
  }
  throw new MDBError('CONFLICT', 'Too many closed segments for one host session');
}
const KIND: Record<MemoryEventType, string> = { 'session.start': 'session', 'user.message': 'observation', 'assistant.message': 'observation', 'tool.result': 'observation', 'note.created': 'note', decision: 'decision', finding: 'finding', 'task.completed': 'observation', 'session.end': 'session' };
export async function ingestRecord(root: string, record: SpoolRecord, now = Date.now()): Promise<IngestOutcome> {
  let event: MemoryEvent;
  try { event = parseMemoryEvent(record.event); } catch (e) { return { status: 'rejected', reason: (e as Error).message }; }
  const registration = await readRegistration(root, String(record.registrationId));
  if (!registration) return { status: 'rejected', reason: 'unknown or revoked registration' };
  if (event.host !== registration.host || event.principalId !== registration.principalId || event.workspaceId !== registration.workspaceId || (event.collectionId ?? '') !== (registration.collectionId ?? '')) return { status: 'rejected', reason: 'event identity or scope does not match its registration' };
  if (!registration.capture.includes(event.type)) return { status: 'rejected', reason: 'event type not enabled for this registration' };
  // A client whose clock runs far ahead must not cost a real event: the server has already acknowledged it, and the spool keeps no content for rejected events.
  // Keep it, stamp it with the receipt time, and record the claimed time and the suspicion (the event id does not depend on the timestamp, so deduplication is unaffected).
  let skew: { claimed: string } | undefined;
  if (Date.parse(event.timestamp) > now + 24 * 3600 * 1000) { skew = { claimed: event.timestamp }; event = { ...event, timestamp: new Date(now).toISOString() }; }
  const owner = new Vault(root); const config = await owner.config();
  if (!config.capture.enabled || !config.capture.allowedSources.includes(event.host)) return { status: 'rejected', reason: 'capture is not enabled for this host' };
  for (const pattern of registration.excludePatterns) if (new RegExp(pattern, 'i').test(event.content ?? '')) return { status: 'rejected', reason: 'excluded by pattern' };
  const vault = new Vault(root, { actorId: registration.principalId, permissions: registration.permissions }); // ACL decides; a failed write is a rejection, never a bypass
  let effectiveRegistration = registration;
  if (registration.chatSource) {
    const provider = event.metadata?.chatProvider, account = event.metadata?.chatSourceAccountId, membership = event.metadata?.chatMembership;
    const expectedSpeaker = event.type === 'user.message' ? 'user' : event.type === 'assistant.message' ? 'assistant' : undefined;
    if (registration.host !== 'engram-chat-client' || !expectedSpeaker || event.metadata?.speaker !== expectedSpeaker
      || provider !== registration.chatSource.provider || account !== registration.chatSource.sourceAccountId
      || typeof event.metadata?.externalConversationId !== 'string' || typeof event.metadata?.externalMessageId !== 'string'
      || !['member', 'standalone', 'unknown'].includes(String(membership))) return { status: 'rejected', reason: 'chat event source identity does not match its trusted registration' };
    const externalProjectId = typeof event.metadata?.externalProjectId === 'string' ? event.metadata.externalProjectId : undefined;
    let route;
    try {
      route = await new ChatProjectRegistry(vault).resolveProject({ provider: registration.chatSource.provider, sourceAccountId: registration.chatSource.sourceAccountId, ...(externalProjectId ? { externalProjectId } : {}), membership: membership as ProjectMembership });
    } catch (error) {
      // Revoked accounts and malformed identity are terminal, not retryable routing outages.
      if (error instanceof MDBError && ['NOT_FOUND_OR_FORBIDDEN', 'INVALID_INPUT'].includes(error.code)) return { status: 'rejected', reason: 'chat source or membership is no longer authorized' };
      throw error;
    }
    if (route.status !== 'routed') throw new MDBError('CONFLICT', `Chat event routing remains ${route.status}; it is retained for later resolution`);
    effectiveRegistration = { ...registration, workspaceId: route.workspaceId };
  }
  const scope = scopeOf(effectiveRegistration);
  try {
    const key = `memory:${event.host}:${event.eventId}`;
    if (await vault.byIdempotencyKey(key, scope)) return { status: 'duplicate', objectId: (await vault.byIdempotencyKey(key, scope))!.id };
    const session = await ensureSession(vault, effectiveRegistration, event);
    if (event.type === 'session.start') return { status: 'duplicate', objectId: session.id };
    if (event.type === 'session.end') { const closed = await new IntelligenceEngine(vault).sessionEnd({ sessionId: session.id, queue: new IntelligenceEngine(owner) }); return { status: 'ingested', objectId: closed.id }; }
    const speaker = event.type === 'user.message' ? 'user' : event.type === 'assistant.message' ? 'assistant' : event.type === 'tool.result' ? 'tool' : String(event.metadata?.speaker ?? 'assistant');
    const isChat = registration.chatSource !== undefined;
    const doc = await vault.put({
      scope, kind: isChat ? 'chat_message' : KIND[event.type], title: event.title ?? event.type, body: redactCaptureText(event.content ?? ''), tags: isChat ? ['chat', 'memory', event.type, `chat-provider-${registration.chatSource!.provider}`, `chat-account-${sha(registration.chatSource!.sourceAccountId).slice(0, 32)}`] : ['memory', event.type],
      evidence: [{ uri: session.uri, revisionId: session.revisionId }], idempotencyKey: key,
      metadata: { sessionId: session.id, hostSessionId: event.sessionId, ...(typeof event.metadata?.project === 'string' ? { project: event.metadata.project } : {}), ...(typeof event.metadata?.cwdHash === 'string' ? { cwdHash: event.metadata.cwdHash } : {}), ...(isChat ? { provider: registration.chatSource!.provider, sourceAccountId: registration.chatSource!.sourceAccountId, externalConversationId: event.metadata?.externalConversationId ?? '', externalMessageId: event.metadata?.externalMessageId ?? '', role: speaker, ...(typeof event.metadata?.externalProjectId === 'string' ? { externalProjectId: event.metadata.externalProjectId } : {}), ...(typeof event.metadata?.conversationTitle === 'string' ? { conversationTitle: event.metadata.conversationTitle } : {}), ...(typeof event.metadata?.eventTime === 'string' ? { sourceTimestamp: event.metadata.eventTime } : {}), ...(typeof event.metadata?.parentMessageId === 'string' ? { parentMessageId: event.metadata.parentMessageId } : {}), ...(typeof event.metadata?.branchId === 'string' ? { branchId: event.metadata.branchId } : {}) } : {}), eventId: event.eventId, eventType: event.type, speaker, host: event.host, eventTime: event.timestamp, ...(skew ? { clockSkewSuspected: true, claimedEventTime: skew.claimed } : {}), classification: event.classification, consentPolicyId: event.consentPolicyId, source: event.host, evidenceClass: speaker === 'user' ? 'user_authored' : 'agent_observation', ...(event.contentHash ? { contentHash: event.contentHash } : {}), ...(event.sourceRef ? { sourceRef: event.sourceRef } : {}), ...(event.agentId ? { agentId: event.agentId } : {}) }
    });
    if (event.type === 'task.completed') await new IntelligenceEngine(owner).enqueue('reflect', { scope: session.scope, objectIds: [session.id, doc.id] });
    return { status: 'ingested', objectId: doc.id };
  } catch (e) {
    if (e instanceof MDBError && ['NOT_FOUND_OR_FORBIDDEN', 'INVALID_INPUT'].includes(e.code)) return { status: 'rejected', reason: e.code === 'NOT_FOUND_OR_FORBIDDEN' ? 'principal has no write access to the workspace' : 'invalid event content' };
    throw e;
  }
}

/** True when the drain lock's owner is a live process. The owner writes owner.json right after creating the lock directory, so a missing file is first treated as "still starting" and only a lock that stays owner-less (a drain killed in between) is stale. */
async function lockOwnerAlive(lock: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try { const { pid } = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) as { pid: number }; process.kill(pid, 0); return true; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code !== 'ENOENT' && !(err instanceof SyntaxError)) return true;
      if (!(await fs.stat(lock).then(() => true, () => false))) return false; // already released
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return false;
}
async function withDrainLock<T>(root: string, work: () => Promise<T>): Promise<T | undefined> {
  const lock = dir(root, 'drain.lock'); await fs.mkdir(dir(root), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await lockOwnerAlive(lock)) return undefined; // another drain is running; it will pick up our events
      await fs.rm(lock, { recursive: true, force: true }); continue;
    }
    // Our directory may be removed as stale by a contender in the instant before the owner file exists; if so, start over rather than fail.
    try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); acquired = true; }
    catch (e) { if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; } // directory vanished underneath us
  }
  if (!acquired) return undefined;
  try { return await work(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
}
/**
 * A hook that ends a session starts a detached drain so it can return at once. That background work must be observable, or nothing that removes or
 * moves a vault (tests, uninstall, purge, backup restore) can tell when it is safe: each spawned drain registers its pid here and clears it when it finishes.
 */
export async function markDrainPending(root: string, pid: number | undefined): Promise<void> {
  if (!pid) return; const d = dir(root, 'drain-pending'); await fs.mkdir(d, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(d, String(pid)), String(Date.now()));
}
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** True while a drain this vault started is still running (registered pid alive, or the drain lock is held by a live process). Stale markers of dead processes are removed. */
export async function drainBusy(root: string): Promise<boolean> {
  const d = dir(root, 'drain-pending'); let busy = false;
  for (const name of await fs.readdir(d).catch(() => [] as string[])) { const pid = Number(name); if (Number.isSafeInteger(pid) && pidAlive(pid)) busy = true; else await fs.rm(path.join(d, name), { force: true }); }
  if (!busy) { try { const { pid } = JSON.parse(await fs.readFile(path.join(dir(root, 'drain.lock'), 'owner.json'), 'utf8')) as { pid: number }; busy = pidAlive(pid); } catch { /* no lock */ } }
  return busy;
}
/** Resolves when no background drain is running; rejects if one is still running after `timeoutMs`. */
export async function waitForDrainIdle(root: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) { if (!(await drainBusy(root))) return; if (Date.now() > until) throw new Error('a background memory drain is still running'); await new Promise(r => setTimeout(r, 50)); }
}
export interface DrainResult { processed: number; ingested: number; duplicates: number; rejected: number; deferred: number; skipped?: string }
/** Drains the spool oldest-first. Transient failures leave the event queued; permanent ones are moved to `rejected` with a reason only (no content retained). */
export async function drainSpool(root: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<DrainResult> {
  try {
    const result = await withDrainLock(root, async () => {
      const out: DrainResult = { processed: 0, ingested: 0, duplicates: 0, rejected: 0, deferred: 0 };
      // Events enqueued while this drain was working skipped their own drain (the lock was held), so look again before releasing, a bounded number of times.
      // Retry after a pass only when records were actually removed. Deferred entries
      // stay queued for a later invocation (for example after an ACL/project mapping
      // change); spinning over them here adds load without making progress.
      for (let pass = 0; pass < 5; pass++) { const before = out.processed; await drainPass(root, options, out); if (out.processed === before || options.signal?.aborted) break; if ((await spoolStats(root)).queued === 0) break; }
      return out;
    });
    return result ?? { processed: 0, ingested: 0, duplicates: 0, rejected: 0, deferred: 0, skipped: 'another drain is running' };
  } finally { await fs.rm(dir(root, 'drain-pending', String(process.pid)), { force: true }).catch(() => undefined); }
}
async function drainPass(root: string, options: { limit?: number; signal?: AbortSignal }, out: DrainResult): Promise<void> {
  {
    const queue = dir(root, 'queue'); await fs.mkdir(dir(root, 'rejected'), { recursive: true, mode: 0o700 });
    await recoverCaptureQueueTemps(root);
    const names = (await fs.readdir(queue).catch(() => [] as string[])).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort().slice(0, options.limit ?? 500);
    for (const name of names) {
      if (options.signal?.aborted) break;
      const file = path.join(queue, name); let record: SpoolRecord;
      try { record = JSON.parse(await fs.readFile(file, 'utf8')) as SpoolRecord; } catch { await fs.rm(file, { force: true }); out.rejected++; await fs.writeFile(dir(root, 'rejected', name), JSON.stringify({ reason: 'unreadable spool file' })); continue; }
      let outcome: IngestOutcome;
      try { outcome = await ingestRecord(root, record); } catch { out.deferred++; continue; /* transient (lock busy, I/O): keep it queued */ }
      out.processed++;
      if (outcome.status === 'rejected') { out.rejected++; await fs.writeFile(dir(root, 'rejected', name), JSON.stringify({ reason: outcome.reason, eventId: String(record.event?.eventId ?? ''), type: String(record.event?.type ?? '') })); }
      else if (outcome.status === 'duplicate') out.duplicates++; else out.ingested++;
      await fs.rm(file, { force: true });
    }
  }
}

/** Closes memory sessions that never received session.end, marking them incomplete, and queues a clearly labeled partial retrospective. */
export async function sweepAbandoned(owner: Vault, options: { timeoutMs: number; now?: number }): Promise<{ closed: string[] }> {
  const now = options.now ?? Date.now(); const closed: string[] = [];
  const docs = await owner.listDocuments(); const lastActivity = new Map<string, number>();
  for (const d of docs) { const sid = typeof d.metadata.sessionId === 'string' ? d.metadata.sessionId : d.kind === 'session' ? d.id : undefined; if (!sid) continue; const t = Date.parse(typeof d.metadata.eventTime === 'string' ? d.metadata.eventTime : d.updatedAt); if (t > (lastActivity.get(sid) ?? 0)) lastActivity.set(sid, t); }
  for (const s of docs.filter(d => d.kind === 'session' && d.metadata.memory === true && d.metadata.lifecycle === 'open')) {
    if (now - (lastActivity.get(s.id) ?? Date.parse(s.updatedAt)) < options.timeoutMs) continue;
    const latest = await owner.get(s.id);
    await new IntelligenceEngine(owner).sessionEnd({ sessionId: latest.id, body: 'INCOMPLETE: the host never sent session.end; closed after inactivity.', incomplete: true }); closed.push(latest.id);
  }
  return { closed };
}
