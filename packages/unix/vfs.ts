import { MDBError } from '../core/types.js';
import type { Ctx } from './ctx.js';

/** The vault as a read-only virtual tree: /wiki, /shared, /discoveries, /profile and /workspaces/<ws>[/collections/<c>]/<objectId>.md. Built only from objects the actor may read (manifest-level metadata, no Markdown read). */
export interface VNode { path: string; name: string; dir: boolean; depth: number; id?: string; title?: string; kind?: string; tags?: string[]; updatedAt?: string; revision?: string }
const GLOBAL = ['wiki', 'shared', 'discoveries', 'profile'];
export async function listVfs(ctx: Ctx): Promise<VNode[]> {
  if (!ctx.client) throw new MDBError('NOT_FOUND', 'no vault');
  const client = ctx.client; const nodes = new Map<string, VNode>();
  const dir = (path: string) => { if (!nodes.has(path)) nodes.set(path, { path, name: path.split('/').at(-1) || '/', dir: true, depth: path.split('/').filter(Boolean).length }); };
  dir('/');
  const res = await client.queries.run({ from: 'documents', pipe: [{ op: 'select', fields: ['id', 'title', 'type', 'tags', 'updatedAt', 'workspace', 'collection', 'area', 'revision'] }] }, { maxRows: ctx.limits.maxBufferLines, maxBytes: 256_000_000, maxBufferRows: ctx.limits.maxBufferLines });
  if (res.truncated) throw new MDBError('RESOURCE_LIMIT', `more than ${ctx.limits.maxBufferLines} objects: narrow with a start path`);
  for (const area of GLOBAL) if (await client.vault.canAccess({ type: 'global', area: area as 'wiki' }, 'read').catch(() => false)) dir(`/${area}`);
  for (const w of await client.vault.listWorkspaces()) { dir('/workspaces'); dir(`/workspaces/${w.id}`); for (const col of await client.vault.listCollections(w.id).catch(() => [])) { dir(`/workspaces/${w.id}/collections`); dir(`/workspaces/${w.id}/collections/${col.id}`); } }
  for (const r of res.rows as Array<{ id: string; title: string; type: string; tags: string[]; updatedAt: string; workspace?: string; collection?: string; area?: string; revision: string }>) {
    const parent = r.workspace ? `/workspaces/${r.workspace}${r.collection ? `/collections/${r.collection}` : ''}` : `/${r.area}`;
    if (r.workspace) { dir('/workspaces'); dir(`/workspaces/${r.workspace}`); if (r.collection) { dir(`/workspaces/${r.workspace}/collections`); dir(parent); } } else dir(parent);
    const name = `${r.id}.md`; nodes.set(`${parent}/${name}`, { path: `${parent}/${name}`, name, dir: false, depth: parent.split('/').filter(Boolean).length + 1, id: r.id, title: r.title, kind: r.type, tags: r.tags, updatedAt: r.updatedAt, revision: r.revision });
  }
  return [...nodes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export const parentOf = (path: string): string => path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';
export const normPath = (p: string): string => { const s = ('/' + p.replace(/^mdb:/, '').replace(/^\.\/?/, '')).replace(/\/+/g, '/'); return s.length > 1 ? s.replace(/\/$/, '') : s; };
export const under = (path: string, root: string): boolean => root === '/' || path === root || path.startsWith(root + '/');
