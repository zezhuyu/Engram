import { mkdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { safePath } from '../storage-local/index.js';
import { refreshNavigation } from '../search-files/navigation.js';
import { MDBError } from '../core/types.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext, Document, Scope, SearchIndexAdapter, SearchInput, SearchResult } from '../core/types.js';
import { authorizedDocuments, FilesystemSearch, mapBodyLines, searchDocuments, type SearchVault } from '../search-files/index.js';
import { manifestFor, type ManifestEntry } from '../search-files/manifest.js';
import { buildFsIndex, fsIndexStatus } from '../search-files/postings.js';
import { combine, distinctTerms, retrieve, ripgrepAvailable, scanFiles, textSpec, titleMatches, type Prefilter } from '../search-files/retrieve.js';
import { profileAsync, profileSync } from '../bench/instrumentation.js';
import { assertAvailableStorage, assertStorageQuota } from '../core/storage-lifecycle.js';
import { VectorBackend, type SemanticMatch } from '../search-semantic/backend.js';
import type { EmbeddingProvider } from '../core/types.js';
import { PostgresSearch } from '../search-postgres/index.js';

const AUTO_INDEX_REFRESH_EVENTS = 256;
const AUTO_FS_INDEX_MIN_DOCUMENTS = 200;
const autoFsIndexBuilds = new Map<string, Promise<void>>();
const sqliteAutoSyncs = new Map<string, { engine: SQLiteSearch; rerun: boolean }>();
type ReadHandle = { database: DatabaseSync; identity: string };
const sqliteReadHandles = new Map<string, ReadHandle>();
const SQLITE_READ_HANDLE_LIMIT = 64;

/** SQLite is disposable. Every candidate is intersected with authorized current revisions. */
export class SQLiteSearch implements SearchIndexAdapter {
  private unavailable?: string;
  private readonly files: FilesystemSearch;
  constructor(public readonly vault: SearchVault) { this.files = new FilesystemSearch(vault); }
  capabilities(): Record<string, boolean> { return { ...this.files.capabilities(), sqlite: !this.unavailable, fts5: !this.unavailable }; }
  private filename(doc: Document): string { return join(this.vault.root, '.mdb', 'indexes', doc.scope.type === 'workspace' ? `workspace-${doc.scope.workspaceId}.sqlite` : 'global.sqlite'); }
  private async open(path: string, create: boolean): Promise<DatabaseSync> {
    await safePath(this.vault.root, relative(this.vault.root, path));
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path, { readOnly: !create });
    try {
      if (create) database.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS documents(object_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, workspace_id TEXT, collection_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(object_id UNINDEXED,title,body,tokenize='unicode61',prefix='2 3');
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(object_id UNINDEXED,title,body,tokenize='trigram');
        CREATE TABLE IF NOT EXISTS edges(from_id TEXT NOT NULL,to_uri TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(from_id,to_uri,relation));
        CREATE TABLE IF NOT EXISTS index_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      // Cheap open probe: count(*) on an FTS5 table walks the whole docsize b-tree (about 160 ms per 5k-row bucket at 100k documents).
      else { database.prepare('SELECT rowid FROM documents_fts LIMIT 1').get(); database.prepare('SELECT rowid FROM documents_trigram LIMIT 1').get(); }
      return database;
    } catch (error) { database.close(); throw error; }
  }
  /**
   * Reuse bounded read-only SQLite connections between queries. SQLite reads
   * remain statement-scoped, so each statement observes the latest committed
   * WAL state. The inode check detects atomic replacement after corruption or
   * rebuild, and safePath is still checked on every acquisition.
   */
  private async openReadOnly(path: string): Promise<DatabaseSync> {
    await safePath(this.vault.root, relative(this.vault.root, path));
    for (let attempt = 0; attempt < 2; attempt++) {
      let fileIdentity: string;
      try { const info = await stat(path, { bigint: true }); fileIdentity = `${info.dev}:${info.ino}`; }
      catch (error) { const stale = sqliteReadHandles.get(path); if (stale) { sqliteReadHandles.delete(path); stale.database.close(); } throw error; }
      const cached = sqliteReadHandles.get(path);
      if (cached?.identity === fileIdentity) {
        sqliteReadHandles.delete(path); sqliteReadHandles.set(path, cached);
        return cached.database;
      }
      if (cached) { sqliteReadHandles.delete(path); cached.database.close(); }

      const database = await this.open(path, false);
      let afterOpenIdentity: string | undefined;
      try { const info = await stat(path, { bigint: true }); afterOpenIdentity = `${info.dev}:${info.ino}`; } catch { /* replaced or removed during open */ }
      if (afterOpenIdentity !== fileIdentity) { database.close(); continue; }
      // Another concurrent query may have populated the cache while this call
      // awaited filesystem/SQLite open. Prefer its connection and close ours.
      const raced = sqliteReadHandles.get(path);
      if (raced?.identity === fileIdentity) { database.close(); sqliteReadHandles.delete(path); sqliteReadHandles.set(path, raced); return raced.database; }
      sqliteReadHandles.set(path, { database, identity: fileIdentity });
      while (sqliteReadHandles.size > SQLITE_READ_HANDLE_LIMIT) {
        const oldest = sqliteReadHandles.entries().next().value as [string, ReadHandle] | undefined;
        if (!oldest) break;
        sqliteReadHandles.delete(oldest[0]); oldest[1].database.close();
      }
      return database;
    }
    throw new Error('SQLite index changed repeatedly while opening');
  }
  private readonly bucketPaths = new Map<string, string>();
  /** Memoized per scope: prefilter maps every manifest entry to its bucket, and path.join per entry cost about 50 ms at 100k documents. */
  private bucketPath(scope: Scope): string {
    const key = scope.type === 'workspace' ? `w:${scope.workspaceId}` : 'g';
    let path = this.bucketPaths.get(key);
    if (path === undefined) { path = join(this.vault.root, '.mdb', 'indexes', scope.type === 'workspace' ? `workspace-${scope.workspaceId}.sqlite` : 'global.sqlite'); this.bucketPaths.set(key, path); }
    return path;
  }
  private static readCheckpoint(database: DatabaseSync): number | undefined {
    const get = (key: string) => (database.prepare('SELECT value FROM index_state WHERE key=?').get(key) as { value: string } | undefined)?.value;
    if (get('schema_version') !== '2') return undefined;
    const value = Number(get('journal_sequence')); return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  private static writeRow(database: DatabaseSync, doc: Document): void {
    const result = database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').run(doc.id, doc.revisionId, doc.scope.type === 'workspace' ? doc.scope.workspaceId : null, doc.scope.type === 'workspace' ? doc.scope.collectionId ?? null : null, doc.kind, doc.title, doc.body, doc.updatedAt);
    // FTS rows share the documents rowid so they can be deleted by rowid (a scan-free primary-key operation).
    const rowid = result.lastInsertRowid;
    database.prepare('INSERT INTO documents_fts(rowid,object_id,title,body) VALUES(?,?,?,?)').run(rowid, doc.id, doc.title, doc.body);
    database.prepare('INSERT INTO documents_trigram(rowid,object_id,title,body) VALUES(?,?,?,?)').run(rowid, doc.id, doc.title, doc.body);
    for (const link of doc.links) database.prepare('INSERT OR IGNORE INTO edges VALUES(?,?,?)').run(doc.id, link.target, link.type);
  }

  /**
   * Query paths must never perform a bulk index sync inline. The journal overlay
   * already makes every committed change visible; this coalesced maintenance
   * task catches the disposable index up after the response has been formed.
   * SQLite serializes concurrent processes at its transaction boundary, while
   * this map prevents duplicate work inside one process.
   */
  private scheduleAutoSync(): void {
    if (!this.vault.actor.permissions.includes('*')) return;
    const key = this.vault.root;
    const current = sqliteAutoSyncs.get(key);
    if (current) { current.rerun = true; return; }
    const state = { engine: this, rerun: false };
    sqliteAutoSyncs.set(key, state);
    setImmediate(() => {
      void (async () => {
        try {
          do { state.rerun = false; await state.engine.sync(); } while (state.rerun);
        } catch { /* stale index is safe: the next query overlays from the committed manifest */ }
        finally { if (sqliteAutoSyncs.get(key) === state) sqliteAutoSyncs.delete(key); }
      })();
    });
  }
  private static deleteRow(database: DatabaseSync, objectId: string): void {
    const row = database.prepare('SELECT rowid AS r FROM documents WHERE object_id=?').get(objectId) as { r: number } | undefined; if (!row) return;
    database.prepare('DELETE FROM documents_fts WHERE rowid=?').run(row.r); database.prepare('DELETE FROM documents_trigram WHERE rowid=?').run(row.r);
    database.prepare('DELETE FROM edges WHERE from_id=?').run(objectId); database.prepare('DELETE FROM documents WHERE rowid=?').run(row.r);
  }

  /** Full rebuild from canonical revisions. The checkpoint is read BEFORE documents are listed, so rows are never older than the checkpoint claims. */
  async rebuild(scope?: Scope): Promise<void> { return profileAsync('sqlite.rebuild', () => this.rebuildUnprofiled(scope)); }
  private async rebuildUnprofiled(scope?: Scope): Promise<void> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'SQLite maintenance requires trusted owner identity');
    await assertAvailableStorage(this.vault.root);
    const manifest = await manifestFor(this.vault); await manifest.sync(); const checkpoint = manifest.sequence;
    const documents = await authorizedDocuments(this.vault, { query: '' }, this.vault.actor);
    const buckets = new Map<string, Document[]>();
    for (const doc of documents) { const path = this.bucketPath(doc.scope); if (!buckets.has(path)) buckets.set(path, []); buckets.get(path)!.push(doc); }
    // Include accessible empty global index so a rebuild removes old rows.
    if (!buckets.size) buckets.set(join(this.vault.root, '.mdb', 'indexes', 'global.sqlite'), []);
    await mkdir(join(this.vault.root, '.mdb', 'indexes'), { recursive: true });
    for (const [path, docs] of buckets) {
      if (scope && docs.length && !docs.some(doc => scope.type === 'global' ? doc.scope.type === 'global' : doc.scope.type === 'workspace' && doc.scope.workspaceId === scope.workspaceId)) continue;
      const estimatedBytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.title) + Buffer.byteLength(doc.body) + 2048, 4096);
      await assertAvailableStorage(this.vault.root, process.env, estimatedBytes);
      await assertStorageQuota('index-scratch', join(this.vault.root, '.mdb', 'indexes'), estimatedBytes);
      // The index is disposable: a corrupt or truncated database file is replaced, never repaired in place.
      const database = await this.open(path, true).catch(async error => { if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => rm(file, { force: true }))); return this.open(path, true); });
      try {
        database.exec('BEGIN IMMEDIATE; DELETE FROM documents; DELETE FROM documents_fts; DELETE FROM documents_trigram; DELETE FROM edges;');
        for (const doc of docs) SQLiteSearch.writeRow(database, doc);
        const state = database.prepare('INSERT OR REPLACE INTO index_state VALUES(?,?)');
        state.run('rebuilt_at', new Date().toISOString()); state.run('schema_version', '2'); state.run('journal_sequence', String(checkpoint));
        profileSync('sqlite.commit', () => database.exec('COMMIT'));
      } catch (error) { database.exec('ROLLBACK'); throw error; } finally { database.close(); }
    }
    await manifest.save().catch(() => undefined);
    this.unavailable = undefined;
  }

  /** Incremental maintenance: re-index only objects touched after each database's checkpoint, drop rows of purged or tombstoned objects, advance the checkpoint. */
  async sync(): Promise<{ databases: number; objects: number }> { return profileAsync('sqlite.sync', () => this.syncUnprofiled()); }
  private async syncUnprofiled(): Promise<{ databases: number; objects: number }> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'SQLite maintenance requires trusted owner identity');
    await assertAvailableStorage(this.vault.root);
    const manifest = await manifestFor(this.vault); await manifest.sync(); const target = manifest.sequence;
    const buckets = new Map<string, ManifestEntry[]>();
    for (const entry of manifest.entries.values()) { const path = this.bucketPath(entry.scope); (buckets.get(path) ?? buckets.set(path, []).get(path)!).push(entry); }
    let objects = 0, databases = 0; const needsRebuild: Scope[] = [];
    for (const [path, entries] of buckets) {
      let database: DatabaseSync; try { database = await this.open(path, true); } catch { continue; }
      try {
        const checkpoint = SQLiteSearch.readCheckpoint(database);
        if (checkpoint === undefined) { needsRebuild.push(entries[0]!.scope); continue; } // missing, wiped (e.g. by a purge) or old format: only a full rebuild can make it trustworthy
        const live = new Map(entries.filter(e => e.status !== 'deleted' && e.status !== 'tombstone').map(e => [e.id, e]));
        const indexed = new Set((database.prepare('SELECT object_id FROM documents').all() as { object_id: string }[]).map(r => r.object_id));
        const dirty = entries.filter(e => e.last > checkpoint && live.has(e.id));
        const docs: Document[] = []; for (const entry of dirty) { try { docs.push(await this.vault.get(entry.id)); } catch { /* purged since */ } }
        const estimatedBytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.title) + Buffer.byteLength(doc.body) + 2048, 4096);
        await assertAvailableStorage(this.vault.root, process.env, estimatedBytes);
        await assertStorageQuota('index-scratch', join(this.vault.root, '.mdb', 'indexes'), estimatedBytes);
        database.exec('BEGIN IMMEDIATE');
        for (const id of indexed) if (!live.has(id) || dirty.some(e => e.id === id)) SQLiteSearch.deleteRow(database, id);
        for (const doc of docs) if (doc.status !== 'deleted' && doc.status !== 'tombstone') SQLiteSearch.writeRow(database, doc);
        database.prepare('INSERT OR REPLACE INTO index_state VALUES(?,?)').run('journal_sequence', String(target));
        profileSync('sqlite.commit', () => database.exec('COMMIT')); objects += docs.length; databases++;
      } catch (error) { try { database.exec('ROLLBACK'); } catch { /* not in a transaction */ } throw error; } finally { database.close(); }
    }
    for (const scope of needsRebuild) { await this.rebuild(scope); databases++; objects += (buckets.get(this.bucketPath(scope)) ?? []).length; }
    return { databases, objects };
  }

  /**
   * Candidate selection from FTS5 / trigram, with a journal overlay. Per database: rows are trusted only up to the database's journal checkpoint;
   * every object touched after it is a candidate regardless of what the (stale) row says. A missing, corrupt, old-format or self-inconsistent
   * database sends just its own scope to the raw-file scan, and the result says so.
   */
  private readonly prefilter: Prefilter = async ({ vault, entries, input, actor }) => {
    const spec = textSpec(input);
    if (!spec) return { info: { textPrefilter: 'none' } };
    const terms = distinctTerms(spec);
    const ftsSafe = terms.every(term => Array.from(term).length >= 3);
    const owner = actor.permissions.includes('*');
    const buckets = new Map<string, ManifestEntry[]>();
    for (const entry of entries) { const path = this.bucketPath(entry.scope); (buckets.get(path) ?? buckets.set(path, []).get(path)!).push(entry); }
    const ids = new Set<string>(); const scanned: ManifestEntry[] = []; const notes: string[] = []; let lag = 0, fallbackScopes = 0;
    const ranks = new Map<string, number>(); const wordOnly = terms.every(term => /^[\p{L}\p{N} _-]+$/u.test(term));
    const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;
    const query = (database: DatabaseSync, checkpoint: number, bucket: Map<string, ManifestEntry>): { ids: Set<string>; consistent: boolean } => {
      const found = new Set<string>(); let consistent = true;
      const run = (table: string, match: string) => {
        for (const row of database.prepare(`SELECT d.object_id AS id, d.revision_id AS rev FROM ${table} t JOIN documents d ON d.rowid = t.rowid WHERE ${table} MATCH ?`).all(match) as { id: string; rev: string }[]) {
          const entry = bucket.get(row.id); found.add(row.id);
          if (entry && entry.last <= checkpoint && entry.rev !== row.rev) consistent = false; // row older than the journal says it can be
        }
      };
      run('documents_trigram', [...new Set(terms)].map(quote).join(' OR '));
      const wordTerms = terms.filter(term => /^[\p{L}\p{N} _-]+$/u.test(term));
      if (wordTerms.length) run('documents_fts', wordTerms.map(quote).join(' OR '));
      return { ids: found, consistent };
    };
    for (const [path, bucketEntries] of buckets) {
      if (!ftsSafe) { scanned.push(...bucketEntries); continue; }
      const byId = new Map(bucketEntries.map(e => [e.id, e]));
      let database: DatabaseSync | undefined; let checkpoint: number | undefined;
      try { database = await this.openReadOnly(path); checkpoint = SQLiteSearch.readCheckpoint(database); } catch { database = undefined; }
      if (!database || checkpoint === undefined) {
        database = undefined;
        // Missing indexes are served from canonical, currently authorized
        // revisions. Initialization is scheduled after query completion.
        scanned.push(...bucketEntries); fallbackScopes++; notes.push('index missing, corrupt or old format'); continue;
      }
      try {
        let dirty = bucketEntries.filter(e => e.last > checkpoint!);
        lag += dirty.length;
        const result = query(database, checkpoint!, byId);
        if (!result.consistent) { scanned.push(...bucketEntries); fallbackScopes++; notes.push('index rows disagree with the journal'); continue; }
        for (const id of result.ids) ids.add(id);
        for (const entry of dirty) ids.add(entry.id);
        if (wordOnly) { // BM25 over the word index; a title hit counts five times a body hit
          try { for (const row of database.prepare('SELECT d.object_id AS id, bm25(documents_fts, 0.0, 5.0, 1.0) AS r FROM documents_fts t JOIN documents d ON d.rowid = t.rowid WHERE documents_fts MATCH ?').all(terms.map(quote).join(' OR ')) as { id: string; r: number }[]) ranks.set(row.id, -row.r); } catch { /* ranking unavailable: lexical scorer ranks */ }
        }
      } catch { scanned.push(...bucketEntries); fallbackScopes++; notes.push('index unreadable'); }
      finally { /* cached read-only connection is bounded and reused */ }
    }
    if (scanned.length) {
      const byTerm = await scanFiles(vault.root, scanned, spec);
      for (const term of terms) { const set = byTerm.get(term) ?? new Set<string>(); for (const id of titleMatches(scanned, term, spec.caseSensitive)) set.add(id); byTerm.set(term, set); }
      for (const id of combine(spec, byTerm)) ids.add(id);
    }
    if (fallbackScopes) this.unavailable = notes[0]; else if (!scanned.length) this.unavailable = undefined;
    const allFellBack = fallbackScopes > 0 && fallbackScopes === buckets.size;
    // BM25 ranks are only used when the whole candidate set is covered by a consistent index (no lag, no file-scan fallback); substring-only matches rank below every word match.
    let finalRanks: Map<string, number> | undefined;
    if (wordOnly && !scanned.length && !fallbackScopes && lag === 0) { const floor = ([...ranks.values()].sort((a, b) => a - b)[0] ?? 0) - 1; finalRanks = new Map([...ids].map(id => [id, ranks.get(id) ?? floor] as [string, number])); }
    return { ids, ...(finalRanks ? { ranks: finalRanks } : {}), ...(allFellBack ? { backend: 'filesystem' } : {}), ...(fallbackScopes ? { fallback: `SQLite unavailable for ${fallbackScopes} scope(s): ${[...new Set(notes)].join('; ')}; served from canonical files` } : {}), info: { textPrefilter: scanned.length && ids.size ? (buckets.size > fallbackScopes || ftsSafe ? 'mixed' : 'file-scan') : 'fts5+trigram', lagObjects: lag, fallbackScopes } };
  };

  async query(input: SearchInput, actor: ActorContext = this.vault.actor): Promise<SearchResult> {
    if (input.includeHistory) { const documents = await authorizedDocuments(this.vault, input, actor); await mapBodyLines(this.vault, documents); return { ...searchDocuments(documents, input, 'filesystem'), fallback: 'History is read from canonical revisions' }; }
    const result = await retrieve(this.vault, input, actor, this.prefilter, 'sqlite');
    const index = (result as SearchResult & { index?: { entries?: number; lagObjects?: number; fallbackScopes?: number } }).index;
    if (actor.permissions.includes('*') && textSpec(input) && Number(index?.entries ?? 0) >= 200
      && (Number(index?.fallbackScopes ?? 0) > 0 || Number(index?.lagObjects ?? 0) > AUTO_INDEX_REFRESH_EVENTS)) this.scheduleAutoSync();
    return result;
  }
  async health(): Promise<Record<string, unknown>> {
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const databases: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const entry of manifest.entries.values()) {
      const path = this.bucketPath(entry.scope); if (seen.has(path)) continue; seen.add(path);
      let state: Record<string, unknown>; let database: DatabaseSync | undefined;
      try { database = await this.open(path, false); const checkpoint = SQLiteSearch.readCheckpoint(database); const lag = checkpoint === undefined ? null : [...manifest.entries.values()].filter(e => this.bucketPath(e.scope) === path && e.last > checkpoint).length; state = { ok: checkpoint !== undefined, checkpoint: checkpoint ?? null, lagObjects: lag }; }
      catch (error) { state = { ok: false, error: (error as Error).message }; } finally { database?.close(); }
      databases[path.split('/').at(-1)!] = state;
    }
    return { backend: 'sqlite', derived: true, available: !this.unavailable, reason: this.unavailable ?? null, journalSequence: manifest.sequence, manifestEntries: manifest.entries.size, databases, strategy: 'Journal-checkpointed FTS5 MATCH/trigram candidate selection with a revision-aware overlay; ranking and snippets come from the shared deterministic scorer, not BM25; candidates re-read through Vault.get; per-scope raw-file fallback' };
  }
}

export class SearchEngine implements SearchIndexAdapter {
  private readonly files: FilesystemSearch;
  private readonly sqlite: SQLiteSearch;
  private readonly postgres: PostgresSearch;
  /** Optional semantic backend: lives in the SQLite index, needs an embedding provider, and never affects keyword, grep or regex. */
  readonly vectors: VectorBackend;
  private searchIndexRefresh?: Promise<void>;
  constructor(public readonly vault: SearchVault, options: { embedder?: EmbeddingProvider; env?: Record<string, string | undefined> } = {}) {
    this.files = new FilesystemSearch(vault); this.sqlite = new SQLiteSearch(vault); this.postgres = new PostgresSearch(vault,{embedder:options.embedder,env:options.env});
    this.vectors = new VectorBackend(vault, { ...options, ensureFresh: () => this.sqlite.sync() });
  }
  capabilities(): Record<string, boolean> { return { ...this.sqlite.capabilities(), postgres: true, postgresFts: true, pgvector: true }; }
  /** Lexical retrieval: SQLite FTS5 (BM25 ranking for keyword) when enabled and healthy, otherwise the filesystem engine. */
  private async lexical(input: SearchInput, actor: ActorContext): Promise<SearchResult> { const config=await this.vault.config();return config.postgres?.enabled?this.postgres.query(input,actor):config.sqlite.enabled?this.sqlite.query(input,actor):this.files.query(input,actor); }

  /**
   * Mode resolution (the mode that ran is always reported):
   *  grep / keyword   lexical only, whatever else is or is not connected
   *  semantic         vector similarity; CAPABILITY_UNAVAILABLE unless SQLite + embeddings are ready
   *  hybrid           keyword and semantic combined by reciprocal rank fusion; without a ready vector backend it is CAPABILITY_UNAVAILABLE, or lexical with a stated fallback when allowFallback is set
   *  auto             hybrid when the vector backend is ready (unless embedding.autoHybrid is false), otherwise keyword
   */
  async query(input: SearchInput, actor: ActorContext = this.vault.actor): Promise<SearchResult> {
    const requested = input.mode ?? 'auto';
    if ((await this.vault.config()).postgres?.enabled) return this.postgres.query(input,actor);
    if (!input.includeHistory && !input.regex && textSpec(input) && actor.permissions.includes('*')) {
      const config = await this.vault.config();
      if (!config.sqlite.enabled && !config.postgres?.enabled) await this.ensureFilesystemIndex();
    }
    if (input.includeHistory || requested === 'grep' || requested === 'keyword' || input.regex) return this.lexical(input, actor);
    const wantsVector = requested === 'semantic' || requested === 'hybrid' || requested === 'auto';
    if (!wantsVector) return this.lexical(input, actor);
    if (requested === 'auto') {
      if ((await this.vault.config()).embedding?.autoHybrid === false) return this.lexical(input, actor);
      const status = await this.vectors.status().catch(() => undefined);
      if (!status?.ready) return this.lexical(input, actor);
      try { return await this.fuse(input, actor, 'auto'); }
      catch (error) { if (error instanceof MDBError && error.code === 'CAPABILITY_UNAVAILABLE') return { ...(await this.lexical({ ...input, mode: 'keyword' }, actor)), requestedMode: 'auto', fallback: `Semantic retrieval unavailable (${error.message}); keyword results` }; throw error; }
    }
    if (!input.query.trim()) return this.lexical({ ...input, mode: 'keyword' }, actor);
    const status = await this.vectors.status();
    if (!status.ready) { if (requested === 'hybrid' && input.allowFallback) { const r = await this.lexical({ ...input, mode: 'keyword', allowFallback: undefined }, actor); return { ...r, requestedMode: 'hybrid', fallback: [`Semantic embeddings unavailable (${status.reason}); explicit lexical-only (keyword) fallback`, r.fallback].filter(Boolean).join('; ') }; } throw new MDBError('CAPABILITY_UNAVAILABLE', status.reason ?? 'Semantic search is unavailable'); }
    try { return requested === 'semantic' ? await this.semanticOnly(input, actor) : await this.fuse(input, actor, 'hybrid'); }
    catch (error) {
      if (requested === 'hybrid' && input.allowFallback && error instanceof MDBError && error.code === 'CAPABILITY_UNAVAILABLE') return { ...(await this.lexical({ ...input, mode: 'keyword' }, actor)), requestedMode: 'hybrid', fallback: `Semantic retrieval unavailable (${error.message}); keyword results` };
      throw error;
    }
  }
  private async ensureFilesystemIndex(): Promise<void> {
    const manifest = await manifestFor(this.vault); await manifest.sync();
    if (manifest.entries.size < AUTO_FS_INDEX_MIN_DOCUMENTS) return;
    const status = await fsIndexStatus(this.vault);
    if (status.present && manifest.sequence - (status.manifestSequence ?? 0) < AUTO_INDEX_REFRESH_EVENTS) return;
    let build = autoFsIndexBuilds.get(this.vault.root);
    if (!build) {
      build = buildFsIndex(this.vault).then(() => undefined).finally(() => autoFsIndexBuilds.delete(this.vault.root));
      autoFsIndexBuilds.set(this.vault.root, build);
    }
    await build.catch(() => undefined); // storage pressure or an incomplete derived build falls back to canonical scans
  }

  /** Trusted server maintenance hook; callers run this off request paths. */
  async refreshSearchIndex(): Promise<void> {
    if (!this.vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Search index maintenance requires trusted owner identity');
    if (this.searchIndexRefresh) return this.searchIndexRefresh;
    this.searchIndexRefresh = (async () => {
      const config = await this.vault.config();
      if (config.postgres?.enabled) return; // PostgreSQL is externally managed and remains an explicit operator action.
      if (config.sqlite.enabled) { await this.sqlite.sync(); return; }
      await this.ensureFilesystemIndex();
    })().finally(() => { this.searchIndexRefresh = undefined; });
    return this.searchIndexRefresh;
  }

  private page(input: SearchInput): { limit: number; offset: number } {
    const limit = input.limit ?? 20, offset = Number(input.cursor ?? '0');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new MDBError('INVALID_INPUT', 'limit must be between 1 and 1000');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new MDBError('INVALID_INPUT', 'Invalid cursor');
    return { limit, offset };
  }
  private note(lag: number): string | undefined { return lag > 0 ? `${lag} readable object${lag === 1 ? ' has' : 's have'} no current vectors yet (run "mdb embed sync"); keyword matching still covers ${lag === 1 ? 'it' : 'them'}` : undefined; }

  private async semanticOnly(input: SearchInput, actor: ActorContext): Promise<SearchResult> {
    const { limit, offset } = this.page(input); const need = offset + limit + 1;
    if (offset + limit > 1000) throw new MDBError('INVALID_INPUT', 'semantic paging is limited to the first 1000 results');
    const found = await this.vectors.search(input, actor, Math.min(1000, need + 20));
    const hits: SearchResult['hits'] = []; let materialized = 0;
    for (const m of found.matches) {
      if (hits.length >= need) break; const mat = await this.vectors.materialize(m); if (!mat) continue; materialized++;
      hits.push({ objectId: mat.doc.id, uri: mat.doc.uri, revisionId: mat.doc.revisionId, title: mat.doc.title, kind: mat.doc.kind, snippet: mat.snippet, lineStart: mat.lineStart, lineEnd: mat.lineEnd, score: Math.round(m.similarity * 1e6) / 1e6, retrievalMode: 'semantic', sources: ['semantic'] });
    }
    void materialized; const note = this.note(found.lagObjects);
    return { hits: hits.slice(offset, offset + limit), mode: 'semantic', backend: `sqlite+vector(${found.status.backend})`, ranking: 'similarity', ...(hits.length > offset + limit ? { cursor: String(offset + limit) } : {}),
      vector: { backend: found.status.backend ?? 'sqlite-blob-scan', model: found.status.model ?? '', dimensions: found.status.dimensions ?? 0, lagObjects: found.lagObjects, ...(note ? { note } : {}) } };
  }

  /** Keyword (lexical, exact matching) and semantic rankings are both kept in full and combined by reciprocal rank fusion. There is no similarity threshold: a keyword match can only be outranked, never dropped. */
  private async fuse(input: SearchInput, actor: ActorContext, requested: 'hybrid' | 'auto'): Promise<SearchResult> {
    if (!input.query.trim()) return this.lexical({ ...input, mode: 'keyword' }, actor);
    const { limit, offset } = this.page(input); const depth = Math.min(1000, Math.max(100, 5 * (offset + limit)));
    if (offset + limit > 1000) throw new MDBError('INVALID_INPUT', 'hybrid paging is limited to the first 1000 results');
    const sem = await this.vectors.search(input, actor, depth); // throws CAPABILITY_UNAVAILABLE before any keyword work if embeddings fail
    const kw = await this.lexical({ ...input, mode: 'keyword', limit: depth, cursor: undefined, allowFallback: undefined }, actor);
    const K = 60; const fused = new Map<string, { score: number; kw?: SearchResult['hits'][number]; sem?: SemanticMatch; sources: string[] }>();
    kw.hits.forEach((h, i) => fused.set(h.objectId, { score: 1 / (K + i + 1), kw: h, sources: ['keyword'] }));
    sem.matches.forEach((m, i) => { const cur = fused.get(m.objectId); if (cur) { cur.score += 1 / (K + i + 1); cur.sem = m; cur.sources.push('semantic'); } else fused.set(m.objectId, { score: 1 / (K + i + 1), sem: m, sources: ['semantic'] }); });
    const order = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || b[1].sources.length - a[1].sources.length || a[0].localeCompare(b[0]));
    const hits: SearchResult['hits'] = [];
    for (const [id, f] of order) {
      if (hits.length >= offset + limit + 1) break;
      let base = f.kw;
      if (!base) { const mat = await this.vectors.materialize(f.sem!); if (!mat) continue; base = { objectId: id, uri: mat.doc.uri, revisionId: mat.doc.revisionId, title: mat.doc.title, kind: mat.doc.kind, snippet: mat.snippet, lineStart: mat.lineStart, lineEnd: mat.lineEnd, score: 0, retrievalMode: 'hybrid' }; }
      hits.push({ ...base, score: Math.round(f.score * 1e6) / 1e6, retrievalMode: 'hybrid', sources: f.sources });
    }
    const note = this.note(sem.lagObjects); const fallback = [kw.fallback, note].filter(Boolean).join('; ');
    return { hits: hits.slice(offset, offset + limit), mode: 'hybrid', ...(requested === 'auto' ? { requestedMode: 'auto' } : {}), backend: `${kw.backend}+vector(${sem.status.backend})`, ranking: 'rrf', ...(fallback ? { fallback } : {}),
      ...(hits.length > offset + limit ? { cursor: String(offset + limit) } : {}), vector: { backend: sem.status.backend ?? 'sqlite-blob-scan', model: sem.status.model ?? '', dimensions: sem.status.dimensions ?? 0, lagObjects: sem.lagObjects, ...(note ? { note } : {}) } };
  }
  async rebuild(scope?: Scope): Promise<void> {
    await assertStorageQuota('cache', join(this.vault.root, '.mdb', 'indexes'), 0);
    await refreshNavigation(this.vault);
    const config=await this.vault.config();
    if(config.postgres?.enabled)await this.postgres.rebuild(scope);
    else if (config.sqlite.enabled) await this.sqlite.rebuild(scope); // also persists the manifest
    else { const manifest = await manifestFor(this.vault); await manifest.sync(); await manifest.save(); if (this.vault.actor.permissions.includes('*')) await buildFsIndex(this.vault); }
  }
  links(id: string) { return this.files.links(id); }
  backlinks(id: string) { return this.files.backlinks(id); }
  related(id: string, depth = 1) { return this.files.related(id, depth); }
  context(input: Omit<SearchInput, 'query'> & { task?: string; query?: string; budgetTokens?: number }) { return this.files.context(input); }
  /** Incremental SQLite maintenance (owner only): re-index only objects touched after each database checkpoint. No-op when SQLite is disabled. */
  async sync(): Promise<{ databases: number; objects: number }> { const config=await this.vault.config();return config.postgres?.enabled?this.postgres.sync():config.sqlite.enabled ? this.sqlite.sync() : { databases: 0, objects: 0 }; }
  /** Embeds new and changed revisions (owner only). Sends document text to the configured embedding provider, subject to its locality and privacy settings. */
  async embedClear() { return (await this.vault.config()).postgres?.enabled?this.postgres.embedClear():this.vectors.clear(); }
  async embedSync(options: { signal?: AbortSignal; maxObjects?: number } = {}) { return (await this.vault.config()).postgres?.enabled?this.postgres.embedSync(options):this.vectors.sync(options); }
  async health(): Promise<Record<string, unknown>> {
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const config=await this.vault.config();const base = config.postgres?.enabled ? await this.postgres.health() : config.sqlite.enabled ? await this.sqlite.health() : await this.files.health();
    const vectorPromise=config.postgres?.enabled?this.postgres.vectorStatus():this.vectors.status();
    const vector=await vectorPromise.catch(e => ({ ready: false, reason: (e as Error).message }));
    return { ...base, vector, manifest: { entries: manifest.entries.size, journalSequence: manifest.sequence, persisted: manifest.persisted, loadedFromDisk: manifest.loadedFromDisk }, ripgrep: ripgrepAvailable(), ...(config.postgres?.enabled || config.sqlite.enabled ? {} : { fsIndex: await fsIndexStatus(this.vault) }) };
  }
  async close(): Promise<void> { await Promise.all([this.postgres.close(), this.vectors.close()]); }
}
