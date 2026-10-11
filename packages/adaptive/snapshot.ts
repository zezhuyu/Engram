import { createHash } from 'node:crypto';
import type { CommitEvent, Document, Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';

export interface SealedObject { id: string; revisionId: string; sequence: number; firstSequence: number; scope: Scope }
/**
 * A sealed, revision-consistent view of the vault at committed journal sequence W. It is reconstructed from the append-only journal prefix [1..W]
 * (so it can be rebuilt after a crash and never reads a mutable head): for each object, the revision its last record at or before W points to.
 */
export class SnapshotView {
  constructor(readonly watermark: number, private readonly objects: Map<string, SealedObject>, readonly allowPost: Set<string> = new Set()) {}
  has(id: string): boolean { return this.objects.has(id); }
  /** In the frozen universe: existed live at or before W, or is an explicitly enumerated post-W derived output. */
  eligible(id: string): boolean { return this.objects.has(id) || this.allowPost.has(id); }
  revisionOf(id: string): string | undefined { return this.objects.get(id)?.revisionId; }
  get size(): number { return this.objects.size; }
  entries(): SealedObject[] { return [...this.objects.values()]; }
  /** Policy exclusion (workspace opt-out): the same sealed snapshot minus whole workspaces. Excluded workspaces are invisible to every stage, Dream included. */
  excludeWorkspaces(ids: Set<string>): SnapshotView { if (!ids.size) return this; return new SnapshotView(this.watermark, new Map([...this.objects].filter(([, o]) => !(o.scope.type === 'workspace' && ids.has(o.scope.workspaceId)))), this.allowPost); }
  withAllowPost(ids: Iterable<string>): SnapshotView { return new SnapshotView(this.watermark, this.objects, new Set([...this.allowPost, ...ids])); }
  scopes(): string[] { return [...new Set(this.entries().map(o => o.scope.type === 'global' ? `global:${o.scope.area}` : `workspace:${o.scope.workspaceId}`))].sort(); }
  /** Reads the exact sealed revision. Returns undefined when it is gone (purged, access revoked) so callers never fall back to a newer head. */
  async read(vault: Vault, id: string): Promise<Document | undefined> {
    const rev = this.revisionOf(id); if (!rev) return this.allowPost.has(id) ? vault.get(id).catch(() => undefined) : undefined;
    const doc = await vault.get(id, rev).catch(() => undefined); return doc && doc.status !== 'deleted' ? doc : undefined;
  }
}
export interface Sealed { view: SnapshotView; watermark: number; manifestHash: string; policyVersion: string; liveObjects: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Builds the sealed view for events with sequence <= watermark (default: the current committed head). */
export async function viewAt(vault: Vault, watermark?: number): Promise<{ view: SnapshotView; events: CommitEvent[] }> {
  const events = await vault.events(); const head = events.reduce((m, e) => Math.max(m, e.sequence), 0); const w = watermark ?? head;
  const last = new Map<string, SealedObject & { op: string }>();
  for (const e of events) { if (e.sequence > w) continue; const prev = last.get(e.objectId); last.set(e.objectId, { id: e.objectId, revisionId: e.revisionId, sequence: e.sequence, firstSequence: prev?.firstSequence ?? e.sequence, scope: e.scope, op: e.operation }); }
  const live = new Map<string, SealedObject>(); for (const [id, o] of last) if (o.op !== 'delete' && o.op !== 'purge') live.set(id, { id, revisionId: o.revisionId, sequence: o.sequence, firstSequence: o.firstSequence, scope: o.scope });
  return { view: new SnapshotView(w, live), events };
}
/** Hash of the access policy that decided what the cycle may read: workspace grants and capture registrations. A change mid-cycle invalidates it. */
export async function policyVersion(vault: Vault): Promise<string> {
  const workspaces = (await vault.listWorkspaces()).map(w => ({ id: w.id, grants: w.grants })).sort((a, b) => a.id.localeCompare(b.id));
  let registrations: string[] = []; try { const { listRegistrations } = await import('../memory/capture.js'); registrations = (await listRegistrations(vault.root)).map((r: { id: string }) => r.id).sort(); } catch { /* capture not in use */ }
  return hash({ workspaces, registrations }).slice(0, 32);
}
export async function sealSnapshot(vault: Vault, watermark?: number): Promise<Sealed> {
  const { view } = await viewAt(vault, watermark);
  const manifestHash = hash(view.entries().map(o => [o.id, o.revisionId, o.sequence]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))); 
  return { view, watermark: view.watermark, manifestHash, policyVersion: await policyVersion(vault), liveObjects: view.size };
}
