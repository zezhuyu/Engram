import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { runMcpProxy } from '../../packages/memory/mcp-proxy.js';
import { PassThrough } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { enqueueWrite, listOutbox, outboxStatus } from '../../packages/memory/outbox.js';
import { ensureWatcher, watchOutbox, watcherRunning, watcherServiceText, type WatchEvent } from '../../packages/memory/outbox-watch.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

const MCP = resolve('bin/mdb-mcp.js'), MDB = resolve('bin/mdb.js');
const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
async function world(t: { after(fn: () => void | Promise<void>): void }) {
  let stopServer: (() => Promise<void>) | undefined; t.after(() => stopServer?.()); // before the vault's cleanup: the server must be gone before its directory is removed
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj');
  const cred = await createHttpCredential(owner.vault, 'agent-w', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-w', ['read', 'write']);
  const port = await freePort(); const url = `http://127.0.0.1:${port}/mcp`; let child: ChildProcess | undefined;
  const start = async () => { const c = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port), MDB_MCP_HTTP_REQUESTS_PER_MINUTE: '5000' } }); child = c; let err = '';
    await new Promise<void>((res, rej) => { c.stderr!.setEncoding('utf8'); c.stderr!.on('data', (d: string) => { err += d; if (/MCP HTTP listening/.test(err)) res(); }); c.once('exit', code => rej(new Error(`server exit ${code} ${err}`))); }); };
  stopServer = async () => { const c = child; child = undefined; if (c && c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise<void>(r => c.once('exit', () => r())); } };
  const outbox = await mkdtemp(path.join(tmpdir(), 'engram-watch-')); t.after(() => rm(outbox, { recursive: true, force: true }));
  return { owner, url, token: cred.token, outbox, start, stop: stopServer, tasks: async () => (await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'proj' }] })).filter(d => d.metadata.kind === 'task' || d.metadata.stableId) };
}
const until = async (check: () => boolean | Promise<boolean>, ms: number, what: string) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`timed out waiting for ${what}`); };

test('a watcher with no agent running delivers by itself as soon as the server is back, retries for free while it is down, and deletes the local copy only after the server accepted it', async t => {
  const w = await world(t);
  await enqueueWrite(w.outbox, { url: w.url, workspaceId: 'proj', tool: 'engram_task_upsert', arguments: { taskId: 'W-1', title: 'Written while the server was down', status: 'open' } });
  const events: WatchEvent[] = []; const abort = new AbortController(); t.after(() => abort.abort()); // a failing assertion must not leave the loop running
  const running = watchOutbox({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, intervalMs: 150, idleMs: 100, timeoutMs: 800, signal: abort.signal, onEvent: e => events.push(e) });
  await until(() => events.some(e => e.event === 'unreachable'), 8000, 'the watcher to notice the server is down');
  await new Promise(r => setTimeout(r, 900)); // several retry passes while the server is still down
  const waiting = await listOutbox(w.outbox, () => true); assert.equal(waiting.length, 1, 'the write is still on disk');
  assert.equal(waiting[0]!.entry.attempts, 0, 'unreachable retries are free: nothing is counted against the entry'); assert.equal(events.filter(e => e.event === 'unreachable').length, 1, 'the state change is reported once, not on every retry');
  const before = Date.now(); await w.start(); await until(async () => (await listOutbox(w.outbox, () => true)).length === 0, 15000, 'the watcher to deliver after the server returned'); const took = Date.now() - before;
  await until(() => events.some(e => e.event === 'delivered'), 5000, 'the delivered event (the file is deleted a moment before the watcher reports it)');
  assert.ok(events.some(e => e.event === 'reachable') && events.some(e => e.event === 'delivered' && (e.delivered ?? 0) >= 1), JSON.stringify(events.map(e => e.event)));
  assert.ok((await w.tasks()).some(d => d.metadata.stableId === 'W-1'), 'the server has the write'); assert.ok(took < 8000, `delivered ${took} ms after the server returned`);
  const log = await readFile(path.join(w.outbox, 'outbox.log'), 'utf8'); assert.match(log, /delivered|merged|created/); assert.equal((await outboxStatus(w.outbox)).queued, 0);
  abort.abort(); await running; assert.equal(events.at(-1)!.event, 'stop'); recordCase({ suite: 'memory', name: 'outbox-watch-delivers-without-an-agent', status: 'PASS' });
});

test('the watcher keeps everything and waits (slowly) when the server refuses the credential, then delivers once the right credential is used', async t => {
  const w = await world(t); await w.start();
  await enqueueWrite(w.outbox, { url: w.url, workspaceId: 'proj', tool: 'engram_task_upsert', arguments: { taskId: 'W-2', title: 'Kept while the credential is wrong', status: 'open' } });
  const events: WatchEvent[] = []; const abort = new AbortController(); t.after(() => abort.abort()); // a failing assertion must not leave the loop running
  const running = watchOutbox({ url: w.url, token: 'not-the-credential-'.repeat(4), workspaceId: 'proj', outbox: w.outbox, intervalMs: 100, authIntervalMs: 100, timeoutMs: 1500, signal: abort.signal, onEvent: e => events.push(e) });
  await until(() => events.some(e => e.event === 'auth-refused'), 8000, 'the watcher to report the refused credential'); abort.abort(); await running;
  assert.equal((await listOutbox(w.outbox, () => true)).length, 1, 'nothing was lost or rejected'); assert.equal((await outboxStatus(w.outbox)).rejected, 0);
  const again = new AbortController(); t.after(() => again.abort()); const events2: WatchEvent[] = [];
  const second = watchOutbox({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, intervalMs: 100, signal: again.signal, onEvent: e => events2.push(e) });
  await until(async () => (await listOutbox(w.outbox, () => true)).length === 0, 10000, 'delivery with the right credential'); again.abort(); await second; assert.ok((await w.tasks()).some(d => d.metadata.stableId === 'W-2'));
});

test('an empty queue costs no network at all (a directory listing only)', async t => {
  const outbox = await mkdtemp(path.join(tmpdir(), 'engram-watch-empty-')); t.after(() => rm(outbox, { recursive: true, force: true })); let fetches = 0; const events: WatchEvent[] = [];
  const realFetch = globalThis.fetch; globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { fetches++; return realFetch(...a); }) as typeof fetch; t.after(() => { globalThis.fetch = realFetch; });
  await watchOutbox({ url: 'http://127.0.0.1:9/mcp', token: 'x'.repeat(40), outbox, idleMs: 20, maxPasses: 10, onEvent: e => events.push(e) }); assert.equal(fetches, 0); assert.deepEqual(events.map(e => e.event), ['start', 'stop']);
});

test('CLI: watch refuses a token file other users can read, and the printed service definitions never contain the credential', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'engram-watch-cli-')); t.after(() => rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'token'); await writeFile(file, 'super-secret-token-value-0123456789abcdef\n'); await chmod(file, 0o644);
  const env = { ...process.env, ENGRAM_OUTBOX: path.join(dir, 'outbox'), ENGRAM_AUTO_RECONNECT: '1' }; // the isolation helper sets 0; the explicit watch command honours the off switch
  const refused = spawnSync(process.execPath, [MDB, 'outbox', 'watch', '--url', 'http://127.0.0.1:9/mcp', '--token-file', file], { encoding: 'utf8', env, timeout: 20000 }); assert.notEqual(refused.status, 0); assert.match(refused.stderr + refused.stdout, /must not be readable by others/);
  for (const platform of ['macos', 'linux'] as const) { const unit = spawnSync(process.execPath, [MDB, 'outbox', 'watch-unit', '--platform', platform, '--url', 'http://100.1.2.3:9/mcp', '--token-file', file, '--workspace', 'proj'], { encoding: 'utf8', env, timeout: 20000 }); const text = unit.stdout; assert.equal(unit.status, 0, unit.stderr);
    assert.ok(!text.includes('super-secret-token'), 'the credential is not in the service text'); assert.match(text, platform === 'macos' ? /KeepAlive/ : /Restart=on-failure/); assert.match(text, /outbox/); }
  assert.ok(!watcherServiceText('linux', { node: '/n', mdb: '/m', url: 'http://h/mcp', tokenFile: '/t' }).includes('Bearer'));
  const isolated = watcherServiceText('macos', { node: '/n', mdb: '/m', url: 'http://h/mcp', tokenFile: '/t', env: { ENGRAM_DATA_DIR: path.join(dir, 'selected-root') } });
  assert.ok(!isolated.includes('StandardErrorPath'), 'launchd must not create an unbounded app-owned log file');
});

test('CLI: the real watcher process delivers through a 0600 token file and then exits with status 0 promptly when asked, even after it held a live HTTP connection', async t => {
  const w = await world(t); await w.start(); const dir = await mkdtemp(path.join(tmpdir(), 'engram-watch-proc-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'token'); await writeFile(file, w.token + '\n'); await chmod(file, 0o600);
  await enqueueWrite(w.outbox, { url: w.url, workspaceId: 'proj', tool: 'engram_task_upsert', arguments: { taskId: 'W-3', title: 'Delivered by the real process', status: 'open' } });
  const child = spawn(process.execPath, [MDB, 'outbox', 'watch', '--url', w.url, '--token-file', file, '--workspace', 'proj', '--outbox', w.outbox, '--interval-sec', '1'], { env: { ...process.env, ENGRAM_AUTO_RECONNECT: '1' }, stdio: ['ignore', 'ignore', 'pipe'] }); t.after(() => { child.kill('SIGKILL'); });
  let log = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { log += d; });
  await until(() => /"event":"delivered"/.test(log), 20000, 'the watcher process to deliver'); assert.ok((await w.tasks()).some(d => d.metadata.stableId === 'W-3')); assert.equal((await listOutbox(w.outbox, () => true)).length, 0);
  const stopped = new Promise<number | null>(res => child.once('exit', code => res(code))); const asked = Date.now(); child.kill('SIGTERM');
  assert.equal(await Promise.race([stopped, new Promise<string>(r => setTimeout(() => r('still running'), 6000))]), 0, 'exits with status 0 within a few seconds of SIGTERM'); assert.ok(Date.now() - asked < 6500); assert.ok(!log.includes(w.token), 'the credential is never logged');
});

// ---- the default behaviour: no command, no agent, no installed service -----------------------------------------------------------------------------------------------------------
const pidOfLock = async (outbox: string): Promise<number | undefined> => { const file = (await readdir(outbox).catch(() => [])).find(n => /^watcher-.*\.lock$/.test(n)); if (!file) return undefined; try { return JSON.parse(await readFile(path.join(outbox, file), 'utf8')).pid as number; } catch { return undefined; } };
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const withAutoReconnect = (t: { after(fn: () => void | Promise<void>): void }, outbox: string) => { const saved = { a: process.env.ENGRAM_AUTO_RECONNECT, i: process.env.ENGRAM_WATCH_INTERVAL_SEC, e: process.env.ENGRAM_WATCH_IDLE_EXIT_SEC }; process.env.ENGRAM_AUTO_RECONNECT = '1'; process.env.ENGRAM_WATCH_INTERVAL_SEC = '1'; process.env.ENGRAM_WATCH_IDLE_EXIT_SEC = '2';
  t.after(async () => { const pid = await pidOfLock(outbox); if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL'); for (const [k, v] of [['ENGRAM_AUTO_RECONNECT', saved.a], ['ENGRAM_WATCH_INTERVAL_SEC', saved.i], ['ENGRAM_WATCH_IDLE_EXIT_SEC', saved.e]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }); };

test('DEFAULT: a write kept because the server is down starts a background watcher by itself; the agent session can end; the server returns; the write arrives with no command, and the watcher then leaves on its own', async t => {
  const w = await world(t); withAutoReconnect(t, w.outbox);
  const input = new PassThrough(), output = new PassThrough(); let buffer = ''; const waiting = new Map<number, (m: any) => void>(); output.setEncoding('utf8'); output.on('data', (c: string) => { buffer += c; let i; while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); waiting.get(m.id)?.(m); } });
  const done = runMcpProxy({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, input, output, timeoutMs: 1500, drainIntervalMs: 3_600_000 });
  const rpc = (method: string, params?: unknown) => new Promise<any>(res => { const id = waiting.size + 1; waiting.set(id, res); input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); });
  const reply = await rpc('tools/call', { name: 'engram_task_upsert', arguments: { taskId: 'A-1', title: 'Kept while the server was down', status: 'open' } }); assert.equal(JSON.parse(reply.result.content[0].text).persistence, 'QUEUED_OFFLINE');
  for (const id of ['A-1b', 'A-1c']) await rpc('tools/call', { name: 'engram_task_upsert', arguments: { taskId: id, title: 'Also kept', status: 'open' } });
  input.end(); await done; // the agent session is over: nothing of the proxy is running any more
  await until(async () => !!(await pidOfLock(w.outbox)), 10000, 'the automatic watcher to appear'); const pid = (await pidOfLock(w.outbox))!; assert.ok(isAlive(pid), 'a detached watcher process is running');
  assert.equal((await readFile(path.join(w.outbox, 'outbox.log'), 'utf8')).match(/"event":"watcher-started"/g)?.length, 1, 'three writes queued at once start ONE watcher, not three');
  await w.start(); await until(async () => (await listOutbox(w.outbox, () => true)).length === 0, 20000, 'delivery by the automatic watcher, with no agent and no command'); assert.ok((await w.tasks()).some(d => d.metadata.stableId === 'A-1'));
  await until(() => !isAlive(pid), 20000, 'the watcher to leave once nothing waits'); assert.equal(await pidOfLock(w.outbox), undefined, 'and it removes its lock');
  recordCase({ suite: 'memory', name: 'auto-reconnect-is-the-default', status: 'PASS' });
});

test('one watcher per server: asking again while one runs starts nothing new; a lock left by a dead process (crash, reboot) is taken over; ENGRAM_AUTO_RECONNECT=0 turns it off', async t => {
  const w = await world(t); withAutoReconnect(t, w.outbox);
  await enqueueWrite(w.outbox, { url: w.url, workspaceId: 'proj', tool: 'engram_task_upsert', arguments: { taskId: 'A-2', title: 'x', status: 'open' } });
  const base = { url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox };
  assert.equal(await ensureWatcher({ ...base, env: { ...process.env, ENGRAM_AUTO_RECONNECT: '0' } }), 'disabled'); assert.equal(await pidOfLock(w.outbox), undefined, 'opt-out starts nothing');
  assert.equal(await ensureWatcher(base), 'started'); await until(async () => !!(await pidOfLock(w.outbox)), 10000, 'the first watcher'); const first = (await pidOfLock(w.outbox))!;
  assert.equal(await ensureWatcher(base), 'running'); assert.equal(await ensureWatcher(base), 'running'); assert.equal(await pidOfLock(w.outbox), first, 'still the same single watcher'); assert.ok(await watcherRunning(w.outbox, w.url, 'proj'));
  const second = new AbortController(); const events: WatchEvent[] = []; await watchOutbox({ url: w.url, token: w.token, workspaceId: 'proj', outbox: w.outbox, signal: second.signal, onEvent: e => events.push(e) }); assert.deepEqual(events.map(e => e.event), ['already-running'], 'a second explicit watcher does not run alongside');
  process.kill(first, 'SIGKILL'); await until(() => !isAlive(first), 5000, 'the watcher to die'); assert.equal(await watcherRunning(w.outbox, w.url, 'proj'), false, 'a dead watcher is not "running" even though its lock file is still there');
  assert.equal(await ensureWatcher(base), 'started', 'the stale lock is taken over'); await until(async () => { const pid = await pidOfLock(w.outbox); return !!pid && pid !== first; }, 10000, 'the replacement watcher');
});
