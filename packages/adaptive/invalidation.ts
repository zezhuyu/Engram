import type { Document } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { loadDocuments, readableEntries } from '../intelligence/corpus.js';
import { isInsight, projectProfile } from '../intelligence/insights.js';
import type { AdaptiveStore } from './state.js';

export interface Invalidation { objectId: string; kind: string; action: 'purged'; because: string }
const idOf = (uri: string) => uri.split('/').at(-1)!;
const mentions = (doc: Document, purged: Set<string>): string | undefined => {
  const refs: string[] = [...(doc.evidence ?? []).map(e => idOf(e.uri))];
  for (const key of ['sources', 'sourceRefs']) { const v = doc.metadata[key]; if (Array.isArray(v)) for (const r of v as Array<{ uri?: string }>) if (r?.uri) refs.push(idOf(r.uri)); }
  const rev = doc.metadata.source_revisions; if (Array.isArray(rev)) for (const r of rev as Array<{ objectId?: string }>) if (r?.objectId) refs.push(r.objectId);
  return refs.find(r => purged.has(r));
};
/**
 * Purge is a privacy operation: anything the pipeline derived from purged evidence must go too. Workspace summaries quote their sources, so they are purged
 * (history included); accepted insights and discoveries are purged as well, because their evidence spans quote the source, and the root Markdown projection is refreshed. Runs before every cycle step that reads derived data.
 */
export async function propagatePurges(vault: Vault, store: AdaptiveStore): Promise<Invalidation[]> {
  const cursors = await store.cursors(); const events = await vault.eventsSince(cursors.purge ?? 0);
  const purged = new Set(events.filter(e => e.operation === 'purge').map(e => e.objectId)); const done: Invalidation[] = []; const head = events.at(-1)?.sequence ?? cursors.purge ?? 0;
  if (!purged.size) { if (head > (cursors.purge ?? 0)) await store.advanceCursors(c => { c.purge = Math.max(c.purge ?? 0, head); }); return done; }
  const docs = await loadDocuments(vault, await readableEntries(vault, { kinds: ['workspace_daily_summary', 'user_insight', 'discovery'] })); let insightChanged = false;
  for (const doc of docs) {
    if (purged.has(doc.id)) continue; const because = mentions(doc, purged); if (!because) continue;
    // Derived artifacts quote their evidence (summary excerpts, insight evidence spans, discovery spans): withdrawing them from view would leave the text in their history, so they are purged too.
    await vault.purge(doc.id, true).catch(() => undefined); if (isInsight(doc)) insightChanged = true; done.push({ objectId: doc.id, kind: doc.kind, action: 'purged', because });
  }
  if (insightChanged && vault.actor.permissions.includes('*')) await projectProfile(vault).catch(() => undefined);
  await store.advanceCursors(c => { c.purge = Math.max(c.purge ?? 0, head, ...[0]); });
  return done;
}
