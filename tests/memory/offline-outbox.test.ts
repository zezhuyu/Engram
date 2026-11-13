import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { runMcpProxy } from '../../packages/memory/mcp-proxy.js';
import { drainOutbox, enqueueWrite, outboxStatus } from '../../packages/memory/outbox.js';
import { drainOutboxNow, proxyCall } from '../../packages/memory/mcp-proxy.js';
import { rotateHttpCredential } from '../../packages/mcp/credentials.js';
import { stat, readFile as readF } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { upsertNote, upsertTask } from '../../packages/memory/workspace-ops.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { defaultOutboxDirectory } from '../../packages/memory/outbox.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js');
const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
async function world(t: Cleanup) {
  let stopProxy: (() => Promise<void>) | undefined; t.after(() => stopProxy?.()); // stop cache writers before either directory is removed
  let stopServer: (() => Promise<void>) | undefined; t.after(() => stopServer?.()); // registered before the vault's cleanup: the server must be gone before its directory is removed
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj'); await owner.createWorkspace('other');
  const cred = await createHttpCredential(owner.vault, 'agent-o', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-o', ['read', 'write']);
  const port = await freePort(); const url = `http://127.0.0.1:${port}/mcp`; let child: ChildProcess | undefined;
  const start = async () => { const c = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port), MDB_MCP_HTTP_REQUESTS_PER_MINUTE: '5000' } }); child = c; let err = '';
    await new Promise<void>((res, rej) => { c.stderr!.setEncoding('utf8'); c.stderr!.on('data', (d: string) => { err += d; if (/MCP HTTP listening/.test(err)) res(); }); c.once('exit', code => rej(new Error(`server exit ${code} ${err}`))); }); };
  const stop = async () => { const c = child; child = undefined; if (c && c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise<void>(r => c.once('exit', () => r())); } };
  stopServer = stop; await start();
  const outbox = defaultOutboxDirectory({ ENGRAM_DATA_DIR: root });
  assert.equal(outbox, path.join(root, '.engram-runtime/outbox'), 'the replay writer resolves beneath the selected vault data root');
  // an in-process proxy wired to pipes, exactly as an agent host would talk to it over stdio
  const input = new PassThrough(), output = new PassThrough(); const pending = new Map<number, (m: any) => void>(); let nextId = 1;
  output.setEncoding('utf8'); let buffer = ''; output.on('data', (chunk: string) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); const m = JSON.parse(line); pending.get(m.id)?.(m); } });
  const done = runMcpProxy({ url, token: cred.token, workspaceId: 'proj', outbox, input, output, timeoutMs: 2500, drainIntervalMs: 60_000, autoReconnect: false }); // watcher behavior has its own process-lifecycle suite
  stopProxy = async () => { input.end(); await done.catch(() => undefined); };
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise(res => { const id = nextId++; pending.set(id, res); input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); });
  const call = async (name: string, args: Record<string, unknown>) => { const reply = await rpc('tools/call', { name, arguments: args }); const text = reply.result?.content?.[0]?.text as string | undefined; return { reply, value: text ? JSON.parse(text) : undefined, isError: !!reply.result?.isError }; };
  const task = (taskId: string, title: string, status = 'open', extra: Record<string, unknown> = {}) => call('engram_task_upsert', { taskId, title, status, ...extra });
  const serverTasks = async () => (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'proj' }] })).filter(d => d.metadata.typed === 'task');
  const queuedFiles = async () => (await readdir(outbox)).filter(n => /^\d+-.*\.json$/.test(n));
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }); await rpc('tools/list');
  return { owner, rpc, call, task, serverTasks, queuedFiles, outbox, stop, start, token: cred.token, credId: cred.id, url };
}

test('online writes pass straight through; while the server is down a write is kept locally and the agent is told it is QUEUED_OFFLINE; reads fail honestly; the tool list still works', async t => {
  const w = await world(t);
  const online = await w.task('T-1', 'First', 'open'); assert.equal(online.value.persistence, 'COMMITTED'); assert.equal((await w.queuedFiles()).length, 0);
  await w.stop();
  const queued = await w.task('T-2', 'Written while offline', 'open', { body: 'details' });
  assert.equal(queued.isError, false); assert.equal(queued.value.persistence, 'QUEUED_OFFLINE'); assert.match(queued.value.note, /deleted/);
  const files = await w.queuedFiles(); assert.equal(files.length, 1, 'the write is on disk before the agent was told');
  const stored = await readFile(path.join(w.outbox, files[0]!), 'utf8'); assert.ok(!stored.includes(w.token), 'no credential in the outbox'); assert.equal(JSON.parse(stored).arguments.taskId, 'T-2');
  const read = await w.call('mdb_search', { query: 'anything' }); assert.equal(read.isError, true); assert.equal(read.value.error.code, 'SERVER_UNREACHABLE');
  assert.ok((await w.rpc('tools/list')).result.tools.some((x: { name: string }) => x.name === 'engram_task_upsert'), 'the cached tool list keeps the write tools available');
  assert.deepEqual((await outboxStatus(w.outbox)).queued, 1);
  recordCase({ suite: 'memory', name: 'offline-outbox-queues-writes', status: 'PASS' });
});

test('when the server returns, the queued write reaches it (after a restart that dropped the session) and the local copy is deleted', async t => {
  const w = await world(t); await w.task('T-1', 'First'); await w.stop();
  await w.task('T-2', 'Offline one', 'in_progress'); await w.call('engram_note_upsert', { noteId: 'plans/x', title: 'Plan', body: 'offline note' });
  assert.equal((await w.queuedFiles()).length, 2);
  await w.start();
  const next = await w.task('T-3', 'After recovery'); assert.equal(next.value.persistence, 'COMMITTED', 'the old session is gone after the restart; the proxy starts a new one');
  for (let i = 0; i < 50 && (await w.queuedFiles()).length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await w.queuedFiles()).length, 0, 'delivered entries are deleted locally');
  const tasks = await w.serverTasks(); assert.deepEqual(tasks.map(d => d.metadata.stableId).sort(), ['T-1', 'T-2', 'T-3']); assert.equal(tasks.find(d => d.metadata.stableId === 'T-2')!.metadata.taskStatus, 'in_progress');
  assert.ok((await w.owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'proj' }] })).some(d => d.metadata.stableId === 'plans/x' && d.body === 'offline note'));
  recordCase({ suite: 'memory', name: 'offline-outbox-replays-and-deletes', status: 'PASS' });
});

test('an online write persists its merge base before response, so a fresh proxy can merge after an immediate stop', async t => {
  const w = await world(t);
  const written = await w.task('T-BASE', 'Base', 'open', { body: 'client line\nserver line\n' });
  assert.equal(written.value.persistence, 'COMMITTED');
  const cacheName = (await readdir(w.outbox)).find(name => /^cache-.*\.json$/.test(name));
  assert.ok(cacheName, 'the cache exists as soon as the successful write response arrives');
  const cache = JSON.parse(await readFile(path.join(w.outbox, cacheName!), 'utf8')) as { bases?: Record<string, string> };
  const baseId = cache.bases?.['engram_task_upsert:T-BASE'];
  assert.ok(baseId, 'the acknowledged record revision is already on disk');
  assert.equal((await w.owner.vault.get((await w.serverTasks()).find(doc => doc.metadata.stableId === 'T-BASE')!.id)).revisionId, baseId);

  await w.stop();
  await upsertTask(w.owner, { scope: { type: 'workspace', workspaceId: 'proj' }, taskId: 'T-BASE', title: 'Base', status: 'in_progress', body: 'client line\nserver line\n' });
  const input = new PassThrough(), output = new PassThrough(); const pending = new Map<number, (message: any) => void>(); let buffer = '';
  output.setEncoding('utf8'); output.on('data', (chunk: string) => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(message.id)?.(message); } });
  const done = runMcpProxy({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, input, output, timeoutMs: 2500, drainIntervalMs: 60_000, autoReconnect: false });
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise(resolve => { const id = pending.size + 1; pending.set(id, resolve); input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); });
  const offline = await rpc('tools/call', { name: 'engram_task_upsert', arguments: { taskId: 'T-BASE', title: 'Base', status: 'open', body: 'client line (offline)\nserver line\n' } });
  assert.match(offline.result.content[0].text, /QUEUED_OFFLINE/);
  input.end(); await done;
  const queued = JSON.parse(await readFile(path.join(w.outbox, (await w.queuedFiles())[0]!), 'utf8')) as { baseRevisionId?: string };
  assert.equal(queued.baseRevisionId, baseId, 'the restarted proxy loaded and attached the durable base');
  await w.start();
  const drained = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 4000 });
  assert.equal(drained?.remaining, 0);
  const merged = (await w.serverTasks()).find(doc => doc.metadata.stableId === 'T-BASE')!;
  assert.equal(merged.metadata.taskStatus, 'in_progress');
  assert.match(merged.body, /client line \(offline\)/, 'the body edit merges with the server status edit after proxy restart');
  recordCase({ suite: 'memory', name: 'offline-proxy-write-base-durable-before-response', status: 'PASS' });
});

test('an online committed write is acknowledged when the remembered-base cache cannot be saved', async t => {
  const w = await world(t); const outbox = path.join(w.outbox, 'cache-save-failure');
  await mkdir(outbox, { recursive: true });
  const cachePath = path.join(outbox, `cache-${createHash('sha256').update(`${w.url}\0proj`).digest('hex').slice(0, 16)}.json`);
  await mkdir(cachePath);
  t.after(() => rm(cachePath, { recursive: true, force: true }));

  const stderr: string[] = []; const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  t.after(() => { process.stderr.write = originalWrite; });
  const written = await proxyCall({ url: w.url, token: w.token, workspaceId: 'proj', outbox }, 'tools/call', { name: 'engram_task_upsert', arguments: { taskId: 'T-CACHE-FAIL', title: 'Committed despite cache failure', status: 'open' } });
  assert.equal((written.value as { persistence?: string }).persistence, 'COMMITTED');
  assert.equal((await w.serverTasks()).filter(doc => doc.metadata.stableId === 'T-CACHE-FAIL').length, 1);
  assert.equal(stderr.filter(line => line.includes('could not persist remembered revision for engram_task_upsert: EISDIR')).length, 1);
  recordCase({ suite: 'memory', name: 'offline-proxy-committed-write-cache-failure', status: 'PASS' });
});

test('a replay whose cache save fails stays queued and safely replays idempotently after cache recovery', async t => {
  const w = await world(t); await w.stop(); await w.task('T-DRAIN-CACHE-FAIL', 'Replay me');
  const queued = await w.queuedFiles(); assert.equal(queued.length, 1);
  await w.start();
  const cachePath = path.join(w.outbox, `cache-${createHash('sha256').update(`${w.url}\0proj`).digest('hex').slice(0, 16)}.json`);
  await rm(cachePath, { force: true }); await mkdir(cachePath);
  t.after(() => rm(cachePath, { recursive: true, force: true }));

  const failedSave = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 4000 });
  assert.equal(failedSave?.remaining, 1, 'a failed base-cache save yields retry, so the durable entry stays queued');
  assert.equal((await w.queuedFiles()).length, 1);
  let committed = (await w.serverTasks()).filter(doc => doc.metadata.stableId === 'T-DRAIN-CACHE-FAIL');
  for (let i = 0; i < 30 && committed.length === 0; i++) { await new Promise(resolve => setTimeout(resolve, 50)); committed = (await w.serverTasks()).filter(doc => doc.metadata.stableId === 'T-DRAIN-CACHE-FAIL'); }
  assert.equal(committed.length, 1, 'the server committed once even though its cache base could not be saved');

  await rm(cachePath, { recursive: true, force: true });
  const recovered = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 4000 });
  assert.equal(recovered?.remaining, 0);
  assert.equal((await w.queuedFiles()).length, 0);
  const doc = (await w.serverTasks()).find(item => item.metadata.stableId === 'T-DRAIN-CACHE-FAIL')!;
  assert.equal((await w.owner.vault.history(doc.id)).length, 1, 'ALREADY_APPLIED replay does not create a duplicate revision');
  recordCase({ suite: 'memory', name: 'offline-proxy-drain-cache-failure-idempotent', status: 'PASS' });
});

test('order is preserved: two offline versions of one record arrive as two revisions, newest last; a newer online write never gets overwritten by an older queued one', async t => {
  const w = await world(t); await w.stop();
  await w.task('T-9', 'v1', 'open'); await w.task('T-9', 'v2', 'in_progress'); assert.equal((await w.queuedFiles()).length, 2);
  await w.start();
  const online = await w.task('T-9', 'v3 written after recovery', 'done'); assert.equal(online.value.persistence, 'COMMITTED');
  const doc = (await w.serverTasks()).find(d => d.metadata.stableId === 'T-9')!;
  assert.equal(doc.title, 'v3 written after recovery'); assert.equal(doc.revisionNumber, 3, 'v1, v2, v3 in that order, none lost');
  assert.deepEqual((await w.owner.vault.history(doc.id)).map(h => h.revisionNumber), [1, 2, 3]);
  assert.equal((await w.queuedFiles()).length, 0);
  recordCase({ suite: 'memory', name: 'offline-outbox-order', status: 'PASS' });
});

test('while the client was disconnected somebody else changed the same records: on recovery the offline writes are merged like git, a true clash becomes a conflict note, a forbidden write is rejected, and every step is in the timestamped log', async t => {
  const w = await world(t);
  const base = await w.task('T-5', 'Base', 'open', { body: 'line a\nline b\nline c' }); assert.equal(base.value.persistence, 'COMMITTED');
  const note = await w.call('engram_note_upsert', { noteId: 'plans/k', title: 'Plan', body: 'one\ntwo\nthree\nfour\n' }); assert.equal(note.value.persistence, 'COMMITTED');
  await w.stop();
  // the other side: written straight into the vault while the client has no connection
  const scope = { type: 'workspace' as const, workspaceId: 'proj' };
  await upsertTask(w.owner, { scope, taskId: 'T-5', title: 'Base', status: 'in_progress', body: 'line a\nline b\nline c' });
  await upsertNote(w.owner, { scope, noteId: 'plans/k', title: 'Plan', body: 'one\ntwo\nthree\nfour (server)\n' });
  // the offline side
  const q1 = await w.task('T-5', 'Base', 'open', { body: 'line a (offline)\nline b\nline c' });     // body edit only: merges with the server's status change
  const q2 = await w.call('engram_note_upsert', { noteId: 'plans/k', title: 'Plan', body: 'one (offline)\ntwo\nthree\nfour\n' }); // a different line of the same note
  const q3 = await w.call('engram_note_upsert', { noteId: 'plans/clash', title: 'Clash', body: 'created offline\n' });                       // a record the server also created meanwhile
  await upsertNote(w.owner, { scope, noteId: 'plans/clash', title: 'Clash', body: 'created on the server\n' });
  const q4 = await w.call('engram_task_upsert', { scope: { type: 'workspace', workspaceId: 'other' }, taskId: 'X-1', title: 'not allowed', status: 'open' });
  for (const q of [q1, q2, q3, q4]) assert.equal(q.value.persistence, 'QUEUED_OFFLINE'); assert.equal((await w.queuedFiles()).length, 4);
  await w.start(); await w.task('T-6', 'trigger drain');
  for (let i = 0; i < 100 && (await w.queuedFiles()).length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await w.queuedFiles()).length, 0, 'everything left the local outbox');
  const docs = await w.owner.vault.listDocuments({ scopes: [scope] }); const byId = (id: string) => docs.find(d => d.metadata.stableId === id)!;
  assert.equal(byId('T-5').metadata.taskStatus, 'in_progress', 'the server\'s change survived'); assert.match(byId('T-5').body, /line a \(offline\)/, 'and so did the offline edit');
  assert.equal(byId('plans/k').body, 'one (offline)\ntwo\nthree\nfour (server)\n', 'a different line of the same note: both edits');
  assert.equal(byId('plans/clash').body, 'created on the server\n', 'the server version of the clashing record was not overwritten'); assert.ok(docs.some(d => d.tags.includes('conflict') && /created offline/.test(d.body)), 'the offline version is kept in a conflict note');
  const status = await outboxStatus(w.outbox); assert.equal(status.rejected, 1, 'the forbidden write is kept aside'); assert.equal(status.queued, 0);
  const log = (await readFile(path.join(w.outbox, 'outbox.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { at: string; event: string; key?: string });
  assert.ok(log.every(entry => Number.isFinite(Date.parse(entry.at))), 'every log line is timestamped'); assert.deepEqual([...log].map(l => Date.parse(l.at)), [...log].map(l => Date.parse(l.at)).sort((a, b) => a - b), 'in time order');
  const events = log.map(l => `${l.event}:${l.key}`); for (const expected of ['queued:engram_task_upsert:T-5', 'merged:engram_task_upsert:T-5', 'merged:engram_note_upsert:plans/k', 'conflict-note:engram_note_upsert:plans/clash', 'rejected:engram_task_upsert:X-1']) assert.ok(events.includes(expected), `${expected} in ${events.join(', ')}`);
  assert.ok(events.indexOf('queued:engram_task_upsert:T-5') < events.indexOf('merged:engram_task_upsert:T-5'), 'queued before merged');
  recordCase({ suite: 'memory', name: 'offline-outbox-merge-with-concurrent-server-writes', status: 'PASS' });
});

test('regression (found with real Claude Code): a proxy that starts with queued writes serves a complete tool list while its startup drain is running, and the drain still delivers', async t => {
  const w = await world(t); await w.stop(); await w.task('T-7', 'queued before the proxy restarts', 'open'); assert.equal((await w.queuedFiles()).length, 1);
  await w.start();
  // a second proxy process-equivalent on the same outbox, started fresh like a new agent session; its first calls race its own startup drain
  const input = new PassThrough(), output = new PassThrough(); const pending = new Map<number, (m: any) => void>(); let buffer = ''; output.setEncoding('utf8');
  output.on('data', (chunk: string) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); pending.get(m.id)?.(m); } });
  const cred = await createHttpCredential(w.owner.vault, 'agent-o2', ['workspace:proj:read', 'workspace:proj:write']); await w.owner.vault.grant('proj', 'agent-o2', ['read', 'write']);
  const url = (await readFile(path.join(w.outbox, (await readdir(w.outbox)).find(n => /^\d{14}-/.test(n))!), 'utf8')).match(/"url":"([^"]+)"/)![1]!;
  const done = runMcpProxy({ url, token: w.token, workspaceId: 'proj', outbox: w.outbox, input, output, timeoutMs: 2500, drainIntervalMs: 60_000 }); void cred;
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise(res => { const id = 500 + pending.size; pending.set(id, res); input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); });
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } }); const tools = (await rpc('tools/list')).result.tools as Array<{ name: string }>;
  assert.ok(tools.some(x => x.name === 'engram_note_upsert') && tools.some(x => x.name === 'engram_task_upsert') && tools.length > 10, `tool list complete, got ${tools.length}`);
  for (let i = 0; i < 60 && (await w.queuedFiles()).length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await w.queuedFiles()).length, 0); assert.ok((await w.serverTasks()).some(d => d.metadata.stableId === 'T-7'));
  input.end(); await done; recordCase({ suite: 'memory', name: 'offline-proxy-startup-drain-race', status: 'PASS' });
});

test('regression (found with real Claude Code): with a cache the proxy answers initialize and tools/list immediately even when the server is slow, so a host that starts its first turn without waiting still has the tools', async t => {
  const w = await world(t); await new Promise(r => setTimeout(r, 200)); // the first proxy has written the cache by now
  const slow: typeof fetch = async (input, init) => { await new Promise(r => setTimeout(r, 1500)); return fetch(input, init); };
  const input = new PassThrough(), output = new PassThrough(); const lines: any[] = []; output.setEncoding('utf8'); let buffer = ''; output.on('data', (chunk: string) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  const done = runMcpProxy({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, input, output, timeoutMs: 5000, drainIntervalMs: 60_000, fetchImpl: slow });
  const started = Date.now(); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } } })}\n`); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  for (let i = 0; i < 100 && lines.filter(l => l.id === 1 || l.id === 2).length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(Date.now() - started < 1000, `answered in ${Date.now() - started} ms although every server call takes 1.5 s`); assert.ok(lines.find(l => l.id === 2).result.tools.length > 10);
  input.end(); await done; recordCase({ suite: 'memory', name: 'offline-proxy-cache-first-start', status: 'PASS' });
});

test('regression (found with Claude Code 2.1.287): the stateless-protocol probe server/discover is declined, so the host falls back to the classic initialize protocol the proxy actually speaks', async t => {
  const w = await world(t);
  const reply = await w.rpc('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }); assert.equal(reply.error.code, -32601);
  assert.ok((await w.rpc('tools/list')).result.tools.length > 10);
  recordCase({ suite: 'memory', name: 'offline-proxy-declines-stateless-probe', status: 'PASS' });
});

test('regression (found by the Node 22 run): two proxies on the same server and workspace (two host sessions on one machine) never tear the shared cache file and never lose each other\'s remembered revisions', async t => {
  const w = await world(t);
  const open = () => { const input = new PassThrough(), output = new PassThrough(); const pending = new Map<number, (m: any) => void>(); let buffer = '', next = 1; output.setEncoding('utf8'); output.on('data', (chunk: string) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); pending.get(m.id)?.(m); } });
    const done = runMcpProxy({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, input, output, timeoutMs: 4000, drainIntervalMs: 60_000 });
    const rpc = (method: string, params?: unknown): Promise<any> => new Promise(res => { const id = next++; pending.set(id, res); input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); });
    return { rpc, close: async () => { input.end(); await done; } }; };
  const a = open(), b = open(); await Promise.all([a.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'a', version: '1' } }), b.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'b', version: '1' } })]);
  const write = (p: ReturnType<typeof open>, id: string) => p.rpc('tools/call', { name: 'engram_task_upsert', arguments: { taskId: id, title: id, status: 'open' } });
  await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.all([write(a, `A-${i}`), write(b, `B-${i}`)]))); await a.close(); await b.close();
  const cacheName = (await readdir(w.outbox)).find(n => /^cache-.*\.json$/.test(n))!; const cache = JSON.parse(await readFile(path.join(w.outbox, cacheName), 'utf8')) as { bases: Record<string, string>; tools: unknown };
  assert.ok(cache.tools, 'the file is intact JSON'); assert.ok((await readdir(w.outbox)).every(n => !n.endsWith('.tmp')), 'no temporary file left behind');
  const mine = Object.keys(cache.bases); assert.ok(mine.some(k => k.includes('A-')) && mine.some(k => k.includes('B-')), `both sessions' remembered revisions survived: ${mine.length} keys`);
  recordCase({ suite: 'memory', name: 'offline-proxy-shared-cache', status: 'PASS' });
});

test('long outages: unreachable attempts are not counted or rewritten; a backlog larger than one pass drains completely; a rotated credential keeps everything queued (with an explicit reason) until the new token is used; the cap is explicit', async t => {
  const w = await world(t); await w.stop();
  for (let i = 0; i < 130; i++) await w.task(`B-${i}`, `backlog ${i}`);
  const files = await w.queuedFiles(); assert.equal(files.length, 130);
  const before = await Promise.all(files.map(async f => (await stat(path.join(w.outbox, f))).mtimeMs));
  for (let i = 0; i < 5; i++) { const r = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 800, waitMs: 3000 }); assert.equal(r?.stopped, 'offline'); }
  const after = await Promise.all(files.map(async f => (await stat(path.join(w.outbox, f))).mtimeMs)); assert.deepEqual(after, before, 'five failed drain passes rewrote nothing');
  assert.equal(JSON.parse(await readF(path.join(w.outbox, files[0]!), 'utf8')).attempts, 0, 'being unreachable is not counted against an entry');
  await w.start(); const rotated = await rotateHttpCredential(w.owner.vault, w.credId); // the credential changed while this client was away
  const refused = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 3000, waitMs: 8000 }); assert.equal(refused?.stopped, 'auth'); assert.equal((await w.queuedFiles()).length, 130, 'nothing was lost or rejected');
  const ok = await drainOutboxNow({ url: w.url, token: rotated.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 8000, waitMs: 120000 }); assert.equal(ok?.remaining, 0); assert.equal((await w.queuedFiles()).length, 0); assert.equal((await w.serverTasks()).filter(d => /^B-/.test(String(d.metadata.stableId))).length, 130, 'all 130 arrived, in one drain');
  const capped = spawnSync(process.execPath, ['--input-type=module', '-e', `const { enqueueWrite } = await import(${JSON.stringify(path.resolve('dist/packages/memory/outbox.js'))}); let n = 0, err = ''; for (let i = 0; i < 5; i++) try { await enqueueWrite(${JSON.stringify(path.join(w.outbox, 'capdir'))}, { url: 'http://x/mcp', tool: 'engram_task_upsert', arguments: { taskId: 'c' + i, title: 't', status: 'open' } }); n++; } catch (e) { err = e.message; } console.log(JSON.stringify({ n, err }));`], { env: { ...process.env, ENGRAM_OUTBOX_CAP: '3' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(capped.stdout), { n: 3, err: 'The local outbox is full' }, 'a full outbox is an explicit error to the agent, never a silent drop');
  const proxyModule = pathToFileURL(path.resolve('dist/packages/memory/mcp-proxy.js')).href;
  const exitsAfterDrain = spawnSync(process.execPath, ['--input-type=module', '-e', `import { PassThrough } from 'node:stream'; import { runMcpProxy } from ${JSON.stringify(proxyModule)}; const input = new PassThrough(), output = new PassThrough(); output.resume(); input.end(); await runMcpProxy({ url: 'http://127.0.0.1:1/mcp', token: 'test', outbox: ${JSON.stringify(path.join(w.outbox, 'empty-child-outbox'))}, input, output, drainIntervalMs: 60000, drainWaitMs: 60000, autoReconnect: false });`], { encoding: 'utf8', timeout: 2500 });
  assert.equal(exitsAfterDrain.error, undefined, `a completed proxy drain must not retain its 60-second shutdown timer: ${exitsAfterDrain.error?.message ?? ''}`);
  recordCase({ suite: 'memory', name: 'offline-outbox-long-outage-hazards', status: 'PASS' });
});

test('a drain waits out the server\'s rate limit (Retry-After) instead of giving up, so a backlog larger than the per-minute limit still empties', async t => {
  const w = await world(t); await w.stop(); for (let i = 0; i < 6; i++) await w.task(`R-${i}`, `rate ${i}`); await w.start();
  let calls = 0, limited = 0; const limiting: typeof fetch = async (input, init) => { calls++; if (calls === 4 || calls === 5) { limited++; return new Response('{"error":"Rate limit exceeded"}', { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' } }); } return fetch(input, init); };
  const started = Date.now(); const r = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 5000, waitMs: 60000, fetchImpl: limiting });
  assert.equal(r?.remaining, 0); assert.equal(limited, 2); assert.ok(Date.now() - started >= 1000, 'it waited for Retry-After'); assert.equal((await w.serverTasks()).filter(d => /^R-/.test(String(d.metadata.stableId))).length, 6);
  recordCase({ suite: 'memory', name: 'offline-drain-honours-rate-limit', status: 'PASS' });
});

test('regression (found by the multi-day run): several writes queued offline on top of each other do not revert what the server changed meanwhile; each is merged against the previous queued write, not against the server\'s result', async t => {
  const w = await world(t); await w.task('D-1', 'chain', 'open', { body: 'client: 0\n\nserver: 0\n' }); await w.stop();
  for (let r = 1; r <= 4; r++) await w.task('D-1', 'chain', 'open', { body: `client: ${r}\n\nserver: 0\n` }); // the client never saw the server's edits: every write still says "server: 0"
  const scope = { type: 'workspace' as const, workspaceId: 'proj' }; for (let k = 1; k <= 3; k++) await upsertTask(w.owner, { scope, taskId: 'D-1', title: 'chain', status: 'open', body: `client: 0\n\nserver: ${k}\n` });
  await w.start(); const drained = await drainOutboxNow({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, timeoutMs: 5000, waitMs: 60000 });
  const doc = (await w.serverTasks()).find(d => d.metadata.stableId === 'D-1')!; assert.equal(drained?.remaining, 0); assert.equal(doc.body, 'client: 4\n\nserver: 3\n', 'both sides\' latest lines survive'); assert.equal((await w.owner.vault.history(doc.id)).length, 1 + 3 + 4, 'baseline, 3 server edits, 4 client edits, each one revision');
  recordCase({ suite: 'memory', name: 'offline-outbox-chained-writes-do-not-revert-server', status: 'PASS' });
});

test('independent processes serialize drains at the shared outbox and never deliver the same entry concurrently', async t => {
  const w = await world(t); await w.stop();
  await enqueueWrite(w.outbox, { url: w.url, workspaceId: 'proj', tool: 'engram_task_upsert', arguments: { taskId: 'LOCK-1', title: 'queued', status: 'open' } });
  let calls = 0; let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const delivery = async () => { calls++; await gate; return 'delivered' as const; };
  const first = drainOutbox({ directory: w.outbox, deliver: delivery });
  await new Promise(resolve => setTimeout(resolve, 30));
  const moduleUrl = pathToFileURL(resolve('dist/packages/memory/outbox.js')).href;
  const script = `const { drainOutbox } = await import(${JSON.stringify(moduleUrl)}); const result = await drainOutbox({ directory: ${JSON.stringify(w.outbox)}, deliver: async () => { console.log('DELIVERY'); return 'delivered'; } }); console.log('DONE', result.remaining);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]); let output = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (chunk: string) => { output += chunk; });
  const childDone = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(output, '', 'the second process waits on the filesystem lock before it can inspect or deliver entries');
  unblock();
  await Promise.all([first, childDone]);
  assert.equal(calls, 1, 'the first process delivers the entry once');
  assert.doesNotMatch(output, /DELIVERY/, 'the waiting process observes that the entry was deleted');
  assert.match(output, /DONE 0/);
  assert.equal((await outboxStatus(w.outbox)).queued, 0);
});
