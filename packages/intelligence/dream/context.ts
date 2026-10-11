import type { Document } from '../../core/types.js';
import type { Vault } from '../../core/vault.js';
import { manifestFor, type ManifestEntry } from '../../search-files/manifest.js';
import { loadDocuments, readableEntries } from '../corpus.js';
import { KNOWLEDGE_KINDS } from './plan.js';
import { readStats } from './lifecycle.js';
import { learnedSuccess } from './learning.js';
import type { Graph, PlanContext, Budgets } from './types.js';
import { SearchEngine } from '../../search-sqlite/index.js';

/** The knowledge a dream may draw on: readable, live, non-raw-log objects. Discoveries and anything derived from a dream never seed new dreams. */
export async function dreamPool(vault: Vault, filter: { workspaceId?: string } = {}): Promise<ManifestEntry[]> {
  const entries = await readableEntries(vault, { kinds: KNOWLEDGE_KINDS });
  return entries.filter(e => !['superseded', 'rejected', 'deleted', 'tombstone'].includes(e.status) && e.ec !== 'dream' && (!filter.workspaceId || e.scope.type === 'global' || e.scope.workspaceId === filter.workspaceId));
}
export async function graphFor(vault: Vault, pool: ManifestEntry[], semantic = new Map<string, Set<string>>()): Promise<Graph> {
  const manifest = await manifestFor(vault); await manifest.sync();
  const byKey = new Map<string, ManifestEntry>(); for (const e of pool) { byKey.set(e.id, e); byKey.set(manifest.uri(e), e); byKey.set(e.title, e); }
  const byId = new Map(pool.map(e => [e.id, e]));
  return {
    out: e => [...new Map([...e.refs.map(([, target]) => byKey.get(target)), ...[...(semantic.get(e.id) ?? [])].map(id => byId.get(id))].filter((x): x is ManifestEntry => !!x && x.id !== e.id).map(x => [x.id, x])).values()],
    in: e => [...new Set([...([e.id, manifest.uri(e), e.title].flatMap(key => [...(manifest.referencedBy.get(key) ?? [])]).map(id => byId.get(id)).filter((x): x is ManifestEntry => !!x && x.id !== e.id)), ...pool.filter(candidate => semantic.get(candidate.id)?.has(e.id))])],
    semantic: e => [...(semantic.get(e.id) ?? [])].map(id => byId.get(id)).filter((x): x is ManifestEntry => !!x)
  };
}
export interface Suppression { suppressed: (ids: string[]) => boolean; known: number }
const refKey = (e: ManifestEntry) => `${e.id}@${e.rev}`;
/**
 * Repeat suppression: a cluster is skipped when every object-and-revision in it was already part of a rejected discovery (nothing new since) or of a live one
 * (already covered). A new object or a new revision of a cited object makes the cluster eligible again.
 */
export async function suppression(vault: Vault, pool: ManifestEntry[]): Promise<Suppression> {
  const discoveries = await loadDocuments(vault, (await readableEntries(vault, { kinds: ['discovery'] })).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 500));
  const sets = discoveries.filter(d => d.status !== 'superseded').map(d => new Set(((Array.isArray(d.metadata.sourceRefs) ? d.metadata.sourceRefs : d.evidence) as Array<{ uri: string; revisionId: string }>).map(r => `${r.uri.split('/').at(-1)}@${r.revisionId}`)));
  const byId = new Map(pool.map(e => [e.id, e]));
  return { known: sets.length, suppressed: ids => { const keys = ids.map(id => byId.get(id)).filter((e): e is ManifestEntry => !!e).map(refKey); return keys.length > 0 && sets.some(set => keys.every(k => set.has(k))); } };
}
/** Optional, bounded semantic association lookup. It runs only when SQLite and configured embeddings are ready; global source titles/bodies only are sent as queries. */
export async function semanticAssociations(vault: Vault, pool: ManifestEntry[], search = new SearchEngine(vault)): Promise<Map<string, Set<string>>> {
  const links = new Map<string, Set<string>>();
  try {
    if (!(await search.vectors.status()).ready) return links;
    const publicEntries = pool.filter(e => e.scope.type === 'global').slice(0, 12);
    for (const entry of publicEntries) {
      const doc = (await loadDocuments(vault, [entry]))[0]; if (!doc) continue;
      const result = await search.query({ query: `${doc.title}\n${doc.body.slice(0, 1200)}`, mode: 'semantic', limit: 8 }, vault.actor);
      for (const hit of result.hits) {
        if (hit.objectId === entry.id || !pool.some(candidate => candidate.id === hit.objectId)) continue;
        (links.get(entry.id) ?? links.set(entry.id, new Set()).get(entry.id)!).add(hit.objectId);
        (links.get(hit.objectId) ?? links.set(hit.objectId, new Set()).get(hit.objectId)!).add(entry.id);
      }
    }
  } catch { /* Semantic search is optional; existing lexical/graph discovery remains available. */ }
  return links;
}
export async function planContext(vault: Vault, pool: ManifestEntry[], budgets: Budgets, rng: () => number, options: { search?: SearchEngine; semantic?: boolean } = {}): Promise<PlanContext & { knownDiscoveries: number; semanticAssociationCount: number }> {
  const semantic = options.semantic === false ? new Map<string, Set<string>>() : await semanticAssociations(vault, pool, options.search);
  const [graph, stats, supp] = await Promise.all([graphFor(vault, pool, semantic), readStats(vault), suppression(vault, pool)]);
  return { pool, graph, budgets, rng, success: await learnedSuccess(vault, stats), suppressed: supp.suppressed, knownDiscoveries: supp.known, semanticAssociationCount: [...semantic.values()].reduce((sum, ids) => sum + ids.size, 0) / 2 };
}
export type { Document };
