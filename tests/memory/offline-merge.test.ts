import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Engram, type Scope } from '../../packages/sdk/index.js';
import { offlineFromAsOf, upsertNote, upsertTask, writeHandoff, type OfflineWrite } from '../../packages/memory/workspace-ops.js';

type T = { after(fn: () => void | Promise<void>): void };
const scope: Scope = { type: 'workspace', workspaceId: 'w' };
async function world(t: T) { const { root } = await disposableVault(t); const client = new Engram(root); await client.createWorkspace('w'); return client; }
const record = async (client: Engram, stableId: string) => (await client.vault.listDocuments({ scopes: [scope] })).find(d => d.metadata.stableId === stableId)!;
const offline = (entryId: string, extra: Partial<OfflineWrite> = {}): OfflineWrite => ({ entryId, queuedAt: '2026-10-13T01:00:00.000Z', ...extra });
const PLAN = ['# Plan', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5', ''].join('\n');

test('a note edited offline merges with a different part edited on the server meanwhile: both changes survive as one new revision', async t => {
  const c = await world(t); const base = await upsertNote(c, { scope, noteId: 'plan', title: 'Plan', body: PLAN });
  await upsertNote(c, { scope, noteId: 'plan', title: 'Plan', body: PLAN.replace('step 5', 'step 5 (server edit)') }); // somebody else, while the client was disconnected
  const local = PLAN.replace('step 1', 'step 1 (offline edit)');
  const result = await upsertNote(c, { scope, noteId: 'plan', title: 'Plan', body: local, offline: offline('entry-0001', { baseRevisionId: base.revisionId }) });
  assert.equal(result.merge!.outcome, 'MERGED'); assert.equal(result.merge!.baseRevisionId, base.revisionId);
  const doc = await record(c, 'plan'); assert.equal(doc.body, PLAN.replace('step 1', 'step 1 (offline edit)').replace('step 5', 'step 5 (server edit)')); assert.equal(result.merge!.body, doc.body);
  assert.equal(doc.revisionNumber, 3); assert.equal((doc.metadata.merge as { outcome: string }).outcome, 'MERGED'); assert.equal((await c.vault.history(doc.id)).length, 3, 'history keeps the base, the server edit and the merge');
  recordCase({ suite: 'memory', name: 'offline-merge-note-clean', status: 'PASS' });
});

test('replaying the same queued write is idempotent, also after the record has moved on', async t => {
  const c = await world(t); const base = await upsertNote(c, { scope, noteId: 'n', title: 'N', body: PLAN });
  await upsertNote(c, { scope, noteId: 'n', title: 'N', body: PLAN.replace('step 5', 'step 5 (server)') });
  const write = { scope, noteId: 'n', title: 'N', body: PLAN.replace('step 1', 'step 1 (local)'), offline: offline('entry-0002', { baseRevisionId: base.revisionId }) };
  const first = await upsertNote(c, write); await upsertNote(c, { scope, noteId: 'n', title: 'N', body: (await record(c, 'n')).body + 'later line\n' });
  const again = await upsertNote(c, write); assert.equal(again.merge!.outcome, 'ALREADY_APPLIED'); assert.equal(again.revisionId, first.revisionId, 'a replay after the head moved returns the original applied revision'); assert.equal(again.created, false); assert.equal(again.unchanged, true);
  const doc = await record(c, 'n'); assert.equal(doc.revisionNumber, 4, 'the replay added no revision'); assert.ok(first.merge!.outcome === 'MERGED');
  recordCase({ suite: 'memory', name: 'offline-merge-idempotent', status: 'PASS' });
});

test('overlapping edits keep the server record untouched and store the whole conflict (markers plus the complete local version) as a conflict note; a replay does not add another', async t => {
  const c = await world(t); const base = await upsertNote(c, { scope, noteId: 'c', title: 'C', body: PLAN });
  await upsertNote(c, { scope, noteId: 'c', title: 'C', body: PLAN.replace('step 3', 'step 3 (server)') });
  const write = { scope, noteId: 'c', title: 'C', body: PLAN.replace('step 3', 'step 3 (local)'), offline: offline('entry-0003', { baseRevisionId: base.revisionId }) };
  const result = await upsertNote(c, write); assert.equal(result.merge!.outcome, 'CONFLICT'); assert.deepEqual(result.merge!.conflictingFields, ['body']);
  const head = await record(c, 'c'); assert.equal(head.body, PLAN.replace('step 3', 'step 3 (server)'), 'the server version was not changed'); assert.equal(head.revisionNumber, 2);
  const note = (await c.vault.listDocuments({ scopes: [scope] })).find(d => d.metadata.stableId === result.merge!.conflictNoteId)!; assert.ok(note.tags.includes('conflict'));
  for (const piece of ['<<<<<<< local (offline write 2026-10-13T01:00:00.000Z)', '||||||| revision 1', 'step 3 (local)', 'step 3 (server)', '>>>>>>> server (revision 2', 'Complete local version']) assert.ok(note.body.includes(piece), piece);
  const again = await upsertNote(c, write); assert.equal(again.merge!.outcome, 'CONFLICT'); assert.equal((await c.vault.listDocuments({ scopes: [scope] })).filter(d => d.tags.includes('conflict')).length, 1, 'one conflict note, not one per replay');
  recordCase({ suite: 'memory', name: 'offline-merge-conflict-note', status: 'PASS' });
});

test('tasks merge field by field: status changed on the server and body changed offline both survive; the same field changed differently on both sides is a conflict', async t => {
  const c = await world(t); const base = await upsertTask(c, { scope, taskId: 'T-1', title: 'Rotate key', status: 'open', body: 'Owner: alice.\nWaiting for the key.' });
  await upsertTask(c, { scope, taskId: 'T-1', title: 'Rotate key', status: 'in_progress', body: 'Owner: alice.\nWaiting for the key.' });
  const merged = await upsertTask(c, { scope, taskId: 'T-1', title: 'Rotate key', status: 'open', body: 'Owner: alice.\nWaiting for the key.\nNote from offline agent.', offline: offline('entry-0004', { baseRevisionId: base.revisionId }) });
  assert.equal(merged.merge!.outcome, 'MERGED'); const doc = await record(c, 'T-1');
  assert.equal(doc.metadata.taskStatus, 'in_progress', 'the offline side did not touch the status, so the server\'s change stays'); assert.match(doc.body, /Note from offline agent/); assert.ok(doc.tags.includes('status:in_progress') && !doc.tags.includes('status:open'));
  const clash = await upsertTask(c, { scope, taskId: 'T-1', title: 'Rotate key', status: 'blocked', body: doc.body, offline: offline('entry-0005', { baseRevisionId: base.revisionId }) }); // base said open; offline says blocked; server says in_progress
  assert.equal(clash.merge!.outcome, 'CONFLICT'); assert.ok(clash.merge!.conflictingFields!.includes('taskStatus')); assert.equal((await record(c, 'T-1')).metadata.taskStatus, 'in_progress');
  recordCase({ suite: 'memory', name: 'offline-merge-task-fields', status: 'PASS' });
});

test('the base is found from the server time of the last contact when the client does not know a revision id; an old stale expectedRevisionId is a base, not a hard conflict', async t => {
  const c = await world(t); const r1 = await upsertNote(c, { scope, noteId: 't', title: 'T', body: PLAN }); await new Promise(r => setTimeout(r, 30));
  await upsertNote(c, { scope, noteId: 't', title: 'T', body: PLAN.replace('step 5', 'step 5 (server)') });
  const rev1 = (await c.vault.history((await record(c, 't')).id))[0]!; const serverTime = new Date(Date.parse(rev1.updatedAt) + 1005).toISOString(); // last contact: just after revision 1 (the merge allows one second of clock slack)
  const byTime = await upsertNote(c, { scope, noteId: 't', title: 'T', body: PLAN.replace('step 1', 'step 1 (local)'), offline: offline('entry-0006', { serverTime }) });
  assert.equal(byTime.merge!.outcome, 'MERGED'); assert.equal(byTime.merge!.baseRevisionId, r1.revisionId); assert.match((await record(c, 't')).body, /step 1 \(local\)[\s\S]*step 5 \(server\)/);
  const stale = await upsertNote(c, { scope, noteId: 't', title: 'T', body: (await record(c, 't')).body + 'extra\n', expectedRevisionId: r1.revisionId, offline: offline('entry-0007') });
  assert.notEqual(stale.merge!.outcome, undefined); // no CONFLICT error: the stale expected revision was used as the merge base
  recordCase({ suite: 'memory', name: 'offline-merge-base-lookup', status: 'PASS' });
});

test('a record created on the server while the client was offline (both sides added it) merges only if the content agrees; fast-forward and provenance rules still hold', async t => {
  const c = await world(t);
  await upsertNote(c, { scope, noteId: 'both', title: 'Both', body: 'server version\n', host: 'studio', sessionId: 's-1' });
  const clash = await upsertNote(c, { scope, noteId: 'both', title: 'Both', body: 'offline version\n', offline: offline('entry-0008', { serverTime: '2026-01-01T00:00:00.000Z' }) });
  assert.equal(clash.merge!.outcome, 'CONFLICT', 'two different first versions of the same record');
  const base = await upsertNote(c, { scope, noteId: 'ff', title: 'FF', body: 'one\n', host: 'studio', sessionId: 's-1' });
  const ff = await upsertNote(c, { scope, noteId: 'ff', title: 'FF', body: 'one\ntwo\n', host: 'claude-code', offline: offline('entry-0009', { baseRevisionId: base.revisionId }) });
  assert.equal(ff.merge!.outcome, 'FAST_FORWARD'); const doc = await record(c, 'ff'); assert.equal(doc.body, 'one\ntwo\n'); assert.equal(doc.metadata.host, 'claude-code'); assert.equal(doc.metadata.sessionId, undefined, 'the earlier writer\'s session is not inherited');
  const h = await writeHandoff(c, { scope, sessionId: 'sess-a', state: 'ended', completed: ['a'], next: ['b'], blockers: [], filesTouched: [], openTasks: [], offline: offline('entry-0010') });
  assert.equal(h.merge, undefined, 'a first write of a record that does not exist yet is just created');
  recordCase({ suite: 'memory', name: 'offline-merge-created-meanwhile-and-fast-forward', status: 'PASS' });
});

test('natively, for every client (no offline proxy involved): a write that names the revision it was based on is merged by the server when the record has moved; one that names none keeps the plain update behaviour', async t => {
  const c = await world(t); const base = await upsertNote(c, { scope, noteId: 'native', title: 'Native', body: PLAN });
  await upsertNote(c, { scope, noteId: 'native', title: 'Native', body: PLAN.replace('step 5', 'step 5 (other client)') });
  const merged = await upsertNote(c, { scope, noteId: 'native', title: 'Native', body: PLAN.replace('step 1', 'step 1 (this client)'), expectedRevisionId: base.revisionId });
  assert.equal(merged.merge!.outcome, 'MERGED'); assert.equal((await record(c, 'native')).body, PLAN.replace('step 1', 'step 1 (this client)').replace('step 5', 'step 5 (other client)'));
  const clash = await upsertNote(c, { scope, noteId: 'native', title: 'Native', body: PLAN.replace('step 5', 'step 5 (clash)'), expectedRevisionId: base.revisionId });
  assert.equal(clash.merge!.outcome, 'CONFLICT'); assert.match((await record(c, 'native')).body, /step 5 \(other client\)/, 'the other client\'s text is still there');
  const plain = await upsertNote(c, { scope, noteId: 'native', title: 'Native', body: 'no base information: replaces as before\n' }); assert.equal(plain.merge, undefined); assert.equal((await record(c, 'native')).body, 'no base information: replaces as before\n');
  recordCase({ suite: 'memory', name: 'native-server-merge-stale-expected-revision', status: 'PASS' });
});

test('the server compares timestamps first: a write carrying only the server-clock time its copy was current at is merged against the record as of that time', async t => {
  const c = await world(t); await upsertNote(c, { scope, noteId: 'timed', title: 'T', body: PLAN }); await new Promise(r => setTimeout(r, 30));
  const rev1 = (await c.vault.history((await record(c, 'timed')).id))[0]!; await upsertNote(c, { scope, noteId: 'timed', title: 'T', body: PLAN.replace('step 5', 'step 5 (later, elsewhere)') });
  const asOf = new Date(Date.parse(rev1.updatedAt) + 1005).toISOString(); const result = await upsertNote(c, { scope, noteId: 'timed', title: 'T', body: PLAN.replace('step 2', 'step 2 (mine)'), offline: offlineFromAsOf(asOf) });
  assert.equal(result.merge!.outcome, 'MERGED'); assert.match((await record(c, 'timed')).body, /step 2 \(mine\)[\s\S]*step 5 \(later, elsewhere\)/);
  recordCase({ suite: 'memory', name: 'native-server-merge-as-of-timestamp', status: 'PASS' });
});
