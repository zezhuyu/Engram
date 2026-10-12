import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ActorContext, CommitEvent, Document, Scope } from '../core/types.js';
import { atomicWrite, safePath } from '../storage-local/index.js';
import { documentUri, objectIdFromUri, scopeKey } from '../core/vault.js';

/** What the manifest needs from a vault. Every read goes through the actor-bound Vault, so access checks are never bypassed. */
export interface ManifestSource {
  root: string;
  actor: ActorContext;
  journalSince(sequence: number): Promise<Array<Pick<CommitEvent, 'sequence' | 'transactionId' | 'objectId' | 'previousRevisionId' | 'operation' | 'scope'>>>;
  get(objectId: string, revisionId?: string): Promise<Document>;
  canAccess(scope: Scope, action?: 'read' | 'write' | 'promote'): Promise<boolean>;
}

/**
 * One lightweight record per object: enough to filter by scope, kind, tag, status and time, to find backlink candidates, and to locate
 * the head revision file, without reading any body. It is DERIVED from the journal and never authoritative: every result that leaves
 * the search layer is re-read through Vault.get, which re-checks authorization.
 */
export interface ManifestEntry {
  id: string; rev: string;
  /** Journal sequence of the object's first and latest records (creation order, and index-lag detection). */
  first: number; last: number;
  scope: Scope; sk: string; kind: string; title: string; tags: string[]; status: string; updated: string;
  /** Event time (UTC ISO, from metadata.eventTime or creation), MDB session id, host session id, event type and speaker, for recent/timeline recall. */
  at: string; sid?: string; hs?: string; et?: string; sp?: string;
  /** Insight-related metadata for targeted lookups: preference key, evidence class, category, and whether the object is an explicit user statement. */
  pk?: string; ec?: string; cat?: string; ex?: boolean; /** knowledge domain (metadata.domain), used to find cross-domain associations */ dom?: string;
  /** Outgoing references: declared relations and body references, as [type, rawTarget]. Superset of what a viewer may see. */
  refs: Array<[string, string]>;
  /** Lower-cased text of every Markdown heading in the body, newline-joined ('' = no headings); absent = unknown (too long to keep). Lets the ranking bound prove a term cannot score the heading bonus. */
  hd?: string;
}
const FILE = '.mdb/indexes/manifest.v4.jsonl';
/** Lower-cased heading lines of a Markdown body (matching the ranking rule `^#{1,6}\s`), or undefined when they would be larger than 1 KiB. */
export function headingText(body: string): string | undefined {
  const headings: string[] = []; for (const line of body.split('\n')) if (/^#{1,6}\s/.test(line)) headings.push(line.replace(/^#{1,6}\s+/, '').toLowerCase());
  const joined = headings.join('\n'); return joined.length <= 1024 ? joined : undefined;
}
const BODY_REFERENCE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|mdb:\/\/[^\s)\]>]+/g;
export const bodyReferences = (body: string): Array<[string, string]> => Array.from(body.matchAll(BODY_REFERENCE), match => ['references', match[1] ?? match[0]] as [string, string]);

export class Manifest {
  readonly entries = new Map<string, ManifestEntry>();
  readonly byScope = new Map<string, Set<string>>();
  /** raw reference string -> ids that mention it. */
  readonly referencedBy = new Map<string, Set<string>>();
  sequence = 0; lastTx = '';
  /** Objects touched while their scope was unreadable to this actor; fetched when the scope becomes readable (a grant). scopeKey -> id -> sequences. */
  private readonly pending = new Map<string, { scope: Scope; ids: Map<string, { first: number; last: number }> }>();
  private chain: Promise<unknown> = Promise.resolve();
  private orderGeneration = 0;
  private recentOrder?: { generation: number; descending: ManifestEntry[]; ascending: ManifestEntry[] };
  persisted = false; loadedFromDisk = false; lastSyncChanged = 0;
  constructor(private readonly source: ManifestSource) {}

  private isOwner(): boolean { return this.source.actor.permissions.includes('*'); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> { const run = this.chain.then(work, work); this.chain = run.catch(() => undefined); return run; }

  /** Per scope: entries whose status is deleted/tombstone (never search candidates), so the active count of a scope is O(1). */
  private readonly inactive = new Map<string, number>();
  private static readonly isInactive = (e: ManifestEntry): boolean => e.status === 'deleted' || e.status === 'tombstone';
  /** Entries a search without metadata filters would examine in the given scopes. Exact, O(scopes). */
  activeCount(scopes: Iterable<string>): number { let n = 0; for (const sk of scopes) n += (this.byScope.get(sk)?.size ?? 0) - (this.inactive.get(sk) ?? 0); return n; }
  private titleBlob?: { generation: number; ids: string[]; lower?: { text: string; starts: Float64Array }; raw?: { text: string; starts: Float64Array } };
  private static joinTitles(titles: string[]): { text: string; starts: Float64Array } { const starts = new Float64Array(titles.length); let at = 0; for (let i = 0; i < titles.length; i++) { starts[i] = at; at += titles[i]!.length + 1; } return { text: titles.join('\u0000'), starts }; }
  /**
   * Ids of entries whose title contains `term` (already lower-cased unless caseSensitive), identical to filtering every entry with its own lower-cased
   * title, but as one substring scan over a joined blob that is rebuilt only when the manifest changed. A term containing NUL cannot be searched in the blob.
   */
  titleIds(term: string, caseSensitive: boolean): Set<string> {
    const found = new Set<string>();
    if (!term || term.includes('\u0000')) { for (const e of this.entries.values()) if ((caseSensitive ? e.title : e.title.toLocaleLowerCase()).includes(term)) found.add(e.id); return found; }
    let blob = this.titleBlob; if (!blob || blob.generation !== this.orderGeneration) blob = this.titleBlob = { generation: this.orderGeneration, ids: [...this.entries.keys()] };
    const joined = caseSensitive ? (blob.raw ??= Manifest.joinTitles([...this.entries.values()].map(e => e.title))) : (blob.lower ??= Manifest.joinTitles([...this.entries.values()].map(e => e.title.toLocaleLowerCase())));
    const { text, starts } = joined;
    for (let from = text.indexOf(term); from >= 0;) {
      let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (starts[mid]! <= from) lo = mid; else hi = mid - 1; }
      found.add(blob.ids[lo]!); if (lo + 1 >= starts.length) break; from = text.indexOf(term, starts[lo + 1]!);
    }
    return found;
  }

  private remove(id: string): void {
    const old = this.entries.get(id); if (!old) return;
    this.orderGeneration++;
    if (Manifest.isInactive(old)) this.inactive.set(old.sk, (this.inactive.get(old.sk) ?? 1) - 1);
    this.entries.delete(id); this.byScope.get(old.sk)?.delete(id);
    for (const [, target] of old.refs) { const set = this.referencedBy.get(target); set?.delete(id); if (set && !set.size) this.referencedBy.delete(target); }
  }
  private put(entry: ManifestEntry): void {
    this.remove(entry.id); this.orderGeneration++; this.entries.set(entry.id, entry); if (Manifest.isInactive(entry)) this.inactive.set(entry.sk, (this.inactive.get(entry.sk) ?? 0) + 1);
    let scoped = this.byScope.get(entry.sk); if (!scoped) { scoped = new Set(); this.byScope.set(entry.sk, scoped); } scoped.add(entry.id);
    for (const [, target] of entry.refs) { let set = this.referencedBy.get(target); if (!set) { set = new Set(); this.referencedBy.set(target, set); } set.add(entry.id); }
  }
  /** Lazily built, journal-invalidated ordering for recent/timeline queries; disposable and actor-local. */
  orderedByTime(descending = true): readonly ManifestEntry[] {
    if (!this.recentOrder || this.recentOrder.generation !== this.orderGeneration) {
      const descendingEntries = [...this.entries.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      this.recentOrder = { generation: this.orderGeneration, descending: descendingEntries, ascending: [...descendingEntries].reverse() };
    }
    return descending ? this.recentOrder.descending : this.recentOrder.ascending;
  }
  static fromDocument(doc: Document, first: number, last: number): ManifestEntry {
    const headings = headingText(doc.body); return { id: doc.id, rev: doc.revisionId, first, last, scope: doc.scope, sk: scopeKey(doc.scope), kind: doc.kind, title: doc.title, tags: doc.tags, status: doc.status, updated: doc.updatedAt, at: typeof doc.metadata.eventTime === 'string' ? doc.metadata.eventTime : doc.createdAt, ...(typeof doc.metadata.sessionId === 'string' ? { sid: doc.metadata.sessionId } : {}), ...(typeof doc.metadata.hostSessionId === 'string' ? { hs: doc.metadata.hostSessionId } : {}), ...(typeof doc.metadata.eventType === 'string' ? { et: doc.metadata.eventType } : {}), ...(typeof doc.metadata.speaker === 'string' ? { sp: doc.metadata.speaker } : {}), ...(typeof doc.metadata.preferenceKey === 'string' ? { pk: doc.metadata.preferenceKey } : {}), ...(typeof doc.metadata.evidenceClass === 'string' ? { ec: doc.metadata.evidenceClass } : {}), ...(typeof doc.metadata.category === 'string' ? { cat: doc.metadata.category } : {}), ...(typeof doc.metadata.domain === 'string' ? { dom: doc.metadata.domain } : {}), ...(doc.metadata.explicitPreference === true || doc.metadata.evidenceClass === 'explicit' ? { ex: true } : {}), refs: [...doc.links.map(l => [l.type, l.target] as [string, string]), ...bodyReferences(doc.body)], ...(headings === undefined ? {} : { hd: headings }) };
  }

  /** Applies every readable journal record newer than the manifest. Always completes before a query uses the manifest, so it can never be stale. */
  sync(): Promise<number> {
    return this.exclusive(async () => {
      const fresh = await this.source.journalSince(this.sequence);
      this.lastSyncChanged = 0; if (!fresh.length) return 0;
      const touched = new Map<string, { first: number; last: number; purged: boolean; scope: Scope }>();
      for (const event of fresh) {
        const known = touched.get(event.objectId) ?? { first: this.entries.get(event.objectId)?.first ?? this.pendingFirst(event.objectId) ?? event.sequence, last: 0, purged: false, scope: event.scope };
        if (!event.previousRevisionId && !this.entries.has(event.objectId) && event.operation !== 'purge') known.first = event.sequence;
        known.last = event.sequence; if (event.operation === 'purge') known.purged = true;
        touched.set(event.objectId, known);
      }
      const ids = [...touched.keys()];
      for (let offset = 0; offset < ids.length; offset += 64) {
        await Promise.all(ids.slice(offset, offset + 64).map(async id => {
          const meta = touched.get(id)!;
          if (meta.purged) { this.remove(id); this.forgetPending(id); return; }
          try { this.put(Manifest.fromDocument(await this.source.get(id), meta.first, meta.last)); this.forgetPending(id); }
          catch { this.remove(id); this.remember(id, meta); /* unreadable now: pick it up if the scope is granted later */ }
        }));
      }
      const last = fresh.at(-1)!; this.sequence = last.sequence; this.lastTx = last.transactionId; this.lastSyncChanged = ids.length;
      return ids.length;
    });
  }

  private pendingFirst(id: string): number | undefined { for (const group of this.pending.values()) { const hit = group.ids.get(id); if (hit) return hit.first; } return undefined; }
  private forgetPending(id: string): void { for (const [sk, group] of this.pending) { group.ids.delete(id); if (!group.ids.size) this.pending.delete(sk); } }
  private remember(id: string, meta: { first: number; last: number; scope: Scope }): void { const sk = scopeKey(meta.scope); let group = this.pending.get(sk); if (!group) { group = { scope: meta.scope, ids: new Map() }; this.pending.set(sk, group); } group.ids.set(id, { first: meta.first, last: meta.last }); }
  /** Fetches objects whose scope has become readable since they were skipped. */
  private refreshPending(allowed: Set<string>): Promise<void> {
    return this.exclusive(async () => {
      for (const [sk, group] of [...this.pending]) {
        if (!allowed.has(sk) && !(await this.source.canAccess(group.scope, 'read'))) continue;
        for (const [id, meta] of [...group.ids]) { try { this.put(Manifest.fromDocument(await this.source.get(id), meta.first, meta.last)); group.ids.delete(id); } catch { /* still unreadable */ } }
        if (!group.ids.size) this.pending.delete(sk);
      }
    });
  }

  /** Owner-only: derived file next to the other indexes, replaced atomically. Safe to delete at any time. */
  save(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.isOwner()) return;
      const lines = [JSON.stringify({ v: 4, hd: 1, sequence: this.sequence, lastTx: this.lastTx, count: this.entries.size })];
      for (const entry of this.entries.values()) lines.push(JSON.stringify(entry));
      await atomicWrite(this.source.root, FILE, lines.join('\n') + '\n'); this.persisted = true;
    });
  }
  /** Loads the persisted manifest if it provably belongs to this journal; otherwise starts empty. */
  load(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.entries.size) return false;
      let text: string; try { text = await fs.readFile(await safePath(this.source.root, FILE), 'utf8'); } catch { return false; }
      try {
        const lines = text.split('\n').filter(Boolean); const header = JSON.parse(lines[0]!) as { v: number; hd?: number; sequence: number; lastTx: string; count: number };
        if (header.v !== 4 || header.hd !== 1 || !Number.isSafeInteger(header.sequence) || header.count !== lines.length - 1) return false;
        // The manifest must have been built from THIS journal: the record at its sequence has to carry the recorded transaction id.
        const anchor = header.sequence ? (await this.source.journalSince(header.sequence - 1))[0] : undefined;
        if (header.sequence && (anchor?.sequence !== header.sequence || anchor.transactionId !== header.lastTx)) return false;
        const loaded: ManifestEntry[] = lines.slice(1).map(line => JSON.parse(line) as ManifestEntry);
        if (loaded.some(e => typeof e.id !== 'string' || typeof e.rev !== 'string' || !e.scope || typeof e.sk !== 'string')) return false;
        for (const entry of loaded) this.put(entry);
        this.sequence = header.sequence; this.lastTx = header.lastTx; this.loadedFromDisk = true; this.persisted = true; return true;
      } catch { this.entries.clear(); this.byScope.clear(); this.referencedBy.clear(); this.inactive.clear(); this.sequence = 0; this.lastTx = ''; return false; }
    });
  }
  async drop(): Promise<void> { await fs.rm(path.join(this.source.root, FILE), { force: true }); this.persisted = false; }

  /** Scopes the actor may read right now (ACL files are consulted per query, never cached across queries). */
  async readableScopes(): Promise<Set<string>> {
    if (this.pending.size) await this.refreshPending(new Set());
    const allowed = new Set<string>();
    await Promise.all([...this.byScope.entries()].filter(([, ids]) => ids.size).map(async ([sk, ids]) => { const id = ids.values().next().value as string; if (await this.source.canAccess(this.entries.get(id)!.scope, 'read')) allowed.add(sk); }));
    return allowed;
  }
  uri(entry: ManifestEntry): string { return documentUri(entry.id, entry.scope); }
  idFromReference(reference: string): string { return objectIdFromUri(reference); }
}

const managers = new WeakMap<object, Promise<Manifest>>();
/** One manifest per vault object (and therefore per actor); built lazily and reused by every engine on that vault. */
export function manifestFor(source: ManifestSource): Promise<Manifest> {
  let existing = managers.get(source);
  if (!existing) { existing = (async () => { const manifest = new Manifest(source); await manifest.load(); const before = manifest.entries.size; const changed = await manifest.sync(); if (source.actor.permissions.includes('*') && (!manifest.loadedFromDisk || changed > Math.max(500, before / 20))) await manifest.save().catch(() => undefined); return manifest; })(); managers.set(source, existing); existing.catch(() => managers.delete(source)); }
  return existing;
}
