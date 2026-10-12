import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Engram } from '../sdk/index.js';
import { MDBError } from '../core/types.js';
import { atomicWrite } from '../storage-local/index.js';
import type { ProjectBinding } from '../core/project-binding.js';
import { upsertNote } from './workspace-ops.js';
import { openRemoteSession, RemoteError, type RemoteSession } from './remote-client.js';
import { looksSecret } from './redact.js';

/**
 * Opt-in Markdown file sync. Only files under the approved include patterns (and not under an exclude) are ever read, only after the project recorded separate file-sync consent,
 * and a file with a secret in it is quarantined locally instead of uploaded. Every write carries the revision it was based on, so a concurrent edit becomes a visible conflict note,
 * never an overwrite. A file written while the server is unreachable is queued durably (one entry per path) and the result says QUEUED_OFFLINE until the server acknowledges it.
 */
export type SyncStatus = 'COMMITTED' | 'QUEUED_OFFLINE' | 'FAILED' | 'CONFLICT' | 'QUARANTINED' | 'SKIPPED' | 'DISABLED' | 'TOMBSTONED';
export interface SyncOutcome { path: string; status: SyncStatus; detail?: string; revisionId?: string; unchanged?: boolean }
interface FileState { noteId: string; hash: string; baseRevisionId?: string; status: SyncStatus; at: string; detail?: string; conflictNoteId?: string; renamedFrom?: string }
interface SyncState { schemaVersion: 1; files: Record<string, FileState> }
interface QueueEntry { path: string; hash: string; queuedAt: string; bytes: number }
export const MAX_SYNC_FILE_BYTES = 256 * 1024;
export const MAX_RUN_BYTES = 5 * 1024 * 1024;
export const MAX_QUEUE_ENTRIES = 200;
const STATE_KEY = '.engram/sync-state.json', QUEUE_DIR = '.engram/sync-queue';
/** Never uploaded, whatever the patterns say. */
const ALWAYS_DENIED = [/(^|\/)(README|AGENTS|CLAUDE)\.md$/i, /(^|\/)\.env[^/]*$/i, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.engram\/(?!notes\/)/, /\.(pem|key|p12)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)/];

export function globToRegExp(pattern: string): RegExp {
  let out = ''; for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') { if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; } else out += '[^/]*'; }
    else if (c === '?') out += '[^/]'; else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
const matches = (patterns: string[], rel: string): boolean => patterns.some(p => globToRegExp(p).test(rel));

export type Eligibility = { ok: true; rel: string; abs: string; size: number } | { ok: false; reason: string };
/** Decides whether one path may be synchronized. Everything unusual is a refusal with a reason. */
export async function evaluatePath(projectDir: string, binding: ProjectBinding, candidate: string): Promise<Eligibility> {
  try {
    const abs = path.resolve(projectDir, candidate); const lexical = path.relative(path.resolve(projectDir), abs).split(path.sep).join('/');
    if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) return { ok: false, reason: 'outside the project' };
    if (!lexical.endsWith('.md')) return { ok: false, reason: 'not a Markdown file' };
    if (ALWAYS_DENIED.some(re => re.test(lexical))) return { ok: false, reason: 'never synchronized (instruction, secret or tool directory)' };
    if (matches(binding.notesExclude, lexical)) return { ok: false, reason: 'excluded by pattern' };
    if (!matches(binding.notesInclude, lexical)) return { ok: false, reason: 'not under an approved path' };
    const info = await fs.lstat(abs);
    if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!info.isFile()) return { ok: false, reason: 'not a regular file' };
    const realRoot = await fs.realpath(projectDir); const real = await fs.realpath(abs);
    if (real !== path.join(realRoot, lexical)) return { ok: false, reason: 'path passes through a symlink' };
    if (info.size > MAX_SYNC_FILE_BYTES) return { ok: false, reason: `larger than ${MAX_SYNC_FILE_BYTES} bytes` };
    return { ok: true, rel: lexical, abs, size: info.size };
  } catch (error) { return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}

// ---- transports ---------------------------------------------------------------------------------------------------------------------------
export type SinkResult = { kind: 'committed'; revisionId: string; unchanged: boolean } | { kind: 'offline' } | { kind: 'refused'; detail: string } | { kind: 'conflict'; detail: string } | { kind: 'failed'; detail: string };
export interface NoteWrite { noteId: string; title: string; body: string; sourcePath: string; expectedRevisionId: string; status?: 'active' | 'tombstone'; tags?: string[] }
export interface SyncSink { upsert(write: NoteWrite): Promise<SinkResult> }
export function localSink(client: Engram, workspaceId: string): SyncSink {
  return { async upsert(w) {
    try { const r = await upsertNote(client, { scope: { type: 'workspace', workspaceId }, noteId: w.noteId, title: w.title, body: w.body, sourcePath: w.sourcePath, tags: ['file-sync', ...(w.tags ?? [])], expectedRevisionId: w.expectedRevisionId, ...(w.status ? { status: w.status } : {}), metadata: { contentSource: 'file-sync' } }); return { kind: 'committed', revisionId: r.revisionId, unchanged: r.unchanged }; }
    catch (error) { if (error instanceof MDBError) return error.code === 'CONFLICT' ? { kind: 'conflict', detail: error.message } : error.code === 'NOT_FOUND_OR_FORBIDDEN' ? { kind: 'refused', detail: error.message } : { kind: 'failed', detail: error.message }; return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }; }
  } };
}
export function remoteSink(binding: ProjectBinding, env: NodeJS.ProcessEnv = process.env, timeoutMs = 4000): SyncSink {
  let session: Promise<RemoteSession> | undefined;
  return { async upsert(w) {
    const token = binding.credentialRef ? env[binding.credentialRef] : undefined;
    if (!binding.serverUrl || !token) return { kind: 'offline' }; // without a credential nothing can be delivered: keep it queued
    try {
      session ??= openRemoteSession({ url: binding.serverUrl, token, workspaceId: binding.workspaceId, timeoutMs }); const s = await session;
      const reply = await s.call('engram_note_upsert', { noteId: w.noteId, title: w.title, body: w.body, sourcePath: w.sourcePath, tags: ['file-sync', ...(w.tags ?? [])], expectedRevisionId: w.expectedRevisionId, contentSource: 'file-sync', ...(w.status ? { status: w.status } : {}) });
      if (reply.isError) { const code = (reply.value as { error?: { code?: string; message?: string } } | undefined)?.error; return code?.code === 'CONFLICT' ? { kind: 'conflict', detail: code.message ?? 'conflict' } : code?.code === 'NOT_FOUND_OR_FORBIDDEN' ? { kind: 'refused', detail: 'the server refused this credential for the workspace' } : { kind: 'failed', detail: code?.message ?? 'the server rejected the note' }; }
      const v = reply.value as { revisionId?: string; unchanged?: boolean; persistence?: string }; if (v.persistence !== 'COMMITTED' || !v.revisionId) return { kind: 'failed', detail: 'the server did not acknowledge a commit' };
      return { kind: 'committed', revisionId: v.revisionId, unchanged: !!v.unchanged };
    } catch (error) { session = undefined; if (error instanceof RemoteError) return error.kind === 'auth' || error.kind === 'workspace' ? { kind: 'refused', detail: error.message } : error.kind === 'network' ? { kind: 'offline' } : { kind: 'failed', detail: error.message }; return { kind: 'offline' }; }
  } };
}

// ---- state and queue ----------------------------------------------------------------------------------------------------------------------
export interface SyncContext { projectDir: string; binding: ProjectBinding; sink: SyncSink; now?: Date }
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const queueKey = (rel: string): string => `${QUEUE_DIR}/${sha(rel).slice(0, 32)}.json`;
async function readState(projectDir: string): Promise<SyncState> { try { const s = JSON.parse(await fs.readFile(path.join(projectDir, STATE_KEY), 'utf8')) as SyncState; if (s?.schemaVersion === 1 && s.files && typeof s.files === 'object') return s; } catch { /* none yet */ } return { schemaVersion: 1, files: {} }; }
async function writeState(projectDir: string, state: SyncState): Promise<void> { await atomicWrite(projectDir, STATE_KEY, `${JSON.stringify(state, null, 1)}\n`); }
async function listQueue(projectDir: string): Promise<QueueEntry[]> { const dir = path.join(projectDir, QUEUE_DIR); const out: QueueEntry[] = []; for (const name of await fs.readdir(dir).catch(() => [] as string[])) if (name.endsWith('.json')) try { out.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as QueueEntry); } catch { /* skip a torn entry; it is rewritten on the next write */ } return out; }
const title = (rel: string, body: string): string => (/^#\s+(.+)$/m.exec(body)?.[1] ?? path.basename(rel, '.md')).replace(/\s+/g, ' ').trim().slice(0, 200) || path.basename(rel);

export async function syncFile(ctx: SyncContext, candidate: string): Promise<SyncOutcome> {
  const { projectDir, binding, sink } = ctx; const now = (ctx.now ?? new Date()).toISOString();
  if (!binding.fileSyncConsent) return { path: candidate, status: 'DISABLED', detail: 'no file-sync consent is recorded for this project' };
  const eligible = await evaluatePath(projectDir, binding, candidate);
  if (!eligible.ok) {
    if (eligible.reason !== 'missing') return { path: candidate, status: 'SKIPPED', detail: eligible.reason };
    return tombstoneIfKnown(ctx, path.relative(path.resolve(projectDir), path.resolve(projectDir, candidate)).split(path.sep).join('/'));
  }
  const { rel, abs } = eligible; const bytes = await fs.readFile(abs); if (bytes.includes(0)) return { path: rel, status: 'SKIPPED', detail: 'binary content' };
  const body = bytes.toString('utf8'); const hash = sha(body); const state = await readState(projectDir); const known = state.files[rel];
  if (looksSecret(body)) { state.files[rel] = { noteId: `file:${rel}`, hash, status: 'QUARANTINED', at: now, detail: 'the file contains what looks like a secret; it was not uploaded' }; await writeState(projectDir, state); return { path: rel, status: 'QUARANTINED', detail: 'looks like it contains a secret; nothing was uploaded. Remove the secret and save again.' }; }
  if (known && known.hash === hash && (known.status === 'COMMITTED' || known.status === 'CONFLICT')) return { path: rel, status: known.status === 'COMMITTED' ? 'SKIPPED' : 'CONFLICT', detail: known.status === 'COMMITTED' ? 'unchanged since the last committed sync' : known.detail ?? 'unresolved conflict', unchanged: true };
  const noteId = `file:${rel}`; const write: NoteWrite = { noteId, title: title(rel, body), body, sourcePath: rel, expectedRevisionId: known?.baseRevisionId ?? 'none' };
  const result = await sink.upsert(write);
  if (result.kind === 'committed') { state.files[rel] = { noteId, hash, baseRevisionId: result.revisionId, status: 'COMMITTED', at: now }; await writeState(projectDir, state); await fs.rm(path.join(projectDir, queueKey(rel)), { force: true }); return { path: rel, status: 'COMMITTED', revisionId: result.revisionId, unchanged: result.unchanged }; }
  if (result.kind === 'conflict') {
    // Keep the other side exactly as it is; store this side as its own note so nothing is lost and a person can merge.
    const conflictNoteId = `conflict:${rel}:${hash.slice(0, 8)}`;
    const saved = await sink.upsert({ noteId: conflictNoteId, title: `Conflict: ${title(rel, body)}`, body, sourcePath: rel, expectedRevisionId: 'none', tags: ['conflict'] });
    state.files[rel] = { noteId, hash, ...(known?.baseRevisionId ? { baseRevisionId: known.baseRevisionId } : {}), status: 'CONFLICT', at: now, detail: `the server copy changed since this machine last synced; this version was saved as ${conflictNoteId} and nothing was overwritten`, conflictNoteId }; await writeState(projectDir, state);
    await fs.rm(path.join(projectDir, queueKey(rel)), { force: true });
    return { path: rel, status: 'CONFLICT', detail: state.files[rel]!.detail!, ...(saved.kind === 'committed' ? { revisionId: saved.revisionId } : {}) };
  }
  // offline / refused / failed: durable, coalesced queue entry (one per path), bounded
  const queue = await listQueue(projectDir); const already = queue.some(q => q.path === rel);
  if (!already && queue.length >= MAX_QUEUE_ENTRIES) return { path: rel, status: 'FAILED', detail: `the offline queue is full (${MAX_QUEUE_ENTRIES} files)` };
  await atomicWrite(projectDir, queueKey(rel), `${JSON.stringify({ path: rel, hash, queuedAt: now, bytes: bytes.length } satisfies QueueEntry)}\n`);
  const status: SyncStatus = result.kind === 'offline' ? 'QUEUED_OFFLINE' : 'FAILED';
  const detail = result.kind === 'offline' ? 'saved locally and queued; it is not on the server yet' : result.detail;
  state.files[rel] = { noteId, hash, ...(known?.baseRevisionId ? { baseRevisionId: known.baseRevisionId } : {}), status, at: now, detail }; await writeState(projectDir, state);
  return { path: rel, status, detail };
}

async function tombstoneIfKnown(ctx: SyncContext, rel: string, renamedTo?: string): Promise<SyncOutcome> {
  const state = await readState(ctx.projectDir); const known = state.files[rel];
  if (!known || known.status === 'TOMBSTONED') return { path: rel, status: 'SKIPPED', detail: 'missing and never synchronized' };
  if (!known.baseRevisionId) { delete state.files[rel]; await writeState(ctx.projectDir, state); await fs.rm(path.join(ctx.projectDir, queueKey(rel)), { force: true }); return { path: rel, status: 'SKIPPED', detail: 'removed before it ever reached the server' }; }
  const result = await ctx.sink.upsert({ noteId: known.noteId, title: `Deleted: ${path.basename(rel, '.md')}`, body: '', sourcePath: rel, expectedRevisionId: known.baseRevisionId, status: 'tombstone', ...(renamedTo ? { tags: [`renamed-to:${renamedTo}`.slice(0, 120)] } : {}) });
  if (result.kind === 'committed') { state.files[rel] = { ...known, status: 'TOMBSTONED', baseRevisionId: result.revisionId, at: (ctx.now ?? new Date()).toISOString(), detail: renamedTo ? `renamed to ${renamedTo}` : 'file deleted locally; history is kept on the server' }; await writeState(ctx.projectDir, state); return { path: rel, status: 'TOMBSTONED', revisionId: result.revisionId }; }
  return { path: rel, status: result.kind === 'offline' ? 'QUEUED_OFFLINE' : result.kind === 'conflict' ? 'CONFLICT' : 'FAILED', detail: result.kind === 'offline' ? 'deletion not delivered yet' : result.kind === 'refused' || result.kind === 'conflict' || result.kind === 'failed' ? result.detail : '' };
}

// ---- reconcile: queue, approved roots, vanished files -------------------------------------------------------------------------------------
async function* walk(dir: string, depth = 0, budget = { files: 2000 }): AsyncGenerator<string> {
  if (depth > 8) return;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (budget.files <= 0) return; const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // a link is never followed; evaluatePath would refuse it anyway
    if (entry.isDirectory()) yield* walk(full, depth + 1, budget); else if (entry.isFile() && entry.name.endsWith('.md')) { budget.files--; yield full; }
  }
}
const staticPrefix = (pattern: string): string => { const i = pattern.search(/[*?]/); const head = i < 0 ? path.posix.dirname(pattern) : pattern.slice(0, i); return head.endsWith('/') ? head.slice(0, -1) : path.posix.dirname(`${head}x`); };

/** Brings the server in line with the approved files: drains the queue, syncs changed files, and records deletions and renames. Bounded per run. */
export async function reconcile(ctx: SyncContext): Promise<{ outcomes: SyncOutcome[]; skippedForBudget: number }> {
  const outcomes: SyncOutcome[] = []; let bytes = 0, skippedForBudget = 0;
  if (!ctx.binding.fileSyncConsent) return { outcomes: [{ path: '*', status: 'DISABLED', detail: 'no file-sync consent is recorded for this project' }], skippedForBudget };
  const seen = new Set<string>(); const handle = async (candidate: string, size?: number) => {
    if (seen.has(candidate)) return; seen.add(candidate);
    if (size !== undefined && bytes + size > MAX_RUN_BYTES) { skippedForBudget++; return; } bytes += size ?? 0;
    outcomes.push(await syncFile(ctx, candidate));
  };
  for (const entry of await listQueue(ctx.projectDir)) await handle(entry.path);
  const roots = [...new Set(ctx.binding.notesInclude.map(staticPrefix))];
  const newHashes = new Map<string, string>();
  for (const root of roots) { const abs = path.join(ctx.projectDir, root); for await (const file of walk(abs)) { const e = await evaluatePath(ctx.projectDir, ctx.binding, file); if (e.ok) { const state = (await readState(ctx.projectDir)).files[e.rel]; const text = await fs.readFile(e.abs, 'utf8').catch(() => ''); if (!state) newHashes.set(sha(text), e.rel); await handle(e.rel, e.size); } } }
  const state = await readState(ctx.projectDir);
  for (const [rel, known] of Object.entries(state.files)) {
    if (seen.has(rel) || known.status === 'TOMBSTONED' || known.status === 'QUARANTINED') continue;
    const e = await evaluatePath(ctx.projectDir, ctx.binding, rel); if (e.ok || e.reason !== 'missing') continue;
    seen.add(rel); outcomes.push(await tombstoneIfKnown(ctx, rel, newHashes.get(known.hash)));
  }
  return { outcomes, skippedForBudget };
}

export interface SyncReport { consent: boolean; include: string[]; exclude: string[]; committed: number; queued: number; queuedBytes: number; conflicts: Array<{ path: string; conflictNoteId?: string }>; quarantined: string[]; failed: Array<{ path: string; detail?: string }>; lastSyncAt?: string }
export async function syncReport(projectDir: string, binding: ProjectBinding): Promise<SyncReport> {
  const state = await readState(projectDir); const queue = await listQueue(projectDir); const files = Object.entries(state.files);
  const last = files.map(([, f]) => f.at).sort().at(-1);
  return { consent: binding.fileSyncConsent, include: binding.notesInclude, exclude: binding.notesExclude, committed: files.filter(([, f]) => f.status === 'COMMITTED').length, queued: queue.length, queuedBytes: queue.reduce((n, q) => n + q.bytes, 0),
    conflicts: files.filter(([, f]) => f.status === 'CONFLICT').map(([p, f]) => ({ path: p, ...(f.conflictNoteId ? { conflictNoteId: f.conflictNoteId } : {}) })), quarantined: files.filter(([, f]) => f.status === 'QUARANTINED').map(([p]) => p), failed: files.filter(([, f]) => f.status === 'FAILED').map(([p, f]) => ({ path: p, ...(f.detail ? { detail: f.detail } : {}) })), ...(last ? { lastSyncAt: last } : {}) };
}

/** Paths a host tool call touched. Claude Code/Codex Write and Edit carry file_path; apply_patch carries the patch text. Returns undefined when the payload names no file. */
export function pathsFromHookPayload(stdin: string): string[] | undefined {
  try {
    const payload = JSON.parse(stdin) as { tool_input?: Record<string, unknown>; tool_name?: string }; const input = payload.tool_input ?? {};
    const direct = [input.file_path, input.path, input.notebook_path].filter((v): v is string => typeof v === 'string' && v.length > 0);
    const patch = typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : typeof input.command === 'string' ? input.command : '';
    const fromPatch = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]!.trim());
    const all = [...direct, ...fromPatch]; return all.length ? [...new Set(all)].slice(0, 50) : undefined;
  } catch { return undefined; }
}
