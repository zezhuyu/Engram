import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchEngine } from '../../packages/search-files/index.js';
import { buildPack } from '../dream/pack.js';
import { recordCase } from '../helpers/report.js';
import { world } from './helpers.js';

test('events committed after the sealed watermark never reach Stage A or Stage B, stay visible to foreground reads, and are picked up by the next cycle', async t => {
  const w = await world(t); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  let late: Awaited<ReturnType<typeof w.say>> | undefined; w.provider.onProfile = async () => { late ??= await w.say('alpha', 'LATEMARKER I prefer Rust for tools [key:late]'); };
  const first = await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'seal-1', respectActivity: false }); const c1 = first.cycle!;
  assert.equal(c1.state, 'COMPLETED', JSON.stringify({ state: c1.state, error: c1.error, ws: c1.workspaces, dream: c1.dream.error }));
  const lateSeq = (await w.vault.events()).find(e => e.objectId === late!.id)!.sequence; assert.ok(lateSeq > c1.watermark, 'the late commit is after W');
  const requestText = JSON.stringify(w.provider.calls.map(c => [c.documents.map(d => [d.id, d.body]), c.instruction, c.goals]));
  assert.ok(!requestText.includes('LATEMARKER') && !requestText.includes(late!.id), 'no model request contains W+1 material (Stage A or Stage B)');
  assert.equal((await w.vault.get(late!.id)).id, late!.id, 'foreground read sees it');
  assert.ok((await new SearchEngine(w.vault).query({ query: 'LATEMARKER', mode: 'grep' })).hits.length >= 1, 'foreground search sees it');
  const second = await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'seal-2', respectActivity: false }); assert.equal(second.cycle!.state, 'COMPLETED', JSON.stringify(second.cycle!.error));
  assert.ok(w.provider.profileCalls().some(c => JSON.stringify(c.documents).includes('LATEMARKER')), 'the late event is eligible in the next cycle');
  assert.equal(second.cycle!.workspaces.alpha!.fromSequenceExclusive, c1.watermark, 'cursor advanced exactly to the previous watermark');
  recordCase({ suite: 'adaptive', name: 'snapshot-fence-w-plus-n', status: 'PASS' });
});

test('Stage B sees accepted Stage A output but never W+1 evidence or its own output as a source', async t => {
  const w = await world(t); await buildPack(w.vault); const said = await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  const run = await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'ab-1', respectActivity: false }); const c = run.cycle!; assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  assert.equal(c.workspaces.alpha!.accepted.length, 1, 'low-risk explicit insight accepted');
  const accepted = c.workspaces.alpha!.accepted[0]!; assert.ok(c.permittedDerived.some(o => o.objectId === accepted.objectId && o.stage === 'WORKSPACE_INSIGHT'));
  const dreamDocs = w.provider.dreamCalls().flatMap(call => call.documents);
  assert.ok(dreamDocs.every(d => d.kind !== 'discovery'), 'a discovery is never a source');
  assert.ok(dreamDocs.every(d => d.id !== said.id || d.revisionId === said.revisionId), 'sealed revisions only');
  assert.equal(c.dream.status, 'SUCCEEDED'); assert.ok(c.dream.corpusVisibility && c.dream.corpusVisibility.watermark === c.watermark && c.dream.corpusVisibility.permittedDerived.some(o => o.objectId === accepted.objectId));
  recordCase({ suite: 'adaptive', name: 'stage-b-inputs', status: 'PASS' });
});

test('Stage A failure prevents Stage B; Stage B failure resumes without rerunning successful Stage A', async t => {
  const w = await world(t); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  w.provider.profileFails = () => new Error('simulated stage A failure');
  const a = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'fail-a', respectActivity: false })).cycle!;
  assert.ok(['RETRY_WAIT', 'BLOCKED'].includes(a.state), a.state); assert.equal(w.provider.dreamCalls().length, 0, 'Dream never started'); assert.equal(a.dream.status, 'PENDING'); assert.equal(a.global.status, 'PENDING');
  assert.equal((await w.ai.store.cursors()).workspaces.alpha ?? 0, 0, 'the failed workspace cursor did not advance');
  delete w.provider.profileFails; const profileCallsAfterFailure = w.provider.profileCalls().length;
  const w2 = await world(t); await buildPack(w2.vault); await w2.say('alpha', 'I prefer TypeScript for services [key:lang]');
  let dreamAttempts = 0; w2.provider.dreamFails = () => (++dreamAttempts <= 1 ? new Error('simulated stage B failure') : undefined);
  const b1 = (await w2.ai.runCycle({ kind: 'manual', idempotencyKey: 'fail-b', respectActivity: false })).cycle!; assert.ok(['RETRY_WAIT', 'BLOCKED'].includes(b1.state), `${b1.state} ${JSON.stringify(b1.dream.error)}`);
  assert.equal(b1.workspaces.alpha!.status, 'SUCCEEDED'); const profileBefore = w2.provider.profileCalls().length; const insightsBefore = (await w2.vault.listDocuments()).filter(d => d.kind === 'user_insight').length;
  const b2 = (await w2.ai.resumeCycle(b1.id, { respectActivity: false })).cycle!; assert.equal(b2.state, 'COMPLETED', JSON.stringify({ e: b2.error, d: b2.dream.error }));
  assert.equal(w2.provider.profileCalls().length, profileBefore, 'successful Stage A was not rerun'); assert.equal((await w2.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, insightsBefore, 'no duplicate insight');
  void profileCallsAfterFailure; recordCase({ suite: 'adaptive', name: 'stage-failure-semantics', status: 'PASS' });
});
