import type { Document } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { objectIdFromUri } from '../core/vault.js';

type SourceRef = { uri?: unknown; revisionId?: unknown };

/** Current, actor-bound check for derived insight text. Historical approval is not authorization. */
export async function insightCurrentlyAccessible(vault: Vault, doc: Document, scopeLabel?: string): Promise<boolean> {
  if (doc.kind !== 'user_insight' || !['accepted', 'superseded'].includes(doc.status)) return false;
  const label = typeof doc.metadata.scopeLabel === 'string' ? doc.metadata.scopeLabel : 'global';
  if (scopeLabel && label !== 'global' && label !== scopeLabel) return false;

  // Vault.get intentionally removes inaccessible refs from evidence. Metadata.sources is
  // retained for provenance, so inspect both representations and fail closed if none remain.
  const refs = new Map<string, { uri: string; revisionId: string }>();
  for (const ref of doc.evidence ?? []) if (ref?.uri && ref.revisionId) refs.set(`${ref.uri}\0${ref.revisionId}`, { uri: ref.uri, revisionId: ref.revisionId });
  if (Array.isArray(doc.metadata.sources)) for (const value of doc.metadata.sources) {
    if (!value || typeof value !== 'object') return false;
    const ref = value as SourceRef;
    if (typeof ref.uri !== 'string' || typeof ref.revisionId !== 'string') return false;
    refs.set(`${ref.uri}\0${ref.revisionId}`, { uri: ref.uri, revisionId: ref.revisionId });
  }
  // Owner-entered preferences can be schema-versioned but have no supporting
  // conversation (for example `profile correct`). They remain directly
  // visible because the owner authored the claim; extracted claims without
  // verifiable source references fail closed.
  if (!refs.size) return doc.metadata.evidenceClass === 'explicit' && doc.metadata.origin === 'user_statement'
    || typeof doc.metadata.modelProvider !== 'string' && doc.metadata.insightSchema !== 1 && !Array.isArray(doc.metadata.sources);

  for (const ref of refs.values()) {
    try {
      const id = objectIdFromUri(ref.uri);
      const current = await vault.get(id);
      const cited = await vault.get(id, ref.revisionId);
      if (current.uri !== ref.uri || cited.uri !== ref.uri || current.status === 'deleted' || cited.status === 'deleted'
        || current.metadata.sensitivity === 'sensitive' || cited.metadata.sensitivity === 'sensitive'
        || !await vault.canAccess(current.scope, 'read') || !await vault.canAccess(cited.scope, 'read')) return false;
    } catch { return false; }
  }
  return true;
}
