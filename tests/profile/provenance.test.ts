import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { upsertTask, upsertNote } from '../../packages/memory/workspace-ops.js';
import { fetchProjection } from '../../packages/project-init.js';
import { Engram, MDBError, OWNER, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
const ws = (workspaceId: string): Scope => ({ type: 'workspace', workspaceId });
const profile: Scope = { type: 'global', area: 'profile' };
async function world(t: T) { const { root, vault } = await disposableVault(t); const client = new Engram(root, OWNER); for (const id of ['proj', 'other', 'personal']) await vault.createWorkspace(id, ''); return { root, vault, client }; }

test('provenance describes the writer of THAT revision: a later writer that supplies none does not inherit the earlier host, session or source file', async t => {
  const { client } = await world(t); const scope = ws('proj');
  await upsertTask(client, { scope, taskId: 'T-1', title: 'Rotate key', status: 'open', host: 'studio', sessionId: 'studio-seed-1', sourcePath: 'seed/notes.md', assignee: 'alice' });
  await upsertTask(client, { scope, taskId: 'T-1', title: 'Rotate key', status: 'in_progress' });
  const docs = async () => (await client.vault.listDocuments({ scopes: [scope] })).find(d => d.metadata.stableId === 'T-1')!;
  const second = await docs();
  assert.equal(second.revisionNumber, 2); assert.equal(second.metadata.host, undefined); assert.equal(second.metadata.sessionId, undefined); assert.equal(second.metadata.sourcePath, undefined);
  assert.equal(second.metadata.assignee, 'alice', 'domain fields (assignee) are partial-update fields and are kept');
  const first = await client.vault.get(second.id, (await client.vault.history(second.id))[0]!.revisionId); assert.equal(first.metadata.host, 'studio', 'the earlier revision still records its own writer');
  await upsertTask(client, { scope, taskId: 'T-1', title: 'Rotate key', status: 'done', host: 'codex', sessionId: 'codex-s9' });
  const third = await docs(); assert.equal(third.metadata.host, 'codex'); assert.equal(third.metadata.sessionId, 'codex-s9'); assert.equal(third.metadata.sourcePath, undefined);
  await upsertNote(client, { scope, noteId: 'plans/x', title: 'Plan', body: 'one', host: 'studio', sessionId: 's1' }); await upsertNote(client, { scope, noteId: 'plans/x', title: 'Plan', body: 'two' });
  const note = (await client.vault.listDocuments({ scopes: [scope] })).find(d => d.metadata.stableId === 'plans/x')!; assert.equal(note.metadata.host, undefined); assert.equal(note.metadata.sessionId, undefined);
  recordCase({ suite: 'profile', name: 'provenance-not-inherited', status: 'PASS' });
});

test('metadataRemove cannot touch protected keys and is part of the idempotency payload', async t => {
  const { client } = await world(t); const doc = await client.put({ scope: ws('proj'), kind: 'note', title: 'n', body: 'b', metadata: { keep: 1, drop: 2 } });
  await assert.rejects(client.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataRemove: ['_idempotency'] }), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT');
  const patched = await client.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataRemove: ['drop'], idempotencyKey: 'k1' });
  assert.equal(patched.metadata.drop, undefined); assert.equal(patched.metadata.keep, 1);
  await assert.rejects(client.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, idempotencyKey: 'k1' }), /Idempotency key was already used/, 'the same key with a different removal list is a different operation');
  recordCase({ suite: 'profile', name: 'metadata-remove-protected', status: 'PASS' });
});

const insight = (client: Engram, body: string, scopeLabel: string | undefined, extra: { status?: string; sensitivity?: string } = {}) => client.put({ scope: profile, kind: 'user_insight', title: body.slice(0, 40), body, status: extra.status ?? 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: body.slice(0, 12), evidenceClass: 'explicit', visibility: 'user_private', sensitivity: extra.sensitivity ?? 'none', ...(scopeLabel ? { scopeLabel } : {}) } });

test('what a project job shows the model as goals: only accepted, non-sensitive insights labelled for that project or global', async t => {
  const { client, vault } = await world(t);
  await insight(client, 'GOAL-GLOBAL-ok accepted global insight.', undefined); await insight(client, 'GOAL-PROJ-ok accepted proj insight.', 'proj');
  await insight(client, 'GOAL-OTHER-LEAK accepted insight of another project.', 'other'); await insight(client, 'GOAL-PERSONAL-LEAK accepted personal insight.', 'personal');
  await insight(client, 'GOAL-SENSITIVE-LEAK sensitive proj insight.', 'proj', { sensitivity: 'sensitive' }); await insight(client, 'GOAL-CANDIDATE-LEAK unreviewed proj guess.', 'proj', { status: 'candidate' });
  const said = await vault.put({ scope: ws('proj'), kind: 'observation', title: 'User message', body: 'I like narrow functions.', metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message' } });
  const calls: ModelRequest[] = []; const provider: ModelProvider = { id: 'spy', async generate(request) { calls.push(request); return { kind: 'no_insight', title: 'No insight', body: 'Nothing.', evidence: [] }; } };
  const engine = new IntelligenceEngine(vault, provider); await engine.enqueue('profile', { scope: ws('proj'), objectIds: [said.id] }); await engine.run({ job: 'profile', limit: 1 });
  const goals = calls[0]!.goals;
  assert.match(goals, /GOAL-GLOBAL-ok/); assert.match(goals, /GOAL-PROJ-ok/);
  for (const leak of ['GOAL-OTHER-LEAK', 'GOAL-PERSONAL-LEAK', 'GOAL-SENSITIVE-LEAK', 'GOAL-CANDIDATE-LEAK']) assert.ok(!JSON.stringify(calls).includes(leak), `${leak} reached the model`);
  recordCase({ suite: 'profile', name: 'goals-scoped-to-job', status: 'PASS' });
});

test('promotion boundaries: a project insight, a candidate and a sensitive insight never reach global or another project\'s injection', async t => {
  const { client } = await world(t);
  await insight(client, 'PROJ-A-ONLY accepted insight for proj.', 'proj'); await insight(client, 'OTHER-ONLY accepted insight for other.', 'other'); await insight(client, 'GLOBAL-OK accepted global insight.', undefined);
  await insight(client, 'CANDIDATE-NEVER unreviewed.', 'proj', { status: 'candidate' }); await insight(client, 'SENSITIVE-NEVER private.', undefined, { sensitivity: 'sensitive' });
  const claims = async (workspace: string) => (await fetchProjection({ client }, workspace, 900)).preferences.concat((await fetchProjection({ client }, workspace, 900)).insights).map(i => i.claim).join(' | ');
  const proj = await claims('proj'), other = await claims('other'), unrelated = await claims('personal');
  assert.match(proj, /PROJ-A-ONLY/); assert.match(proj, /GLOBAL-OK/); assert.ok(!/OTHER-ONLY/.test(proj));
  assert.match(other, /OTHER-ONLY/); assert.ok(!/PROJ-A-ONLY/.test(other)); assert.match(unrelated, /GLOBAL-OK/); assert.ok(!/PROJ-A-ONLY|OTHER-ONLY/.test(unrelated), 'a project with no insights of its own sees only global ones');
  for (const text of [proj, other, unrelated]) assert.ok(!/CANDIDATE-NEVER|SENSITIVE-NEVER/.test(text), 'candidates and sensitive insights are never injected');
  const globalList = (await client.memory.insights({ status: 'accepted', scopeLabel: 'global', limit: 100 })).insights.map(i => i.claim).join(' | ');
  assert.ok(!/PROJ-A-ONLY|OTHER-ONLY|CANDIDATE/.test(globalList), 'project-labelled insights are not in the global list');
  recordCase({ suite: 'profile', name: 'promotion-boundaries', status: 'PASS' });
});

test('a proposal from a project job keeps its scope label, evidence lineage and review status through approval, and is not promoted to global', async t => {
  const { client, vault } = await world(t);
  const said = await vault.put({ scope: ws('proj'), kind: 'observation', title: 'User message', body: 'For this repo always run make check before a PR.', metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message' } });
  const provider: ModelProvider = { id: 'one', async generate() { return { kind: 'user_insight', title: 'make check', body: 'The user wants make check run before a PR in this repo.', evidence: [{ uri: said.uri, revisionId: said.revisionId, span: 'always run make check before a PR' }], metadata: { category: 'preference', preferenceKey: 'make-check', sensitivity: 'none', explicitStatement: true } }; } };
  const engine = new IntelligenceEngine(vault, provider); await engine.enqueue('profile', { scope: ws('proj'), objectIds: [said.id] }); await engine.run({ job: 'profile', limit: 1 });
  const proposal = (await engine.proposals()).find(p => p.input.kind === 'user_insight')!;
  assert.equal(proposal.status, 'pending'); assert.equal(proposal.input.metadata!.scopeLabel, 'proj'); assert.equal(proposal.input.evidence![0]!.uri, said.uri);
  const approved = await engine.review(proposal.id, true, 'ok'); const doc = await vault.get(approved.objectId!);
  assert.equal(doc.status, 'accepted'); assert.equal(doc.metadata.scopeLabel, 'proj'); assert.equal(doc.evidence[0]!.revisionId, said.revisionId);
  assert.equal((await client.memory.insights({ status: 'accepted', scopeLabel: 'global' })).insights.length, 0, 'not promoted to global');
  assert.match((await fetchProjection({ client }, 'proj', 900)).preferences.map(i => i.claim).join(' '), /make check/); assert.ok(!(await fetchProjection({ client }, 'other', 900)).preferences.some(i => /make check/.test(i.claim)));
  recordCase({ suite: 'profile', name: 'derived-insight-lineage-and-scope', status: 'PASS' });
});
