import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Vault } from '../core/vault.js';
import { MDBError } from '../core/types.js';

export type WikiRetireReport = { workspace: string; namespace: string; dryRun: boolean; verified: number; unverified: number; verifiedSources: number; leftovers: Array<{ id: string; kind: string; title: string }>; deleted: Array<{ id: string; kind: string; title: string; revisionId?: string }>; restored: number; errors: Array<{ id?: string; path?: string; reason: string }> };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const imported = (doc: { kind: string; metadata: Record<string, unknown> }) => ['source', 'wiki_page'].includes(doc.kind) && typeof doc.metadata.importPath === 'string' && typeof doc.metadata.importSha256 === 'string';

/** Verify the complete imported snapshot before tombstoning it; all mutations go through Vault. */
export async function wikiRetireWorkspace(vault: Vault, input: { workspace: string; intoWikiVerified?: boolean; restore?: boolean; dryRun?: boolean; allowLeftovers?: boolean }): Promise<WikiRetireReport> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workspace)) throw new MDBError('INVALID_ARGUMENT', 'Workspace must be a lowercase namespace slug');
  if (!vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'wiki retire-workspace is owner-CLI only');
  const namespace = input.workspace, report: WikiRetireReport = { workspace: input.workspace, namespace, dryRun: input.dryRun === true, verified: 0, unverified: 0, verifiedSources: 0, leftovers: [], deleted: [], restored: 0, errors: [] };
  if (input.restore) {
    const docs = await vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: input.workspace }], includeHistory: true });
    for (const doc of docs) {
      if (!imported(doc)) continue;
      const current = await vault.get(doc.id);
      if (current.status !== 'deleted' || !current.previousRevisionId) continue;
      const restored = await vault.restore(current.id, current.previousRevisionId, current.revisionId, `wiki-restore:${namespace}:${current.id}:${current.revisionId}`);
      report.restored++; report.deleted.push({ id: restored.id, kind: restored.kind, title: restored.title, revisionId: restored.revisionId });
    }
    await vault.setWorkspaceRetired(namespace, false);
    return report;
  }
  if (!input.intoWikiVerified) throw new MDBError('INVALID_ARGUMENT', 'Retirement requires --into-wiki-verified');
  const workspaceRecord = await vault.getWorkspace(namespace);
  const oldDocs = await vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: namespace }], includeHistory: false });
  const liveDocs = oldDocs.filter(doc => doc.status !== 'deleted'), candidates = liveDocs.filter(imported);
  report.leftovers = liveDocs.filter(doc => !imported(doc)).map(doc => ({ id: doc.id, kind: doc.kind, title: doc.title }));
  const globalDocs = await vault.listDocuments({ scopes: [{ type: 'global', area: 'wiki' }] });
  const targetByKey = new Map(globalDocs.filter(doc => doc.metadata.wikiNamespace === namespace && imported(doc)).map(doc => [`${doc.kind}:${String(doc.metadata.wikiOriginalPath ?? String(doc.metadata.importPath).slice(namespace.length + 1))}`, doc]));
  for (const doc of candidates) {
    const rel = String(doc.metadata.importPath), target = targetByKey.get(`${doc.kind}:${rel}`), expected = String(doc.metadata.importSha256);
    let reason: string | undefined;
    if (!target) reason = 'global wiki namespace counterpart is missing';
    else if (target.metadata.importSha256 !== expected) reason = 'global wiki original-content SHA-256 differs';
    else if (doc.kind === 'source') {
      try {
        const oldBytes = await fs.readFile(path.join(vault.root, String(doc.metadata.originalPath)));
        const newBytes = await fs.readFile(path.join(vault.root, String(target.metadata.originalPath)));
        if (sha256(oldBytes) !== expected || sha256(newBytes) !== expected) reason = 'source original bytes do not match verified SHA-256';
      } catch { reason = 'source original is missing or unreadable'; }
    }
    if (reason) { report.unverified++; report.errors.push({ id: doc.id, path: rel, reason }); }
    else { report.verified++; if (doc.kind === 'source') report.verifiedSources++; }
  }
  if (!candidates.length && !workspaceRecord.retired) report.errors.push({ reason: 'workspace has no imported documents to verify; refusing empty retirement' });
  if (report.leftovers.length && !input.allowLeftovers) report.errors.push({ reason: `${report.leftovers.length} workspace leftovers require --allow-leftovers` });
  if (report.errors.length) return report;
  for (const doc of candidates) {
    if (input.dryRun) { report.deleted.push({ id: doc.id, kind: doc.kind, title: doc.title }); continue; }
    try { const deleted = await vault.delete(doc.id, doc.revisionId, `wiki-retire:${namespace}:${doc.id}:${doc.revisionId}`); report.deleted.push({ id: doc.id, kind: doc.kind, title: doc.title, revisionId: deleted.revisionId }); }
    catch (error) { report.errors.push({ id: doc.id, reason: (error as Error).message }); }
  }
  if (!input.dryRun && report.errors.length === 0) await vault.setWorkspaceRetired(namespace, true);
  return report;
}
