import { readFile } from 'node:fs/promises';
import { atomicWrite, safePath, withVaultLock } from '../storage-local/index.js';
import { MDBError, type Document } from '../core/types.js';
import type { SearchVault } from './index.js';

const start = '<!-- MDB:GENERATED:START -->';
const end = '<!-- MDB:GENERATED:END -->';
const clean = (text: string) => text.replace(/[\r\n\[\]<>]/g, ' ').slice(0, 160);
export async function guarded(root: string, key: string, title: string, lines: string[]): Promise<void> {
  let existing: string;
  try { existing = await readFile(await safePath(root, key), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; existing = `# ${title}\n`; }
  const generated = `${start}\n${lines.join('\n')}\n${end}`;
  const first = existing.indexOf(start); const last = existing.indexOf(end);
  if ((first < 0) !== (last < 0) || first >= 0 && last < first) throw new MDBError('INVALID_INPUT', `Malformed generated block in ${key}`);
  const next = first >= 0 ? existing.slice(0, first) + generated + existing.slice(last + end.length) : existing.trimEnd() + '\n\n' + generated + '\n';
  await atomicWrite(root, key, next);
}

/** Navigation files are derived views. Generated blocks never replace authored prose. */
export async function refreshNavigation(vault: SearchVault): Promise<void> {
  if (!vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Navigation maintenance requires trusted owner identity');
  const documents = await vault.listDocuments();
  const scoped = new Map<string, Document[]>();
  for (const doc of documents) {
    if (doc.status === 'deleted' || doc.status === 'tombstone') continue;
    if (doc.kind === 'discovery' && doc.metadata.derivedFromPrivate === true) continue; // built from private workspace material: never listed in a shared index
    if (doc.kind === 'user_insight') continue; // insights are user-private: they appear only in the generated profile projections, never in shared navigation
    const key = doc.scope.type === 'global' ? doc.scope.area : `workspaces/${doc.scope.workspaceId}${doc.scope.collectionId ? `/collections/${doc.scope.collectionId}` : ''}`;
    if (!scoped.has(key)) scoped.set(key, []);
    scoped.get(key)!.push(doc);
  }
  // Empty scope indexes must also reconcile after the final document is deleted.
  for (const area of ['wiki', 'shared', 'discoveries', 'profile']) if (!scoped.has(area)) scoped.set(area, []);
  const enhanced = vault as SearchVault & { listWorkspaces?: () => Promise<Array<{ id: string; description: string }>>; listCollections?: (id: string) => Promise<Array<{ id: string; description: string }>> };
  const workspaces = enhanced.listWorkspaces ? await enhanced.listWorkspaces() : Array.from(new Set(documents.flatMap(doc => doc.scope.type === 'workspace' ? [doc.scope.workspaceId] : []))).map(id => ({ id, description: '' }));
  for (const workspace of workspaces) {
    const key = `workspaces/${workspace.id}`; if (!scoped.has(key)) scoped.set(key, []);
    if (enhanced.listCollections) for (const collection of await enhanced.listCollections(workspace.id)) { const collectionKey = `${key}/collections/${collection.id}`; if (!scoped.has(collectionKey)) scoped.set(collectionKey, []); }
  }
  await withVaultLock(vault.root, async () => {
    for (const [key, docs] of scoped) {
      const children = [...scoped.keys()].filter(child => child.startsWith(`${key}/collections/`) && child.split('/').length === key.split('/').length + 2);
      await guarded(vault.root, `${key}/INDEX.md`, `${key} index`, [
        ...children.map(child => `- [Collection: ${clean(child.split('/').at(-1)!)}](${child.slice(key.length + 1)}/INDEX.md)`),
        ...docs.sort((a, b) => a.title.localeCompare(b.title)).map(doc => `- [${clean(doc.title)}](${doc.uri}) · ${doc.kind} · ${doc.revisionId}`)
      ]);
    }
    await guarded(vault.root, 'MAIN_INDEX.md', 'Engram navigation', ['- [Profile](PROFILE.md)', '- [User insights](USER_INSIGHT.md)', ...['wiki','shared','discoveries'].map(area => `- [${area}](${area}/INDEX.md)`), '- [Workspace registry](WORKSPACE_REGISTRY.md)', ...workspaces.map(workspace => `- [${clean(workspace.id)}](workspaces/${workspace.id}/INDEX.md)`)]);
    await guarded(vault.root, 'WORKSPACE_REGISTRY.md', 'Workspace registry', workspaces.map(workspace => `- [${clean(workspace.id)}](workspaces/${workspace.id}/INDEX.md): ${clean(workspace.description)}`));
  });
}
