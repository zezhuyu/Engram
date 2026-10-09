import { createHash, randomUUID } from 'node:crypto';
import {
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand,
  S3Client, type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { MDBError, type CommitEvent, type CommitJournalStore, type ObjectStore } from '../core/types.js';

type Head = { sequence: number; recordKey?: string; recordSha256?: string };
type Record = { event: CommitEvent; previous?: Head };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode === 404 || (error as { name?: string }).name === 'NoSuchKey';
const precondition = (error: unknown) => [409, 412].includes((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0);

/**
 * S3-backed canonical object store. Revisions and commit records are immutable objects. The
 * `_commit-head.json` pointer is the only mutable commit record and is advanced with If-Match /
 * If-None-Match; a client must not emulate those conditions with an unconditional PUT.
 *
 * AWS S3 and compatible stores must provide conditional PutObject and strongly consistent
 * GET/HEAD after PUT. This class does not depend on rename, directory listing order, or fsync.
 */
export class S3ObjectStore implements ObjectStore, CommitJournalStore {
  readonly client: S3Client;
  private readonly base: string;
  private readonly headKey: string;
  constructor(readonly bucket: string, options: S3ClientConfig & { prefix?: string; client?: S3Client } = {}) {
    if (!bucket || bucket.includes('/')) throw new MDBError('INVALID_INPUT', 'S3 bucket name is required');
    const { prefix = '', client, ...clientOptions } = options;
    this.client = client ?? new S3Client(clientOptions);
    this.base = prefix.replace(/^\/+|\/+$/g, '');
    this.headKey = this.key('.mdb/events/_commit-head.json');
  }
  private key(key: string): string {
    if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.split('/').some(p => !p || p === '.' || p === '..')) throw new MDBError('INVALID_INPUT', 'Unsafe object key');
    return this.base ? `${this.base}/${key}` : key;
  }
  private async bytes(key: string): Promise<Uint8Array> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      if (!response.Body) throw new MDBError('INTERNAL', `S3 returned an empty body for ${key}`);
      return await response.Body.transformToByteArray();
    } catch (error) { if (missing(error)) throw Object.assign(new Error('Object not found'), { code: 'ENOENT' }); throw error; }
  }
  async read(key: string): Promise<Uint8Array> { return this.bytes(key); }
  /** Read a set of keys in stable input order with a hard concurrency cap. */
  async readMany(keys: string[], concurrency = 8): Promise<Uint8Array[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new MDBError('INVALID_INPUT', 'S3 read concurrency must be between 1 and 32');
    const results = new Array<Uint8Array>(keys.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(keys.length, concurrency) }, async () => {
      while (true) { const index = next++; if (index >= keys.length) return; results[index] = await this.read(keys[index]!); }
    }));
    return results;
  }
  async stat(key: string): Promise<{ etag?: string; size: number } | null> {
    try { const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) })); return { ...(r.ETag ? { etag: r.ETag } : {}), size: r.ContentLength ?? 0 }; }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async *list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    const keyPrefix = this.key(prefix);
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: keyPrefix, ContinuationToken: token }));
      for (const item of page.Contents ?? []) if (item.Key && item.Size !== undefined) {
        const key = this.base ? item.Key.slice(this.base.length + 1) : item.Key;
        yield { key, size: item.Size };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: bytes, IfNoneMatch: '*', Metadata: { sha256: hash(bytes) } })); }
    catch (error) {
      if (!precondition(error)) throw error;
      const existing = await this.read(key);
      if (hash(existing) !== hash(bytes)) throw new MDBError('CONFLICT', 'Immutable S3 object already exists with different bytes');
    }
  }
  async compareAndSwapPointer(key: string, expected: string | null, value: string): Promise<boolean> {
    if (/^(?:\.mdb\/objects\/|.*\/sources\/originals\/|\.mdb\/events\/records\/)/.test(key)) throw new MDBError('INVALID_INPUT', 'Canonical immutable objects cannot be replaced by pointers');
    let etag: string | undefined; let current: string | null = null;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) })); etag = head.ETag;
      current = Buffer.from(await this.bytes(key)).toString('utf8');
    } catch (error) { if (!missing(error)) throw error; }
    if (current !== expected) return false;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: value, ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) }));
      return true;
    } catch (error) { if (precondition(error)) return false; throw error; }
  }
  async removeForAuthorizedPurge(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) })); }

  async initializeJournal(): Promise<void> {
    const initial = JSON.stringify({ sequence: 0 } satisfies Head);
    if (!await this.compareAndSwapPointer('.mdb/events/_commit-head.json', null, initial)) await this.readHead();
  }
  private async readHead(): Promise<{ head: Head; raw: string }> {
    const bytes = await this.read('.mdb/events/_commit-head.json'); const raw = Buffer.from(bytes).toString('utf8');
    let head: Head; try { head = JSON.parse(raw) as Head; } catch { throw new MDBError('INTERNAL', 'S3 commit head is corrupt'); }
    if (!Number.isSafeInteger(head.sequence) || head.sequence < 0 || (head.sequence > 0 && (!head.recordKey || !head.recordSha256))) throw new MDBError('INTERNAL', 'S3 commit head is invalid');
    return { head, raw };
  }
  async readCommittedJournal(): Promise<CommitEvent[]> {
    let { head } = await this.readHead(); const reverse: CommitEvent[] = [];
    while (head.sequence > 0) {
      if (!head.recordKey || !head.recordSha256) throw new MDBError('INTERNAL', 'S3 commit chain is incomplete');
      const bytes = await this.read(head.recordKey);
      if (hash(bytes) !== head.recordSha256) throw new MDBError('INTERNAL', 'S3 commit record hash mismatch');
      let record: Record; try { record = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record; } catch { throw new MDBError('INTERNAL', 'S3 commit record is corrupt'); }
      if (record.event.sequence !== head.sequence || !record.previous || record.previous.sequence !== head.sequence - 1) throw new MDBError('INTERNAL', 'S3 commit chain sequence mismatch');
      reverse.push(record.event); head = record.previous;
    }
    return reverse.reverse();
  }
  async appendCommittedEvent(event: CommitEvent): Promise<CommitEvent> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const { head, raw } = await this.readHead();
      const current = await this.readCommittedJournal();
      const prior = current.find(e => e.transactionId === event.transactionId || (event.idempotencyKey && e.idempotencyKey === event.idempotencyKey && JSON.stringify(e.scope) === JSON.stringify(event.scope)));
      if (prior) return prior;
      const latest = current.findLast(e => e.objectId === event.objectId);
      if ((event.previousRevisionId ?? undefined) !== (latest && latest.operation !== 'purge' ? latest.revisionId : undefined)) throw new MDBError('CONFLICT', 'S3 canonical revision changed before commit publication');
      const published: CommitEvent = { ...event, sequence: head.sequence + 1 };
      const key = `.mdb/events/records/${String(published.sequence).padStart(16, '0')}-${published.transactionId}.json`;
      const record: Record = { event: published, ...(head.sequence ? { previous: head } : { previous: { sequence: 0 } }) };
      const bytes = Buffer.from(JSON.stringify(record)); await this.putImmutable(key, bytes);
      const next: Head = { sequence: published.sequence, recordKey: key, recordSha256: hash(bytes) };
      if (await this.compareAndSwapPointer('.mdb/events/_commit-head.json', raw, JSON.stringify(next))) return published;
    }
    throw new MDBError('CONFLICT', 'S3 journal head remained contended after 16 retries');
  }
  /** Replaces the reachable journal chain for an explicitly authorized privacy purge. The new head
   * is published atomically, then orphaned/old records are erased; a retry completes partial cleanup. */
  async rewriteCommittedJournal(events: CommitEvent[]): Promise<void> {
    const { raw } = await this.readHead();
    const generation = randomUUID(); let next: Head = { sequence: 0 }; const retained = new Set<string>();
    for (let i=0;i<events.length;i++) {
      const event = { ...events[i]!, sequence: i+1 };
      const key = `.mdb/events/records/rewritten/${generation}/${String(event.sequence).padStart(16,'0')}.json`;
      const record: Record = { event, ...(next.sequence ? { previous: next } : { previous: { sequence: 0 } }) };
      const bytes=Buffer.from(JSON.stringify(record)); await this.putImmutable(key,bytes);
      next={sequence:event.sequence,recordKey:key,recordSha256:hash(bytes)};retained.add(this.key(key));
    }
    if (!await this.compareAndSwapPointer('.mdb/events/_commit-head.json',raw,JSON.stringify(next))) throw new MDBError('CONFLICT','S3 journal changed during privacy purge');
    for await(const entry of this.list('.mdb/events/records')) if(!retained.has(this.key(entry.key))) await this.removeForAuthorizedPurge(entry.key);
  }
  close(): void { this.client.destroy(); }
}

/** Configured through environment only; credentials use the standard AWS provider chain. */
export function createS3ObjectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): S3ObjectStore {
  const bucket = env.MDB_S3_BUCKET; if (!bucket) throw new MDBError('CAPABILITY_UNAVAILABLE', 'MDB_S3_BUCKET is required for S3 storage');
  return new S3ObjectStore(bucket, { region: env.MDB_S3_REGION ?? 'us-east-1', ...(env.MDB_S3_ENDPOINT ? { endpoint: env.MDB_S3_ENDPOINT, forcePathStyle: true } : {}), prefix: env.MDB_S3_PREFIX ?? '' });
}
