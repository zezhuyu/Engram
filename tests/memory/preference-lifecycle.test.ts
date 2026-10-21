import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scripted, world, type World } from '../adaptive/helpers.js';
import { AdaptiveIntelligence } from '../../packages/adaptive/index.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { Engram, eventFromHostPayload, type ModelCallOptions, type ModelProposal, type ModelRequest } from '../../packages/sdk/index.js';
import { createRegistration, drainSpool, enqueueEvent } from '../../packages/memory/capture.js';
import { buildSessionContext } from '../../packages/memory/session-context.js';
import { buildPack } from '../dream/pack.js';
import { recordCase } from '../helpers/report.js';

/**
 * A scripted model that behaves like an honest extractor for ordinary statements and like a bad one for the hard cases, so the validation rules (not the model) decide what a future session is told.
 * Message markers: "[key:x]" names the preference; "Maybe/not sure" is ambiguous; "billing module" makes the model invent a trait; "medical" is sensitive; "flaky" fails the first attempt.
 */
class Extractor extends Scripted {
  flaky = 0;
  override async generate(req: ModelRequest, options?: ModelCallOptions): Promise<ModelProposal> {
    if (req.job !== 'profile') return super.generate(req, options);
    this.calls.push(req);
    const doc = req.documents.find(d => d.metadata.speaker === 'user') ?? req.documents[0]!;
    const key = /\[key:(\w+)\]/.exec(doc.body)?.[1] ?? 'general'; const text = doc.body.replace(/\s*\[key:\w+\]/, '').trim();
    const evidence = [{ uri: doc.uri, revisionId: doc.revisionId, span: text.slice(0, 90) }];
    if (/flaky/i.test(text) && this.flaky++ === 0) throw new Error('model unavailable (first attempt)');
    if (/billing module/i.test(text)) return { kind: 'user_insight', title: 'Kubernetes expert', body: 'The user is an expert in Kubernetes.', evidence: [{ uri: doc.uri, revisionId: doc.revisionId, span: 'expert in Kubernetes' }], metadata: { category: 'capability', preferenceKey: key, sensitivity: 'none', explicitStatement: true } };
    const subject = text.replace(/^(?:actually,?\s*)?(?:maybe\s+)?i\s+(?:prefer|want|would like|'d like)\s*/i, '').replace(/[.?!]+$/, '');
    const ambiguous = /maybe|not sure/i.test(text); const sensitive = /medical/i.test(text);
    return { kind: 'user_insight', title: `Prefers ${subject.slice(0, 40)}`, body: `The user prefers ${subject}.`, evidence, metadata: { category: 'preference', preferenceKey: key, sensitivity: sensitive ? 'sensitive' : 'none', explicitStatement: !ambiguous } };
  }
}

let counter = 0;
async function setup(t: Parameters<typeof world>[0]) {
  const w = await world(t, { provider: false }); await buildPack(w.vault); const provider = new Extractor();
  const ai = new AdaptiveIntelligence(w.vault, provider); await ai.configure({ enabled: true, autoAccept: 'low-risk', timezone: 'UTC', resources: { maxLoadAverage: 10_000, maxRssMiB: 1_000_000, activityPollMs: 20 } } as never);
  const registrations = new Map<string, Awaited<ReturnType<typeof createRegistration>>>();
  /** What the host hook does: a prompt becomes a queued, redacted event, then a committed observation. Returns the event so a delivery can be repeated. */
  const say = async (workspaceId: string, prompt: string, extra: Record<string, unknown> = {}) => {
    let reg = registrations.get(workspaceId); if (!reg) { reg = await createRegistration(w.vault, { host: 'claude-code', principalId: 'tester', workspaceId, consent: true }); registrations.set(workspaceId, reg); }
    const event = eventFromHostPayload(reg, { hook_event_name: 'UserPromptSubmit', session_id: `sess-${workspaceId}`, cwd: '/p', prompt_id: `p${++counter}`, prompt, ...extra })!;
    await enqueueEvent(w.root, { registrationId: reg.id, event }); await drainSpool(w.root); return { reg, event };
  };
  const cycle = async (label: string) => { const c = (await ai.runCycle({ kind: 'manual', idempotencyKey: `${label}-${++counter}`, respectActivity: false })).cycle!; return c; };
  const context = async (workspaceId: string) => (await buildSessionContext(new Engram(w.root), { workspaceId })).text;
  const insights = async () => (await w.vault.listDocuments({ includeHistory: false })).filter(d => d.kind === 'user_insight' && d.metadata.insightSchema === 1 && !String(d.metadata.preferenceKey).startsWith('goal-')); // the dream pack seeds its own goal insights
  const engine = new IntelligenceEngine(w.vault, provider);
  const dbg = async () => JSON.stringify((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').map(d => [d.metadata.preferenceKey, d.metadata.scopeLabel, d.status, d.body.slice(0, 50)]));
  return { w, provider, ai, engine, say, cycle, context, insights, registrations, dbg };
}

test('a stated preference is captured, extracted, validated, accepted and delivered to the next session of that project only, with no manual memory command', async t => {
  const s = await setup(t);
  await s.say('alpha', 'I prefer small, reviewable commits. [key:commits]'); await s.say('beta', 'I prefer Python for scripting. [key:language]');
  assert.equal((await s.w.vault.listDocuments()).filter(d => d.kind === 'observation').length, 2, 'captured passively as durable observations');
  assert.doesNotMatch(await s.context('alpha'), /small, reviewable commits/, 'before extraction nothing is claimed');
  const c = await s.cycle('first'); assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  const accepted = (await s.insights()).filter(d => d.status === 'accepted'); assert.equal(accepted.length, 2); assert.ok(accepted.every(d => d.metadata.evidenceClass === 'explicit' && d.evidence.length >= 1 && d.metadata.scopeLabel));
  const alpha = await s.context('alpha'), beta = await s.context('beta');
  assert.match(alpha, /prefers small, reviewable commits/); assert.doesNotMatch(alpha, /Python/, 'no cross-project leakage'); assert.match(beta, /prefers Python for scripting/); assert.doesNotMatch(beta, /small, reviewable commits/);
  assert.ok(!accepted.some(d => d.metadata.scopeLabel === 'global'), 'a workspace statement does not silently become a global fact');
  recordCase({ suite: 'memory', name: 'preference-lifecycle-capture-to-context', status: 'PASS' });
});

test('the same event delivered twice, and the same statement said again, produce one observation and one insight', async t => {
  const s = await setup(t);
  const first = await s.say('alpha', 'I prefer tabs over spaces. [key:indent]'); await s.cycle('dup-a');
  const before = (await s.w.vault.listDocuments()).filter(d => d.kind === 'observation').length;
  await enqueueEvent(s.w.root, { registrationId: first.reg.id, event: first.event }); await drainSpool(s.w.root); // the hook retried after a lost acknowledgement
  assert.equal((await s.w.vault.listDocuments()).filter(d => d.kind === 'observation').length, before, 'the delivery is idempotent');
  await s.say('alpha', 'I prefer tabs over spaces. [key:indent]'); const c = await s.cycle('dup-b'); assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  assert.equal((await s.insights()).filter(d => d.metadata.preferenceKey === 'indent' && d.status === 'accepted').length, 1, 'repeating the statement does not create a second insight');
  assert.equal((await s.context('alpha')).match(/prefers tabs over spaces/g)!.length, 1);
});

test('a later correction supersedes the old preference: the next session sees only the new one and the history keeps both', async t => {
  const s = await setup(t);
  await s.say('alpha', 'I prefer large squashed commits. [key:commits]'); await s.cycle('corr-a'); assert.match(await s.context('alpha'), /large squashed commits/);
  await s.say('alpha', 'Actually, I want small atomic commits, instead of squashed ones. [key:commits]'); const c = await s.cycle('corr-b'); assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  const now = await s.context('alpha'); assert.match(now, /small atomic commits/); assert.doesNotMatch(now, /large squashed commits/, 'the superseded claim is no longer told to the agent');
  const docs = (await s.insights()).filter(d => d.metadata.preferenceKey === 'commits'); const old = docs.find(d => /large squashed/.test(d.body))!; assert.equal(old.status, 'superseded'); assert.equal((await s.w.vault.history(old.id)).length, 2, 'accepted, then superseded: both revisions kept');
  recordCase({ suite: 'memory', name: 'preference-lifecycle-correction', status: 'PASS' });
});

test('ambiguous statements, invented traits and sensitive items are never told to an agent as accepted facts', async t => {
  const s = await setup(t);
  await s.say('alpha', 'Maybe I would like tabs? Not sure yet. [key:indent]'); await s.cycle('amb');
  await s.say('alpha', 'I am working on the billing module this week. [key:trait]'); await s.cycle('trait');
  const ctx = await s.context('alpha'); assert.doesNotMatch(ctx, /tabs/); assert.doesNotMatch(ctx, /Kubernetes/);
  const all = await s.insights(); assert.equal(all.filter(d => d.status === 'accepted').length, 0, JSON.stringify(all.map(d => [d.metadata.preferenceKey, d.status])));
  assert.ok(!all.some(d => /Kubernetes/.test(d.body)), 'a claim whose cited words are not in the source is rejected, never stored');
  const pending = await s.engine.proposals(); assert.ok(pending.some(p => p.status === 'pending' && /tabs/.test(p.input.body)), 'the ambiguous one waits for the user, as a proposal');
  recordCase({ suite: 'memory', name: 'preference-lifecycle-no-false-promotion', status: 'PASS' });
});

test('sensitive preferences remain private until explicit owner review', async t => {
  const s = await setup(t);
  await s.say('alpha', 'I prefer to avoid late meetings because of my medical treatment. [key:health]');
  const c = await s.cycle('sensitive'); assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  const ctx = await s.context('alpha'); assert.doesNotMatch(ctx, /medical|late meetings/);
  const accepted = (await s.insights()).filter(d => d.status === 'accepted'); assert.equal(accepted.length, 0);
  const pending = (await s.engine.proposals()).filter(p => p.status === 'pending' && p.input.kind === 'user_insight');
  assert.equal(pending.length, 1); assert.equal(pending[0]!.input.metadata?.sensitivity, 'sensitive');
  recordCase({ suite: 'memory', name: 'sensitive-preference-pending-review', status: 'PASS' });
});

test('a model failure mid-extraction and a late, replayed delivery still end with exactly one accepted insight', async t => {
  const s = await setup(t);
  await s.say('alpha', 'I prefer flaky-test quarantine over retries. [key:flaky]');
  const failed = await s.cycle('flaky-1'); assert.notEqual(failed.state, 'COMPLETED', 'the first attempt fails: the model was unavailable'); assert.equal((await s.insights()).filter(d => d.status === 'accepted').length, 0);
  const retried = await s.cycle('flaky-2'); assert.equal(retried.state, 'COMPLETED', JSON.stringify(retried.error));
  assert.equal((await s.insights()).filter(d => d.metadata.preferenceKey === 'flaky' && d.status === 'accepted').length, 1, 'exactly one, not zero and not two');
  // the user said this a day ago on a machine that was offline; the spool delivers it now
  await s.say('alpha', 'I prefer descriptive branch names. [key:branches]', { _engramCapturedAt: '2026-10-11T08:00:00.000Z' }); const late = await s.cycle('late'); assert.equal(late.state, 'COMPLETED', JSON.stringify(late.error));
  const ctx = await s.context('alpha'); assert.match(ctx, /flaky-test quarantine/); assert.match(ctx, /descriptive branch names/);
  recordCase({ suite: 'memory', name: 'preference-lifecycle-crash-and-replay', status: 'PASS' });
});

test('a promoted global preference reaches every project only after review; before that no project is told it', async t => {
  const s = await setup(t);
  await s.say('alpha', 'I prefer concise answers everywhere. [key:style]'); await s.say('beta', 'I prefer concise answers everywhere. [key:style]');
  const c = await s.cycle('promo'); const promo = c.global.promotions.find(p => p.preferenceKey === 'style'); assert.equal(promo?.status, 'PROPOSED');
  assert.ok(!(await s.insights()).some(d => d.metadata.scopeLabel === 'global'), 'nothing is global yet');
  const reviewed = await s.engine.review(promo!.proposalId!, true, 'user approved the promotion'); assert.equal(reviewed.status, 'approved');
  const gamma = await s.w.vault.createWorkspace('gamma', ''); void gamma;
  assert.match(await s.context('gamma'), /concise answers everywhere/, 'once approved, a project that never stated it receives it as a global preference');
});
