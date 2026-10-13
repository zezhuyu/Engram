import { createHash } from 'node:crypto';
import type { Engram } from '../sdk/index.js';
import { MDBError, type Document, type Evidence, type Scope } from '../core/types.js';
import { redactText } from './redact.js';
import { merge3, mergeScalar, mergeTags } from './merge.js';

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
/** What the server did with a write that a client made while it was disconnected. */
export interface MergeInfo { outcome: 'CREATED' | 'FAST_FORWARD' | 'MERGED' | 'CONFLICT' | 'ALREADY_APPLIED'; baseRevisionId?: string; theirsRevisionId?: string; conflictNoteId?: string; conflictingFields?: string[]; /** the merged body, so a client that keeps a local copy can update it like `git pull` */ body?: string }
export interface TypedResult { persistence: 'COMMITTED'; kind: string; stableId: string; objectId: string; revisionId: string; revisionNumber: number; created: boolean; unchanged: boolean; contentHash: string; redactions: number; uri: string; merge?: MergeInfo }
/** Sent by a client that queued this write while it could not reach the server. entryId makes the replay idempotent; baseRevisionId (the revision the writer last saw) or serverTime (the server clock at the last successful contact) locate the common ancestor for the three-way merge. */
export interface OfflineWrite { entryId: string; queuedAt?: string; serverTime?: string; baseRevisionId?: string;
  /** A write queued on top of an earlier queued write of the same record was made against THAT write's content (the client had not seen the server's changes), so that content, not the server's result, is its merge base. The arguments are those of the same tool call. */
  baseArguments?: Record<string, unknown> }
/** A bare `asOf` timestamp (server clock) is enough to ask for a merge: the base is the record as of that time. */
export function offlineFromAsOf(asOf: unknown): OfflineWrite {
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) invalid('asOf must be an ISO timestamp');
  return { entryId: `asof-${sha256(`${asOf}\0${Date.now()}\0${Math.random()}`).slice(0, 32)}`, serverTime: asOf as string };
}
export function checkOffline(value: unknown): OfflineWrite | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) invalid('offline must be an object');
  const v = value as Record<string, unknown>; for (const key of Object.keys(v)) if (!['entryId', 'queuedAt', 'serverTime', 'baseRevisionId', 'baseArguments'].includes(key)) invalid(`offline.${key.slice(0, 30)} is not a known field`);
  if (typeof v.entryId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(v.entryId)) invalid('offline.entryId must be 8-64 letters, digits or dashes');
  for (const key of ['queuedAt', 'serverTime'] as const) if (v[key] !== undefined && (typeof v[key] !== 'string' || !Number.isFinite(Date.parse(v[key] as string)))) invalid(`offline.${key} must be an ISO timestamp`);
  if (v.baseRevisionId !== undefined && (typeof v.baseRevisionId !== 'string' || v.baseRevisionId.length > 200)) invalid('offline.baseRevisionId must be a revision id');
  if (v.baseArguments !== undefined && (typeof v.baseArguments !== 'object' || v.baseArguments === null || Array.isArray(v.baseArguments) || JSON.stringify(v.baseArguments).length > 700_000)) invalid('offline.baseArguments must be the arguments object of an earlier call');
  return { entryId: v.entryId as string, ...(v.queuedAt ? { queuedAt: v.queuedAt as string } : {}), ...(v.serverTime ? { serverTime: v.serverTime as string } : {}), ...(v.baseRevisionId ? { baseRevisionId: v.baseRevisionId as string } : {}), ...(v.baseArguments ? { baseArguments: v.baseArguments as Record<string, unknown> } : {}) };
}
interface Provenance { host?: string; sessionId?: string; sourcePath?: string }
interface Upsert extends Provenance { kind: 'note' | 'task' | 'handoff'; stableId: string; scope: Scope; title: string; body: string; tags?: string[]; status?: string; metadata?: Record<string, unknown>; evidence?: Evidence[]; expectedRevisionId?: string; offline?: OfflineWrite }

/** Describe the writer of THIS revision: a later revision from a different writer must not claim an earlier writer's host, session or source file. */
const PROVENANCE_KEYS = ['host', 'sessionId', 'sourcePath'] as const;
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
  if (input.offline && existing) return mergeOfflineWrite(client, input, { existing, createKey, title: input.title, body, tags, contentHash, done });
  if (!existing) {
    if (input.expectedRevisionId && input.expectedRevisionId !== 'none' && !input.offline) throw new MDBError('CONFLICT', 'Expected revision given but the record does not exist yet');
    return done(await client.put({ scope: input.scope, kind: input.kind, title: input.title, body, tags, ...(input.status ? { status: input.status } : {}), metadata, ...(input.evidence ? { evidence: input.evidence } : {}), idempotencyKey: createKey }), true, false);
  }
  const head = await client.vault.get(existing.id);
  // 'none' means: create it, and if somebody else already has, never overwrite (identical content is simply already there).
  if (input.expectedRevisionId === 'none') { if (head.metadata.contentHash === contentHash && head.title === input.title && head.status === (input.status ?? 'active')) return done(head, false, true); throw new MDBError('CONFLICT', 'A record with this id already exists with different content'); }
  // The server itself decides, for every write that says which revision it was based on, whether the record moved since: a stale expectedRevisionId is merged (or becomes a conflict note), never refused and never overwritten.
  if (input.expectedRevisionId && input.expectedRevisionId !== head.revisionId) return mergeOfflineWrite(client, { ...input, offline: { entryId: `auto-${sha256(`${input.expectedRevisionId}\0${contentHash}`).slice(0, 32)}` } }, { existing, createKey, title: input.title, body, tags, contentHash, done });
  // An update always states the status: a record that was tombstoned (its file deleted) and is written again is active again, never left hidden.
  const status = input.status ?? 'active';
  if (head.metadata.contentHash === contentHash && head.title === input.title && head.status === status) return done(head, false, true);
  const patched = await client.patch({ objectId: head.id, expectedRevisionId: head.revisionId, title: input.title, body, tags, status, metadataPatch: metadata, metadataRemove: PROVENANCE_KEYS.filter(key => !(key in metadata)), ...(input.evidence ? { evidence: input.evidence } : {}), idempotencyKey: `${createKey}@${contentHash}` });
  return done(patched, false, false);
}


const STATUS_TAG = /^status:/;
type BaseDoc = Pick<Document, 'revisionNumber' | 'updatedAt' | 'title' | 'body' | 'status' | 'tags' | 'metadata'> & { revisionId: string; queuedPredecessor?: true };
const str = (value: unknown, max = 300_000): string => typeof value === 'string' && value.length <= max ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 500)) : [];
/** The record exactly as an earlier call of the same tool would have written it (title, body, tags, status, domain metadata), used as the merge base for a write queued on top of it. */
function baseFromArguments(kind: Upsert['kind'], a: Record<string, unknown>, at: string | undefined): BaseDoc {
  const common = { revisionId: 'queued-predecessor', revisionNumber: 0, updatedAt: at ?? new Date(0).toISOString(), queuedPredecessor: true as const };
  if (kind === 'task') return { ...common, title: str(a.title, 300), body: str(a.body), status: 'active', tags: ['task', `status:${str(a.status, 40)}`], metadata: { taskStatus: str(a.status, 40), ...(str(a.assignee, 200) ? { assignee: str(a.assignee, 200) } : {}) } };
  if (kind === 'note') return { ...common, title: str(a.title, 300), body: str(a.body), status: a.status === 'tombstone' ? 'tombstone' : 'active', tags: [...new Set(['note', ...strings(a.tags)])], metadata: a.contentSource ? { contentSource: str(a.contentSource, 40) } : {} };
  const lists = ['completed', 'next', 'blockers', 'filesTouched', 'openTasks'].map(k => strings(a[k])); const [completed, next, blockers, filesTouched, openTasks] = lists as [string[], string[], string[], string[], string[]];
  return { ...common, title: `Handoff ${str(a.sessionId, 128)} (${str(a.state, 20)})`, body: handoffBody(str(a.state, 20), completed, next, blockers, filesTouched, openTasks), status: 'active', tags: ['handoff'], metadata: { handoffState: str(a.state, 20), openTasks: openTasks.slice(0, 50) } };
}
const sameContent = (a: BaseDoc, b: Document, keys: string[]): boolean => a.title === b.title && a.body === b.body && a.status === b.status && [...a.tags].sort().join('\0') === [...b.tags].sort().join('\0') && keys.every(key => sameJson(a.metadata[key], b.metadata[key]));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/**
 * A write made while the client could not reach the server, merged like `git merge`: base = the revision the writer last saw (explicit, or the last revision at or before the
 * server time of its last contact), theirs = what the server has now, ours = the queued write. Non-overlapping changes are combined into a new revision; an overlapping change
 * keeps the server's version untouched and stores the complete conflict (git-style markers plus the local version) as a `conflict:` note, so nothing is lost and nothing is overwritten.
 */
async function mergeOfflineWrite(client: Engram, input: Upsert, ctx: { existing: Document; createKey: string; title: string; body: string; tags: string[]; contentHash: string; done: (doc: Document, created: boolean, unchanged: boolean) => TypedResult }): Promise<TypedResult> {
  const offline = input.offline!, { existing, createKey } = ctx; const stableId = input.stableId; const offlineKey = `${createKey}@offline:${offline.entryId}`; const conflictId = `conflict:${stableId}:${offline.entryId.slice(0, 8)}`;
  const applied = await client.vault.byIdempotencyKey(offlineKey, input.scope);
  if (applied) return { ...ctx.done(applied, false, true), merge: { outcome: 'ALREADY_APPLIED' } };
  const earlier = await client.vault.byIdempotencyKey(`note:${conflictId}`, input.scope);
  if (earlier) return { ...ctx.done(await client.vault.get(existing.id), false, true), merge: { outcome: 'CONFLICT', conflictNoteId: conflictId } };
  const status = input.status ?? 'active'; const domainKeys = Object.keys(input.metadata ?? {}).filter(key => !(PROVENANCE_KEYS as readonly string[]).includes(key));
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await client.vault.get(existing.id); const history = await client.vault.history(head.id);
    const explicit = offline.baseRevisionId ?? (input.expectedRevisionId && input.expectedRevisionId !== 'none' ? input.expectedRevisionId : undefined);
    let base: BaseDoc | undefined = offline.baseArguments ? baseFromArguments(input.kind, offline.baseArguments, offline.queuedAt) : explicit ? history.find(doc => doc.revisionId === explicit) : undefined;
    // One second of slack: the server clock has second resolution, so a revision written in the last second before the disconnect counts as concurrent. Treating it as "theirs" is safe: if the writer had already seen it, its own copy contains the same change and the merge takes that change once.
    if (!base && !explicit && !offline.baseArguments && offline.serverTime) { const limit = Date.parse(offline.serverTime) - 1000; base = [...history].filter(doc => Date.parse(doc.updatedAt) <= limit).sort((a, b) => a.revisionNumber - b.revisionNumber).at(-1); }
    const metadataKeys = { merge: { entryId: offline.entryId, ...(offline.queuedAt ? { queuedAt: offline.queuedAt } : {}), ...(offline.serverTime ? { serverTime: offline.serverTime } : {}) } };
    const write = (fields: { title: string; body: string; tags: string[]; status: string; metadata: Record<string, unknown> }, outcome: MergeInfo['outcome']): Promise<TypedResult> => {
      const contentHash = sha256(JSON.stringify([input.kind, fields.title, fields.body, fields.status, fields.tags]));
      const metadata = { ...fields.metadata, typed: input.kind, stableId, contentHash, merge: { ...metadataKeys.merge, outcome, ...(base && !base.queuedPredecessor ? { baseRevisionId: base.revisionId } : {}), theirsRevisionId: head.revisionId } };
      return client.patch({ objectId: head.id, expectedRevisionId: head.revisionId, title: fields.title, body: fields.body, tags: fields.tags, status: fields.status, metadataPatch: metadata, metadataRemove: PROVENANCE_KEYS.filter(key => !(key in metadata)), ...(input.evidence ? { evidence: input.evidence } : {}), idempotencyKey: offlineKey })
        .then(doc => ({ ...ctx.done(doc, false, false), contentHash, merge: { outcome, ...(base && !base.queuedPredecessor ? { baseRevisionId: base.revisionId } : {}), theirsRevisionId: head.revisionId, body: fields.body } }));
    };
    const ourProvenance = Object.fromEntries(PROVENANCE_KEYS.filter(key => input.metadata?.[key] !== undefined || (input as unknown as Record<string, unknown>)[key] !== undefined).map(key => [key, (input as unknown as Record<string, unknown>)[key]]));
    const oursMeta: Record<string, unknown> = { ...Object.fromEntries(domainKeys.map(key => [key, input.metadata![key]])), ...ourProvenance };
    if (base && (base.revisionId === head.revisionId || (base.queuedPredecessor && sameContent(base, head, domainKeys)))) { try { return await write({ title: ctx.title, body: ctx.body, tags: ctx.tags, status, metadata: oursMeta }, 'FAST_FORWARD'); } catch (error) { if (error instanceof MDBError && error.code === 'CONFLICT') continue; throw error; } }
    // ---- three-way merge ------------------------------------------------------------------------------------------------------
    const conflicts: string[] = []; const labels = { ours: `local (offline write ${offline.queuedAt ?? 'queued'})`, theirs: `server (revision ${head.revisionNumber}, ${head.updatedAt})`, base: base?.queuedPredecessor ? 'the previous write queued by this client' : base ? `revision ${base.revisionNumber}, ${base.updatedAt}` : 'empty (no common ancestor)' };
    const bodyMerge = merge3(base?.body ?? '', ctx.body, head.body, labels); if (bodyMerge.conflicts) conflicts.push('body');
    const title = mergeScalar<string>(base?.title, ctx.title, head.title); if (title.conflict) conflicts.push('title');
    const statusMerge = mergeScalar<string>(base?.status, status, head.status); if (statusMerge.conflict) conflicts.push('status');
    const tagOf = (tags: string[] | undefined) => tags?.find(tag => STATUS_TAG.test(tag)); const plain = (tags: string[] | undefined) => (tags ?? []).filter(tag => !STATUS_TAG.test(tag));
    const statusTag = mergeScalar<string | undefined>(tagOf(base?.tags), tagOf(ctx.tags), tagOf(head.tags)); if (statusTag.conflict) conflicts.push('status tag');
    const merged: Record<string, unknown> = {};
    for (const key of domainKeys) { const m = mergeScalar<string>(base ? JSON.stringify(base.metadata[key]) : undefined, JSON.stringify(oursMeta[key]), JSON.stringify(head.metadata[key])); if (m.conflict) conflicts.push(key); else if (m.value !== undefined) merged[key] = JSON.parse(m.value); }
    if (conflicts.length) {
      const note = await upsertTyped(client, { kind: 'note', stableId: conflictId, scope: input.scope, title: `Merge conflict: ${ctx.title}`.slice(0, 300), tags: ['conflict', 'merge-conflict', `conflict-of:${stableId}`.slice(0, 120)],
        body: [`# Merge conflict in ${input.kind} \`${stableId}\``, '', `An offline write (${offline.queuedAt ?? 'queued'}) was based on ${base ? `revision ${base.revisionNumber} (${base.updatedAt})` : 'no earlier revision'}; the server record is now at revision ${head.revisionNumber} (${head.updatedAt}). The server record was **not changed**.`, '', `Conflicting fields: ${conflicts.join(', ')}`, '',
          ...(conflicts.includes('title') || conflicts.includes('status') || conflicts.some(key => domainKeys.includes(key)) ? ['## Field values', '', `- title: local ${JSON.stringify(ctx.title)} / server ${JSON.stringify(head.title)} / base ${JSON.stringify(base?.title)}`, ...domainKeys.map(key => `- ${key}: local ${JSON.stringify(oursMeta[key])} / server ${JSON.stringify(head.metadata[key])} / base ${JSON.stringify(base?.metadata[key])}`), ''] : []),
          '## Body, merged with git-style markers', '', '```', bodyMerge.text, '```', '', '## Complete local version', '', '```', ctx.body, '```'].join('\n') });
      return { ...ctx.done(head, false, true), merge: { outcome: 'CONFLICT', ...(base ? { baseRevisionId: base.revisionId } : {}), theirsRevisionId: head.revisionId, conflictNoteId: note.stableId, conflictingFields: conflicts } };
    }
    const tags = [...new Set([input.kind, ...mergeTags(plain(base?.tags), plain(ctx.tags), plain(head.tags)), ...(statusTag.value ? [statusTag.value] : [])])];
    // Nothing to add: the merged content is exactly what the server already has (for example the same file was already delivered and the acknowledgement was lost).
    if (bodyMerge.text === head.body && title.value === head.title && statusMerge.value === head.status && [...tags].sort().join('\0') === [...head.tags].sort().join('\0') && domainKeys.every(key => sameJson(merged[key], head.metadata[key]))) return { ...ctx.done(head, false, true), merge: { outcome: 'ALREADY_APPLIED', ...(base ? { baseRevisionId: base.revisionId } : {}), theirsRevisionId: head.revisionId } };
    try { return await write({ title: title.value, body: bodyMerge.text, tags, status: statusMerge.value, metadata: { ...merged, ...ourProvenance } }, 'MERGED'); }
    catch (error) { if (error instanceof MDBError && error.code === 'CONFLICT') continue; throw error; } // the record moved again while merging: start over from the new head
  }
  throw new MDBError('CONFLICT', 'The record kept changing while the offline write was being merged; it can be sent again safely');
}

export async function upsertTask(client: Engram, input: Provenance & { scope: Scope; taskId: string; title: string; status: TaskStatus; body?: string; assignee?: string; evidence?: Evidence[]; expectedRevisionId?: string; offline?: OfflineWrite }): Promise<TypedResult> {
  if (!(TASK_STATUSES as readonly string[]).includes(input.status)) invalid(`status must be one of ${TASK_STATUSES.join(', ')}`);
  return upsertTyped(client, { kind: 'task', stableId: input.taskId, scope: input.scope, title: input.title, body: input.body ?? '', tags: [`status:${input.status}`], metadata: { taskStatus: input.status, ...(input.assignee ? { assignee: input.assignee } : {}) }, ...(input.host ? { host: input.host } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.evidence ? { evidence: input.evidence } : {}), ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}), ...(input.offline ? { offline: input.offline } : {}) });
}

export async function upsertNote(client: Engram, input: Provenance & { scope: Scope; noteId: string; title: string; body: string; tags?: string[]; evidence?: Evidence[]; expectedRevisionId?: string; status?: 'active' | 'tombstone'; metadata?: Record<string, unknown>; offline?: OfflineWrite }): Promise<TypedResult> {
  return upsertTyped(client, { kind: 'note', stableId: input.noteId, scope: input.scope, title: input.title, body: input.body, ...(input.tags ? { tags: input.tags } : {}), ...(input.status ? { status: input.status } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.host ? { host: input.host } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), ...(input.evidence ? { evidence: input.evidence } : {}), ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}), ...(input.offline ? { offline: input.offline } : {}) });
}

export interface HandoffInput extends Provenance { offline?: OfflineWrite; scope: Scope; sessionId: string; state: 'ended' | 'interrupted'; completed: string[]; next: string[]; blockers: string[]; filesTouched: string[]; openTasks: string[] }
export const handoffBody = (state: string, completed: string[], next: string[], blockers: string[], filesTouched: string[], openTasks: string[]): string => `State: ${state}\n\n${list('Completed', completed)}\n${list('Next', next)}\n${list('Blockers', blockers)}\n${list('Files touched', filesTouched)}\n${list('Open tasks', openTasks)}`;
const list = (title: string, items: string[]): string => `## ${title}\n${items.length ? items.map(item => `- ${item}`).join('\n') : '- none'}\n`;
/** Written only by an explicit call. A session that simply stops produces no handoff; an interrupted one may record what is open but never claims completed work. */
export async function writeHandoff(client: Engram, input: HandoffInput): Promise<TypedResult> {
  if (input.state === 'interrupted' && input.completed.length) invalid('an interrupted handoff cannot list completed work');
  for (const items of [input.completed, input.next, input.blockers, input.filesTouched, input.openTasks]) if (!Array.isArray(items) || items.length > 200 || items.some(item => typeof item !== 'string' || item.length > 500)) invalid('handoff lists must hold at most 200 short strings');
  const body = handoffBody(input.state, input.completed, input.next, input.blockers, input.filesTouched, input.openTasks);
  return upsertTyped(client, { kind: 'handoff', stableId: checkId(input.sessionId, 'session id'), scope: input.scope, title: `Handoff ${input.sessionId} (${input.state})`, body, metadata: { handoffState: input.state, openTasks: input.openTasks.slice(0, 50) }, ...(input.host ? { host: input.host } : {}), sessionId: input.sessionId, ...(input.offline ? { offline: input.offline } : {}) });
}
