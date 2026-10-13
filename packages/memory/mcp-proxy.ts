import { ensureWatcher } from './outbox-watch.js';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { remoteUrlAllowed } from '../core/private-network.js';
import { appendLog, defaultOutboxDirectory, drainOutbox, enqueueWrite, entryKey, listOutbox, type Delivery, type DrainResult, type OutboxEntry } from './outbox.js';

/**
 * Local stdio MCP proxy for an agent host. It adds exactly one thing to the plain HTTP connection: when the Engram server cannot be reached, a task, note or handoff
 * write is kept in the local outbox (and the agent is told it is QUEUED_OFFLINE, not committed), and it is written to the server, in order, as soon as the server answers
 * again, after which the local copy is deleted. It computes nothing about memory itself: every read, search and context call is forwarded unchanged, and while the
 * server is down reads fail honestly instead of returning guesses. The bearer token is read from the environment at start, sent only to an allowed URL, and never stored.
 */
export const WRITE_TOOLS = ['engram_task_upsert', 'engram_note_upsert', 'engram_handoff_write'] as const;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };
export interface ProxyOptions { /** start the background watcher when a write is kept locally (default true; ENGRAM_AUTO_RECONNECT=0 also disables) */ autoReconnect?: boolean; /** have each drain pass recount the queue (used by one-shot drains that report it) */ countRemaining?: boolean; /** called with the result of every drain pass */ onDrain?: (result: DrainResult) => void; /** how long to wait for the last drain when input ends (default 3000) */ drainWaitMs?: number; url: string; token: string; workspaceId?: string; outbox?: string; input: Readable; output: Writable; timeoutMs?: number; drainIntervalMs?: number; fetchImpl?: typeof fetch; log?: (line: string) => void }
class Unreachable extends Error { constructor(readonly kind: 'offline' | 'auth', message: string, readonly retryAfterMs?: number) { super(message); } }

const textReply = (id: Rpc['id'], value: unknown, isError = false): RpcReply => ({ jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } });
const errorReply = (id: Rpc['id'], message: string, code = -32000): RpcReply => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function runMcpProxy(options: ProxyOptions): Promise<void> {
  const url = new URL(options.url);
  if (!remoteUrlAllowed(url)) throw new Error('Refusing to send a credential over plain HTTP to a non-private host');
  const outbox = options.outbox ?? defaultOutboxDirectory(), timeout = options.timeoutMs ?? 8000, doFetch = options.fetchImpl ?? fetch, log = options.log ?? (() => undefined);
  const identity = createHash('sha256').update(`${options.url}\0${options.workspaceId ?? ''}`).digest('hex').slice(0, 16);
  const cacheFile = path.join(outbox, `cache-${identity}.json`);
  const mine = (entry: OutboxEntry) => entry.url === options.url && (entry.workspaceId ?? '') === (options.workspaceId ?? '');
  let id = 1000;
  type Cache = { initialize?: unknown; tools?: unknown; bases?: Record<string, string>; serverTime?: string };
  // Several host sessions on this machine (Claude and Codex, two terminals) share one cache file: a torn or missing file is simply an empty cache.
  const readCache = async (): Promise<Cache> => { try { const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Cache; return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } };
  const cache: Cache = await readCache(); cache.bases ??= {};
  const saves = new Set<Promise<unknown>>();
  /** Atomic and safe against another proxy writing at the same time: a private temporary file per write, and what other sessions remembered about records is merged in, not overwritten. */
  // read-merge-write is serialised across proxies by a lock directory (mkdir is atomic); a lock older than 10 s belongs to a crashed process and is taken over
  const withLock = async <T>(action: () => Promise<T>): Promise<T> => {
    const lock = `${cacheFile}.lock`; const deadline = Date.now() + 5000;
    for (;;) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const age = Date.now() - ((await fs.stat(lock).catch(() => undefined))?.mtimeMs ?? Date.now()); if (age > 10_000) { await fs.rmdir(lock).catch(() => undefined); continue; } if (Date.now() > deadline) throw new Error('cache lock timeout'); await new Promise(r => setTimeout(r, 15 + Math.random() * 25)); }
    }
    try { return await action(); } finally { await fs.rmdir(lock).catch(() => undefined); }
  };
  const saveCache = (): Promise<unknown> => { const job: Promise<unknown> = (async () => {
    await fs.mkdir(outbox, { recursive: true, mode: 0o700 });
    await withLock(async () => { const other = await readCache(); const merged: Cache = { ...other, ...cache, bases: { ...other.bases, ...cache.bases } }; const temporary = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(merged), { mode: 0o600 }); await fs.rename(temporary, cacheFile).catch(() => fs.rm(temporary, { force: true })); Object.assign(cache, { bases: merged.bases }); if (!cache.tools && merged.tools) cache.tools = merged.tools; if (!cache.initialize && merged.initialize) cache.initialize = merged.initialize; });
  })().catch(() => undefined).finally(() => saves.delete(job)); saves.add(job); return job; };

  const post = async (body: unknown, extra: Record<string, string> = {}): Promise<Response> => {
    try { const response = await doFetch(url, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(options.workspaceId ? { 'X-Engram-Workspace': options.workspaceId } : {}), ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      const date = response.headers.get('date'); if (response.ok && date && Number.isFinite(Date.parse(date))) { cache.serverTime = new Date(date).toISOString(); } // the SERVER's clock at the last successful contact
      return response; }
    catch { throw new Unreachable('offline', 'The Engram server did not answer'); }
  };
  const readReply = async (response: Response): Promise<RpcReply> => {
    const text = await response.text(); const data = /^\s*[[{]/.test(text) ? text : (text.split('\n').find(line => line.startsWith('data:')) ?? '').slice(5);
    try { const parsed = JSON.parse(data); return (Array.isArray(parsed) ? parsed[0] : parsed) as RpcReply; } catch { throw new Unreachable('offline', 'Unreadable server response'); }
  };
  const classify = (response: Response): void => {
    if (response.status === 401 || response.status === 403) throw new Unreachable('auth', `The server refused the credential (${response.status})`);
    if (response.status === 429) { const wait = Number(response.headers.get('retry-after')); throw new Unreachable('offline', 'The Engram server is rate limiting this client (429)', Number.isFinite(wait) && wait > 0 ? Math.min(wait, 65) * 1000 : 5000); }
    if (response.status === 408 || response.status === 425 || response.status >= 500) throw new Unreachable('offline', `The Engram server is unavailable (${response.status})`);
  };
  // One upstream MCP session at a time. Setup is single-flight: a drain that starts with the process and the host's own initialize must share the same session, never create two and fight over it.
  let sessionReady: Promise<string> | undefined;
  const openSession = async (): Promise<string> => {
    const response = await post({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'engram-proxy', version: '1' } } });
    classify(response); const sid = response.headers.get('mcp-session-id');
    if (response.status !== 200 || !sid) throw new Unreachable('offline', `Unexpected initialize response (${response.status})`);
    const reply = await readReply(response); if (reply.result) { cache.initialize = reply.result; void saveCache(); }
    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': sid }); await initialized.arrayBuffer().catch(() => undefined);
    return sid;
  };
  const ensureSession = (): Promise<string> => sessionReady ??= openSession().catch(error => { sessionReady = undefined; throw error; });
  /** One forwarded request. A server restart drops the session (404): start a new one once and retry. */
  const forward = async (method: string, params: Record<string, unknown> | undefined): Promise<RpcReply> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sid = await ensureSession();
      const response = await post({ jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) }, { 'Mcp-Session-Id': sid });
      if (response.status === 404 || response.status === 400) { sessionReady = undefined; if (attempt === 0) continue; }
      classify(response);
      if (response.status === 404 || response.status === 400) throw new Unreachable('offline', 'The server session could not be re-established');
      return readReply(response);
    }
    throw new Unreachable('offline', 'The server session could not be re-established');
  };

  // The host asks for initialize and tools/list at start-up and may begin its first turn without waiting for slow servers, so these two are answered from the cache at once (when there is one) and refreshed
  // in the background; a changed tool list is announced with notifications/tools/list_changed. Everything else always goes to the server.
  const notify = (method: string) => options.output.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  let warming: Promise<void> | undefined;
  const warm = (): Promise<void> => warming ??= (async () => { try { const reply = await forward('tools/list', undefined); if (reply.result && JSON.stringify(reply.result) !== JSON.stringify(cache.tools)) { cache.tools = reply.result; await saveCache(); notify('notifications/tools/list_changed'); } void drain(); } catch { /* offline: the cache stays as it is */ } })().finally(() => { warming = undefined; });

  // ---- replay -------------------------------------------------------------------------------------------------------------------------
  const delivered = new Map<string, string>(); // entry id -> revision the server reported
  const deliver = async (entry: OutboxEntry): Promise<Delivery> => {
    try {
      // The server merges this with whatever changed on its side while this client was disconnected (like git): base = the revision this client last saw, or the server's state at its last contact.
      const offline = { entryId: entry.id, queuedAt: entry.queuedAt, ...(entry.serverTime ? { serverTime: entry.serverTime } : {}), ...(entry.baseArguments ? { baseArguments: entry.baseArguments } : entry.baseRevisionId ? { baseRevisionId: entry.baseRevisionId } : {}) };
      // During a drain a rate limit is simply waited out (the server says for how long), so a backlog larger than the per-minute limit still empties in one pass.
      let reply: RpcReply | undefined; for (let attempt = 0; attempt < 6; attempt++) { try { reply = await forward('tools/call', { name: entry.tool, arguments: { ...entry.arguments, offline } }); break; } catch (error) { if (error instanceof Unreachable && error.retryAfterMs && attempt < 5) { await new Promise(r => setTimeout(r, error.retryAfterMs)); continue; } throw error; } }
      if (!reply) return 'offline';
      const result = reply.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined; const body = result?.content?.[0]?.text ?? '';
      if (reply.error) { const refused = /scope|access|forbidden|not found/i.test(reply.error.message) || entry.attempts >= 7; if (refused) await appendLog(outbox, { event: 'rejected', id: entry.id, tool: entry.tool, key: entry.key, queuedAt: entry.queuedAt, reason: reply.error.message.slice(0, 200) }); return refused ? 'rejected' : 'retry'; }
      let parsed: { persistence?: string; revisionId?: string; merge?: { outcome?: string; conflictNoteId?: string; conflictingFields?: string[] }; error?: { code?: string; message?: string } } = {}; try { parsed = JSON.parse(body); } catch { /* plain text */ }
      if (!result?.isError) {
        if (parsed.revisionId) { cache.bases![entry.key] = parsed.revisionId; delivered.set(entry.id, parsed.revisionId); void saveCache(); }
        await appendLog(outbox, { event: parsed.merge?.outcome === 'CONFLICT' ? 'conflict-note' : parsed.merge?.outcome === 'MERGED' ? 'merged' : 'delivered', id: entry.id, tool: entry.tool, key: entry.key, queuedAt: entry.queuedAt, outcome: parsed.merge?.outcome ?? parsed.persistence ?? 'COMMITTED', ...(parsed.revisionId ? { revisionId: parsed.revisionId } : {}), ...(parsed.merge?.conflictNoteId ? { conflictNoteId: parsed.merge.conflictNoteId, conflictingFields: parsed.merge.conflictingFields } : {}) });
        return 'delivered';
      }
      const code = parsed.error?.code;
      if (code === 'INVALID_INPUT' || code === 'NOT_FOUND_OR_FORBIDDEN' || code === 'INVALID_ARGUMENT' || entry.attempts >= 7) { await appendLog(outbox, { event: 'rejected', id: entry.id, tool: entry.tool, key: entry.key, queuedAt: entry.queuedAt, reason: `${code ?? 'error'}: ${(parsed.error?.message ?? body).slice(0, 200)}` }); return 'rejected'; }
      return 'retry'; // including CONFLICT: the server only raises it when the record kept changing during the merge; the same entry is sent again
    } catch (error) { return error instanceof Unreachable ? (error.kind === 'auth' ? 'auth' : 'offline') : 'retry'; }
  };
  let draining: Promise<unknown> | undefined;
  const drain = (): Promise<unknown> => draining ??= drainOutbox({ directory: outbox, match: mine, deliver, revisionOf: entry => delivered.get(entry.id), countRemaining: options.countRemaining ?? false }).then(result => { options.onDrain?.(result); if (result.delivered || result.conflicts || result.rejected) log(`outbox: delivered ${result.delivered}, conflicts ${result.conflicts}, rejected ${result.rejected}, remaining ${result.remaining}`); return result; }).catch(() => undefined).finally(() => { draining = undefined; });

  // ---- request handling --------------------------------------------------------------------------------------------------------------
  const handleWrite = async (message: Rpc): Promise<RpcReply> => {
    const params = message.params ?? {}, tool = String(params.name), args = (params.arguments ?? {}) as Record<string, unknown>; const key = entryKey(tool, args);
    const queue = async (why: string): Promise<RpcReply> => {
      // a write made on top of an earlier queued write of the same record is based on THAT write (the client has not seen the server's changes), not on whatever the server has by the time it is delivered
    const predecessor = (await listOutbox(outbox, e => mine(e) && e.key === key)).at(-1)?.entry;
    try { const entry = await enqueueWrite(outbox, { url: options.url, ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), tool, arguments: args, ...(cache.serverTime ? { serverTime: cache.serverTime } : {}), ...(predecessor ? { baseArguments: predecessor.arguments } : cache.bases![key] ? { baseRevisionId: cache.bases![key] } : {}) }); await appendLog(outbox, { event: 'queued', id: entry.id, tool, key, queuedAt: entry.queuedAt, reason: why.slice(0, 120), ...(entry.serverTime ? { serverTime: entry.serverTime } : {}) });
        if (options.autoReconnect !== false) void ensureWatcher({ url: options.url, token: options.token, ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), outbox }); // the default: deliver by itself when the server returns, even if this session ends first
        return textReply(message.id, { persistence: 'QUEUED_OFFLINE', queuedId: entry.id, tool, reason: why, note: 'Saved on this machine only. It will be written to the Engram server, in order, when the connection returns, and the local copy is then deleted. Other agents cannot see it yet.' }); }
      catch (error) { return textReply(message.id, { persistence: 'FAILED', error: { code: 'OUTBOX_UNAVAILABLE', message: (error as Error).message } }, true); }
    };
    if ((await listOutbox(outbox, mine)).length) await drain(); // an older queued write for the same record must reach the server first
    if ((await listOutbox(outbox, entry => mine(entry) && entry.key === key)).length) return queue('an earlier write to the same record is still waiting for the server');
    try { const reply = await forward('tools/call', { name: tool, arguments: args }); reply.id = message.id ?? null; try { const seen = JSON.parse((reply.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '{}') as { revisionId?: string }; if (seen.revisionId) { cache.bases![key] = seen.revisionId; void saveCache(); } } catch { /* not a typed result */ } void drain(); return reply; }
    catch (error) { if (error instanceof Unreachable) return queue(error.message); throw error; }
  };
  const handle = async (message: Rpc): Promise<RpcReply | undefined> => {
    const method = message.method ?? '';
    if (message.id === undefined || message.id === null) return undefined; // notifications need no answer; the upstream session is initialized by the proxy itself
    try {
      if (method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
      // Newer hosts first probe for the stateless protocol (server/discover). The proxy speaks the classic initialize protocol only (it keeps one upstream session and answers from its cache), so it declines and the host falls back; forwarding the probe made the host switch to a protocol whose result format the cached answers do not have.
      if (method === 'server/discover') return errorReply(message.id, 'Method not found', -32601);
      if (method === 'initialize' && cache.initialize && cache.tools) {
        const known = cache.initialize as { capabilities?: { tools?: object } }; void warm();
        return { jsonrpc: '2.0', id: message.id, result: { ...known, capabilities: { ...known.capabilities, tools: { ...known.capabilities?.tools, listChanged: true } } } };
      }
      if (method === 'tools/list' && cache.tools) { void warm(); return { jsonrpc: '2.0', id: message.id, result: cache.tools }; }
      if (method === 'initialize') {
        try { await ensureSession(); void drain(); return { jsonrpc: '2.0', id: message.id, result: cache.initialize ?? {} }; }
        catch (error) { if (!(error instanceof Unreachable)) throw error; const requested = (message.params?.protocolVersion as string | undefined) ?? '2025-03-26';
          return { jsonrpc: '2.0', id: message.id, result: { ...(cache.initialize as object ?? { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: 'engram-offline-proxy', version: '1' } }), instructions: `The Engram server is unreachable right now (${error.message}). Task, note and handoff writes are kept on this machine and sent to the server automatically when it returns; reads fail until then.` } }; }
      }
      if (method === 'tools/call' && (WRITE_TOOLS as readonly string[]).includes(String(message.params?.name))) return await handleWrite(message);
      try { const reply = await forward(method, message.params); reply.id = message.id; if (method === 'tools/list' && reply.result) { cache.tools = reply.result; void saveCache(); } void drain(); return reply; }
      catch (error) {
        if (!(error instanceof Unreachable)) throw error;
        if (method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: cache.tools ?? { tools: [] } };
        if (method === 'resources/list') return { jsonrpc: '2.0', id: message.id, result: { resources: [] } };
        if (method === 'prompts/list') return { jsonrpc: '2.0', id: message.id, result: { prompts: [] } };
        if (method === 'tools/call') return textReply(message.id, { error: { code: 'SERVER_UNREACHABLE', message: `${error.message}. Reads and searches need the server; only task, note and handoff writes are buffered while it is down.` } }, true);
        return errorReply(message.id, error.message);
      }
    } catch (error) { return errorReply(message.id, (error as Error).message, -32603); }
  };

  const send = (reply: RpcReply) => options.output.write(`${JSON.stringify(reply)}\n`);
  void drain(); const timer = setInterval(() => void drain(), options.drainIntervalMs ?? 30_000); timer.unref?.();
  const lines = readline.createInterface({ input: options.input, crlfDelay: Infinity }); const inflight = new Set<Promise<void>>();
  lines.on('line', line => { if (!line.trim()) return; let message: Rpc; try { message = JSON.parse(line) as Rpc; } catch { send(errorReply(null, 'Parse error', -32700)); return; }
    const job = handle(message).then(reply => { if (reply) send(reply); }).finally(() => inflight.delete(job)); inflight.add(job); });
  await new Promise<void>(resolve => lines.once('close', resolve));
  await Promise.allSettled([...inflight]); await Promise.allSettled([...saves]); clearInterval(timer); await Promise.race([drain(), new Promise(r => setTimeout(r, options.drainWaitMs ?? 3000))]);
}

/** Called by `init`: contacts the server once so the proxy can serve initialize and tools/list from its cache even on its very first offline start. */
export async function primeProxyCache(options: { url: string; token: string; workspaceId?: string; outbox?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<void> {
  const { PassThrough } = await import('node:stream'); const input = new PassThrough(), output = new PassThrough(); output.resume();
  const done = runMcpProxy({ ...options, input, output, drainIntervalMs: 3_600_000 });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'engram-init', version: '1' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`); input.end(); await done;
}
/** The stdio command a host should launch to talk to the server through the offline-buffering proxy. */
export function proxyCommand(url: string, tokenEnv: string, workspaceId: string, binary: string, node = process.execPath): { command: string; args: string[] } {
  // A host starts the proxy with a minimal environment, so an outbox location chosen at init time is written into the command instead of being left to an environment variable.
  const outbox = process.env.ENGRAM_OUTBOX ? ['--outbox', path.resolve(process.env.ENGRAM_OUTBOX)] : [];
  // Plain HTTP is only allowed to a tailnet host when the user opted in (MDB_TRANSPORT_TRUST=tailscale). The same minimal environment means the proxy would not see that opt-in, so it is written into the command (never for https).
  const trust = process.env.MDB_TRANSPORT_TRUST && url.startsWith('http:') ? ['--transport-trust', process.env.MDB_TRANSPORT_TRUST] : [];
  return { command: node, args: [binary, 'mcp-proxy', '--url', url, '--token-env', tokenEnv, '--workspace', workspaceId, ...outbox, ...trust] };
}

/** One drain pass without a host attached (used by `mdb outbox drain` and the SessionStart hook): sends what is waiting for this server and workspace, then returns. */
export async function drainOutboxNow(options: { url: string; token: string; workspaceId?: string; outbox?: string; timeoutMs?: number; waitMs?: number; fetchImpl?: typeof fetch; log?: (line: string) => void }): Promise<DrainResult | undefined> {
  const { PassThrough } = await import('node:stream'); const input = new PassThrough(), output = new PassThrough(); output.resume(); input.end(); let last: DrainResult | undefined; const total: DrainResult = { delivered: 0, conflicts: 0, rejected: 0, remaining: 0 };
  await runMcpProxy({ ...options, input, output, drainIntervalMs: 3_600_000, drainWaitMs: options.waitMs ?? 120_000, countRemaining: true, onDrain: r => { last = r; total.delivered += r.delivered; total.conflicts += r.conflicts; total.rejected += r.rejected; } });
  return last ? { ...total, remaining: last.remaining, ...(last.stopped ? { stopped: last.stopped } : {}) } : undefined;
}

/**
 * One tool call through the same machinery as the stdio proxy (session handling, offline buffering of the three write tools, honest failure for reads): used by the CLI's remote mode,
 * so `mdb task upsert` on a machine that is offline is kept in the outbox exactly like an agent's write.
 */
export async function proxyCall(options: { url: string; token: string; workspaceId?: string; outbox?: string; timeoutMs?: number; fetchImpl?: typeof fetch }, method: 'tools/call' | 'tools/list', params?: Record<string, unknown>): Promise<{ isError: boolean; text: string; value?: unknown; raw: unknown }> {
  const { PassThrough } = await import('node:stream'); const input = new PassThrough(), output = new PassThrough(); output.setEncoding('utf8'); let buffer = '';
  const reply = new Promise<RpcReply>(resolve => output.on('data', (chunk: string) => { buffer += chunk; const i = buffer.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buffer.slice(0, i)) as RpcReply); }));
  const done = runMcpProxy({ ...options, input, output, drainIntervalMs: 3_600_000, drainWaitMs: 1500 });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })}\n`); const answer = await reply; input.end(); await done;
  if (answer.error) return { isError: true, text: answer.error.message, raw: answer };
  const result = answer.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined; const text = result?.content?.[0]?.text ?? ''; let value: unknown = text; try { value = text ? JSON.parse(text) : result; } catch { /* plain text */ }
  return { isError: !!result?.isError, text, value: method === 'tools/list' ? result : value, raw: answer };
}
