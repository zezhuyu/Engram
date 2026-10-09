import { createHash } from 'node:crypto';

export interface Acked { objectId: string; revisionId: string; revisionNumber: number; bodyDigest: string; status: string }
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
/** In-memory state machine of ACKNOWLEDGED operations. Anything the product acknowledged must survive; unacknowledged work is allowed to appear only as a whole. */
export class ReferenceModel {
  readonly heads = new Map<string, Acked>();
  readonly chain = new Map<string, string[]>();
  ack(entry: Acked): void {
    const previous = this.heads.get(entry.objectId);
    if (previous && entry.revisionNumber !== previous.revisionNumber + 1) throw new Error(`model: non-monotonic revision for ${entry.objectId}`);
    this.heads.set(entry.objectId, entry);
    this.chain.set(entry.objectId, [...(this.chain.get(entry.objectId) ?? []), entry.revisionId]);
  }
  parseAckLines(stdout: string): void {
    for (const line of stdout.split('\n')) { if (!line.startsWith('ACK ')) continue; const [, objectId, revisionId, revisionNumber, bodyDigest, status] = line.split(' '); this.ack({ objectId: objectId!, revisionId: revisionId!, revisionNumber: Number(revisionNumber), bodyDigest: bodyDigest!, status: status ?? 'active' }); }
  }
}
