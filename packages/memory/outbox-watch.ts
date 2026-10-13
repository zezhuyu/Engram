import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appendLog, listOutbox } from './outbox.js';
import { drainOutboxNow } from './mcp-proxy.js';
import { mdbBinaryPath } from './adapters.js';

export interface WatchEvent { at: string; event: 'start' | 'already-running' | 'waiting' | 'unreachable' | 'reachable' | 'delivered' | 'auth-refused' | 'idle' | 'stop'; queued?: number; delivered?: number; conflicts?: number; rejected?: number; remaining?: number }
export interface WatchOptions {
  url: string; token: string; workspaceId?: string; outbox: string;
  /** seconds between attempts while something waits (default 10): a recovered server is found within about this long */
  intervalMs?: number; /** between checks of an empty queue (a directory listing, no network) */ idleMs?: number; /** slower retries after the server refused the credential */ authIntervalMs?: number;
  /** the project's Markdown sync queue: when it has entries, `syncProject` runs after the server answers */ projectDir?: string; syncProject?: () => Promise<void>;
  /** leave once nothing has waited for this long (the automatic watcher); unset = run until stopped */ exitWhenEmptyMs?: number; /** one watcher per server and workspace for an outbox directory (default true) */ lock?: boolean;
  signal?: AbortSignal; onEvent?: (event: WatchEvent) => void; /** tests: stop after this many loop passes */ maxPasses?: number; timeoutMs?: number;
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
const fileQueued = async (projectDir?: string): Promise<number> => { if (!projectDir) return 0; try { return (await fs.readdir(path.join(projectDir, '.engram', 'sync-queue'))).filter(name => !name.startsWith('.')).length; } catch { return 0; } };

const lockFile = (outbox: string, url: string, workspaceId?: string): string => path.join(outbox, `watcher-${createHash('sha256').update(`${url}\0${workspaceId ?? ''}`).digest('hex').slice(0, 16)}.lock`);
const spawnedAt = new Map<string, number>();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** true when a live watcher already serves this server+workspace; a lock left by a dead process (crash, power loss, reboot) is taken over */
export async function watcherRunning(outbox: string, url: string, workspaceId?: string): Promise<boolean> {
  try { const info = JSON.parse(await fs.readFile(lockFile(outbox, url, workspaceId), 'utf8')) as { pid?: number }; return typeof info.pid === 'number' && alive(info.pid); } catch { return false; }
}
async function takeLock(outbox: string, url: string, workspaceId?: string): Promise<(() => Promise<void>) | undefined> {
  await fs.mkdir(outbox, { recursive: true, mode: 0o700 }); const file = lockFile(outbox, url, workspaceId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); return async () => { try { const mine = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: number }; if (mine.pid === process.pid) await fs.rm(file, { force: true }); } catch { /* already gone */ } }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (await watcherRunning(outbox, url, workspaceId)) return undefined; await fs.rm(file, { force: true }); }
  }
  return undefined;
}
/**
 * The default behaviour of every client: the moment a write is kept locally because the server cannot be reached, make sure ONE small watcher is running for that server, so delivery happens
 * as soon as the server is back, whether or not an agent session is still open. It is an ordinary detached process that leaves by itself once nothing has waited for a minute: it installs
 * nothing, survives no reboot (the next client session starts it again if anything still waits), and gets the credential only through its own environment, never from a file.
 * ENGRAM_AUTO_RECONNECT=0 turns it off.
 */
export async function ensureWatcher(options: { url: string; token: string; workspaceId?: string; outbox: string; projectDir?: string; tokenEnv?: string; env?: NodeJS.ProcessEnv; idleExitSec?: number; intervalSec?: number }): Promise<'started' | 'running' | 'disabled' | 'failed'> {
  const env = options.env ?? process.env; if (env.ENGRAM_AUTO_RECONNECT === '0') return 'disabled';
  const key = lockFile(options.outbox, options.url, options.workspaceId); const recent = spawnedAt.get(key); if (recent !== undefined && Date.now() - recent < 5000 && !(await fs.access(key).then(() => true, () => false))) return 'running'; // several writes queued at once: the watcher just started has not taken its lock yet
  try {
    if (await watcherRunning(options.outbox, options.url, options.workspaceId)) return 'running';
    const tokenEnv = options.tokenEnv ?? 'ENGRAM_WATCH_TOKEN';
    const args = [mdbBinaryPath(), 'outbox', 'watch', '--url', options.url, '--token-env', tokenEnv, '--outbox', options.outbox, '--exit-when-empty-sec', String(options.idleExitSec ?? (Number(env.ENGRAM_WATCH_IDLE_EXIT_SEC) || 60)), '--interval-sec', String(options.intervalSec ?? (Number(env.ENGRAM_WATCH_INTERVAL_SEC) || 10)), ...(options.workspaceId ? ['--workspace', options.workspaceId] : []), ...(options.projectDir ? ['--project-dir', options.projectDir] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...env, [tokenEnv]: options.token, ENGRAM_AUTO_RECONNECT: '1' } }); child.on('error', () => undefined); child.unref();
    spawnedAt.set(key, Date.now()); await appendLog(options.outbox, { event: 'watcher-started', pid: child.pid ?? 0 }).catch(() => undefined); return 'started';
  } catch { return 'failed'; /* delivery then waits for the next session, exactly as before */ }
}

/**
 * Keeps retrying on its own so a client that is not running an agent still delivers the moment the server is back. It computes nothing about memory: it only checks whether anything waits
 * (a directory listing, no network when empty) and, if so, replays it through the same drain the proxy uses (oldest first, deleted locally only after the server acknowledged, merged by the server).
 * Unreachable attempts are free: nothing is counted or rewritten. It never stores the credential: the caller passes it in.
 */
export async function watchOutbox(options: WatchOptions): Promise<void> {
  const interval = options.intervalMs ?? 10_000, idle = options.idleMs ?? interval, authInterval = options.authIntervalMs ?? 60_000; const emit = (event: Omit<WatchEvent, 'at'>) => options.onEvent?.({ at: new Date().toISOString(), ...event });
  const match = (entry: { url: string; workspaceId?: string }) => entry.url === options.url && (entry.workspaceId ?? '') === (options.workspaceId ?? '');
  const release = options.lock === false ? async () => undefined : await takeLock(options.outbox, options.url, options.workspaceId); if (!release) { emit({ event: 'already-running' }); return; }
  try {
  emit({ event: 'start' }); let state: 'idle' | 'unreachable' | 'auth' | 'ok' = 'idle'; let passes = 0; let emptySince = Date.now();
  while (!options.signal?.aborted && (options.maxPasses === undefined || passes < options.maxPasses)) {
    passes++; const typed = (await listOutbox(options.outbox, match).catch(() => [])).length; const files = await fileQueued(options.projectDir); const queued = typed + files;
    if (!queued) { if (state !== 'idle') { state = 'idle'; emit({ event: 'idle' }); } if (options.exitWhenEmptyMs !== undefined && Date.now() - emptySince >= options.exitWhenEmptyMs) break; await sleep(idle, options.signal); continue; }
    emptySince = Date.now();
    let delivered = 0, conflicts = 0, rejected = 0, remaining = typed, stopped: string | undefined;
    if (typed) { const result = await drainOutboxNow({ url: options.url, token: options.token, ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), outbox: options.outbox, timeoutMs: options.timeoutMs ?? 4000, waitMs: 120_000 }).catch(() => undefined); if (result) { delivered = result.delivered; conflicts = result.conflicts; rejected = result.rejected; remaining = result.remaining; stopped = result.stopped; } else stopped = 'offline'; }
    if (!stopped && files && options.syncProject) { try { await options.syncProject(); } catch { stopped = 'offline'; } }
    if (stopped === 'auth') { if (state !== 'auth') { state = 'auth'; emit({ event: 'auth-refused', queued, remaining }); } await sleep(authInterval, options.signal); continue; }
    if (stopped) { if (state !== 'unreachable') { state = 'unreachable'; emit({ event: 'unreachable', queued, remaining }); } await sleep(interval, options.signal); continue; }
    if (state === 'unreachable' || state === 'auth') emit({ event: 'reachable', queued });
    state = 'ok'; emit({ event: 'delivered', delivered, conflicts, rejected, remaining, queued }); await sleep(interval, options.signal);
  }
  emit({ event: 'stop' });
  } finally { await release(); }
}

/** Service definitions to INSTALL BY HAND (nothing here installs anything). The credential comes from a 0600 token file, never from the unit text. */
export function watcherServiceText(platform: 'macos' | 'linux', input: { node: string; mdb: string; url: string; tokenFile: string; workspaceId?: string; outbox?: string; projectDir?: string }): string {
  const args = [input.mdb, 'outbox', 'watch', '--url', input.url, '--token-file', input.tokenFile, ...(input.workspaceId ? ['--workspace', input.workspaceId] : []), ...(input.outbox ? ['--outbox', input.outbox] : []), ...(input.projectDir ? ['--project-dir', input.projectDir] : [])];
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (platform === 'macos') return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>dev.engram.outbox-watch</string>\n<key>ProgramArguments</key><array>${[input.node, ...args].map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardErrorPath</key><string>/tmp/engram-outbox-watch.log</string>\n</dict></plist>\n`;
  const quote = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  return `[Unit]\nDescription=Engram outbox watcher (delivers writes kept while the server was unreachable)\nAfter=network-online.target\n\n[Service]\nExecStart=${[input.node, ...args].map(quote).join(' ')}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
}
