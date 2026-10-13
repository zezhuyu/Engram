import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactText } from './redact.js';
import { syncDirectory } from '../storage-local/index.js';

/**
 * Client-side durable outbox for writes an agent made while the Engram server was unreachable (task, note and handoff upserts). An entry is the tool call itself
 * (tool name and arguments), never a credential. It is written and fsynced before the agent is told "queued", replayed in order once the server answers, and deleted
 * only after the server acknowledged it. A write the server refuses on its merits (a stale expected revision, invalid input, no access) is moved aside, never retried
 * blindly and never deleted, so nothing the agent wrote is lost and nothing overwrites newer server state.
 */
export interface OutboxEntry { version: 1; id: string; url: string; workspaceId?: string; tool: string; arguments: Record<string, unknown>; key: string; queuedAt: string; attempts: number;
  /** Server clock (from its Date header) at the last successful contact before this write was queued, and the revision of this record that the writer last saw through this client: together they locate the common ancestor if the server record changed meanwhile. */
  serverTime?: string; baseRevisionId?: string;
  /** set when this write was queued on top of an earlier queued write of the same record: that write's arguments are this write's merge base */ baseArguments?: Record<string, unknown> }
/** offline = the server did not answer (nothing is counted against the entry); retry = the server answered with a transient error (counted); auth = the credential was refused (entries are kept until the user fixes it). */
export type Delivery = 'delivered' | 'conflict' | 'rejected' | 'retry' | 'offline' | 'auth';
/** Days of offline work must fit: the bound exists to stop a runaway loop, not to drop a user's writes (override for tests with ENGRAM_OUTBOX_CAP). */
export const OUTBOX_CAP = Number(process.env.ENGRAM_OUTBOX_CAP) > 0 ? Number(process.env.ENGRAM_OUTBOX_CAP) : 5000;
export const MAX_ENTRY_BYTES = 700 * 1024;
export const defaultOutboxDirectory = (): string => process.env.ENGRAM_OUTBOX ?? path.join(os.homedir(), '.Engram-outbox');

/** Entries for the same record must be replayed in order, so the record's identity is part of the entry. */
export function entryKey(tool: string, args: Record<string, unknown>): string {
  const id = tool === 'engram_task_upsert' ? args.taskId : tool === 'engram_note_upsert' ? args.noteId : tool === 'engram_handoff_write' ? args.sessionId : undefined;
  return `${tool}:${typeof id === 'string' ? id : createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)}`;
}
const scrub = (value: unknown): unknown => typeof value === 'string' ? redactText(value) : Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)])) : value;

/** Only files this module wrote (timestamp-uuid.json). The proxy's cache and anything else in the directory are never treated as queued writes. */
const ENTRY_NAME = /^\d{14}-[0-9a-f-]{36}\.json$/;
const jsonNames = async (directory: string): Promise<string[]> => (await fs.readdir(directory).catch(() => [] as string[])).filter(name => ENTRY_NAME.test(name)).sort();

export async function enqueueWrite(directory: string, input: { url: string; workspaceId?: string; tool: string; arguments: Record<string, unknown>; serverTime?: string; baseRevisionId?: string; baseArguments?: Record<string, unknown> }): Promise<OutboxEntry> {
  const entry: OutboxEntry = { version: 1, id: randomUUID(), url: input.url, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), tool: input.tool, arguments: scrub(input.arguments) as Record<string, unknown>, key: entryKey(input.tool, input.arguments), queuedAt: new Date().toISOString(), attempts: 0, ...(input.serverTime ? { serverTime: input.serverTime } : {}), ...(input.baseRevisionId ? { baseRevisionId: input.baseRevisionId } : {}), ...(input.baseArguments ? { baseArguments: scrub(input.baseArguments) as Record<string, unknown> } : {}) };
  const text = JSON.stringify(entry); if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw new Error('The queued write is too large for the local outbox');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await syncDirectory(path.dirname(directory)).catch(() => undefined);
  if ((await jsonNames(directory)).length >= OUTBOX_CAP) throw new Error('The local outbox is full');
  const target = path.join(directory, `${String(Date.now()).padStart(14, '0')}-${entry.id}.json`), temporary = `${target}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, target); await syncDirectory(directory); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return entry;
}

export async function listOutbox(directory: string, match: (entry: OutboxEntry) => boolean = () => true): Promise<Array<{ name: string; entry: OutboxEntry }>> {
  const out: Array<{ name: string; entry: OutboxEntry }> = [];
  for (const name of await jsonNames(directory)) {
    try { const entry = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as OutboxEntry; if (entry?.version === 1 && typeof entry.tool === 'string' && entry.arguments && typeof entry.arguments === 'object' && typeof entry.url === 'string' && match(entry)) out.push({ name, entry }); }
    catch { await moveAside(directory, name, 'rejected', 'unreadable queued write'); }
  }
  return out;
}

async function moveAside(directory: string, name: string, folder: 'conflicts' | 'rejected', reason: string): Promise<void> {
  const target = path.join(directory, folder); await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.rename(path.join(directory, name), path.join(target, name)).catch(() => undefined);
  await fs.writeFile(path.join(target, `${name}.reason.json`), JSON.stringify({ reason, at: new Date().toISOString() }), { mode: 0o600 });
}

/** Append-only, timestamped record of what happened to each queued write (kept after the queued copy is deleted). Rotated at 1 MB. */
export const LOG_FILE = 'outbox.log';
export async function appendLog(directory: string, record: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, LOG_FILE);
    if (((await fs.stat(file).catch(() => undefined))?.size ?? 0) > 1_000_000) await fs.rename(file, `${file}.1`).catch(() => undefined);
    await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch { /* the log must never block a write */ }
}
export async function readLog(directory: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(path.join(directory, LOG_FILE), 'utf8').catch(() => ''); const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n').filter(Boolean).slice(-limit)) try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* a torn last line */ }
  return out;
}

export interface DrainResult { delivered: number; conflicts: number; rejected: number; remaining: number; stopped?: 'offline' | 'auth' }
/** Replays matching entries oldest first. Offline or an auth problem stops the run and keeps everything that is left, in order. */
export async function drainOutbox(options: { directory: string; match?: (entry: OutboxEntry) => boolean; deliver: (entry: OutboxEntry) => Promise<Delivery>; /** revision the server reported for the entry just delivered */ revisionOf?: (entry: OutboxEntry) => string | undefined; limit?: number; /** count what is left by reading every entry again (default true); periodic retries skip it so an idle retry costs one file read, not thousands */ countRemaining?: boolean }): Promise<DrainResult> {
  const result: DrainResult = { delivered: 0, conflicts: 0, rejected: 0, remaining: 0 }; const match = options.match ?? (() => true); let handled = 0;
  for (const name of await jsonNames(options.directory)) { // entries are read one at a time, so a retry that fails on the first one reads one file
    if (handled >= (options.limit ?? OUTBOX_CAP)) break;
    let entry: OutboxEntry; try { entry = JSON.parse(await fs.readFile(path.join(options.directory, name), 'utf8')) as OutboxEntry; } catch { if (!(await fs.stat(path.join(options.directory, name)).catch(() => undefined))) continue; await moveAside(options.directory, name, 'rejected', 'unreadable queued write'); continue; }
    if (entry?.version !== 1 || typeof entry.tool !== 'string' || !entry.arguments || typeof entry.url !== 'string' || !match(entry)) continue; handled++;
    const outcome = await options.deliver(entry).catch(() => 'retry' as const);
    if (outcome === 'delivered') {
      await fs.rm(path.join(options.directory, name), { force: true }); await syncDirectory(options.directory).catch(() => undefined); result.delivered++;
    }
    else if (outcome === 'conflict') { await moveAside(options.directory, name, 'conflicts', 'the server copy changed since this write was based on it; nothing was overwritten'); result.conflicts++; }
    else if (outcome === 'rejected') { await moveAside(options.directory, name, 'rejected', 'the server refused this write (invalid, or not permitted)'); result.rejected++; }
    else if (outcome === 'retry') { // the server answered with a transient error: that counts against the entry
      entry.attempts++; const file = path.join(options.directory, name); await fs.writeFile(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 }).then(() => fs.rename(`${file}.tmp`, file)).catch(() => fs.rm(`${file}.tmp`, { force: true }));
      result.stopped = 'offline'; break;
    } else { result.stopped = outcome === 'auth' ? 'auth' : 'offline'; break; } // unreachable or credential refused: nothing is rewritten and nothing is counted
  }
  if (options.countRemaining !== false) result.remaining = (await listOutbox(options.directory, options.match)).length;
  return result;
}

export async function outboxStatus(directory: string, match?: (entry: OutboxEntry) => boolean): Promise<{ queued: number; conflicts: number; rejected: number; oldest?: string; log: string }> {
  const queued = await listOutbox(directory, match); const count = async (folder: string) => (await fs.readdir(path.join(directory, folder)).catch(() => [] as string[])).filter(name => ENTRY_NAME.test(name)).length;
  return { queued: queued.length, conflicts: await count('conflicts'), rejected: await count('rejected'), ...(queued[0] ? { oldest: queued[0].entry.queuedAt } : {}), log: path.join(directory, LOG_FILE) };
}
