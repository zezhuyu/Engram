import type { Document, Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { manifestFor, type ManifestEntry } from '../search-files/manifest.js';
import { scopeMatches } from '../search-files/index.js';

export interface EntryFilter { kinds?: string[]; scope?: Scope; /** also include global objects */ withGlobal?: boolean; pk?: string; sessionId?: string; speaker?: string; explicitOnly?: boolean; sinceSequence?: number; excludeKinds?: string[] }
/**
 * Targeted, authorized access to the corpus through the journal-synced manifest. Nothing here loads documents it does not return;
 * the manifest is a superset hint, so callers that need content read it through Vault.get (which re-checks access).
 */
export async function readableEntries(vault: Vault, filter: EntryFilter = {}): Promise<ManifestEntry[]> {
  const manifest = await manifestFor(vault); await manifest.sync();
  const allowed = await manifest.readableScopes(); const out: ManifestEntry[] = [];
  for (const sk of allowed) for (const id of manifest.byScope.get(sk) ?? []) {
    const e = manifest.entries.get(id)!;
    if (e.status === 'deleted' || e.status === 'tombstone') continue;
    if (filter.kinds && !filter.kinds.includes(e.kind)) continue; if (filter.excludeKinds?.includes(e.kind)) continue;
    if (filter.scope && !(scopeEqual(e.scope, filter.scope) || (filter.withGlobal && e.scope.type === 'global'))) continue;
    if (filter.pk !== undefined && e.pk !== filter.pk) continue;
    if (filter.sessionId && e.sid !== filter.sessionId) continue;
    if (filter.speaker && e.sp !== filter.speaker) continue;
    if (filter.explicitOnly && !e.ex) continue;
    if (filter.sinceSequence !== undefined && e.last <= filter.sinceSequence) continue;
    out.push(e);
  }
  return out;
}
export const scopeEqual = (a: Scope, b: Scope): boolean => JSON.stringify(a) === JSON.stringify(b);
export const inScope = (e: ManifestEntry, scope: Scope): boolean => scopeMatches(e.scope, scope);
/** Newest first by event time, ties by id. */
export const newestFirst = (a: ManifestEntry, b: ManifestEntry): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1);
export const oldestFirst = (a: ManifestEntry, b: ManifestEntry): number => newestFirst(b, a);
export async function loadDocuments(vault: Vault, entries: ManifestEntry[]): Promise<Document[]> {
  const out: Document[] = []; for (let i = 0; i < entries.length; i += 16) out.push(...(await Promise.all(entries.slice(i, i + 16).map(e => vault.get(e.id).catch(() => undefined)))).filter((d): d is Document => !!d && d.status !== 'deleted'));
  return out;
}
