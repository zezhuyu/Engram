import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { IntelligenceEngine, PROFILE_MAX_INSIGHTS } from '../../packages/intelligence/index.js';
import { MDBError, type Document, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
const proj: Scope = { type: 'workspace', workspaceId: 'proj' };
async function world(t: T) {
  const { vault } = await disposableVault(t); await vault.createWorkspace('proj', ''); await vault.createWorkspace('private', '');
  const said = (body: string, scope: Scope = proj, at = '2026-10-07T10:00:00.000Z') => vault.put({ scope, kind: 'observation', title: 'User message', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime: at } });
  return { vault, said };
}
type Step = { claim: string; key: string; doc: Document; span: string } | 'abstain' | Error;
/** A provider that answers from a script, one step per call, and records every request. */
function scripted(steps: Step[]): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return { id: 'scripted', calls, async generate(request) {
    calls.push(request); const step = steps.shift() ?? 'abstain';
    if (step instanceof Error) throw step;
    if (step === 'abstain') return { kind: 'no_insight', title: 'No insight', body: 'Nothing further is stated.', evidence: [] };
    return { kind: 'user_insight', title: step.claim.slice(0, 80), body: step.claim, evidence: [{ uri: step.doc.uri, revisionId: step.doc.revisionId, span: step.span }], metadata: { category: 'preference', preferenceKey: step.key, sensitivity: 'none', explicitStatement: true } };
  } };
}
const FOUR = 'From now on write commit messages in the imperative mood. Always run the linter before committing. I prefer small pull requests. Use tabs, never spaces, in Go files.';
const four = (doc: Document): Step[] => [
  { claim: 'The user wants commit messages in the imperative mood.', key: 'commit-mood', doc, span: 'write commit messages in the imperative mood' },
  { claim: 'The user always runs the linter before committing.', key: 'lint-first', doc, span: 'Always run the linter before committing' },
  { claim: 'The user prefers small pull requests.', key: 'pr-size', doc, span: 'I prefer small pull requests' },
  { claim: 'The user wants tabs, never spaces, in Go files.', key: 'go-tabs', doc, span: 'Use tabs, never spaces, in Go files' }
];
const run = async (engine: IntelligenceEngine) => { await engine.enqueue('profile', { scope: proj, incremental: true }); const [job] = await engine.run({ job: 'profile', limit: 1 }); return job!; };
const pendingInsights = async (engine: IntelligenceEngine) => (await engine.proposals()).filter(p => p.input.kind === 'user_insight' && p.status === 'pending');

test('the observed four-preference batch yields four independent, separately cited proposals; the cursor waits until the model says nothing more remains', async t => {
  const w = await world(t); const message = await w.said(FOUR);
  const provider = scripted(four(message)); const engine = new IntelligenceEngine(w.vault, provider);
  const job1 = await run(engine);
  assert.equal(job1.status, 'complete'); assert.equal(PROFILE_MAX_INSIGHTS, 4);
  const proposals = await pendingInsights(engine); assert.equal(proposals.length, 4);
  for (const [i, p] of proposals.entries()) { assert.equal(p.status, 'pending', 'every proposal needs human review'); assert.equal(p.input.evidence?.length, 1); assert.equal(p.input.evidence![0]!.span, four(message)[i] && (four(message)[i] as { span: string }).span); assert.ok(FOUR.includes(p.input.evidence![0]!.span!), 'span is verbatim source text'); }
  assert.equal(job1.telemetry?.proposals, 4); assert.equal(job1.telemetry?.complete, false, 'the cap was reached: more might remain');
  const callsAfterFirst = provider.calls.length;
  const job2 = await run(engine); // evidence was NOT consumed, so it is shown again, with the four claims excluded
  assert.ok(provider.calls[callsAfterFirst]!.documents.some(d => d.id === message.id), 'unprocessed evidence is reconsidered');
  assert.match(provider.calls[callsAfterFirst]!.instruction, /Already known or already proposed/); assert.match(provider.calls[callsAfterFirst]!.instruction, /imperative mood/);
  assert.equal(job2.telemetry?.complete, true); assert.equal((await pendingInsights(engine)).length, 4, 'no duplicates after the second job');
  const callsAfterSecond = provider.calls.length; await run(engine);
  assert.equal(provider.calls.length, callsAfterSecond, 'now the cursor moved: nothing new, no model call');
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.status === 'accepted').length, 0, 'nothing is accepted automatically');
  recordCase({ suite: 'profile', name: 'multi-insight-four-preferences', status: 'PASS' });
});

test('a truncated or failed later call keeps the earlier proposals, reports partial, and does not advance the cursor', async t => {
  const w = await world(t); const message = await w.said(FOUR); const steps = four(message);
  const provider = scripted([steps[0]!, steps[1]!, new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit'), new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit'), new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit')]);
  const engine = new IntelligenceEngine(w.vault, provider); const job = await run(engine);
  assert.equal(job.status, 'complete'); assert.equal(job.telemetry?.outcome, 'partial'); assert.match(job.telemetry!.partialReason!, /truncated/); assert.equal((await pendingInsights(engine)).length, 2);
  const before = provider.calls.length; provider.calls.length = 0;
  const retry = scripted([steps[2]!, steps[3]!, 'abstain']); const engine2 = new IntelligenceEngine(w.vault, retry); await run(engine2);
  assert.ok(retry.calls[0]!.documents.some(d => d.id === message.id), 'the evidence that was not fully processed is offered again'); void before;
  assert.equal((await pendingInsights(engine2)).length, 4, 'the two earlier claims are not proposed again; only the two missing ones are added');
  recordCase({ suite: 'profile', name: 'multi-insight-truncation-partial', status: 'PASS' });
});

test('a first-call failure proposes nothing and leaves the cursor alone', async t => {
  const w = await world(t); const message = await w.said(FOUR);
  const failing = new IntelligenceEngine(w.vault, scripted([new Error('provider down'), new Error('provider down'), new Error('provider down')]));
  await failing.enqueue('profile', { scope: proj, incremental: true }); const [job] = await failing.run({ job: 'profile', limit: 1 });
  assert.notEqual(job!.status, 'complete'); assert.equal((await pendingInsights(failing)).length, 0);
  const ok = scripted(four(message)); await ((async () => { const e = new IntelligenceEngine(w.vault, ok); await e.enqueue('profile', { scope: proj, incremental: true, instruction: 'retry after outage' }); await e.run({ job: 'profile', limit: 1 }); })()); assert.ok(ok.calls[0]!.documents.some(d => d.id === message.id), 'the evidence was never consumed');
  recordCase({ suite: 'profile', name: 'multi-insight-first-call-failure', status: 'PASS' });
});

test('crash recovery: proposals made before the crash are kept and are not proposed again by the next process', async t => {
  const w = await world(t); const message = await w.said(FOUR); const steps = four(message);
  const crashing = new IntelligenceEngine(w.vault, scripted([steps[0]!, steps[1]!, new Error('process killed')]));
  await run(crashing); const kept = (await pendingInsights(crashing)).length; assert.equal(kept, 2);
  const restarted = new IntelligenceEngine(w.vault, scripted([steps[2]!, steps[3]!, 'abstain']));
  await run(restarted); assert.equal((await pendingInsights(restarted)).length, 4, 'exactly four, no duplicates of the first two');
  recordCase({ suite: 'profile', name: 'multi-insight-crash-recovery', status: 'PASS' });
});

test('duplicates are exact-repeat only: a repeat is dropped, a correction that shares most words is NOT dropped', async t => {
  const w = await world(t); const first = await w.said('I prefer concise code review feedback.');
  const engine = new IntelligenceEngine(w.vault, scripted([{ claim: 'The user prefers concise code review feedback.', key: 'review', doc: first, span: 'I prefer concise code review feedback' }, 'abstain']));
  await run(engine); assert.equal((await pendingInsights(engine)).length, 1);
  const second = await w.said('Still true: I prefer concise code review feedback.', proj, '2026-10-07T11:00:00.000Z');
  const again = new IntelligenceEngine(w.vault, scripted([{ claim: 'the user prefers concise code-review feedback', key: 'review', doc: second, span: 'I prefer concise code review feedback' }]));
  const repeat = await run(again); assert.equal(repeat.status, 'complete'); assert.equal((await pendingInsights(again)).length, 1, 'the exact repeat is not a second proposal'); assert.equal(repeat.telemetry?.duplicates, 1);
  const third = await w.said('Actually I now prefer detailed code review feedback.', proj, '2026-10-07T12:00:00.000Z');
  const correction = new IntelligenceEngine(w.vault, scripted([{ claim: 'The user prefers detailed code review feedback.', key: 'review', doc: third, span: 'I now prefer detailed code review feedback' }, 'abstain']));
  await run(correction); assert.equal((await pendingInsights(correction)).length, 2, 'the correction was proposed for review, not dropped as a near-duplicate');
  recordCase({ suite: 'profile', name: 'multi-insight-duplicates', status: 'PASS' });
});

test('ACL isolation: other workspaces\' evidence and insights never reach the model or the exclusion list', async t => {
  const w = await world(t); const mine = await w.said(FOUR); const secret = await w.said('I always keep the vault password in PRIVATE-MARKER-77.', { type: 'workspace', workspaceId: 'private' });
  await w.vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'x', body: 'The user keeps PRIVATE-MARKER-77 secrets.', status: 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'secret', scopeLabel: 'private', sensitivity: 'none', evidenceClass: 'explicit' } });
  void secret; const provider = scripted(four(mine)); await run(new IntelligenceEngine(w.vault, provider));
  assert.ok(provider.calls.length >= 4);
  assert.ok(!JSON.stringify(provider.calls.map(c => [c.documents, c.instruction])).includes('PRIVATE-MARKER-77'), 'the other workspace\'s evidence and its insight claim are in neither the documents nor the exclusion list');
  recordCase({ suite: 'profile', name: 'multi-insight-acl', status: 'PASS' });
});
