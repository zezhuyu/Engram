import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ProviderError } from '../models/errors.js';
import { MDBError, type ActorContext, type Document, type EmbeddingProvider, type SearchInput } from '../core/types.js';
import { safePath } from '../storage-local/index.js';
import { lineOffset, mapBodyLines, scopeMatches, type SearchVault } from '../search-files/index.js';
import { manifestFor, type ManifestEntry } from '../search-files/manifest.js';
import { metadataMatches } from '../search-files/retrieve.js';
import { CHUNKER_VERSION, chunkDocument } from './chunk.js';
import { createBuiltinEmbedder, createEmbedder, describeEmbedding } from './embedder.js';
import { builtinModelStatus } from './builtin-model.js';
import { ensureVectorSchema, normalize, readVecState, scanBest, scanBestVec, toBlob, writeVecState, type VecRow } from './store.js';

export interface VectorStatus { ready: boolean; reason?: string; model?: string; dimensions?: number; backend?: string; sqlite: boolean; embedding: { configured: boolean; available: boolean; model?: string; locality?: string; reason?: string }; buckets: number; embeddedBuckets: number }
export interface SyncReport { buckets: number; embeddedObjects: number; embeddedChunks: number; removedObjects: number; skippedPrivate: number; model: string; dimensions: number }
export interface SemanticMatch extends VecRow { entry: ManifestEntry }
const EXT_ENV = 'ENGRAM_SQLITE_VEC';

/**
 * Semantic retrieval backend. It exists only when ALL of these hold: the SQLite index is enabled, an embedding provider is configured and constructible, and the
 * vector tables in the index databases carry that provider's model. Anything else makes it unavailable, with the reason; keyword, grep and regex never depend on it.
 */
export class VectorBackend {
  private vecLoaded?: boolean;
  private builtinEmbedder?: Awaited<ReturnType<typeof createBuiltinEmbedder>>;
  constructor(private readonly vault: SearchVault, private readonly options: { embedder?: EmbeddingProvider; env?: Record<string, string | undefined>; ensureFresh?: () => Promise<unknown> } = {}) {}
  private env() { return this.options.env ?? process.env; }
  private async embedder(): Promise<EmbeddingProvider> { if (this.options.embedder) return this.options.embedder; const config = (await this.vault.config()).embedding; if (config?.provider === 'builtin') return this.builtinEmbedder ??= await createBuiltinEmbedder(config, { env: this.env() }); return createEmbedder(config, this.env()); }
  async close(): Promise<void> { const embedder = this.builtinEmbedder; this.builtinEmbedder = undefined; await embedder?.close(); }
  bucketPath(scope: ManifestEntry['scope']): string { return path.join(this.vault.root, '.mdb', 'indexes', scope.type === 'workspace' ? `workspace-${scope.workspaceId}.sqlite` : 'global.sqlite'); }

  private async open(file: string, write: boolean): Promise<DatabaseSync> {
    await safePath(this.vault.root, path.relative(this.vault.root, file));
    const { DatabaseSync } = await import('node:sqlite');
    const wantVec = !write && (await this.vault.config()).embedding?.sqliteVec;
    const db = new DatabaseSync(file, { readOnly: !write, ...(wantVec ? { allowExtension: true } : {}) });
    if (wantVec) { try { await this.loadVec(db, wantVec); } catch { this.vecLoaded = false; } }
    return db;
  }
  private async loadVec(db: DatabaseSync, setting: string | true): Promise<void> {
    let ext = typeof setting === 'string' ? setting : this.env()[EXT_ENV];
    if (!ext) { try { const mod = await import(/* @vite-ignore */ 'sqlite-vec' as string) as { getLoadablePath?: () => string }; ext = mod.getLoadablePath?.(); } catch { /* package not installed */ } }
    if (!ext) { this.vecLoaded = false; return; }
    db.enableLoadExtension(true); db.loadExtension(ext); db.enableLoadExtension(false); db.prepare("SELECT vec_version()").get(); this.vecLoaded = true;
  }

  /** Readiness without any network call. */
  async status(): Promise<VectorStatus> {
    const config = await this.vault.config(); const testWorker = process.env.NODE_ENV === 'test' && !!process.env.ENGRAM_BUILTIN_WORKER_PATH; const builtin = config.embedding?.provider === 'builtin' ? testWorker ? { state: 'ready' as const } : await builtinModelStatus({ env: this.env() }) : undefined; const embedding = this.options.embedder ? { configured: true, available: true, model: this.options.embedder.modelId, locality: this.options.embedder.locality ?? 'local' } : config.embedding?.provider === 'builtin' ? { configured: true, available: builtin?.state === 'ready', model: `builtin:bge-m3@4de13258303883538bd53b696b452bf8099f0858`, locality: 'local', ...(builtin?.state === 'ready' ? {} : { reason: 'Built-in bge-m3 is not installed' }) } : describeEmbedding(config.embedding, this.env());
    const base = { sqlite: !!config.sqlite.enabled, embedding, buckets: 0, embeddedBuckets: 0 };
    if (!config.sqlite.enabled) return { ready: false, reason: 'Semantic and hybrid search need the SQLite index (sqlite.enabled: true); keyword, grep and regex are unaffected', ...base };
    if (!embedding.configured) return { ready: false, reason: embedding.reason!, ...base };
    if (!embedding.available) return { ready: false, reason: `Embedding provider unavailable: ${embedding.reason}`, ...base };
    // readiness is a property of the index, not of who asks: the database files are listed, the actor's rights only matter when a query filters rows
    const dir = path.join(this.vault.root, '.mdb', 'indexes'); const files = new Set((await fsp.readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.sqlite')).map(f => path.join(dir, f)));
    let embedded = 0, dims: number | undefined; const model = embedding.model;
    for (const file of files) { let db: DatabaseSync | undefined; try { db = await this.open(file, false); const st = readVecState(db); if (st && st.model === model && st.chunker === CHUNKER_VERSION) { embedded++; dims = st.dimensions; } } catch { /* missing or unreadable index: not embedded */ } finally { db?.close(); } }
    if (!embedded) return { ready: false, reason: `No vectors for ${model} yet: run "mdb embed sync" (the SQLite index must exist first)`, ...base, buckets: files.size };
    return { ready: true, model, dimensions: dims!, backend: this.vecLoaded ? 'sqlite-vec' : 'sqlite-blob-scan', ...base, buckets: files.size, embeddedBuckets: embedded };
  }

  /** Embeds every indexed document revision that has no vectors yet and removes vectors of revisions that no longer exist. Owner only; never touches canonical files. */
  async sync(options: { signal?: AbortSignal; maxObjects?: number } = {}): Promise<SyncReport> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Embedding maintenance requires trusted owner identity');
    const config = await this.vault.config(); if (!config.sqlite.enabled) throw new MDBError('CAPABILITY_UNAVAILABLE', 'Semantic indexing needs the SQLite index (sqlite.enabled: true)');
    const embedder = await this.embedder(); await this.options.ensureFresh?.();
    const remote = (embedder.locality ?? 'local') === 'remote' && !config.embedding?.allowPrivateContentToRemote;
    const dir = path.join(this.vault.root, '.mdb', 'indexes'); const files = (await fsp.readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.sqlite')).sort();
    const report: SyncReport = { buckets: 0, embeddedObjects: 0, embeddedChunks: 0, removedObjects: 0, skippedPrivate: 0, model: embedder.modelId, dimensions: embedder.dimensions };
    let budget = options.maxObjects ?? Infinity;
    for (const f of files) {
      if (options.signal?.aborted) break; let db: DatabaseSync | undefined;
      try {
        db = await this.open(path.join(dir, f), true); ensureVectorSchema(db);
        const st = readVecState(db); if (st && (st.model !== embedder.modelId || st.chunker !== CHUNKER_VERSION || (embedder.dimensions && st.dimensions !== embedder.dimensions))) { db.exec('DELETE FROM vec_chunks; DELETE FROM vec_state'); } // a different model's vectors are never mixed in
        const docs = db.prepare('SELECT object_id AS id, revision_id AS rev, workspace_id AS ws, title, body FROM documents').all() as Array<{ id: string; rev: string; ws: string | null; title: string; body: string }>;
        const have = new Set((db.prepare('SELECT DISTINCT object_id || char(1) || revision_id AS k FROM vec_chunks').all() as Array<{ k: string }>).map(r => r.k));
        const live = new Set(docs.map(d => `${d.id}\u0001${d.rev}`));
        const stale = [...have].filter(k => !live.has(k)); if (stale.length) { const del = db.prepare('DELETE FROM vec_chunks WHERE object_id=? AND revision_id=?'); db.exec('BEGIN'); for (const k of stale) { const [id, rev] = k.split('\u0001'); del.run(id!, rev!); } db.exec('COMMIT'); report.removedObjects += new Set(stale.map(k => k.split('\u0001')[0])).size; }
        const pending = docs.filter(d => !have.has(`${d.id}\u0001${d.rev}`));
        const todo = pending.filter(d => { if (remote && d.ws !== null) { report.skippedPrivate++; return false; } return true; });
        report.buckets++;
        for (let i = 0; i < todo.length && budget > 0; i += 16) {
          if (options.signal?.aborted) break;
          const batch = todo.slice(i, Math.min(todo.length, i + 16, i + budget)); const chunks = batch.map(d => chunkDocument(d.title, d.body)); const texts = chunks.flat().map(c => c.text);
          const vectors = await embedder.embed(texts, options.signal ? { signal: options.signal } : {});
          if (vectors.length !== texts.length) throw new MDBError('INVALID_MODEL_OUTPUT', 'Embedding provider returned the wrong number of vectors');
          const dims = vectors[0]?.length ?? embedder.dimensions; if (!dims || vectors.some(v => v.length !== dims)) throw new MDBError('INVALID_MODEL_OUTPUT', 'Embedding provider returned vectors of inconsistent size');
          const put = db.prepare('INSERT OR REPLACE INTO vec_chunks VALUES(?,?,?,?,?,?)'); let k = 0;
          db.exec('BEGIN IMMEDIATE'); // all chunks of a batch commit together, so a crash leaves whole documents with vectors or none
          try { batch.forEach((d, j) => { for (const c of chunks[j]!) put.run(d.id, d.rev, c.index, c.lineStart, c.lineEnd, toBlob(normalize(vectors[k++]!))); }); writeVecState(db, { model: embedder.modelId, dimensions: dims, chunker: CHUNKER_VERSION }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
          report.embeddedObjects += batch.length; report.embeddedChunks += texts.length; report.dimensions = dims; budget -= batch.length;
        }
        if (!todo.length && !readVecState(db) && !docs.length) writeVecState(db, { model: embedder.modelId, dimensions: embedder.dimensions || 1, chunker: CHUNKER_VERSION });
      } finally { db?.close(); }
    }
    return report;
  }

  /** Removes every vector (owner only). Keyword, grep and regex are unaffected. */
  async clear(): Promise<{ buckets: number }> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Embedding maintenance requires trusted owner identity');
    const dir = path.join(this.vault.root, '.mdb', 'indexes'); let buckets = 0;
    for (const f of (await fsp.readdir(dir).catch(() => [] as string[])).filter(x => x.endsWith('.sqlite'))) { let db: DatabaseSync | undefined; try { db = await this.open(path.join(dir, f), true); db.exec('DROP TABLE IF EXISTS vec_chunks; DROP TABLE IF EXISTS vec_state'); buckets++; } finally { db?.close(); } }
    return { buckets };
  }
  /** Top semantic matches the actor may read, best chunk per object, no similarity cut-off (ranking only). */
  async search(input: SearchInput, actor: ActorContext, topN: number): Promise<{ matches: SemanticMatch[]; lagObjects: number; status: VectorStatus; embedder: EmbeddingProvider }> {
    if (actor.actorId !== this.vault.actor.actorId) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Search identity must match the trusted vault identity');
    const status = await this.status(); if (!status.ready) throw new MDBError('CAPABILITY_UNAVAILABLE', status.reason ?? 'Semantic search is unavailable');
    const embedder = await this.embedder(); let qvec: number[];
    try { qvec = (await embedder.embed([input.query.slice(0, 2000)]))[0]!; } catch (e) { throw new MDBError('CAPABILITY_UNAVAILABLE', `Embedding provider unavailable: ${e instanceof ProviderError || e instanceof MDBError ? e.message : 'the embedding request failed'}`); } // only messages written by this codebase are shown; raw errors may carry credentials
    const qv = normalize(qvec); if (status.dimensions && qv.length !== status.dimensions) throw new MDBError('CAPABILITY_UNAVAILABLE', 'The query embedding does not match the indexed dimensions; run "mdb embed rebuild"');
    const manifest = await manifestFor(this.vault); await manifest.sync(); const allowed = await manifest.readableScopes(); const filters = input.scopes?.length ? input.scopes : undefined;
    const visible = new Map<string, ManifestEntry>(); const buckets = new Map<string, Set<string>>();
    for (const sk of allowed) for (const id of manifest.byScope.get(sk) ?? []) { const e = manifest.entries.get(id)!; if ((!filters || filters.some(s => scopeMatches(e.scope, s))) && metadataMatches(input, e)) { visible.set(id, e); const b = this.bucketPath(e.scope); (buckets.get(b) ?? buckets.set(b, new Set()).get(b)!).add(id); } }
    const seen = new Set<string>(); const found: VecRow[] = [];
    for (const [file] of buckets) {
      let db: DatabaseSync | undefined;
      try {
        db = await this.open(file, false); const st = readVecState(db); if (!st || st.model !== status.model || st.dimensions !== qv.length) continue;
        const accept = (id: string, rev: string) => visible.get(id)?.rev === rev; // revision-aware and ACL-aware: only the current revision of an object the actor can read
        found.push(...(this.vecLoaded ? scanBestVec(db, qv, accept, topN, seen) : scanBest(db, qv, accept, topN, seen)));
      } catch { /* an unreadable bucket just contributes nothing; lag reports the objects without vectors */ } finally { db?.close(); }
    }
    found.sort((a, b) => b.similarity - a.similarity || a.objectId.localeCompare(b.objectId));
    return { matches: found.slice(0, topN).map(r => ({ ...r, entry: visible.get(r.objectId)! })), lagObjects: visible.size - seen.size, status: { ...status, backend: this.vecLoaded ? 'sqlite-vec' : 'sqlite-blob-scan' }, embedder };
  }

  /** Reads the current revision through the Vault (ACL re-check) and rebuilds the matching chunk's text; a revision that moved on since indexing is dropped. */
  async materialize(match: SemanticMatch): Promise<{ doc: Document; snippet: string; lineStart: number; lineEnd: number } | undefined> {
    let doc: Document; try { doc = await this.vault.get(match.objectId); } catch { return undefined; }
    if (doc.revisionId !== match.revisionId || doc.status === 'deleted' || doc.status === 'tombstone') return undefined;
    const chunk = chunkDocument(doc.title, doc.body)[match.chunk]; await mapBodyLines(this.vault, [doc]); const off = lineOffset(doc);
    const text = chunk ? chunk.text.slice(doc.title.length + 1) : doc.body; return { doc, snippet: text.trim().slice(0, 600), lineStart: match.lineStart + off, lineEnd: match.lineEnd + off };
  }
}
