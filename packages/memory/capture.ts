import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MDBError, type Document, type Scope } from '../core/types.js';
import { Vault } from '../core/vault.js';
import { IntelligenceEngine } from '../intelligence/index.js';
import { DEFAULT_CAPTURE, DEFAULT_TOOL_ALLOWLIST, parseMemoryEvent, type MemoryEvent, type MemoryEventType, type Registration } from './types.js';
import { redactText } from './redact.js';
import { atomicWrite } from '../storage-local/index.js';

const DIR = '.mdb/capture';
const dir = (root: string, ...parts: string[]) => path.join(root, DIR, ...parts);
export const queueCap = (): number => (Number(process.env.MDB_CAPTURE_QUEUE_CAP) > 0 ? Number(process.env.MDB_CAPTURE_QUEUE_CAP) : 5000);
const LOW_VALUE: MemoryEventType[] = ['tool.result', 'assistant.message'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

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
export async function createRegistration(owner: Vault, input: { host: string; principalId: string; workspaceId: string; collectionId?: string; capture?: MemoryEventType[]; toolAllowlist?: string[]; excludePatterns?: string[]; consentPolicyId?: string; consent: boolean }): Promise<Registration> {
  if (input.consent !== true) throw new MDBError('INVALID_INPUT', 'Capture requires explicit consent');
  if (!SAFE.test(input.host) || !SAFE.test(input.principalId) || !SAFE.test(input.workspaceId)) throw new MDBError('INVALID_INPUT', 'Invalid host, principal or workspace');
  for (const pattern of input.excludePatterns ?? []) { if (pattern.length > 200) throw new MDBError('INVALID_INPUT', 'Exclude pattern too long'); try { new RegExp(pattern); } catch { throw new MDBError('INVALID_INPUT', 'Invalid exclude pattern'); } }
  const workspaces = await owner.listWorkspaces(); if (!workspaces.some(w => w.id === input.workspaceId)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Workspace not found');
  if (input.collectionId) await owner.listCollections(input.workspaceId).then(list => { if (!list.some(c => c.id === input.collectionId)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Collection not found'); });
  await owner.grant(input.workspaceId, input.principalId, ['read', 'write']);
  await owner.setConfig(c => { c.capture.enabled = true; if (!c.capture.allowedSources.includes(input.host)) c.capture.allowedSources.push(input.host); });
  const registration: Registration = { id: `reg_${randomBytes(8).toString('hex')}`, host: input.host, principalId: input.principalId, workspaceId: input.workspaceId, ...(input.collectionId ? { collectionId: input.collectionId } : {}), capture: input.capture ?? DEFAULT_CAPTURE, toolAllowlist: input.toolAllowlist ?? DEFAULT_TOOL_ALLOWLIST, excludePatterns: input.excludePatterns ?? [], consentPolicyId: input.consentPolicyId ?? 'owner-consent-v1', createdAt: new Date().toISOString(), permissions: [] };
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
  const redacted = redactText(content).slice(0, 20_000);
  const discriminator = str(pick(payload, 'prompt_id', 'turn_id', 'turnId', 'tool_use_id')) ?? '';
  const event: MemoryEvent = {
    eventId: sha([registration.host, sessionId, type, discriminator, sha(redacted)].join('\0')).slice(0, 32), timestamp: now.toISOString(), host: registration.host, sessionId: sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_'),
    workspaceId: registration.workspaceId, ...(registration.collectionId ? { collectionId: registration.collectionId } : {}), principalId: registration.principalId, type,
    ...(str(payload.transcript_path) ? { sourceRef: String(payload.transcript_path).slice(0, 500) } : {}), contentHash: sha(redacted), classification: type === 'user.message' ? 'user_private' : 'workspace_private',
    consentPolicyId: registration.consentPolicyId, schemaVersion: 1, content: redacted, title
  };
  return event;
}

/** An explicitly saved note, decision, finding or task completion (not a hook). Same registration checks, redaction and queue as passive events. */
export async function recordExplicit(root: string, registrationId: string, input: { type: 'note.created' | 'decision' | 'finding' | 'task.completed'; sessionId: string; text: string; title?: string; speaker?: 'user' | 'assistant' }): Promise<'queued' | 'dropped'> {
  const registration = await readRegistration(root, registrationId); if (!registration) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Unknown or revoked registration');
  if (!registration.capture.includes(input.type)) throw new MDBError('INVALID_INPUT', `This registration does not capture ${input.type}; reinstall with --capture including it`);
  if (!SAFE.test(input.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')) || !input.text.trim()) throw new MDBError('INVALID_INPUT', 'A session id and text are required');
  const content = redactText(input.text).slice(0, 20_000);
  const event: MemoryEvent = { eventId: sha([registration.host, input.sessionId, input.type, sha(content)].join('\0')).slice(0, 32), timestamp: new Date().toISOString(), host: registration.host, sessionId: input.sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_'), workspaceId: registration.workspaceId, ...(registration.collectionId ? { collectionId: registration.collectionId } : {}), principalId: registration.principalId, type: input.type, contentHash: sha(content), classification: input.speaker === 'user' ? 'user_private' : 'workspace_private', consentPolicyId: registration.consentPolicyId, schemaVersion: 1, content, title: input.title ?? input.type, metadata: { speaker: input.speaker ?? 'assistant' } };
  return enqueueEvent(root, { registrationId: registration.id, event });
}

// ---- durable bounded spool -----------------------------------------------------------------------------------------------------------
export interface SpoolRecord { registrationId: string; event: MemoryEvent }
/** Never blocks and never throws to the host: a full queue evicts or drops low-value events first and counts what it dropped. */
export async function enqueueEvent(root: string, record: SpoolRecord): Promise<'queued' | 'dropped'> {
  const queue = dir(root, 'queue'); await fs.mkdir(queue, { recursive: true, mode: 0o700 }); await fs.mkdir(dir(root, 'dropped'), { recursive: true, mode: 0o700 });
  const high = !LOW_VALUE.includes(record.event.type);
  let names = await fs.readdir(queue);
  if (names.filter(n => n.endsWith('.json')).length >= queueCap()) {
    const victim = names.filter(n => n.includes('-l-')).sort()[0];
    if (!high || !victim) { await fs.writeFile(dir(root, 'dropped', `${Date.now()}-${randomBytes(3).toString('hex')}`), record.event.type); return 'dropped'; }
    await fs.rm(path.join(queue, victim), { force: true }); await fs.writeFile(dir(root, 'dropped', `${Date.now()}-${randomBytes(3).toString('hex')}`), 'evicted:' + victim);
  }
  const name = `${String(Date.now()).padStart(14, '0')}-${high ? 'h' : 'l'}-${randomBytes(4).toString('hex')}.json`;
  await atomicWrite(root, `${DIR}/queue/${name}`, JSON.stringify(record));
  names = []; return 'queued';
}
export async function spoolStats(root: string): Promise<{ queued: number; dropped: number; rejected: number }> {
  const count = async (d: string) => (await fs.readdir(dir(root, d)).catch(() => [] as string[])).filter(n => !n.startsWith('.')).length;
  return { queued: await count('queue'), dropped: await count('dropped'), rejected: await count('rejected') };
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
  if (Date.parse(event.timestamp) > now + 24 * 3600 * 1000) return { status: 'rejected', reason: 'timestamp in the future' };
  const owner = new Vault(root); const config = await owner.config();
  if (!config.capture.enabled || !config.capture.allowedSources.includes(event.host)) return { status: 'rejected', reason: 'capture is not enabled for this host' };
  for (const pattern of registration.excludePatterns) if (new RegExp(pattern, 'i').test(event.content ?? '')) return { status: 'rejected', reason: 'excluded by pattern' };
  const vault = new Vault(root, { actorId: registration.principalId, permissions: registration.permissions }); // ACL decides; a failed write is a rejection, never a bypass
  const scope = scopeOf(registration);
  try {
    const key = `memory:${event.host}:${event.eventId}`;
    if (await vault.byIdempotencyKey(key, scope)) return { status: 'duplicate', objectId: (await vault.byIdempotencyKey(key, scope))!.id };
    const session = await ensureSession(vault, registration, event);
    if (event.type === 'session.start') return { status: 'duplicate', objectId: session.id };
    if (event.type === 'session.end') { const closed = await new IntelligenceEngine(vault).sessionEnd({ sessionId: session.id, queue: new IntelligenceEngine(owner) }); return { status: 'ingested', objectId: closed.id }; }
    const speaker = event.type === 'user.message' ? 'user' : event.type === 'assistant.message' ? 'assistant' : event.type === 'tool.result' ? 'tool' : String(event.metadata?.speaker ?? 'assistant');
    const doc = await vault.put({
      scope, kind: KIND[event.type], title: event.title ?? event.type, body: redactText(event.content ?? ''), tags: ['memory', event.type],
      evidence: [{ uri: session.uri, revisionId: session.revisionId }], idempotencyKey: key,
      metadata: { sessionId: session.id, hostSessionId: event.sessionId, eventId: event.eventId, eventType: event.type, speaker, host: event.host, eventTime: event.timestamp, classification: event.classification, consentPolicyId: event.consentPolicyId, source: event.host, evidenceClass: speaker === 'user' ? 'user_authored' : 'agent_observation', ...(event.contentHash ? { contentHash: event.contentHash } : {}), ...(event.sourceRef ? { sourceRef: event.sourceRef } : {}), ...(event.agentId ? { agentId: event.agentId } : {}) }
    });
    if (event.type === 'task.completed') await new IntelligenceEngine(owner).enqueue('reflect', { scope: session.scope, objectIds: [session.id, doc.id] });
    return { status: 'ingested', objectId: doc.id };
  } catch (e) {
    if (e instanceof MDBError && ['NOT_FOUND_OR_FORBIDDEN', 'INVALID_INPUT'].includes(e.code)) return { status: 'rejected', reason: e.code === 'NOT_FOUND_OR_FORBIDDEN' ? 'principal has no write access to the workspace' : 'invalid event content' };
    throw e;
  }
}

async function withDrainLock<T>(root: string, work: () => Promise<T>): Promise<T | undefined> {
  const lock = dir(root, 'drain.lock'); await fs.mkdir(dir(root), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let alive = true; try { const { pid } = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) as { pid: number }; process.kill(pid, 0); } catch (err) { alive = (err as NodeJS.ErrnoException).code !== 'ESRCH' && (err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError); }
      if (alive) return undefined; // another drain is running; it will pick up our events
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
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
      for (let pass = 0; pass < 5; pass++) { const before = out.processed + out.deferred; await drainPass(root, options, out); if (out.processed + out.deferred === before || options.signal?.aborted) break; if ((await spoolStats(root)).queued === 0) break; }
      return out;
    });
    return result ?? { processed: 0, ingested: 0, duplicates: 0, rejected: 0, deferred: 0, skipped: 'another drain is running' };
  } finally { await fs.rm(dir(root, 'drain-pending', String(process.pid)), { force: true }).catch(() => undefined); }
}
async function drainPass(root: string, options: { limit?: number; signal?: AbortSignal }, out: DrainResult): Promise<void> {
  {
    const queue = dir(root, 'queue'); await fs.mkdir(dir(root, 'rejected'), { recursive: true, mode: 0o700 });
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
