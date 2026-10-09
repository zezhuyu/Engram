import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MDBError, type ObjectStore } from '../core/types.js';
import { profileAsync } from '../bench/instrumentation.js';

/** The vault root and its ancestors rarely change; their symlink walk is re-verified at most once per second per root. Every key segment is checked on every call. */
const verifiedRoots = new Map<string, number>();
const ROOT_RECHECK_MS = 1000;
export async function safePath(root: string, key: string): Promise<string> {
  if (!key || path.isAbsolute(key) || key.includes('\\') || key.split('/').some(p => p === '..' || p === '.' || !p) || key.includes('\0')) throw new MDBError('INVALID_INPUT', 'Unsafe storage path');
  const resolvedRoot = path.resolve(root);
  if ((verifiedRoots.get(resolvedRoot) ?? 0) < Date.now()) {
    try { if ((await fs.lstat(resolvedRoot)).isSymbolicLink()) throw new MDBError('INVALID_INPUT', 'Vault root must not be a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let ancestor = path.parse(resolvedRoot).root;
    for (const segment of resolvedRoot.slice(ancestor.length).split(path.sep)) {
      if (!segment) continue;
      ancestor = path.join(ancestor, segment);
      try { if ((await fs.lstat(ancestor)).isSymbolicLink()) { const standard = process.platform === 'darwin' && ['/tmp','/var','/etc'].includes(ancestor) && await fs.realpath(ancestor) === '/private'+ancestor; if (!standard) throw new MDBError('INVALID_INPUT','Symlink vault ancestor is not allowed'); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    verifiedRoots.set(resolvedRoot, Date.now() + ROOT_RECHECK_MS);
  }
  const target = path.resolve(resolvedRoot, key);
  let current = resolvedRoot;
  for (const segment of key.split('/')) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new MDBError('INVALID_INPUT', 'Symlink storage path is not allowed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (target === resolvedRoot || !target.startsWith(resolvedRoot + path.sep)) throw new MDBError('INVALID_INPUT', 'Unsafe storage path');
  return target;
}
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await profileAsync('fsync.directory', () => handle.sync()); } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  finally { await handle.close(); }
}
/**
 * Creates `temporary` exclusively and proves, BEFORE any data is written, that the file really lives under the real vault root
 * (not behind a directory swapped for a symlink after the path check). Node has no openat(), so this narrows the time-of-check/
 * time-of-use window instead of eliminating it; the residual risk is an empty stray file, never vault content.
 */
export async function openVerifiedTemp(root: string, temporary: string): Promise<fs.FileHandle> {
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    const [opened, linked, real, realRoot] = await Promise.all([handle.stat(), fs.lstat(temporary).catch(() => null), fs.realpath(temporary).catch(() => null), fs.realpath(root)]);
    const inside = real !== null && real.startsWith(realRoot + path.sep);
    if (!linked || linked.isSymbolicLink() || linked.ino !== opened.ino || linked.dev !== opened.dev || !inside) {
      await handle.close(); if (real !== null) await fs.rm(temporary, { force: true });
      throw new MDBError('INVALID_INPUT', 'Storage path changed during write (possible symlink swap); write refused');
    }
    return handle;
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
export type FaultHook = (stage: string) => void;
/** mkdir -p that also syncs the parent of every directory it created, so a committed file cannot lose its directory entry in a power cut. */
export async function mkdirDurable(directory: string): Promise<void> {
  const created: string[] = [];
  for (let current = directory; ; ) {
    try { await fs.stat(current); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    created.push(current);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  if (!created.length) return;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const dir of created.reverse()) await syncDirectory(path.dirname(dir));
}
export async function atomicWrite(root: string, key: string, data: string | Uint8Array, fault?: FaultHook): Promise<void> {
  const target = await safePath(root, key);
  await mkdirDurable(path.dirname(target));
  await safePath(root, key);
  const temporary = target + '.' + randomUUID() + '.tmp';
  const handle = await openVerifiedTemp(root, temporary);
  try { await handle.writeFile(data); fault?.('atomic.temp_written'); await profileAsync('fsync.file', () => handle.sync()); } finally { await handle.close(); }
  try { fault?.('atomic.before_rename'); await fs.rename(temporary, target); fault?.('atomic.after_rename'); await syncDirectory(path.dirname(target)); }
  finally { await fs.rm(temporary, { force: true }); }
}
const LOCK_GRACE_MS = 2000;
/** A lock is stale when its owner process is gone, or when it never recorded (or tore) its owner file and has been idle past the grace period. */
async function lockIsStale(target: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(target, 'owner.json'), 'utf8')) as { pid?: unknown };
    if (!Number.isInteger(owner.pid)) throw new SyntaxError('owner');
    try { process.kill(owner.pid as number, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch (e) {
    if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    try { return Date.now() - (await fs.stat(target)).mtimeMs > LOCK_GRACE_MS; } catch (s) { if ((s as NodeJS.ErrnoException).code === 'ENOENT') return false; throw s; }
  }
}
/** Only one waiter at a time may remove a stale lock, and it re-checks staleness under a guard so it cannot delete a lock someone else just took. */
async function reclaimStaleLock(target: string): Promise<void> {
  const guard = target + '.reclaim';
  try { await fs.mkdir(guard, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; try { if (Date.now() - (await fs.stat(guard)).mtimeMs > 5000) await fs.rm(guard, { recursive: true, force: true }); } catch { /* raced */ } return; }
  try { if (await lockIsStale(target)) await fs.rm(target, { recursive: true, force: true }); }
  finally { await fs.rm(guard, { recursive: true, force: true }); }
}
/**
 * Fair writer lock. The mutual exclusion is still an exclusive `mkdir`, but contenders first take a ticket (a timestamped file in
 * `.mdb/locks/queue`) and only the OLDEST LIVE ticket may attempt the mkdir. That turns the previous unordered polling race, where
 * unlucky waiters could starve past the deadline, into FIFO order. Waiters heartbeat their ticket on every poll; tickets whose
 * process is gone, or that stopped heartbeating, are removed by whoever notices, so a crashed or frozen waiter cannot block the queue.
 * Tickets are ephemeral coordination files, not durable state, so they are not fsynced.
 */
const QUEUE_KEY = '.mdb/locks/queue';
const TICKET_STALE_MS = 2000;
let ticketCounter = 0;
const ticketPid = (name: string) => Number(name.split('-')[2]);
async function ticketIsLive(queue: string, name: string): Promise<boolean> {
  const pid = ticketPid(name);
  if (Number.isInteger(pid)) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; } }
  try { return Date.now() - (await fs.stat(path.join(queue, name))).mtimeMs < TICKET_STALE_MS; } catch { return false; }
}
async function isFirstLiveTicket(queue: string, mine: string): Promise<boolean> {
  for (const name of (await fs.readdir(queue)).filter(n => !n.endsWith('.tmp')).sort()) {
    if (name === mine) return true;
    if (await ticketIsLive(queue, name)) return false;
    await fs.rm(path.join(queue, name), { force: true });
  }
  return false; // our own ticket vanished; the caller recreates it with the same name (keeping its place)
}
export const LOCK_TIMEOUT_MS = Number(process.env.MDB_LOCK_TIMEOUT_MS) > 0 ? Number(process.env.MDB_LOCK_TIMEOUT_MS) : 10000;
export async function withVaultLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = '.mdb/locks/writer.lock';
  const target = await safePath(root, key);
  const queue = await safePath(root, QUEUE_KEY);
  await mkdirDurable(path.dirname(target));
  await fs.mkdir(queue, { recursive: true, mode: 0o700 });
  const ticket = `${String(Date.now()).padStart(15, '0')}-${String(ticketCounter++ % 1_000_000).padStart(6, '0')}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const ticketPath = path.join(queue, ticket);
  await fs.writeFile(ticketPath, '', { flag: 'wx', mode: 0o600 });
  let acquired = false; let delay = 4;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    await profileAsync('lock.wait', async () => {
      while (!acquired) {
        const now = new Date(); await fs.utimes(ticketPath, now, now).catch(async () => { await fs.writeFile(ticketPath, '', { flag: 'w', mode: 0o600 }); });
        if (await isFirstLiveTicket(queue, ticket)) {
          try { await fs.mkdir(target, { mode: 0o700 }); acquired = true; await fs.writeFile(path.join(target, 'owner.json'), JSON.stringify({ pid: process.pid })); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await lockIsStale(target)) { await reclaimStaleLock(target); continue; }
          }
        }
        if (acquired) break;
        if (Date.now() >= deadline) throw new MDBError('CONFLICT', 'Vault writer is busy');
        await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * delay)));
        delay = Math.min(25, delay + 2);
      }
    });
  } finally { await fs.rm(ticketPath, { force: true }); }
  try { return await action(); } finally { await fs.rm(target, { recursive: true, force: true }); }
}
export class LocalObjectStore implements ObjectStore {
  constructor(public readonly root: string, private readonly fault?: FaultHook) {}
  async read(key: string): Promise<Uint8Array> { return fs.readFile(await safePath(this.root, key)); }
  async stat(key: string): Promise<{ etag: string; size: number } | null> {
    try { const bytes = await this.read(key); return { size: bytes.byteLength, etag: createHash('sha256').update(bytes).digest('hex') }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async *list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    const base = await safePath(this.root, prefix.replace(/\/$/, ''));
    const root = this.root;
    const walk = async function* (directory: string): AsyncIterable<{ key: string; size: number }> {
      let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new MDBError('INVALID_INPUT', 'Symlink storage path is not allowed');
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.isFile()) yield { key: path.relative(root, full).split(path.sep).join('/'), size: (await fs.stat(full)).size };
      }
    };
    yield* walk(base);
  }
  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const target = await safePath(this.root, key);
    await mkdirDurable(path.dirname(target));
    await safePath(this.root, key);
    const temporary = target + '.' + randomUUID() + '.tmp';
    const handle = await openVerifiedTemp(this.root, temporary);
    try { await handle.writeFile(bytes); this.fault?.('revision.temp_written'); await profileAsync('fsync.file', () => handle.sync()); this.fault?.('revision.temp_synced'); } finally { await handle.close(); }
    try {
      try { await fs.link(temporary, target); this.fault?.('revision.after_link'); await syncDirectory(path.dirname(target)); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const existing = await fs.readFile(target);
        if (!existing.equals(Buffer.from(bytes))) throw new MDBError('CONFLICT', 'Immutable object already exists with different bytes');
      }
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async compareAndSwapPointer(key: string, expected: string | null, value: string): Promise<boolean> {
    if (/^(?:\.mdb\/objects\/|.*\/sources\/originals\/|\.mdb\/events\/)/.test(key)) throw new MDBError('INVALID_INPUT', 'Canonical stores cannot be replaced by pointers');
    return withVaultLock(this.root, async () => {
      let current: string | null = null;
      try { current = Buffer.from(await this.read(key)).toString('utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (current !== expected) return false;
      await atomicWrite(this.root, key, value); return true;
    });
  }
  async removeForAuthorizedPurge(key: string): Promise<void> { await fs.rm(await safePath(this.root, key), { force: true }); }
}
