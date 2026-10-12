import { createHash } from 'node:crypto';
import type { Engram } from '../sdk/index.js';
import { MDBError, type Document, type Evidence, type Scope } from '../core/types.js';
import { redactText } from './redact.js';

/**
 * Typed durable records for agent work: notes, tasks and handoffs. Each has a stable identity (an idempotency key scoped to the workspace),
 * so the first write creates an object and every later write is a revision of it. Writes go through Vault only (ACL, journal, immutable revisions);
 * nothing here touches vault files. A returned result means the journal acknowledged the commit.
 */
export const MAX_TYPED_BODY_BYTES = 256 * 1024;
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** COMMITTED = acknowledged by the journal. QUEUED_OFFLINE and FAILED are produced by client-side queues (file sync) and never by this module. */
export type Persistence = 'COMMITTED' | 'QUEUED_OFFLINE' | 'FAILED';
export interface TypedResult { persistence: 'COMMITTED'; kind: string; stableId: string; objectId: string; revisionId: string; revisionNumber: number; created: boolean; unchanged: boolean; contentHash: string; redactions: number; uri: string }
interface Provenance { host?: string; sessionId?: string; sourcePath?: string }
interface Upsert extends Provenance { kind: 'note' | 'task' | 'handoff'; stableId: string; scope: Scope; title: string; body: string; tags?: string[]; status?: string; metadata?: Record<string, unknown>; evidence?: Evidence[]; expectedRevisionId?: string }

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const invalid = (message: string): never => { throw new MDBError('INVALID_INPUT', message); };
const checkId = (id: unknown, label: string): string => { if (typeof id !== 'string' || !STABLE_ID.test(id) || id.includes('..') || id.includes('//')) invalid(`${label} must be 1-128 characters of letters, digits, . _ : / -`); return id as string; };
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function upsertTyped(client: Engram, input: Upsert): Promise<TypedResult> {
  const stableId = checkId(input.stableId, `${input.kind} id`);
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300) invalid('title must be 1-300 characters');
  if (typeof input.body !== 'string') invalid('body must be text');
  if (Buffer.byteLength(input.body) > MAX_TYPED_BODY_BYTES) invalid(`body exceeds ${MAX_TYPED_BODY_BYTES} bytes`);
  const body = redactText(input.body); const redactions = body === input.body ? 0 : 1 + (input.body.match(/\[REDACTED/g)?.length ?? 0) + (body.match(/\[REDACTED/g)?.length ?? 0) - (input.body.match(/\[REDACTED/g)?.length ?? 0);
  const tags = [...new Set([input.kind, ...(input.tags ?? [])])];
  const contentHash = sha256(JSON.stringify([input.kind, input.title, body, input.status ?? '', tags]));
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}), typed: input.kind, stableId, contentHash, ...(input.host ? { host: input.host } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}) };
  const createKey = `${input.kind}:${stableId}`;
  const existing = await client.vault.byIdempotencyKey(createKey, input.scope);
  const done = (doc: Document, created: boolean, unchanged: boolean): TypedResult => ({ persistence: 'COMMITTED', kind: input.kind, stableId, objectId: doc.id, revisionId: doc.revisionId, revisionNumber: doc.revisionNumber, created, unchanged, contentHash, redactions, uri: doc.uri });
  if (!existing) {
    if (input.expectedRevisionId && input.expectedRevisionId !== 'none') throw new MDBError('CONFLICT', 'Expected revision given but the record does not exist yet');
    return done(await client.put({ scope: input.scope, kind: input.kind, title: input.title, body, tags, ...(input.status ? { status: input.status } : {}), metadata, ...(input.evidence ? { evidence: input.evidence } : {}), idempotencyKey: createKey }), true, false);
  }
  const head = await client.vault.get(existing.id);
  // 'none' means: create it, and if somebody else already has, never overwrite (identical content is simply already there).
  if (input.expectedRevisionId === 'none') { if (head.metadata.contentHash === contentHash && head.title === input.title && head.status === (input.status ?? 'active')) return done(head, false, true); throw new MDBError('CONFLICT', 'A record with this id already exists with different content'); }
  if (input.expectedRevisionId && input.expectedRevisionId !== head.revisionId) throw new MDBError('CONFLICT', 'Expected revision is no longer current');
  // An update always states the status: a record that was tombstoned (its file deleted) and is written again is active again, never left hidden.
  const status = input.status ?? 'active';
  if (head.metadata.contentHash === contentHash && head.title === input.title && head.status === status) return done(head, false, true);
  const patched = await client.patch({ objectId: head.id, expectedRevisionId: head.revisionId, title: input.title, body, tags, status, metadataPatch: metadata, ...(input.evidence ? { evidence: input.evidence } : {}), idempotencyKey: `${createKey}@${contentHash}` });
  return done(patched, false, false);
}

export async function upsertTask(client: Engram, input: Provenance & { scope: Scope; taskId: string; title: string; status: TaskStatus; body?: string; assignee?: string; evidence?: Evidence[]; expectedRevisionId?: string }): Promise<TypedResult> {
  if (!(TASK_STATUSES as readonly string[]).includes(input.status)) invalid(`status must be one of ${TASK_STATUSES.join(', ')}`);
  return upsertTyped(client, { kind: 'task', stableId: input.taskId, scope: input.scope, title: input.title, body: input.body ?? '', tags: [`status:${input.status}`], metadata: { taskStatus: input.status, ...(input.assignee ? { assignee: input.assignee } : {}) }, ...(input.host ? { host: input.host } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.evidence ? { evidence: input.evidence } : {}), ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}) });
}

export async function upsertNote(client: Engram, input: Provenance & { scope: Scope; noteId: string; title: string; body: string; tags?: string[]; evidence?: Evidence[]; expectedRevisionId?: string; status?: 'active' | 'tombstone'; metadata?: Record<string, unknown> }): Promise<TypedResult> {
  return upsertTyped(client, { kind: 'note', stableId: input.noteId, scope: input.scope, title: input.title, body: input.body, ...(input.tags ? { tags: input.tags } : {}), ...(input.status ? { status: input.status } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.host ? { host: input.host } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), ...(input.evidence ? { evidence: input.evidence } : {}), ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}) });
}

export interface HandoffInput extends Provenance { scope: Scope; sessionId: string; state: 'ended' | 'interrupted'; completed: string[]; next: string[]; blockers: string[]; filesTouched: string[]; openTasks: string[] }
const list = (title: string, items: string[]): string => `## ${title}\n${items.length ? items.map(item => `- ${item}`).join('\n') : '- none'}\n`;
/** Written only by an explicit call. A session that simply stops produces no handoff; an interrupted one may record what is open but never claims completed work. */
export async function writeHandoff(client: Engram, input: HandoffInput): Promise<TypedResult> {
  if (input.state === 'interrupted' && input.completed.length) invalid('an interrupted handoff cannot list completed work');
  for (const items of [input.completed, input.next, input.blockers, input.filesTouched, input.openTasks]) if (!Array.isArray(items) || items.length > 200 || items.some(item => typeof item !== 'string' || item.length > 500)) invalid('handoff lists must hold at most 200 short strings');
  const body = `State: ${input.state}\n\n${list('Completed', input.completed)}\n${list('Next', input.next)}\n${list('Blockers', input.blockers)}\n${list('Files touched', input.filesTouched)}\n${list('Open tasks', input.openTasks)}`;
  return upsertTyped(client, { kind: 'handoff', stableId: checkId(input.sessionId, 'session id'), scope: input.scope, title: `Handoff ${input.sessionId} (${input.state})`, body, metadata: { handoffState: input.state, openTasks: input.openTasks.slice(0, 50) }, ...(input.host ? { host: input.host } : {}), sessionId: input.sessionId });
}
