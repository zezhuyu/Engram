import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReplicaStore } from '../replication/replica.js';

export type ReplicaWorkspaceSize = { bytes: number; files: number; approximate: boolean };
const CACHE_MS = 60_000, MAX_FILES = 20_000, MAX_MS = 250;
const cache = new Map<string, { at: number; value: ReplicaWorkspaceSize }>();

/** Bounded estimate of one workspace projection plus its journal-owned immutable revisions. */
export async function replicaWorkspaceSize(store: ReplicaStore, workspaceId: string, now = Date.now()): Promise<ReplicaWorkspaceSize> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(workspaceId)) return { bytes: 0, files: 0, approximate: true };
  const key = `${store.root}\0${workspaceId}`, previous = cache.get(key); if (previous && now - previous.at < CACHE_MS) return previous.value;
  const deadline = Date.now() + MAX_MS, seen = new Set<string>(); let bytes = 0, files = 0, approximate = false;
  const add = async (file: string) => { if (files >= MAX_FILES || Date.now() >= deadline) { approximate = true; return false; } try { const stat = await fs.stat(file); if (stat.isFile()) { bytes += stat.size; files++; } } catch { /* concurrently removed */ } return true; };
  const walk = async (directory: string): Promise<void> => {
    if (files >= MAX_FILES || Date.now() >= deadline) { approximate = true; return; }
    let handle; try { handle = await fs.opendir(directory); } catch { return; }
    for await (const child of handle) { if (files >= MAX_FILES || Date.now() >= deadline) { approximate = true; return; } const full = path.join(directory, child.name); if (child.isSymbolicLink()) continue; if (child.isDirectory()) await walk(full); else if (child.isFile()) await add(full); }
  };
  await walk(path.join(store.vault.root, 'workspaces', workspaceId));
  if (!approximate) {
    const journal = path.join(store.vault.root, '.mdb/events/commits.jsonl'); let handle;
    try { handle = await fs.open(journal, 'r'); const stat = await handle.stat(); let end = stat.size, tail = Buffer.alloc(0), scanned = 0;
      while (end > 0 && !approximate) { if (files >= MAX_FILES || Date.now() >= deadline || scanned >= MAX_FILES) { approximate = true; break; } const size = Math.min(64 * 1024, end); end -= size; const chunk = Buffer.alloc(size); await handle.read(chunk, 0, size, end); const lines = Buffer.concat([chunk, tail]).toString('utf8').split('\n'); tail = Buffer.from(lines.shift() ?? '');
        for (const line of lines.reverse()) { if (!line) continue; scanned++; if (scanned > MAX_FILES) { approximate = true; break; } try { const event = JSON.parse(line) as { objectId?: string; revisionId?: string; scope?: { type?: string; workspaceId?: string } }; if (event.scope?.type !== 'workspace' || event.scope.workspaceId !== workspaceId || !event.objectId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(event.objectId) || !event.revisionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(event.revisionId)) continue; const identity = `${event.objectId}/${event.revisionId}`; if (seen.has(identity)) continue; seen.add(identity); if (!(await add(path.join(store.vault.root, '.mdb/objects', event.objectId, 'revs', `${event.revisionId}.md`)))) break; } catch { /* ignore a partial trailing journal line */ } }
      }
      if (end === 0 && tail.length) { try { const event = JSON.parse(tail.toString('utf8')) as { objectId?: string; revisionId?: string; scope?: { type?: string; workspaceId?: string } }; if (event.scope?.type === 'workspace' && event.scope.workspaceId === workspaceId && event.objectId && event.revisionId && !seen.has(`${event.objectId}/${event.revisionId}`)) await add(path.join(store.vault.root, '.mdb/objects', event.objectId, 'revs', `${event.revisionId}.md`)); } catch { /* journal tail is incomplete */ } }
    } catch { /* no local journal is possible only for a partial replica */ } finally { await handle?.close(); }
  }
  const value = { bytes, files, approximate }; cache.set(key, { at: now, value }); if (cache.size > 4096) for (const [entry, item] of cache) { if (now - item.at >= CACHE_MS || cache.size > 4096) cache.delete(entry); else break; } return value;
}
