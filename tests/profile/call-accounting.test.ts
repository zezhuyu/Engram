import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { world as adaptiveWorld } from '../adaptive/helpers.js';
import { IntelligenceEngine, CallMeter, PROFILE_CALL_BUDGET, profileCallBudget, type JobTelemetry } from '../../packages/intelligence/index.js';
import { OpenAICompatibleProvider } from '../../packages/models/openai.js';
import { MDBError, type CriticVerdict, type Document, type ModelCallOptions, type ModelProposal, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
const proj: Scope = { type: 'workspace', workspaceId: 'proj' };
async function world(t: T, maxCalls?: number) {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  const setBudget = async (value: number | undefined) => { const config = await vault.config(); config.model = { ...config.model, ...(value === undefined ? {} : { maxCallsPerProfileBatch: value }) } as typeof config.model; if (value === undefined) delete (config.model as { maxCallsPerProfileBatch?: number }).maxCallsPerProfileBatch; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(config)); };
  if (maxCalls !== undefined) await setBudget(maxCalls);
  const said = (body: string) => vault.put({ scope: proj, kind: 'observation', title: 'User message', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime: '2026-10-07T10:00:00.000Z' } });
  return { root, vault, said, setBudget };
}
const insight = (doc: Document, claim: string, key: string, span: string): ModelProposal => ({ kind: 'user_insight', title: claim.slice(0, 80), body: claim, evidence: [{ uri: doc.uri, revisionId: doc.revisionId, span }], metadata: { category: 'preference', preferenceKey: key, sensitivity: 'none', explicitStatement: true } });
const NOTHING: ModelProposal = { kind: 'no_insight', title: 'No insight', body: 'Nothing further.', evidence: [] };
const BROKEN: ModelProposal = { kind: 'user_insight', title: 'x', body: 'y', evidence: [] };
/** Answers generate() from a script and counts both kinds of provider invocation independently of the engine's own counters. */
function counting(steps: Array<ModelProposal | Error>, critic: 'accept' | 'none' = 'accept'): ModelProvider & { generated: ModelRequest[]; critiqued: number; usageSeen: number } {
  const provider = { id: 'counting', generated: [] as ModelRequest[], critiqued: 0, usageSeen: 0,
    async generate(request: ModelRequest, options?: ModelCallOptions) { provider.generated.push(request); options?.onUsage?.({ retries: 0 }); const step = steps.shift() ?? NOTHING; if (step instanceof Error) throw step; return step; },
    ...(critic === 'accept' ? { async critique(_request: unknown, options?: ModelCallOptions): Promise<CriticVerdict> { provider.critiqued++; options?.onUsage?.({ retries: 0 }); return { verdict: 'accept', rationale: 'supported' }; } } : {}) };
  return provider as never;
}
const run = async (engine: IntelligenceEngine, input: Record<string, unknown> = {}) => { await engine.enqueue('profile', { scope: proj, incremental: true, ...input }); const [job] = await engine.run({ job: 'profile', limit: 1 }); return job!; };
const pending = async (engine: IntelligenceEngine) => (await engine.proposals()).filter(p => p.input.kind === 'user_insight' && p.status === 'pending');
const TEXT = 'From now on write commit messages in the imperative mood. Always run the linter before committing. I prefer small pull requests.';
const THREE = (m: Document) => [insight(m, 'The user wants commit messages in the imperative mood.', 'commit-mood', 'write commit messages in the imperative mood'), insight(m, 'The user always runs the linter before committing.', 'lint-first', 'Always run the linter before committing'), insight(m, 'The user prefers small pull requests.', 'pr-size', 'I prefer small pull requests')];

test('telemetry counts every provider invocation (first generation, schema repair, critic) and agrees with what the provider actually received', async t => {
  const w = await world(t, 20); const m = await w.said(TEXT); const [first] = THREE(m);
  const provider = counting([BROKEN, first!, NOTHING]); const engine = new IntelligenceEngine(w.vault, provider); const job = await run(engine);
  assert.equal(job.status, 'complete'); const tele = job.telemetry!;
  assert.deepEqual(tele.calls, { generate: 2, repair: 1, critic: 1 }, 'a broken answer, its repair, the critic, then the confirming "nothing more" call');
  assert.equal(tele.modelCalls, 4); assert.equal(provider.generated.length + provider.critiqued, tele.modelCalls, 'exactly what the provider received, not one per job');
  assert.equal(tele.terminal, 'proposed'); assert.equal(tele.complete, true); assert.equal(tele.budget?.max, 20); assert.equal(tele.budget?.exhausted, false);
  assert.deepEqual(tele.tokens, { input: 0, output: 0, reported: false }, 'a provider that reports no tokens is reported as not reported, never as zero'); assert.equal(tele.retries, 0);
  recordCase({ suite: 'profile', name: 'call-accounting-counts-every-invocation', status: 'PASS' });
});

test('a spent budget stops BEFORE the call that would exceed it, keeps the validated proposals, persists an incomplete state and leaves the cursor; the next batch finishes without duplicates', async t => {
  const w = await world(t, 3); const m = await w.said(TEXT); const [a, b, c] = THREE(m);
  const provider = counting([a!, b!, c!, NOTHING]); const engine = new IntelligenceEngine(w.vault, provider); const job = await run(engine);
  assert.equal(job.status, 'pending', 'a call-budget pause remains resumable'); const tele = job.telemetry!;
  assert.equal(provider.generated.length + provider.critiqued, 3, 'the provider was never called more than the budget allows');
  assert.deepEqual(tele.calls, { generate: 2, repair: 0, critic: 1 }); assert.equal(tele.terminal, 'budget_exhausted'); assert.equal(tele.budget?.exhausted, true); assert.equal(tele.complete, false); assert.equal(tele.outcome, 'partial'); assert.match(tele.partialReason!, /MODEL_BUDGET_EXHAUSTED/);
  assert.equal(tele.proposals, 2); assert.equal((await pending(engine)).length, 2, 'validated proposals are preserved'); assert.match(job.result!, /,/, 'the job result lists the proposals it made');
  assert.ok((await engine.proposals()).some(p => p.flags?.includes('model_critic_skipped_budget')), 'the proposal whose critic did not fit is flagged, not silently accepted');
  // the cursor did not move: the same evidence is offered again, with the two claims excluded, and the batch finishes
  await w.setBudget(10); const next = counting([c!, NOTHING]); const engine2 = new IntelligenceEngine(w.vault, next); const job2 = await run(engine2, { instruction: 'next batch' });
  assert.ok(next.generated[0]!.documents.some(d => d.id === m.id), 'unprocessed evidence is reconsidered'); assert.match(next.generated[0]!.instruction, /imperative mood/); assert.match(next.generated[0]!.instruction, /linter/);
  assert.equal(job2.telemetry?.terminal, 'proposed'); assert.equal(job2.telemetry?.complete, true); assert.equal((await pending(engine2)).length, 3, 'no duplicates, nothing lost');
  const after = counting([]); await run(new IntelligenceEngine(w.vault, after), { instruction: 'third batch' }); assert.equal(after.generated.length, 0, 'now the cursor moved: no evidence, no provider call');
  recordCase({ suite: 'profile', name: 'call-accounting-budget-exhausted-cursor', status: 'PASS' });
});

test('a budget spent before ANY proposal exists is an incomplete batch (not an error, not dead-lettered): nothing stored, cursor kept, the terminal state says why', async t => {
  const w = await world(t, 2); const m = await w.said(TEXT); const provider = counting([BROKEN, BROKEN, BROKEN, THREE(m)[0]!]); const engine = new IntelligenceEngine(w.vault, provider); const job = await run(engine);
  assert.equal(provider.generated.length, 2, 'the budget stopped the repair loop at 2 calls'); assert.equal(job.status, 'pending', 'an exhausted budget does not report terminal completion'); assert.equal(job.telemetry?.terminal, 'budget_exhausted'); assert.equal(job.telemetry?.proposals, 0); assert.equal(job.telemetry?.complete, false); assert.equal(job.result, 'incomplete:budget_exhausted'); assert.equal((await engine.proposals()).length, 0);
  const again = counting([THREE(m)[0]!, NOTHING]); await w.setBudget(5); await run(new IntelligenceEngine(w.vault, again), { instruction: 'retry' }); assert.ok(again.generated[0]!.documents.some(d => d.id === m.id), 'the cursor stayed, so the evidence is processed next time');
});

test('extraction failures are persisted as incomplete with the real counts and a terminal state, and never advance the cursor', async t => {
  const w = await world(t, 10); const m = await w.said(TEXT);
  const down = new IntelligenceEngine(w.vault, counting([new Error('provider down'), new Error('provider down'), new Error('provider down')])); const failed = await run(down);
  assert.notEqual(failed.status, 'complete'); assert.equal(failed.telemetry?.terminal, 'provider_error'); assert.equal(failed.telemetry?.complete, false); assert.equal(failed.telemetry?.proposals, 0); assert.equal(failed.telemetry?.calls?.generate, 1);
  const broken = new IntelligenceEngine(w.vault, counting([BROKEN, BROKEN, BROKEN]));
  assert.equal(await broken.retryNow(failed.id, { force: true }), true, 'retry uses the persisted job after its configured backoff');
  const [bad] = await broken.run({ jobId: failed.id, limit: 1 }); assert.ok(bad); assert.equal(bad.telemetry?.terminal, 'malformed'); assert.equal(bad.telemetry?.complete, false); assert.deepEqual(bad.telemetry?.calls, { generate: 1, repair: 2, critic: 0 }); assert.equal(bad.status, 'dead_letter');
  const ok = counting([THREE(m)[0]!, NOTHING]); await run(new IntelligenceEngine(w.vault, ok), { instruction: 'recovered' }); assert.ok(ok.generated[0]!.documents.some(d => d.id === m.id), 'evidence still unprocessed after both failures');
});

test('token usage and provider-internal retries are reported when the endpoint reports them, and honestly absent when it does not', async t => {
  const w = await world(t, 10); const m = await w.said(TEXT); let requests = 0;
  const response = (content: unknown, input: number, output: number) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const answers = [new Response('overloaded', { status: 503 }), response(insight(m, 'The user wants commit messages in the imperative mood.', 'commit-mood', 'write commit messages in the imperative mood'), 120, 30), response({ verdict: 'accept', rationale: 'ok' }, 50, 10), response(NOTHING, 40, 5)];
  const provider = new OpenAICompatibleProvider({ id: 'fake-openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', locality: 'local', timeoutMs: 5000, maxRetries: 2, maxInputTokens: 12000, maxOutputTokens: 800, sleep: async () => undefined, fetch: (async () => { const answer = answers[requests++]; if (!answer) throw new Error('Unexpected endpoint request'); return answer; }) as typeof fetch });
  const job = await run(new IntelligenceEngine(w.vault, provider)); const tele = job.telemetry!;
  assert.equal(job.status, 'complete'); assert.deepEqual(tele.tokens, { input: 210, output: 45, reported: true }); assert.deepEqual(tele.calls, { generate: 2, repair: 0, critic: 1 }); assert.equal(tele.retries, 1, 'the 503 was retried once by the provider and is reported as a retry, not as a model call');
  assert.ok(tele.modelCalls <= requests, 'model calls never exceed HTTP requests'); assert.equal(requests - (tele.retries ?? 0), tele.modelCalls, 'HTTP requests = provider calls + provider-internal retries');
  const direct: Array<{ inputTokens?: number; outputTokens?: number; retries?: number }> = []; requests = 0; answers.splice(0, answers.length, new Response('x', { status: 503 }), new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(NOTHING) }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), { status: 200 }));
  await provider.generate({ job: 'profile', documents: [], goals: '', instruction: 'x' }, { onUsage: usage => direct.push(usage) }); assert.deepEqual(direct, [{ inputTokens: 7, outputTokens: 3, retries: 1 }], 'onUsage fires exactly once per call');
  recordCase({ suite: 'profile', name: 'call-accounting-tokens-and-retries', status: 'PASS' });
});

test('the budget is validated and bounded; the default is five calls per profile batch', async () => {
  assert.equal(profileCallBudget(undefined), 5); assert.equal(PROFILE_CALL_BUDGET.default, 5); assert.equal(profileCallBudget(1), 1); assert.equal(profileCallBudget(50), 50);
  for (const bad of [0, 51, 2.5, -1, Number.NaN]) assert.throws(() => profileCallBudget(bad), (error: unknown) => error instanceof MDBError && error.code === 'INVALID_INPUT' && /maxCallsPerProfileBatch/.test(error.message));
  const tele: JobTelemetry = { modelCalls: 0, malformed: 0, repairs: 0, outcome: 'pending' }; const meter = new CallMeter(tele, 2); meter.take('generate'); meter.take('critic'); assert.throws(() => meter.take('generate'), /2 model call/); assert.equal(tele.modelCalls, 2, 'the refused call is not counted'); assert.equal(tele.budget?.exhausted, true);
});

test('the daily cycle is charged for the provider calls actually made, and a profile batch can never spend more than the cycle has left', async t => {
  const w = await adaptiveWorld(t, { config: { maxModelCallsPerCycle: 50 } }); await w.say('alpha', 'I prefer TypeScript [key:a]');
  const result = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'accounting', respectActivity: false })).cycle!; assert.equal(result.state, 'COMPLETED', JSON.stringify(result.error));
  assert.equal(result.metrics.modelCalls, w.provider.calls.length, 'cycle metrics equal the provider calls that really happened (an insight plus the confirming call), not one per job'); assert.ok(w.provider.calls.length >= 2);
  assert.equal(result.budgets.modelCallsUsed, w.provider.calls.length);
  const tight = await adaptiveWorld(t, { config: { maxModelCallsPerCycle: 1 } }); await tight.say('alpha', 'I prefer TypeScript [key:a]'); const paused = (await tight.ai.runCycle({ kind: 'manual', idempotencyKey: 'tight', respectActivity: false })).cycle!;
  assert.ok(tight.provider.calls.length <= 1, `a one-call cycle budget allowed ${tight.provider.calls.length} provider calls`); assert.equal(paused.state, 'PAUSED'); assert.equal(paused.error?.category, 'RESOURCE_PRESSURE');
  recordCase({ suite: 'profile', name: 'call-accounting-cycle-charge', status: 'PASS' });
});

test('cycle accounting includes real Dream generations and a zero-call Dream contributes nothing', async t => {
  const w = await adaptiveWorld(t, { config: { maxModelCallsPerCycle: 50 } });
  await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Python JSON APIs', body: 'Python services expose JSON over HTTP using FastAPI.', tags: ['domain:python-api', 'api', 'json', 'provides:json'] });
  await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'JS dashboards', body: 'Browser dashboards consume JSON through fetch and render widgets.', tags: ['domain:js-frontend', 'dashboard', 'consumes:json'] });
  const cycle = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'dream-accounting', respectActivity: false })).cycle!;
  assert.equal(cycle.state, 'COMPLETED', JSON.stringify(cycle.error));
  assert.ok(w.provider.dreamCalls().length > 0, 'the fixture really invokes Dream');
  assert.equal(cycle.metrics.modelCalls, w.provider.calls.length);
  assert.equal(cycle.budgets.modelCallsUsed, w.provider.calls.length);
  const tight = await adaptiveWorld(t, { config: { maxModelCallsPerCycle: 1, dreamMode: 'deep' } });
  for (const doc of await w.vault.listDocuments({ scopes: [{ type: 'global', area: 'wiki' }] })) await tight.vault.put({ scope: doc.scope, kind: doc.kind, title: doc.title, body: doc.body, tags: doc.tags });
  const paused = (await tight.ai.runCycle({ kind: 'manual', idempotencyKey: 'dream-tight', respectActivity: false })).cycle!;
  assert.equal(paused.state, 'PAUSED', JSON.stringify(paused.error));
  assert.equal(paused.error?.category, 'RESOURCE_PRESSURE');
  assert.equal(tight.provider.calls.length, 1, 'Deep Dream cannot exceed the remaining cycle allowance');
  assert.equal(paused.metrics.modelCalls, 1);
  let resumed = paused; let attempts = 1; let previous = tight.provider.calls.length;
  while (resumed.state === 'PAUSED' && attempts < 8) {
    resumed = (await tight.ai.resumeCycle(resumed.id, { respectActivity: false })).cycle!;
    assert.ok(tight.provider.calls.length - previous <= 1, 'each resume respects the one-call allowance');
    previous = tight.provider.calls.length; attempts++;
  }
  assert.equal(resumed.state, 'COMPLETED', JSON.stringify(resumed.error));
  assert.equal(resumed.metrics.modelCalls, tight.provider.calls.length);
});
