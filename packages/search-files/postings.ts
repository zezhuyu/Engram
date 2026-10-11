import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { MDBError } from '../core/types.js';
import { safePath } from '../storage-local/index.js';
import type { SearchVault } from './index.js';
import { manifestFor, type ManifestEntry } from './manifest.js';

/**
 * Filesystem-only candidate index: trigram postings over the raw text (frontmatter + body) of every object's head revision.
 * It is a DERIVED, disposable sidecar under .mdb/indexes/fs-trigram/. It only narrows candidates (a superset of true matches):
 * the shared scorer and Vault.get still decide every hit and re-check authorization. An entry whose head revision differs from the one
 * indexed, or that is absent from the index, is always a candidate, so a stale index is slower but never wrong. A missing or
 * corrupt index makes the caller scan files instead and say so.
 */
const DIR = '.mdb/indexes/fs-trigram';
const SHARDS = 256;
const BLOCK = 4000;
const SCHEMA = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Terms the index can serve: lower-casing is the identity or locale-independent (printable ASCII and CJK/Hangul), so the index and the scorer agree. */
const ELIGIBLE = /^[\x20-\x7e぀-ヿ㐀-鿿가-힯]+$/;

const shardOf = (a: number, b: number, c: number): number => (Math.imul(a * 31 + b, 2654435761) ^ Math.imul(c + 17, 40503)) >>> 24 & (SHARDS - 1);
const keyOf = (a: number, b: number, c: number): number => a * 4294967296 + b * 65536 + c;

function* varints(buffer: Buffer, start: number, end: number): Generator<number> {
  let value = 0, shift = 0;
  for (let i = start; i < end; i++) { const byte = buffer[i]!; value += (byte & 0x7f) * 2 ** shift; if (byte & 0x80) shift += 7; else { yield value; value = 0; shift = 0; } }
}
const pushVarint = (out: number[], value: number): void => { while (value >= 0x80) { out.push((value % 0x80) | 0x80); value = Math.floor(value / 0x80); } out.push(value); };

export interface FsIndexStatus { present: boolean; documents?: number; builtAt?: string; reason?: string }

export async function buildFsIndex(vault: SearchVault): Promise<{ documents: number; shards: number; bytes: number; ms: number }> {
  if (!vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Search index maintenance requires trusted owner identity');
  const started = performance.now();
  const manifest = await manifestFor(vault); await manifest.sync();
  const entries = [...manifest.entries.values()].filter(e => SAFE_ID.test(e.id) && SAFE_ID.test(e.rev)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const base = await safePath(vault.root, '.mdb/indexes'); await fs.mkdir(base, { recursive: true });
  const work = path.join(base, `fs-trigram.${randomUUID()}.tmp`); await fs.mkdir(path.join(work, 'parts'), { recursive: true });
  try {
    const blocks = Math.ceil(entries.length / BLOCK);
    for (let block = 0; block < blocks; block++) {
      const slice = entries.slice(block * BLOCK, (block + 1) * BLOCK);
      const texts: string[] = new Array(slice.length); let next = 0;
      await Promise.all(Array.from({ length: Math.min(32, slice.length) }, async () => {
        for (let i = next++; i < slice.length; i = next++) { try { texts[i] = (await fs.readFile(await safePath(vault.root, `.mdb/objects/${slice[i]!.id}/revs/${slice[i]!.rev}.md`), 'utf8')).toLowerCase(); } catch { texts[i] = ''; } }
      }));
      const buckets: Array<Map<number, number[]>> = Array.from({ length: SHARDS }, () => new Map());
      for (let i = 0; i < slice.length; i++) { // ascending ordinal order keeps every posting list sorted
        const text = texts[i]!; const ordinal = block * BLOCK + i; const seen = new Set<number>();
        for (let p = 0; p + 2 < text.length; p++) {
          const a = text.charCodeAt(p), b = text.charCodeAt(p + 1), c = text.charCodeAt(p + 2); const key = keyOf(a, b, c);
          if (seen.has(key)) continue; seen.add(key);
          const bucket = buckets[shardOf(a, b, c)]!; const list = bucket.get(key); if (list) list.push(ordinal); else bucket.set(key, [ordinal]);
        }
      }
      for (let s = 0; s < SHARDS; s++) {
        const bucket = buckets[s]!; if (!bucket.size) continue;
        const flat: number[] = []; for (const [key, list] of bucket) { flat.push(Math.floor(key / 4294967296), key % 4294967296, list.length, ...list); }
        await fs.writeFile(path.join(work, 'parts', `${block}-${s}`), Buffer.from(Uint32Array.from(flat).buffer));
      }
    }
    let bytes = 0;
    for (let s = 0; s < SHARDS; s++) {
      const merged = new Map<number, number[]>();
      for (let block = 0; block < blocks; block++) {
        let raw: Buffer; try { raw = await fs.readFile(path.join(work, 'parts', `${block}-${s}`)); } catch { continue; }
        const words = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        for (let i = 0; i < words.length;) { const key = words[i]! * 4294967296 + words[i + 1]!; const count = words[i + 2]!; const list = merged.get(key) ?? []; for (let j = 0; j < count; j++) list.push(words[i + 3 + j]!); merged.set(key, list); i += 3 + count; }
      }
      const out: number[] = [];
      for (const key of [...merged.keys()].sort((x, y) => x - y)) {
        const list = merged.get(key)!; const body: number[] = []; pushVarint(body, list.length); let previous = 0; for (const ordinal of list) { pushVarint(body, ordinal - previous); previous = ordinal; }
        const hi = Math.floor(key / 4294967296), lo = key % 4294967296; out.push(hi >> 8 & 0xff, hi & 0xff, lo >>> 24 & 0xff, lo >>> 16 & 0xff, lo >>> 8 & 0xff, lo & 0xff); pushVarint(out, body.length); for (const byte of body) out.push(byte);
      }
      const payload = Buffer.from(out); const file = Buffer.alloc(4 + payload.length); file.writeUInt32LE(crc32(payload), 0); payload.copy(file, 4); bytes += file.length;
      await fs.writeFile(path.join(work, `s${s}.bin`), file);
    }
    await fs.rm(path.join(work, 'parts'), { recursive: true, force: true });
    await fs.writeFile(path.join(work, 'docs.tsv'), entries.map(e => `${e.id}\t${e.rev}`).join('\n') + '\n');
    await fs.writeFile(path.join(work, 'meta.json'), JSON.stringify({ schema: SCHEMA, shards: SHARDS, documents: entries.length, builtAt: new Date().toISOString(), manifestSequence: manifest.sequence }));
    const target = await safePath(vault.root, DIR); const old = `${target}.old.${randomUUID()}`;
    await fs.rename(target, old).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    await fs.rename(work, target); await fs.rm(old, { recursive: true, force: true });
    cache.delete(vault.root);
    return { documents: entries.length, shards: SHARDS, bytes, ms: Math.round(performance.now() - started) };
  } catch (error) { await fs.rm(work, { recursive: true, force: true }); throw error; }
}

interface Loaded { signature: string; documents: number; builtAt: string; ordinals: Map<string, { ordinal: number; rev: string }>; ids: string[]; shards: Map<number, Map<number, { start: number; end: number }> & { buffer?: Buffer }> }
const cache = new Map<string, Loaded>();

async function load(root: string): Promise<Loaded> {
  const dir = await safePath(root, DIR); const metaPath = path.join(dir, 'meta.json');
  let stat; try { stat = await fs.stat(metaPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MDBError('CAPABILITY_UNAVAILABLE', 'filesystem trigram index not built'); throw error; }
  const signature = `${stat.mtimeMs}:${stat.size}`; const hit = cache.get(root); if (hit && hit.signature === signature) return hit;
  let meta: { schema?: number; shards?: number; documents?: number; builtAt?: string };
  try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { throw new MDBError('INTERNAL', 'filesystem trigram index metadata is unreadable'); }
  if (meta.schema !== SCHEMA || meta.shards !== SHARDS) throw new MDBError('INTERNAL', 'filesystem trigram index has an unsupported schema');
  const lines = (await fs.readFile(path.join(dir, 'docs.tsv'), 'utf8')).split('\n').filter(Boolean); const ordinals = new Map<string, { ordinal: number; rev: string }>(); const ids: string[] = [];
  lines.forEach((line, ordinal) => { const [id, rev] = line.split('\t'); if (!id || !rev) throw new MDBError('INTERNAL', 'filesystem trigram index document list is corrupt'); ordinals.set(id, { ordinal, rev }); ids.push(id); });
  if (lines.length !== meta.documents) throw new MDBError('INTERNAL', 'filesystem trigram index document count does not match its metadata');
  const loaded: Loaded = { signature, documents: lines.length, builtAt: meta.builtAt ?? '', ordinals, ids, shards: new Map() }; cache.set(root, loaded); return loaded;
}

async function shard(root: string, loaded: Loaded, s: number): Promise<Map<number, { start: number; end: number }> & { buffer?: Buffer }> {
  const found = loaded.shards.get(s); if (found) return found;
  let raw: Buffer; try { raw = await fs.readFile(path.join(await safePath(root, DIR), `s${s}.bin`)); } catch { cache.delete(root); throw new MDBError('INTERNAL', `filesystem trigram index shard ${s} is missing`); }
  if (raw.length < 4 || raw.readUInt32LE(0) !== crc32(raw.subarray(4))) { cache.delete(root); throw new MDBError('INTERNAL', `filesystem trigram index shard ${s} failed its checksum`); }
  const table: Map<number, { start: number; end: number }> & { buffer?: Buffer } = new Map(); table.buffer = raw;
  for (let i = 4; i < raw.length;) {
    const hi = raw[i]! << 8 | raw[i + 1]!, lo = ((raw[i + 2]! << 24 | raw[i + 3]! << 16 | raw[i + 4]! << 8 | raw[i + 5]!) >>> 0); i += 6;
    let length = 0, shift = 0, byte: number; do { byte = raw[i++]!; length += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    table.set(hi * 4294967296 + lo, { start: i, end: i + length }); i += length;
  }
  loaded.shards.set(s, table); return table;
}

async function postings(root: string, loaded: Loaded, a: number, b: number, c: number): Promise<number[]> {
  const table = await shard(root, loaded, shardOf(a, b, c)); const span = table.get(keyOf(a, b, c)); if (!span) return [];
  const values = varints(table.buffer!, span.start, span.end); const count = values.next().value as number; const list: number[] = new Array(count); let previous = 0, i = 0;
  for (const delta of values) { previous += delta; list[i++] = previous; }
  return list;
}
const intersect = (x: number[], y: number[]): number[] => { const out: number[] = []; let i = 0, j = 0; while (i < x.length && j < y.length) { const p = x[i]!, q = y[j]!; if (p === q) { out.push(p); i++; j++; } else if (p < q) i++; else j++; } return out; };

/** Drops decoded in-memory index state (a new process starts empty); used by tests to prove on-disk damage is detected on a cold read. */
export const resetFsIndexCache = (): void => cache.clear();
export const fsIndexServes = (terms: string[]): boolean => terms.every(term => term.length >= 3 && ELIGIBLE.test(term));

export async function fsIndexStatus(vault: SearchVault): Promise<FsIndexStatus> {
  try { const loaded = await load(vault.root); return { present: true, documents: loaded.documents, builtAt: loaded.builtAt }; }
  catch (error) { return { present: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/** Candidate ids per term (a superset of the entries whose text contains the term), or throws when the index is absent or damaged. */
export async function fsIndexLookup(root: string, entries: ManifestEntry[], terms: string[], caseSensitive: boolean): Promise<{ byTerm: Map<string, Set<string>>; stale: number; indexed: number }> {
  const loaded = await load(root); const byTerm = new Map<string, Set<string>>();
  const stale: string[] = []; for (const e of entries) { const known = loaded.ordinals.get(e.id); if (!known || known.rev !== e.rev) stale.push(e.id); }
  for (const term of terms) {
    const text = caseSensitive ? term.toLowerCase() : term; const keys = new Map<number, [number, number, number]>();
    for (let p = 0; p + 2 < text.length; p++) { const a = text.charCodeAt(p), b = text.charCodeAt(p + 1), c = text.charCodeAt(p + 2); keys.set(keyOf(a, b, c), [a, b, c]); }
    const lists: number[][] = []; for (const [a, b, c] of keys.values()) lists.push(await postings(root, loaded, a, b, c));
    lists.sort((x, y) => x.length - y.length); let current = lists[0] ?? []; for (let i = 1; i < lists.length && current.length; i++) current = intersect(current, lists[i]!);
    const ids = new Set<string>(current.map(ordinal => loaded.ids[ordinal]!)); for (const id of stale) ids.add(id); byTerm.set(term, ids);
  }
  return { byTerm, stale: stale.length, indexed: loaded.documents };
}
