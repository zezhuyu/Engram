import test from 'node:test';
import assert from 'node:assert/strict';
import { Engram } from '../../packages/sdk/index.js';
import { MDBError, type Scope } from '../../packages/core/types.js';
import { MAX_TYPED_BODY_BYTES, upsertNote, upsertTask, writeHandoff } from '../../packages/memory/workspace-ops.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

const scope: Scope = { type: 'workspace', workspaceId: 'proj' };
async function owner(t: Parameters<typeof disposableVault>[0]) { const { root } = await disposableVault(t); const client = new Engram(root); await client.createWorkspace('proj'); return { root, client }; }

test('a task is one object with revisions: a changed update patches, an identical update and a replay add nothing', async t => {
  const { client } = await owner(t);
  const first = await upsertTask(client, { scope, taskId: 'T-1', title: 'Wire resolver', status: 'open', body: 'Start with tests.' });
  assert.equal(first.persistence, 'COMMITTED'); assert.equal(first.created, true); assert.equal(first.revisionNumber, 1);
  const again = await upsertTask(client, { scope, taskId: 'T-1', title: 'Wire resolver', status: 'open', body: 'Start with tests.' });
  assert.equal(again.unchanged, true); assert.equal(again.objectId, first.objectId); assert.equal(again.revisionId, first.revisionId, 'identical content never creates a revision');
  const done = await upsertTask(client, { scope, taskId: 'T-1', title: 'Wire resolver', status: 'done', body: 'Start with tests.\nShipped.', evidence: [] });
  assert.equal(done.objectId, first.objectId, 'same stable id, same object'); assert.equal(done.revisionNumber, 2); assert.equal(done.created, false);
  const replay = await upsertTask(client, { scope, taskId: 'T-1', title: 'Wire resolver', status: 'done', body: 'Start with tests.\nShipped.' });
  assert.equal(replay.revisionId, done.revisionId, 'replaying the same update returns the same revision');
  const tasks = (await client.listDocuments()).filter(d => d.kind === 'task');
  assert.equal(tasks.length, 1, 'no duplicate task object'); assert.equal(tasks[0]!.metadata.taskStatus, 'done'); assert.ok(tasks[0]!.tags.includes('status:done'));
  recordCase({ suite: 'memory', name: 'typed-task-upsert-revisions', status: 'PASS' });
});

test('a stale expected revision is merged or becomes a conflict note, never an overwrite; two tasks stay separate', async t => {
  const { client } = await owner(t);
  const a = await upsertTask(client, { scope, taskId: 'T-2', title: 'Task two', status: 'open' });
  await upsertTask(client, { scope, taskId: 'T-2', title: 'Task two', status: 'in_progress' });
  // Design change: the server no longer refuses a stale expectedRevisionId, it merges (see offline-merge.test.ts). The same field changed differently on both sides is a conflict note, and the record is untouched.
  const stale = await upsertTask(client, { scope, taskId: 'T-2', title: 'Task two', status: 'blocked', expectedRevisionId: a.revisionId }); assert.equal(stale.merge?.outcome, 'CONFLICT');
  assert.equal((await client.vault.get(a.objectId)).metadata.taskStatus, 'in_progress', 'the server version was not overwritten');
  const other = await upsertTask(client, { scope, taskId: 'T-3', title: 'Task three', status: 'open' });
  assert.notEqual(other.objectId, a.objectId);
  assert.equal((await client.listDocuments()).filter(d => d.kind === 'task').length, 2);
});

test('a note keeps its full contents (well past the 800-character capture excerpt), records provenance and redacts secrets', async t => {
  const { client } = await owner(t);
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} of the investigation`).join('\n');
  assert.ok(body.length > 8000);
  const saved = await upsertNote(client, { scope, noteId: 'notes/investigation.md', title: 'Investigation', body, sourcePath: 'notes/investigation.md', host: 'claude-code', sessionId: 'sess-1' });
  const doc = await client.vault.get(saved.objectId);
  assert.equal(doc.body, body, 'exact intended contents, no truncation');
  assert.equal(doc.metadata.sourcePath, 'notes/investigation.md'); assert.equal(doc.metadata.host, 'claude-code'); assert.equal(doc.metadata.sessionId, 'sess-1'); assert.match(String(doc.metadata.contentHash), /^[0-9a-f]{64}$/);
  const secret = await upsertNote(client, { scope, noteId: 'n2', title: 'With a secret', body: 'deploy with api_key=sk-abcdefghijklmnop and Bearer abcdefghijklmnop1234' });
  const redacted = await client.vault.get(secret.objectId);
  assert.doesNotMatch(redacted.body, /sk-abcdefghijklmnop|abcdefghijklmnop1234/); assert.ok(secret.redactions > 0);
});

test('size limits and invalid ids are refused before anything is committed', async t => {
  const { client } = await owner(t);
  await assert.rejects(upsertNote(client, { scope, noteId: 'big', title: 'Too big', body: 'x'.repeat(MAX_TYPED_BODY_BYTES + 1) }), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT');
  for (const id of ['', '../escape', 'has space', 'x'.repeat(200)]) await assert.rejects(upsertTask(client, { scope, taskId: id, title: 't', status: 'open' }), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT', id);
  await assert.rejects(upsertTask(client, { scope, taskId: 'T-9', title: 't', status: 'finished' as never }), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT');
  assert.equal((await client.listDocuments()).length, 0);
});

test('a handoff records what the agent reported; interrupted work is never turned into a successful handoff', async t => {
  const { client } = await owner(t);
  const ended = await writeHandoff(client, { scope, sessionId: 'sess-9', state: 'ended', completed: ['resolver'], next: ['init'], blockers: [], filesTouched: ['packages/mcp/index.ts'], openTasks: ['T-1'] });
  const doc = await client.vault.get(ended.objectId);
  assert.equal(doc.kind, 'handoff'); assert.equal(doc.metadata.handoffState, 'ended'); assert.match(doc.body, /resolver/); assert.match(doc.body, /packages\/mcp\/index\.ts/);
  // a session that was started and observed but never ended leaves no handoff behind
  const session = await client.sessionStart({ scope }); await client.observe({ sessionId: session.id, body: 'worked on the resolver' } as never);
  const handoffs = (await client.listDocuments()).filter(d => d.kind === 'handoff');
  assert.equal(handoffs.length, 1, 'only the explicitly written handoff exists');
  await assert.rejects(writeHandoff(client, { scope, sessionId: 'sess-x', state: 'interrupted', completed: ['everything'], next: [], blockers: [], filesTouched: [], openTasks: [] }), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT', 'an interrupted handoff may not claim completed work');
});

test('an actor without write access cannot create typed records, and no record appears', async t => {
  const { root, client } = await owner(t);
  const outsider = new Engram(root, { actorId: 'outsider', permissions: [] });
  await assert.rejects(upsertTask(outsider, { scope, taskId: 'T-5', title: 'nope', status: 'open' }), (e: unknown) => e instanceof MDBError && e.code === 'NOT_FOUND_OR_FORBIDDEN');
  assert.equal((await client.listDocuments()).length, 0);
  await client.grant('proj', 'reader', ['read']);
  const reader = new Engram(root, { actorId: 'reader', permissions: [] });
  await assert.rejects(upsertNote(reader, { scope, noteId: 'n', title: 'read only', body: 'x' }), (e: unknown) => e instanceof MDBError);
  assert.equal((await client.listDocuments()).length, 0);
});
