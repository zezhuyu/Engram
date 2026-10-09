import type { DatabaseSync } from 'node:sqlite';

/**
 * Vector storage lives INSIDE the SQLite index database of each scope (next to FTS5), so it is disposable, owner-only, wiped by purge, and absent when SQLite is.
 * Rows are pinned to (object, revision): a row whose revision is not the object's current revision is ignored by queries and replaced by the next sync.
 */
export function ensureVectorSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS vec_chunks(object_id TEXT NOT NULL, revision_id TEXT NOT NULL, chunk INTEGER NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY(object_id, revision_id, chunk)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS vec_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}
export interface VecState { model: string; dimensions: number; chunker: number; updatedAt: string }
export function readVecState(db: DatabaseSync): VecState | undefined {
  try {
    const get = (k: string) => (db.prepare('SELECT value FROM vec_state WHERE key=?').get(k) as { value: string } | undefined)?.value;
    const model = get('model'), dims = Number(get('dimensions')), chunker = Number(get('chunker')); if (!model || !Number.isSafeInteger(dims) || dims < 1) return undefined;
    return { model, dimensions: dims, chunker, updatedAt: get('updated_at') ?? '' };
  } catch { return undefined; }
}
export function writeVecState(db: DatabaseSync, s: Omit<VecState, 'updatedAt'>): void {
  const put = db.prepare('INSERT OR REPLACE INTO vec_state VALUES(?,?)'); put.run('model', s.model); put.run('dimensions', String(s.dimensions)); put.run('chunker', String(s.chunker)); put.run('updated_at', new Date().toISOString());
}
export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
export const fromBlob = (b: Uint8Array, dims: number): Float32Array | undefined => b.byteLength === dims * 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : undefined;
export function normalize(v: ArrayLike<number>): Float32Array { const out = new Float32Array(v.length); let n = 0; for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) out[i] = v[i]! / n; return out; }
export function dot(a: Float32Array, b: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; }

export interface VecRow { objectId: string; revisionId: string; chunk: number; lineStart: number; lineEnd: number; similarity: number }
/** Brute-force cosine search over the accepted rows (vectors are stored unit-length, so dot product = cosine). Keeps the best row per object. */
export function scanBest(db: DatabaseSync, query: Float32Array, accept: (objectId: string, revisionId: string) => boolean, keep: number, seen: Set<string>): VecRow[] {
  const best = new Map<string, VecRow>();
  const stmt = db.prepare('SELECT object_id, revision_id, chunk, line_start, line_end, vec FROM vec_chunks');
  for (const r of stmt.iterate() as Iterable<{ object_id: string; revision_id: string; chunk: number; line_start: number; line_end: number; vec: Uint8Array }>) {
    if (!accept(r.object_id, r.revision_id)) continue; const v = fromBlob(r.vec, query.length); if (!v) continue; seen.add(r.object_id);
    const sim = dot(query, v); const cur = best.get(r.object_id);
    if (!cur || sim > cur.similarity) best.set(r.object_id, { objectId: r.object_id, revisionId: r.revision_id, chunk: r.chunk, lineStart: r.line_start, lineEnd: r.line_end, similarity: sim });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity || a.objectId.localeCompare(b.objectId)).slice(0, keep);
}
/** Same search through the optional sqlite-vec extension (C distance function over the very same BLOB column). */
export function scanBestVec(db: DatabaseSync, query: Float32Array, accept: (objectId: string, revisionId: string) => boolean, keep: number, seen: Set<string>): VecRow[] {
  const best = new Map<string, VecRow>();
  const stmt = db.prepare('SELECT object_id, revision_id, chunk, line_start, line_end, 1.0 - vec_distance_cosine(vec, ?) AS sim FROM vec_chunks');
  for (const r of stmt.iterate(toBlob(query)) as Iterable<{ object_id: string; revision_id: string; chunk: number; line_start: number; line_end: number; sim: number }>) {
    if (!accept(r.object_id, r.revision_id)) continue; seen.add(r.object_id); const cur = best.get(r.object_id);
    if (!cur || r.sim > cur.similarity) best.set(r.object_id, { objectId: r.object_id, revisionId: r.revision_id, chunk: r.chunk, lineStart: r.line_start, lineEnd: r.line_end, similarity: r.sim });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity || a.objectId.localeCompare(b.objectId)).slice(0, keep);
}
