import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument, serializeDocument, type Vault } from '../../packages/core/vault.js';
import { digest, type ReferenceModel } from './reference-model.js';

export interface InvariantOptions {
  model?: ReferenceModel;
  /** Objects whose newest revision may legitimately be one step ahead of the model (an unacknowledged transaction past its commit point). */
  allowUnacknowledgedHead?: boolean;
  /** Allow at most this many objects the model does not know about (an unacknowledged create past its commit point). */
  allowUnknownObjects?: number;
  revisionHashes?: Map<string, string>;
}
export interface InvariantReport { ok: boolean; issues: string[]; objects: number; revisions: number; assertions: number; unknownObjects: string[]; ahead: string[] }
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export async function snapshotRevisionHashes(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const base = path.join(root, '.mdb/objects');
  for (const object of await fs.readdir(base).catch(() => [] as string[])) for (const file of await fs.readdir(path.join(base, object, 'revs')).catch(() => [] as string[])) if (file.endsWith('.md')) result.set(`${object}/${file}`, sha(await fs.readFile(path.join(base, object, 'revs', file))));
  return result;
}

/** Checks journal contiguity, revision chains, head/view agreement, hashes, source digests and model containment. */
export async function verifyInvariants(vault: Vault, options: InvariantOptions = {}): Promise<InvariantReport> {
  const issues: string[] = []; let assertions = 0; let revisions = 0;
  const check = (condition: boolean, message: string) => { assertions++; if (!condition) issues.push(message); };
  const verify = await vault.verify(); check(verify.ok, `vault.verify: ${verify.issues.join('; ')}`);
  const events = await vault.events();
  events.forEach((e, i) => check(e.sequence === i + 1, `journal sequence gap at ${i + 1}`));
  check(new Set(events.map(e => e.transactionId)).size === events.length, 'duplicate transaction id');
  check(new Set(events.map(e => e.revisionId)).size === events.length, 'duplicate revision id');
  const byObject = new Map<string, typeof events>();
  for (const e of events) byObject.set(e.objectId, [...(byObject.get(e.objectId) ?? []), e]);
  const heads = new Map<string, string>();
  for (const [objectId, chain] of byObject) {
    if (chain.some(e => e.operation === 'purge')) continue;
    let previous: string | undefined;
    for (const [i, e] of chain.entries()) {
      revisions++;
      const file = path.join(vault.root, `.mdb/objects/${objectId}/revs/${e.revisionId}.md`);
      let text: string; try { text = await fs.readFile(file, 'utf8'); } catch { check(false, `missing revision file ${objectId}/${e.revisionId}`); continue; }
      const doc = parseDocument(text);
      check(doc.revisionNumber === i + 1, `non-monotonic revision number ${objectId}#${i + 1}`);
      check((doc.previousRevisionId ?? undefined) === previous, `broken parent link ${objectId}#${i + 1}`);
      check(serializeDocument(doc) === text, `revision not canonical ${objectId}/${e.revisionId}`);
      if (options.revisionHashes?.has(`${objectId}/${e.revisionId}.md`)) check(options.revisionHashes.get(`${objectId}/${e.revisionId}.md`) === sha(text), `immutable revision changed ${objectId}/${e.revisionId}`);
      previous = e.revisionId;
    }
    const last = chain.at(-1)!; heads.set(objectId, last.revisionId);
    try { const head = JSON.parse(await fs.readFile(path.join(vault.root, `.mdb/heads/${objectId}.json`), 'utf8')) as { revisionId: string }; check(head.revisionId === last.revisionId, `head pointer stale for ${objectId}`); } catch { check(false, `head pointer missing for ${objectId}`); }
    try { const view = await fs.readFile(path.join(vault.root, last.path), 'utf8'); const canonical = await fs.readFile(path.join(vault.root, `.mdb/objects/${objectId}/revs/${last.revisionId}.md`), 'utf8'); check(view === canonical, `current view differs from head revision for ${objectId}`); } catch { check(false, `current view missing for ${objectId}`); }
  }
  const unknownObjects: string[] = [], ahead: string[] = [];
  if (options.model) {
    for (const [objectId, acked] of options.model.heads) {
      const chain = options.model.chain.get(objectId)!;
      const actual = (byObject.get(objectId) ?? []).map(e => e.revisionId);
      check(chain.every((revisionId, i) => actual[i] === revisionId), `acknowledged history of ${objectId} is not a prefix of the journal`);
      const extra = actual.length - chain.length;
      if (extra > 0) { ahead.push(objectId); check(options.allowUnacknowledgedHead === true && extra === 1, `${objectId} has ${extra} unacknowledged revisions`); }
      if (extra === 0) { const doc = await vault.get(objectId); check(digest(doc.body) === acked.bodyDigest, `acknowledged body of ${objectId} changed`); }
    }
    for (const [objectId, chain] of byObject) if (!options.model.heads.has(objectId) && !chain.some(e => e.operation === 'purge')) unknownObjects.push(objectId);
    check(unknownObjects.length <= (options.allowUnknownObjects ?? 0), `unexpected unacknowledged objects: ${unknownObjects.length}`);
  }
  return { ok: issues.length === 0, issues, objects: byObject.size, revisions, assertions, unknownObjects, ahead };
}
