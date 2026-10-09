import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MDBError, type Document, type Evidence } from '../../core/types.js';
import { objectIdFromUri, type Vault } from '../../core/vault.js';
import { atomicWrite, safePath, withVaultLock } from '../../storage-local/index.js';
import { loadDocuments, readableEntries } from '../corpus.js';

/** candidate -> tested -> validated | rejected ; any -> superseded. A validated discovery needs the user's confirmation or a recorded experiment result. */
export type DiscoveryOutcome = 'tested' | 'validated' | 'rejected' | 'superseded';
const ALLOWED: Record<string, DiscoveryOutcome[]> = { candidate: ['tested', 'validated', 'rejected', 'superseded'], hypothesis: ['rejected', 'superseded'], tested: ['validated', 'rejected', 'superseded'], validated: ['superseded'], rejected: ['superseded'], superseded: [] };
const STATS = '.mdb/intelligence/dream-stats.json';
export interface Stats { [family: string]: { validated: number; rejected: number; tested: number } }

export async function readStats(vault: Pick<Vault, 'root'>): Promise<Stats> { try { return JSON.parse(await fs.readFile(await safePath(vault.root, STATS), 'utf8')) as Stats; } catch { return {}; } }
/** Laplace-smoothed share of decided discoveries in this family that were validated; 0.5 when nothing is known. Used to rank future candidates, never to approve one. */
export const successRate = (stats: Stats, family: string): number => { const s = stats[family]; return s ? (s.validated + 1) / (s.validated + s.rejected + 2) : 0.5; };
export const familyOf = (d: Pick<Document, 'metadata'>): string => `${d.metadata.mode ?? 'deep'}|${[...(Array.isArray(d.metadata.domains) ? d.metadata.domains as string[] : [])].sort().join('+')}`;

/**
 * Records what happened to a discovery as a NEW REVISION (the earlier ones stay readable) and feeds the ranking statistics.
 * Repeating a hypothesis never validates it: `validated` needs evidence (an experiment/result object) or the user's own confirmation.
 */
export async function recordFeedback(vault: Vault, id: string, input: { outcome: DiscoveryOutcome; note: string; validatedBy?: 'user' | 'experiment'; evidence?: Evidence[]; supersededBy?: string; reusedBy?: string[] }): Promise<Document> {
  const doc = await vault.get(id); if (doc.kind !== 'discovery') throw new MDBError('INVALID_INPUT', 'Feedback applies to discoveries');
  if (!ALLOWED[doc.status]?.includes(input.outcome)) throw new MDBError('INVALID_INPUT', `A ${doc.status} discovery cannot become ${input.outcome}`);
  if (!input.note?.trim()) throw new MDBError('INVALID_INPUT', 'Feedback needs a note');
  if (input.outcome === 'validated') {
    if (input.validatedBy !== 'user' && !(input.validatedBy === 'experiment' && input.evidence?.length)) throw new MDBError('INVALID_INPUT', 'Validation needs the user\'s confirmation or an experiment result cited as evidence');
    for (const ref of input.evidence ?? []) { const target = await vault.get(objectIdFromUri(ref.uri), ref.revisionId).catch(() => undefined); if (!target || target.kind === 'discovery') throw new MDBError('INVALID_INPUT', 'Validation evidence must be a readable non-discovery object'); }
  }
  const history = Array.isArray(doc.metadata.feedback) ? doc.metadata.feedback as unknown[] : [];
  const updated = await vault.patch({
    objectId: doc.id, expectedRevisionId: doc.revisionId, status: input.outcome,
    ...(input.reusedBy?.length ? { links: [...doc.links, ...input.reusedBy.map(target => ({ type: 'reused_by', target }))] } : {}),
    metadataPatch: { feedback: [...history, { outcome: input.outcome, note: input.note.slice(0, 500), at: new Date().toISOString(), ...(input.validatedBy ? { by: input.validatedBy } : {}), ...(input.evidence?.length ? { evidence: input.evidence } : {}) }], ...(input.outcome === 'validated' ? { validation: { by: input.validatedBy, at: new Date().toISOString(), evidence: input.evidence ?? [] } } : {}), ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}) }
  });
  if (['validated', 'rejected', 'tested'].includes(input.outcome)) await withVaultLock(vault.root, async () => {
    const stats = await readStats(vault); const family = familyOf(doc); const s = (stats[family] ??= { validated: 0, rejected: 0, tested: 0 });
    s[input.outcome as 'validated' | 'rejected' | 'tested']++; await atomicWrite(vault.root, STATS, JSON.stringify(stats, null, 1));
  });
  return updated;
}

/** Discoveries whose cited evidence has since changed (a newer revision exists) or disappeared: they may no longer hold and should be re-examined. */
export async function staleDiscoveries(vault: Vault): Promise<Array<{ id: string; reason: string }>> {
  const stale: Array<{ id: string; reason: string }> = [];
  for (const d of await loadDocuments(vault, await readableEntries(vault, { kinds: ['discovery'] }))) {
    if (['rejected', 'superseded'].includes(d.status)) continue;
    for (const ref of (Array.isArray(d.metadata.sourceRefs) ? d.metadata.sourceRefs : []) as Array<{ uri: string; revisionId: string }>) {
      const head = await vault.get(objectIdFromUri(ref.uri)).catch(() => undefined);
      if (!head || head.status === 'deleted') { stale.push({ id: d.id, reason: `source ${ref.uri} is gone` }); break; }
      if (head.revisionId !== ref.revisionId) { stale.push({ id: d.id, reason: `source ${ref.uri} changed after this discovery` }); break; }
    }
  }
  void path;
  return stale;
}
