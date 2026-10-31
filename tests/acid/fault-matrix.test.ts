import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { faultPreamble, modules, runChild } from '../helpers/child.js';
import { ReferenceModel, digest } from '../helpers/reference-model.js';
import { snapshotRevisionHashes, verifyInvariants } from '../helpers/invariants.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';

/**
 * Commit point of an MDB transaction = the journal record is appended AND fsynced (journal.after_fsync).
 *   PRE   : not durable. After recovery the transaction must be entirely invisible.
 *   AMBIG : record written but not yet fsynced. A SIGKILL keeps page cache, so it may survive; either outcome is allowed, but never partial.
 *   POST  : durable but unacknowledged. After recovery the transaction must be entirely visible (documented: an unacknowledged commit may appear).
 */
type Klass = 'PRE' | 'AMBIG' | 'POST';
const stages: { stage: string; klass: Klass; after?: string }[] = [
  { stage: 'commit.before_revision', klass: 'PRE' },
  { stage: 'revision.partial_write', klass: 'PRE' },
  { stage: 'revision.before_temp_create', klass: 'PRE' },
  { stage: 'revision.temp_written', klass: 'PRE' },
  { stage: 'revision.temp_synced', klass: 'PRE' },
  { stage: 'revision.after_link', klass: 'PRE' },
  { stage: 'revision.after_dirsync', klass: 'PRE' },
  { stage: 'journal.before_append', klass: 'PRE' },
  { stage: 'journal.partial_append', klass: 'PRE' },
  { stage: 'journal.after_append_before_fsync', klass: 'AMBIG' },
  { stage: 'journal.after_fsync', klass: 'POST' },
  { stage: 'head.before_replace', klass: 'POST' },
  { stage: 'atomic.temp_written', klass: 'POST', after: 'journal.after_fsync' },
  { stage: 'atomic.before_rename', klass: 'POST', after: 'journal.after_fsync' },
  { stage: 'atomic.after_rename', klass: 'POST', after: 'journal.after_fsync' },
  { stage: 'view.before_replace', klass: 'POST' },
  { stage: 'view.after_replace', klass: 'POST' },
  { stage: 'commit.before_ack', klass: 'POST' }
];
type Mode = 'kill' | 'throw-eio' | 'throw-enospc';
type Op = 'put' | 'patch' | 'delete' | 'ingest';
const opCode: Record<Op, (target: string, expected: string, source: string) => string> = {
  put: () => `const d=await vault.put({scope:{type:'global',area:'wiki'},kind:'note',title:'in-flight',body:'in-flight body'});`,
  patch: (id, rev) => `const d=await vault.patch({objectId:${JSON.stringify(id)},expectedRevisionId:${JSON.stringify(rev)},body:'in-flight patch'});`,
  delete: (id, rev) => `const d=await vault.delete(${JSON.stringify(id)},${JSON.stringify(rev)});`,
  ingest: (_id, _rev, source) => `const d=await vault.ingest(${JSON.stringify(source)},{type:'global',area:'wiki'});`
};
const recoverySource = (root: string, extra = '') => `import {Vault} from ${JSON.stringify(modules.vault)};import {createHash} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
const v=new Vault(${JSON.stringify(root)}${extra});const first=await v.recover();
const state=async()=>{const h=createHash('sha256');const walk=(d)=>{for(const n of fs.readdirSync(d).sort()){const f=path.join(d,n);const s=fs.statSync(f);if(n==='locks'||n==='quarantine')continue;if(s.isDirectory())walk(f);else{h.update(f.slice(${JSON.stringify(root.length)}));h.update(fs.readFileSync(f));}}};walk(${JSON.stringify(root)});return h.digest('hex');};
const d1=await state();const second=await v.recover();const d2=await state();console.log(JSON.stringify({first,second,d1,d2}));`;

async function runCase(t: { after(fn: () => void | Promise<void>): void }, op: Op, spec: { stage: string; klass: Klass; after?: string }, mode: Mode) {
  const { root, vault } = await disposableVault(t);
  const model = new ReferenceModel();
  const scope = { type: 'global' as const, area: 'wiki' as const };
  const sourceFile = path.join(root, 'import-me.bin'); const sourceBytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
  await fs.writeFile(sourceFile, sourceBytes);
  // Acknowledged baseline.
  const base = await vault.put({ scope, kind: 'note', title: 'baseline', body: 'baseline body' });
  const patched = await vault.patch({ objectId: base.id, expectedRevisionId: base.revisionId, body: 'baseline body v2' });
  const second = await vault.put({ scope: { type: 'workspace', workspaceId: 'ws' }, kind: 'note', title: 'ws note', body: 'ws body' }).catch(async () => { await vault.createWorkspace('ws', ''); return vault.put({ scope: { type: 'workspace', workspaceId: 'ws' }, kind: 'note', title: 'ws note', body: 'ws body' }); });
  const original = await vault.ingest(sourceFile, scope);
  for (const d of [base, patched, second, original]) model.ack({ objectId: d.id, revisionId: d.revisionId, revisionNumber: d.revisionNumber, bodyDigest: digest(d.body), status: d.status });
  const originalPath = path.join(root, String(original.metadata.originalPath)); const originalHash = createHash('sha256').update(await fs.readFile(originalPath)).digest('hex');
  const hashes = await snapshotRevisionHashes(root);
  // Ingest of the same bytes is idempotent, so use a different file for the in-flight ingest.
  const freshSource = path.join(root, 'in-flight.bin'); await fs.writeFile(freshSource, Buffer.from('in-flight source bytes'));

  const faulty = await runChild(`${faultPreamble(root, { stage: spec.stage, mode, ...(spec.after ? { after: spec.after } : {}) })}
try { ${opCode[op](patched.id, patched.revisionId, freshSource)} console.log('ACKED '+d.id); }
catch (e) { console.log('ERR '+(e.code??e.name)); process.exitCode=3; }`);
  const reached = mode === 'kill' ? faulty.signal === 'SIGKILL' : faulty.stdout.includes(`ERR ${mode === 'throw-eio' ? 'EIO' : 'ENOSPC'}`);
  assert.ok(reached, `fault ${spec.stage}/${mode} on ${op} was never reached: signal=${faulty.signal} out=${faulty.stdout} err=${faulty.stderr.slice(0, 300)}`);
  assert.ok(!faulty.stdout.includes('ACKED'), 'a faulted operation must not be acknowledged');

  // A reader that never runs recovery already sees only whole transactions.
  const eventsBefore = (await new Vault(root).events()).length;
  const recovered = await runChild(recoverySource(root));
  assert.equal(recovered.code, 0, recovered.stderr);
  const { first, second: again, d1, d2 } = JSON.parse(recovered.stdout.trim().split('\n').at(-1)!) as { first: { committed: number; repaired: number }; second: { repaired: number; committed: number }; d1: string; d2: string };
  assert.equal(again.repaired, 0, 'second recovery repairs nothing');
  assert.equal(d1, d2, 'recovery converges to an identical on-disk state');
  assert.equal(first.committed, again.committed);
  const eventsAfter = (await new Vault(root).events()).length;
  assert.equal(eventsAfter, eventsBefore, 'recovery never invents or drops committed transactions');

  const fresh = new Vault(root);
  const report = await verifyInvariants(fresh, { model, allowUnacknowledgedHead: spec.klass !== 'PRE', allowUnknownObjects: spec.klass === 'PRE' ? 0 : 1, revisionHashes: hashes });
  assert.deepEqual(report.issues, [], `${op}/${spec.stage}/${mode}`);
  const created = op === 'put' || op === 'ingest';
  const visible = created ? report.unknownObjects.length : report.ahead.length;
  if (spec.klass === 'PRE') assert.equal(visible, 0, 'uncommitted transaction must be invisible');
  if (spec.klass === 'POST') assert.equal(visible, 1, 'durable transaction must be visible after recovery');
  assert.ok(visible === 0 || visible === 1, 'transaction is all-or-nothing');
  // Immutable originals untouched.
  assert.equal(createHash('sha256').update(await fs.readFile(originalPath)).digest('hex'), originalHash);
  // Acknowledged data is readable; the store accepts new writes afterwards.
  assert.equal((await fresh.get(second.id)).body, 'ws body');
  const next = await fresh.put({ scope, kind: 'note', title: 'after recovery', body: 'writes continue' });
  assert.equal((await fresh.get(next.id)).body, 'writes continue');
  assert.equal((await fresh.verify()).ok, true);
  recordCase({ suite: 'acid-fault-matrix', name: `${op}/${spec.stage}/${mode}`, status: 'PASS', detail: { class: spec.klass, visible } });
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items]; const errors: unknown[] = [];
  await Promise.all(Array.from({ length: size }, async () => { for (let item = queue.shift(); item !== undefined; item = queue.shift()) { try { await work(item); } catch (e) { errors.push(e); recordCase({ suite: 'acid-fault-matrix', name: String((item as { name?: string }).name ?? 'case'), status: 'FAIL', detail: { error: String(e).slice(0, 500) } }); } } }));
  if (errors.length) throw errors[0];
}

test('fault matrix: put and patch × every fault point × kill / EIO / ENOSPC recover atomically in a fresh process', async t => {
  const cases: { name: string; op: Op; spec: (typeof stages)[number]; mode: Mode }[] = [];
  for (const op of ['put', 'patch'] as Op[]) for (const spec of stages) for (const mode of ['kill', 'throw-eio', 'throw-enospc'] as Mode[]) cases.push({ name: `${op}/${spec.stage}/${mode}`, op, spec, mode });
  await pool(cases, 4, c => runCase(t, c.op, c.spec, c.mode));
});

test('fault matrix: delete (tombstone) and ingest (original + manifest) × every fault point × kill', async t => {
  const cases: { name: string; op: Op; spec: (typeof stages)[number]; mode: Mode }[] = [];
  for (const op of ['delete', 'ingest'] as Op[]) for (const spec of stages) cases.push({ name: `${op}/${spec.stage}/kill`, op, spec, mode: 'kill' });
  await pool(cases, 4, c => runCase(t, c.op, c.spec, c.mode));
});

test('torn journal tail (simulated partial write) is discarded, committed records survive, and writing continues', async t => {
  const { root, vault } = await disposableVault(t);
  const scope = { type: 'global' as const, area: 'wiki' as const };
  const a = await vault.put({ scope, kind: 'note', title: 'a', body: 'a' });
  const killed = await runChild(`${faultPreamble(root, { stage: 'journal.before_append', mode: 'kill' })} await vault.put({scope:{type:'global',area:'wiki'},kind:'note',title:'b',body:'b'});`);
  assert.equal(killed.signal, 'SIGKILL');
  const journal = path.join(root, '.mdb/events/commits.jsonl');
  const record = JSON.stringify({ sequence: 2, transactionId: 'tx_torn', objectId: 'obj_torn', revisionId: 'rev_torn', path: 'wiki/notes/obj_torn.md', scope, operation: 'put', timestamp: new Date().toISOString() });
  for (const cut of [1, 10, Math.floor(record.length / 2), record.length - 1]) {
    await fs.writeFile(journal, (await fs.readFile(journal, 'utf8')).split('\n').filter(l => l && !l.includes('tx_torn')).join('\n') + '\n' + record.slice(0, cut));
    const recovered = await runChild(recoverySource(root));
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout.trim()).first.committed, 1, `cut at ${cut}`);
    assert.equal((await fs.readFile(journal, 'utf8')).includes('tx_torn'), false, 'torn bytes removed');
  }
  const b = await new Vault(root).put({ scope, kind: 'note', title: 'b2', body: 'b2' });
  assert.equal((await new Vault(root).events()).length, 2);
  assert.equal((await new Vault(root).get(a.id)).body, 'a'); assert.equal((await new Vault(root).get(b.id)).body, 'b2');
  assert.deepEqual((await verifyInvariants(new Vault(root))).issues, []);
  recordCase({ suite: 'acid-fault-matrix', name: 'torn-journal-tail', status: 'PASS' });
});

test('repeated kills during recovery itself still converge', async t => {
  const { root, vault } = await disposableVault(t);
  const scope = { type: 'global' as const, area: 'wiki' as const };
  const doc = await vault.put({ scope, kind: 'note', title: 'x', body: 'v1' });
  // Leave both projections stale: recovery now correctly skips a head write
  // when the journal head is already durable and current, so a view-only
  // interruption cannot reach recover.before_head_write on its next attempt.
  const killed = await runChild(`${faultPreamble(root, { stage: 'head.before_replace', mode: 'kill' })} await vault.patch({objectId:${JSON.stringify(doc.id)},expectedRevisionId:${JSON.stringify(doc.revisionId)},body:'v2'});`);
  assert.equal(killed.signal, 'SIGKILL');
  for (const stage of ['recover.before_view_repair', 'recover.before_head_write']) {
    const crash = await runChild(`${faultPreamble(root, { stage, mode: 'kill' })} await vault.recover();`);
    assert.equal(crash.signal, 'SIGKILL', `${stage} not reached: ${crash.stderr}`);
  }
  const done = await runChild(recoverySource(root)); assert.equal(done.code, 0, done.stderr);
  const result = JSON.parse(done.stdout.trim()); assert.equal(result.second.repaired, 0); assert.equal(result.d1, result.d2);
  assert.equal((await new Vault(root).get(doc.id)).body, 'v2');
  assert.deepEqual((await verifyInvariants(new Vault(root))).issues, []);
  const quarantine = await fs.readdir(path.join(root, '.mdb/quarantine')).catch(() => []);
  assert.equal(quarantine.length, 0, 'a crash-stale view is not mistaken for an external edit');
  recordCase({ suite: 'acid-fault-matrix', name: 'kill-during-recovery', status: 'PASS' });
});

test('view replacement denied (EACCES) after the commit point: the commit stays durable and the view is rebuilt', async t => {
  const { root, vault } = await disposableVault(t);
  const doc = await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'x', body: 'v1' });
  const failing = new Vault(root, undefined, { fault: s => { if (s === 'view.before_replace') { const e = new Error('denied') as NodeJS.ErrnoException; e.code = 'EACCES'; throw e; } } });
  await assert.rejects(failing.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, body: 'v2' }), { code: 'EACCES' });
  assert.equal((await new Vault(root).get(doc.id)).body, 'v2', 'readers see the durable commit without recovery');
  const r = await vault.recover(); assert.equal(r.repaired, 1);
  assert.equal(await fs.readFile(path.join(root, doc.path), 'utf8'), (await fs.readFile(path.join(root, `.mdb/objects/${doc.id}/revs/${(await vault.get(doc.id)).revisionId}.md`), 'utf8')));
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'acid-fault-matrix', name: 'view-eacces', status: 'PASS' });
});

test('post-journal ENOSPC retries with the same idempotency key return the one durable commit', async t => {
  const postCommitStages = [
    'journal.after_fsync', 'after_journal', 'after_journal_append', 'before_view',
    'before_view_update', 'head.before_replace', 'atomic.temp_written',
    'atomic.before_rename', 'atomic.after_rename', 'view.before_replace',
    'view.after_replace', 'commit.before_ack'
  ];
  for (const stage of postCommitStages) {
    const { root } = await disposableVault(t);
    let injected = false;
    const input = { scope: { type: 'global' as const, area: 'wiki' as const }, kind: 'note', title: `retry ${stage}`, body: 'durable once', idempotencyKey: `retry-${stage}` };
    const faulty = new Vault(root, undefined, { fault: point => {
      if (!injected && point === stage) {
        injected = true;
        const error = new Error(`simulated ENOSPC at ${stage}`) as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
    } });

    await assert.rejects(faulty.put(input), error => (error as NodeJS.ErrnoException).code === 'ENOSPC', stage);
    assert.equal(injected, true, `${stage} was reached`);

    const retry = await new Vault(root).put(input);
    const events = (await new Vault(root).events()).filter(event => event.idempotencyKey === input.idempotencyKey);
    assert.equal(events.length, 1, `${stage}: one journal event`);
    assert.equal(retry.id, events[0]!.objectId, `${stage}: retry returns committed object`);
    assert.equal(retry.revisionId, events[0]!.revisionId, `${stage}: retry returns committed revision`);
    assert.equal(retry.body, input.body);
    assert.deepEqual((await verifyInvariants(new Vault(root))).issues, [], `${stage}: durable state remains coherent`);
  }
  recordCase({ suite: 'acid-fault-matrix', name: 'post-journal-enospc-idempotent-retry', status: 'PASS', detail: { stages: postCommitStages } });
});

test('pre-authorization failure and rejected input leave no state behind', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('private', '', {});
  const before = await snapshotRevisionHashes(root); const eventsBefore = (await vault.events()).length;
  const outsider = new Vault(root, { actorId: 'x', permissions: [] });
  await assert.rejects(outsider.put({ scope: { type: 'workspace', workspaceId: 'private' }, kind: 'note', title: 't', body: 'b' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await assert.rejects(vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'Bad Kind', title: 't', body: 'b' }), { code: 'INVALID_INPUT' });
  const doc = await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 't', body: 'b' });
  await assert.rejects(vault.patch({ objectId: doc.id, expectedRevisionId: 'rev_stale', body: 'x' }), { code: 'CONFLICT' });
  assert.equal((await vault.events()).length, eventsBefore + 1);
  const after = await snapshotRevisionHashes(root); assert.equal(after.size, before.size + 1);
  recordCase({ suite: 'acid-fault-matrix', name: 'rejected-before-mutation', status: 'PASS' });
});
