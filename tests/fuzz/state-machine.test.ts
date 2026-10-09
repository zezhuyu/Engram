import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { Prng } from '../helpers/prng.js';
import { ReferenceModel, digest } from '../helpers/reference-model.js';
import { snapshotRevisionHashes, verifyInvariants } from '../helpers/invariants.js';
import { recordCase } from '../helpers/report.js';
import { Vault, serializeDocument } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import type { Document, Scope } from '../../packages/core/types.js';

/**
 * Seeded randomized state machine. After every step: invariants (journal contiguity, parent links, head/view agreement,
 * immutable revision hashes, source digests) and containment in the reference model. After restart: recover twice.
 * Any failure prints the seed and operation trace so it can be replayed with MDB_FUZZ_SEED=<seed>.
 */
interface Live { doc: Document; token: string; deleted: boolean }
async function run(t: { after(fn: () => void | Promise<void>): void }, seed: number, steps: number, withSearch: boolean) {
  const { root, vault: initial } = await disposableVault(t);
  let vault = initial;
  const rng = new Prng(seed); const model = new ReferenceModel(); const trace: string[] = [];
  const scopes: Scope[] = [{ type: 'global', area: 'wiki' }, { type: 'global', area: 'shared' }];
  await vault.createWorkspace('w1', ''); scopes.push({ type: 'workspace', workspaceId: 'w1' });
  const live = new Map<string, Live>(); const purged = new Set<string>(); const originals = new Map<string, string>();
  const revisionBodies = new Map<string, string>(); let hashes = new Map<string, string>();
  const ack = (doc: Document) => { model.ack({ objectId: doc.id, revisionId: doc.revisionId, revisionNumber: doc.revisionNumber, bodyDigest: digest(doc.body), status: doc.status }); revisionBodies.set(doc.revisionId, doc.body); };
  const search = () => new SearchEngine(vault);
  try {
    for (let step = 0; step < steps; step++) {
      const ids = [...live.keys()]; const alive = ids.filter(id => !live.get(id)!.deleted && live.get(id)!.doc.kind !== 'source'); const restorable = ids.filter(id => live.get(id)!.doc.kind !== 'source');
      const r = rng.int(100);
      if (ids.length === 0 || r < 22) {
        const token = `tok${seed}x${step}`; const body = `${token} ${rng.text(8)}\n\n\`\`\`js\nconst x = ${step};\n\`\`\`\n`;
        const doc = await vault.put({ scope: rng.pick(scopes), kind: rng.pick(['note', 'insight', 'fact']), title: `doc ${step} ${rng.word()}`, body, tags: [rng.word()], metadata: { n: step } });
        live.set(doc.id, { doc, token, deleted: false }); ack(doc); trace.push(`put ${doc.id} ${token}`);
      } else if (r < 52 && alive.length) {
        const id = rng.pick(alive); const cur = live.get(id)!; const token = `tok${seed}x${step}`;
        const doc = await vault.patch({ objectId: id, expectedRevisionId: cur.doc.revisionId, body: `${token} ${rng.text(6)}` });
        live.set(id, { doc, token, deleted: false }); ack(doc); trace.push(`patch ${id} ${token}`);
      } else if (r < 58 && alive.length) {
        const id = rng.pick(alive); const cur = live.get(id)!;
        await assert.rejects(vault.patch({ objectId: id, expectedRevisionId: 'rev_stale', body: 'x' }), { code: 'CONFLICT' });
        assert.equal((await vault.get(id)).revisionId, cur.doc.revisionId); trace.push(`conflict ${id}`);
      } else if (r < 66 && alive.length) {
        const id = rng.pick(alive); const cur = live.get(id)!; const other = alive.length > 1 ? rng.pick(alive.filter(x => x !== id)) : undefined;
        if (!other) continue;
        const doc = await vault.patch({ objectId: id, expectedRevisionId: cur.doc.revisionId, links: [{ type: 'related_to', target: live.get(other)!.doc.uri }] });
        live.set(id, { ...cur, doc }); ack(doc); trace.push(`link ${id}->${other}`);
      } else if (r < 74 && alive.length) {
        const id = rng.pick(alive); const cur = live.get(id)!;
        const doc = await vault.delete(id, cur.doc.revisionId); live.set(id, { ...cur, doc, deleted: true }); ack(doc); trace.push(`delete ${id}`);
        assert.equal((await vault.listDocuments()).some(d => d.id === id), false, 'tombstoned object hidden from listings');
      } else if (r < 80 && restorable.length) {
        const id = rng.pick(restorable); const cur = live.get(id)!; const hist = await vault.history(id);
        const target = rng.pick(hist.filter(h => h.status !== 'deleted' && h.revisionId !== cur.doc.revisionId)); if (!target) continue;
        const doc = await vault.restore(id, target.revisionId, cur.doc.revisionId);
        assert.equal(doc.body, target.body, 'restore reproduces old content'); assert.ok(doc.revisionNumber === cur.doc.revisionNumber + 1, 'restore is a NEW revision');
        live.set(id, { doc, token: cur.token, deleted: false }); ack(doc); trace.push(`restore ${id}`);
      } else if (r < 86) {
        const bytes = rng.next() < 0.5 ? Buffer.from(`# source ${step}\n${rng.text(10)}\n`) : Buffer.from([0, 255, step % 256, 7, 13, 10, rng.int(256)]); const file = path.join(root, `src-${step}.${bytes[0] === 0 ? 'bin' : 'md'}`);
        await fs.writeFile(file, bytes); const doc = await vault.ingest(file, scopes[0]!);
        originals.set(String(doc.metadata.originalPath), createHash('sha256').update(bytes).digest('hex'));
        if (!live.has(doc.id)) live.set(doc.id, { doc, token: '', deleted: false }); if (!model.heads.has(doc.id)) ack(doc); trace.push(`ingest ${doc.id}`);
      } else if (r < 89 && ids.length > 3) {
        const id = rng.pick(ids); const doomed = live.get(id)!.doc.metadata.originalPath; await vault.purge(id, true); if (typeof doomed === 'string') originals.delete(doomed); purged.add(id); live.delete(id); model.heads.delete(id); model.chain.delete(id); trace.push(`purge ${id}`);
        await assert.rejects(vault.get(id), { code: 'NOT_FOUND_OR_FORBIDDEN' });
      } else if (r < 94) {
        vault = new Vault(root); const rec = await vault.recover(); const again = await vault.recover(); assert.equal(again.repaired, 0); trace.push(`restart committed=${rec.committed}`);
      } else if (r < 97 && alive.length) {
        const id = rng.pick(alive); const cur = live.get(id)!; if (cur.doc.kind === 'source') continue;
        await fs.writeFile(path.join(root, cur.doc.path), serializeDocument({ ...cur.doc, body: `${cur.token} externally edited ${step}` }));
        const rec = await vault.reconcile(); assert.equal(rec.imported, 1, 'external edit imported as a new revision');
        const doc = await vault.get(id); live.set(id, { ...cur, doc }); ack(doc); trace.push(`external ${id}`);
      }
      for (const [file, hash] of originals) assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex'), hash, `source ${file} changed`);
      const report = await verifyInvariants(vault, { model, revisionHashes: hashes });
      assert.deepEqual(report.issues, [], `step ${step}`);
      hashes = await snapshotRevisionHashes(root);
      if (withSearch && step % 7 === 0) {
        const engine = search();
        for (const [id, l] of live) { if (!l.token) continue; const hits = (await engine.query({ query: l.token, mode: 'grep' })).hits.filter(h => h.objectId === id); if (l.deleted) assert.equal(hits.length, 0, 'deleted content is not searchable'); else if (l.doc.body.includes(l.token)) assert.equal(hits.length, 1, `live doc ${id} must be searchable by ${l.token}`); }
        for (const id of purged) assert.equal((await engine.query({ query: id, mode: 'grep' })).hits.some(h => h.objectId === id), false);
      }
    }
    // Every historical revision is still readable with its original body.
    for (const [revisionId, body] of revisionBodies) { const owner = [...model.heads.keys()].find(id => model.chain.get(id)!.includes(revisionId)); if (owner) assert.equal((await vault.get(owner, revisionId)).body, body, 'history preserved'); }
    // Rebuilding/restarting changes nothing.
    vault = new Vault(root); await vault.recover();
    assert.deepEqual((await verifyInvariants(vault, { model, revisionHashes: hashes })).issues, []);
  } catch (error) {
    recordCase({ suite: 'fuzz-state-machine', name: `seed-${seed}`, status: 'FAIL', seed, detail: { trace: trace.slice(-15) } });
    (error as Error).message += `\n[replay: MDB_FUZZ_SEED=${seed}] last ops: ${trace.slice(-8).join(' | ')}`;
    throw error;
  }
  recordCase({ suite: 'fuzz-state-machine', name: `seed-${seed}`, status: 'PASS', seed, detail: { steps, objects: model.heads.size, purged: purged.size } });
}

const seeds = process.env.MDB_FUZZ_SEED ? [Number(process.env.MDB_FUZZ_SEED)] : Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);
for (const seed of seeds) test(`state machine seed ${seed}: invariants hold after every step and restart`, { timeout: 180000 }, async t => { await run(t, seed, 45, seed % 3 === 0); });
