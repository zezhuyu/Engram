import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite, safePath } from '../storage-local/index.js';

export const CLIENT_PRESENCE_TTL_MS = 7 * 24 * 60 * 60_000;
export const CLIENT_PRESENCE_LIMIT = 10_000;
export const CLIENT_PRESENCE_BYTES = 10 * 1024 * 1024;
const FILE = '.mdb/client-presence.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const modes = ['syncing', 'buffered', 'cached', 'paused', 'offline', 'refused', 'unknown'];
const syncStates = ['idle', 'syncing', 'queued', 'conflict', 'disabled', 'unknown'];
export type ClientPresence = Record<string, unknown> & { credentialId: string; actorId: string; clientId: string; serverReceivedAt: string; sourceBucket: string };
export class ClientPresenceError extends Error { constructor(message: string, public status = 400, public code = 'INVALID_INPUT') { super(message); } }
const record = (value: unknown, keys: string[]): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientPresenceError('Expected an object');
  const result = value as Record<string, any>;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new ClientPresenceError('Unknown heartbeat field');
  return result;
};
const plain = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80 || /[\x00-\x1f\x7f<>/\\]|https?:|javascript:/i.test(value) || value !== value.trim()) throw new ClientPresenceError(`${label} must be a short plain label`);
  return value;
};
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now() + 5 * 60_000) throw new ClientPresenceError('Timestamp must be ISO UTC and not more than five minutes in the future');
  return new Date(value).toISOString();
}
function count(value: unknown, max = 1_000_000): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new ClientPresenceError('Queue counts must be bounded nonnegative integers'); return value as number; }
export function validateClientHeartbeat(input: unknown): Record<string, unknown> {
  const body = record(input, ['schemaVersion','clientId','displayName','hostLabel','appVersion','mode','lastSync','queues','projects','replication']);
  if (body.schemaVersion !== 1 || typeof body.clientId !== 'string' || !UUID.test(body.clientId)) throw new ClientPresenceError('Heartbeat schema version or client ID is invalid');
  const displayName = plain(body.displayName, 'displayName'), hostLabel = plain(body.hostLabel, 'hostLabel'), appVersion = plain(body.appVersion, 'appVersion');
  if (!modes.includes(body.mode)) throw new ClientPresenceError('Heartbeat mode is invalid');
  const lastSync = record(body.lastSync, ['serverContactAt','outboxDeliveredAt','fileSyncCommittedAt','contextFetchedAt']);
  const sync: Record<string, string | null> = {};
  for (const key of ['serverContactAt','outboxDeliveredAt','fileSyncCommittedAt','contextFetchedAt']) { if (!(key in lastSync)) throw new ClientPresenceError('A lastSync timestamp is required'); sync[key] = timestamp(lastSync[key]); }
  const queues = record(body.queues, ['outbox','fileSync','capture','queuedBytes']);
  for (const key of ['outbox','fileSync','capture','queuedBytes']) if (!(key in queues)) throw new ClientPresenceError('All queue totals are required');
  const queueData = { outbox: count(queues.outbox), fileSync: count(queues.fileSync), capture: count(queues.capture), queuedBytes: count(queues.queuedBytes, 1_000_000_000_000) };
  if (!Array.isArray(body.projects) || body.projects.length > 100) throw new ClientPresenceError('At most 100 projects may be reported');
  const projects = body.projects.map((raw: unknown) => {
    const project = record(raw, ['folderName','workspaceId','contextFetchedAt','contextStale','fileSyncState','queuedWrites','conflicts']);
    const folderName = plain(project.folderName, 'folderName');
    if (typeof project.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(project.workspaceId) || typeof project.contextStale !== 'boolean' || !syncStates.includes(project.fileSyncState)) throw new ClientPresenceError('Project metadata is invalid');
    return { folderName, workspaceId: project.workspaceId, contextFetchedAt: timestamp(project.contextFetchedAt), contextStale: project.contextStale, fileSyncState: project.fileSyncState, queuedWrites: count(project.queuedWrites), conflicts: count(project.conflicts) };
  });
  let replication:Record<string,unknown>|undefined;
  if(body.replication!==undefined){const r=record(body.replication,['enrolledWorkspaces','state','epochState','profileSnapshotAt','quotas']);if(!Array.isArray(r.enrolledWorkspaces)||r.enrolledWorkspaces.length>20)throw new ClientPresenceError('At most 20 replica workspaces may be reported');const enrolledWorkspaces=r.enrolledWorkspaces.map((raw:unknown)=>{const w=record(raw,['workspaceId','pendingPush','diverged','deferred','lastPullAt','lastPushAt']);if(typeof w.workspaceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(w.workspaceId))throw new ClientPresenceError('Replica workspace metadata is invalid');return{workspaceId:w.workspaceId,pendingPush:count(w.pendingPush),diverged:count(w.diverged),deferred:count(w.deferred),lastPullAt:timestamp(w.lastPullAt),lastPushAt:timestamp(w.lastPushAt)};});const states=['syncing','synced','offline','refused','epoch-changed','paused','conflict','unknown'];if(typeof r.state!=='string'||!states.includes(r.state)||typeof r.epochState!=='string'||r.epochState.length>80||/[\x00-\x1f\x7f<>/\\]/.test(r.epochState))throw new ClientPresenceError('Replica state is invalid');let quotas:Record<string,number>|undefined;if(r.quotas!==undefined){const q=record(r.quotas,['replicaBytes','maxReplicaBytes','pendingOps','maxPendingOps','pendingBytes','maxPendingBytes']);quotas={replicaBytes:count(q.replicaBytes,1_000_000_000_000),maxReplicaBytes:count(q.maxReplicaBytes,1_000_000_000_000),pendingOps:count(q.pendingOps),maxPendingOps:count(q.maxPendingOps),pendingBytes:count(q.pendingBytes,1_000_000_000_000),maxPendingBytes:count(q.maxPendingBytes,1_000_000_000_000)};}replication={enrolledWorkspaces,state:r.state,epochState:r.epochState,profileSnapshotAt:timestamp(r.profileSnapshotAt),...(quotas?{quotas}:{})};}
  return { schemaVersion: 1, clientId: body.clientId.toLowerCase(), displayName, hostLabel, appVersion, mode: body.mode, lastSync: sync, queues: queueData, projects, ...(replication?{replication}:{}) };
}
async function read(root: string): Promise<{ version: 1; records: ClientPresence[] }> {
  try { const target = await safePath(root, FILE), info = await fs.lstat(target); if (info.isSymbolicLink() || !info.isFile() || info.size > CLIENT_PRESENCE_BYTES) throw new Error(); const value = JSON.parse(await fs.readFile(target, 'utf8')); if (value.version !== 1 || !Array.isArray(value.records) || value.records.length > CLIENT_PRESENCE_LIMIT || value.records.some((item: any) => !item || typeof item.credentialId !== 'string' || typeof item.clientId !== 'string' || typeof item.serverReceivedAt !== 'string')) throw new Error(); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] }; throw new Error('Client presence store is invalid'); }
}
async function write(root: string, value: { version: 1; records: ClientPresence[] }): Promise<void> {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > CLIENT_PRESENCE_BYTES) throw new ClientPresenceError('Client presence store is full', 507, 'STORE_FULL');
  const target = await safePath(root, FILE);
  await atomicWrite(root, FILE, json);
  await fs.chmod(path.dirname(target), 0o700); await fs.chmod(target, 0o600);
}
const prune = (records: ClientPresence[], now: number) => records.filter(item => Number.isFinite(Date.parse(item.serverReceivedAt)) && now - Date.parse(item.serverReceivedAt) < CLIENT_PRESENCE_TTL_MS).slice(-CLIENT_PRESENCE_LIMIT);
const rate = new Map<string, { window: number; count: number }>();
const writeQueues = new Map<string, Promise<void>>();
async function serialized<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(root), prior = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void; const queued = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => queued); writeQueues.set(key, tail);
  await prior;
  try { return await work(); } finally { release(); if (writeQueues.get(key) === tail) writeQueues.delete(key); }
}
export function deriveClientPresenceState(serverReceivedAt: string, now = Date.now()): { state: 'Connected' | 'Last seen'; stale: boolean } {
  const stale = !Number.isFinite(Date.parse(serverReceivedAt)) || now - Date.parse(serverReceivedAt) >= 2 * 60_000;
  return { state: stale ? 'Last seen' : 'Connected', stale };
}
export async function writeClientHeartbeat(root: string, credentialId: string, actorId: string, input: unknown, sourceBucket: string, now = Date.now()): Promise<ClientPresence> {
  const body = validateClientHeartbeat(input), key = `${path.resolve(root)}:${credentialId}:${body.clientId}`, current = rate.get(key);
  if (current && now - current.window < 60_000 && current.count >= 2) throw new ClientPresenceError('Heartbeat rate limit exceeded', 429, 'RATE_LIMITED');
  if (!current || now - current.window >= 60_000) rate.set(key, { window: now, count: 1 }); else current.count++;
  if (rate.size > 20_000) { for (const [entry, value] of rate) if (now - value.window >= 60_000) rate.delete(entry); while (rate.size > 20_000) rate.delete(rate.keys().next().value!); }
  const presence = { ...body, credentialId, actorId, sourceBucket, serverReceivedAt: new Date(now).toISOString() } as ClientPresence;
  return serialized(root, async () => { const store = await read(root), records = prune(store.records, now).filter(item => !(item.credentialId === credentialId && item.clientId === body.clientId)); records.push(presence); await write(root, { version: 1, records: records.slice(-CLIENT_PRESENCE_LIMIT) }); return presence; });
}
export async function listClientPresence(root: string, now = Date.now()): Promise<ClientPresence[]> {
  return serialized(root, async () => { const store = await read(root), records = prune(store.records, now); if (records.length !== store.records.length) await write(root, { version: 1, records }); return records; });
}
export async function deleteCredentialPresence(root: string, credentialId: string): Promise<void> {
  await serialized(root, async () => { const store = await read(root), records = store.records.filter(item => item.credentialId !== credentialId); if (records.length !== store.records.length) await write(root, { version: 1, records }); });
}
