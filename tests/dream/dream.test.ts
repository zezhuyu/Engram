import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { buildPack, type Pack } from './pack.js';
import { dreamer, modeOf } from './helpers.js';
import { Vault } from '../../packages/core/vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { generationMessages } from '../../packages/models/prompts.js';
import { ProviderError } from '../../packages/models/errors.js';
import { dreamPool, planContext } from '../../packages/intelligence/dream/context.js';
import { budgetsFor, planDeep, rngFrom } from '../../packages/intelligence/dream/plan.js';
import { readStats, recordFeedback, staleDiscoveries, successRate } from '../../packages/intelligence/dream/lifecycle.js';
import { Engram, type ModelProposal, type Scope } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
type Cfg = Partial<{ enabled: boolean; eventDriven: boolean; modes: Array<'micro' | 'deep' | 'strategic'>; maxProposalsPerRun: number; maxRunsPerDay: number; maxDurationMs: number; autoAccept: boolean; quietHours: { startHour: number; endHour: number } }>;
async function world(t: T, dream: Cfg = {}) {
  const { root, vault } = await disposableVault(t); const pack = await buildPack(vault);
  const config = await vault.config(); config.dream = { ...config.dream, enabled: true, eventDriven: false, modes: ['micro', 'deep', 'strategic'], ...dream }; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(config));
  return { root, vault, pack };
}
const ids = (pack: Pack, ...keys: string[]) => keys.map(k => pack.ids[k]!);
let attemptCounter = 0;
/** Jobs with identical input are one job; every attempt gets a unique marker so each really runs. */
const enqueueRun = async (engine: IntelligenceEngine, input: NonNullable<Parameters<IntelligenceEngine['enqueue']>[1]>) => { const marker = `attempt-${++attemptCounter}`; await engine.enqueue('dream', { ...input, instruction: marker }); const jobs = await engine.run({ job: 'dream', limit: 3 }); return jobs.filter(j => j.input.instruction === marker); };
const discoveries = async (vault: Vault, status?: string) => (await vault.listDocuments()).filter(d => d.kind === 'discovery' && (!status || d.status === status));

test('a Python API + JavaScript UI pair yields a candidate composition hypothesis, never a fact or a claim about the user', async t => {
  const w = await world(t); const model = dreamer(); const engine = new IntelligenceEngine(w.vault, model);
  const jobs = await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') }); assert.equal(jobs[0]!.status, 'complete', jobs[0]!.error);
  const proposal = (await engine.proposals()).at(-1)!; assert.equal(proposal.status, 'pending'); assert.equal(proposal.input.status, 'hypothesis');
  const m = proposal.input.metadata!; assert.equal(m.subtype, 'composition'); assert.equal(m.mode, 'micro'); assert.equal(m.novelty, 'new_to_user'); assert.deepEqual((m.domains as string[]).sort(), ['js-frontend', 'python-api']);
  assert.equal((m.critic as { outcome: string }).outcome, 'pass'); assert.equal(m.visibility, 'user_private'); assert.equal(m.dreamSchema, 2); assert.ok(m.promptVersion && m.modelProvider === 'fake-dreamer');
  assert.deepEqual((m.sourceRefs as Array<{ uri: string }>).map(r => r.uri).sort(), [w.pack.docs.pyApi!.uri, w.pack.docs.jsDash!.uri].sort());
  const doc = await w.vault.get((await engine.review(proposal.id, true, 'plausible')).objectId!);
  assert.equal(doc.status, 'candidate', 'accepted for follow-up, not verified'); assert.equal(doc.kind, 'discovery'); assert.equal(doc.scope.type, 'global'); assert.match(doc.body, /^Hypothesis:/);
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.origin !== 'user_statement').length, 0, 'no user insight or skill was created');
  const profile = await fs.readFile(path.join(w.root, 'USER_INSIGHT.md'), 'utf8'); assert.doesNotMatch(profile, /Python|JavaScript|composition/i);
  // statements about the user are refused outright, and kept as a rejected record
  const boastful = new IntelligenceEngine(w.vault, dreamer({ override: out => ({ ...out, title: 'Boast', body: 'Hypothesis: the user is proficient in full stack development, combining Python APIs and JavaScript UIs.' }) }));
  await enqueueRun(boastful, { mode: 'micro', objectIds: ids(w.pack, 'pyRate', 'jsCache') });
  const refused = (await boastful.proposals()).at(-1)!; assert.equal(refused.status, 'rejected'); assert.ok(refused.flags!.includes('claims_about_user'));
  recordCase({ suite: 'dream', name: 'composition-hypothesis', status: 'PASS' });
});

test('three modes, three different behaviours: algorithms, prompts, output schemas, budgets and candidate sets', async t => {
  const w = await world(t); const model = dreamer(); const engine = new IntelligenceEngine(w.vault, model);
  await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') });
  await enqueueRun(engine, { mode: 'deep' }); await enqueueRun(engine, { mode: 'strategic' });
  const jobs = (await engine.jobs()).filter(j => j.kind === 'dream'); assert.equal(jobs.length, 3); assert.ok(jobs.every(j => j.status === 'complete'), JSON.stringify(jobs.map(j => j.error)));
  const trace = (mode: string) => jobs.find(j => j.input.mode === mode)!.trace as { algorithm: string; candidates: Array<{ id: string; distance: string }>; clusters: unknown[]; budget: { maxObjects: number; usedObjects: number }; domainsCovered: string[]; goalRefs?: string[]; gaps?: unknown[] };
  assert.equal(new Set(['micro', 'deep', 'strategic'].map(m => trace(m).algorithm)).size, 3);
  assert.ok(trace('deep').domainsCovered.length >= 4 && trace('deep').domainsCovered.length > trace('micro').domainsCovered.length);
  assert.ok(trace('deep').candidates.some(c => c.distance === 'distant')); assert.ok(trace('strategic').goalRefs?.length && !trace('deep').goalRefs); assert.ok(trace('strategic').gaps !== undefined);
  assert.ok(trace('deep').budget.usedObjects <= trace('deep').budget.maxObjects && trace('micro').budget.maxObjects < trace('deep').budget.maxObjects);
  const calls = (mode: string) => model.calls.filter(c => modeOf(c) === mode); assert.ok(calls('micro').length >= 1 && calls('deep').length >= 2 && calls('strategic').length >= 1);
  assert.ok(calls('deep').every(c => c.documents.length <= 4), 'deep clusters are small and distant, not a dump'); assert.ok(calls('strategic').every(c => c.documents.some(d => d.kind === 'user_insight')), 'strategic always includes the goal');
  const system = (mode: string) => generationMessages({ job: 'dream', documents: [], goals: '', instruction: `MODE:${mode}` })[0]!.content;
  assert.match(system('deep'), /mechanism/); assert.match(system('strategic'), /goalRefs/); assert.doesNotMatch(system('micro'), /goalRefs|mechanism \(/); assert.equal(new Set(['micro', 'deep', 'strategic'].map(system)).size, 3);
  const props = (await engine.proposals()); const byMode = (m: string) => props.filter(p => p.input.metadata?.mode === m);
  assert.ok(byMode('deep').every(p => typeof p.input.metadata!.mechanism === 'string')); assert.ok(byMode('strategic').every(p => Array.isArray(p.input.metadata!.goalRefs) && Array.isArray(p.input.metadata!.prerequisites))); assert.ok(byMode('micro').every(p => p.input.metadata!.mechanism === undefined));
  assert.ok(byMode('strategic').every(p => p.critic?.verdict === 'review_required' && p.flags!.includes('high_impact')), 'goal-directed options are always reviewed');
  const deepTrace = trace('deep') as unknown as { clusters: Array<{ hints: Array<unknown>; domains: string[] }> }; const pairs = deepTrace.clusters.map(c => c.domains.slice(0, 2).sort().join('+')); assert.equal(new Set(pairs).size, pairs.length, 'deep does not revisit a domain pair');
  recordCase({ suite: 'dream', name: 'mode-differences-end-to-end', status: 'PASS', detail: { deepProposals: byMode('deep').length, microProposals: byMode('micro').length, strategicProposals: byMode('strategic').length } });
});

test('modes are separate opt-ins and strategic dreaming needs a stated goal', async t => {
  const w = await world(t, { modes: ['micro'] }); const engine = new IntelligenceEngine(w.vault, dreamer());
  const deep = await enqueueRun(engine, { mode: 'deep' }); assert.equal(deep[0]!.status, 'blocked'); assert.match(deep[0]!.error!, /deep dreaming is not enabled/);
  const bare = await disposableVault(t); await bare.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Lonely page', body: 'text body here', tags: ['domain:a'] });
  const c = await bare.vault.config(); c.dream = { ...c.dream, enabled: true, modes: ['strategic'] }; await fs.writeFile(path.join(bare.root, 'mdb.yaml'), YAML.stringify(c));
  const noGoal = new IntelligenceEngine(bare.vault, dreamer()); const r = await enqueueRun(noGoal, { mode: 'strategic' }); assert.equal(r[0]!.status, 'blocked'); assert.match(r[0]!.error!, /at least one accepted goal/);
  recordCase({ suite: 'dream', name: 'mode-opt-in', status: 'PASS' });
});

test('critic: duplicate, trivial, unsupported, already-known and over-certain ideas are rejected, each with a persisted, restart-proof reason', async t => {
  const w = await world(t); const rejectionsOf = async () => (await discoveries(w.vault, 'rejected')).map(d => ({ flags: d.metadata.critic as { reasons: string[] }, body: d.body }));
  const run = async (override: Parameters<typeof dreamer>[0], objects: string[]) => { const e = new IntelligenceEngine(w.vault, dreamer(override)); const jobs = await enqueueRun(e, { mode: 'micro', objectIds: ids(w.pack, ...objects) }); return { e, jobs, last: (await e.proposals()).at(-1)! }; };
  const first = await run({}, ['pyApi', 'jsDash']); assert.equal(first.last.status, 'pending'); await first.e.review(first.last.id, true);
  const duplicate = await run({}, ['pyApi', 'jsChart', 'jsDash']); assert.equal(duplicate.last.status, 'rejected', 'same idea again'); assert.ok(duplicate.last.flags!.includes('duplicate') || duplicate.last.flags!.includes('repeat_of_rejected'));
  const trivial = await run({ override: (out, req) => ({ ...out, title: 'Copy', body: req.documents.find(d => d.kind !== 'user_insight')!.body }) }, ['secRate', 'pyRate']); assert.ok(trivial.last.flags!.includes('trivial_restatement') || trivial.last.flags!.includes('too_thin'), String(trivial.last.flags));
  const certain = await run({ override: out => ({ ...out, title: 'Certain', body: 'This pairing of opsAlert and gardenSoil is proven and guaranteed to work in production without any further testing.' }) }, ['opsAlert', 'secRotate']); assert.equal(certain.last.status, 'rejected'); assert.ok(certain.last.flags!.includes('unsupported_certainty'));
  const unfalsifiable = await run({ override: out => ({ ...out, title: 'Vague', metadata: { ...out.metadata, testPlan: [], proposedValidation: 'later' } }) }, ['vizSeries', 'pyPipe']); assert.equal(unfalsifiable.jobs[0]!.status, 'dead_letter', 'no test plan: the output never becomes a proposal'); assert.match(unfalsifiable.jobs[0]!.error!, /no valid discovery/); assert.match(JSON.stringify((unfalsifiable.jobs[0]!.trace as { skipped: unknown[] }).skipped), /testPlan|proposedValidation/);
  const fabricated = await run({ override: out => ({ ...out, evidence: [...out.evidence, { uri: 'mdb://wiki/objects/obj_invented_000000000000000000000000', revisionId: 'rev_x' }] }) }, ['opsDeploy', 'jsCache']); assert.equal(fabricated.jobs[0]!.status, 'dead_letter');
  const known = await run({ override: out => ({ ...out, title: 'Known', body: w.pack.docs.secRotate!.body }) }, ['secAuth', 'opsAlert']); assert.equal(known.last.status, 'rejected'); assert.ok(known.last.flags!.includes('already_known'), `restating a neighbouring page that was not even cited: ${known.last.flags}`);
  const rejected = await rejectionsOf(); assert.ok(rejected.length >= 4, `${rejected.length} rejected records`); assert.ok(rejected.every(r => r.flags.reasons.length >= 1 && r.flags.reasons[0]!.length > 10), 'every rejection keeps a human reason');
  const reopened = new Engram(w.root); const again = (await reopened.listDocuments()).filter(d => d.kind === 'discovery' && d.status === 'rejected'); assert.equal(again.length, rejected.length, 'rejection records survive a restart'); assert.equal((await discoveries(w.vault, 'candidate')).length, 1, 'only the one good idea is live');
  recordCase({ suite: 'dream', name: 'critic-rejections-persisted', status: 'PASS', detail: { rejectedRecords: rejected.length } });
});

test('privacy: an agent cannot dream over what it cannot read; a remote model never sees private notes; private-derived ideas are reviewed and kept out of shared indexes', async t => {
  const w = await world(t); const agentVault = new Vault(w.root, { actorId: 'agent', permissions: ['global:wiki:read', 'global:discoveries:write', 'global:discoveries:read'] });
  const seen: string[] = []; const spy = dreamer({ override: (out, req) => { seen.push(...req.documents.map(d => d.body)); return out; } });
  const agentEngine = new IntelligenceEngine(agentVault, spy); await enqueueRun(agentEngine, { mode: 'deep' });
  assert.ok(spy.calls.length >= 1); assert.ok(!seen.some(b => b.includes('PRIVATE-MARKER')), 'an agent without workspace access never receives private text, in any mode'); assert.ok(!JSON.stringify(await agentEngine.proposals()).includes('PRIVATE-MARKER'));
  const remote = Object.assign(dreamer(), { locality: 'remote' as const }); const gated = new IntelligenceEngine(w.vault, remote);
  const blocked = await enqueueRun(gated, { mode: 'micro', scope: { type: 'workspace', workspaceId: 'private' } satisfies Scope }); assert.equal(blocked[0]!.status, 'blocked'); assert.match(blocked[0]!.error!, /allowPrivateContentToRemote/); assert.equal(remote.calls.length, 0, 'the remote provider was never called');
  const local = new IntelligenceEngine(w.vault, dreamer()); await enqueueRun(local, { mode: 'micro', objectIds: ids(w.pack, 'privApi', 'pyApi') });
  const p = (await local.proposals()).at(-1)!; assert.equal(p.status, 'pending'); assert.ok(p.flags!.includes('derived_from_private')); assert.equal(p.input.metadata!.derivedFromPrivate, true); assert.equal(p.critic!.verdict, 'review_required');
  const stored = await w.vault.get((await local.review(p.id, true, 'reviewed')).objectId!); assert.equal(stored.metadata.visibility, 'user_private');
  await new Engram(w.root).search.rebuild(); for (const f of ['discoveries/INDEX.md', 'MAIN_INDEX.md', 'wiki/INDEX.md', 'shared/INDEX.md']) assert.doesNotMatch(await fs.readFile(path.join(w.root, f), 'utf8'), /billing|Internal billing/i, f);
  assert.equal((await new Engram(w.root, { actorId: 'nobody', permissions: ['global:wiki:read'] }).listDocuments()).filter(d => d.kind === 'discovery').length, 0, 'discoveries are invisible without a discoveries grant');
  recordCase({ suite: 'dream', name: 'dream-privacy', status: 'PASS' });
});

test('feedback drives status and ranking; rejected ideas do not come back without new evidence; repetition never validates', async t => {
  const w = await world(t); const engine = new IntelligenceEngine(w.vault, dreamer());
  const make = async (...keys: string[]) => { await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, ...keys) }); const p = (await engine.proposals()).at(-1)!; assert.equal(p.status, 'pending', String(p.flags)); return w.vault.get((await engine.review(p.id, true)).objectId!); };
  const good = await make('pyApi', 'jsDash'), bad = await make('opsDeploy', 'vizDash');
  await assert.rejects(recordFeedback(w.vault, good.id, { outcome: 'validated', note: 'looked fine', validatedBy: 'experiment' }), { code: 'INVALID_INPUT' }, 'an experiment must cite its result');
  await assert.rejects(recordFeedback(w.vault, good.id, { outcome: 'validated', note: 'I think so' }), { code: 'INVALID_INPUT' }, 'saying it again is not validation');
  const tested = await recordFeedback(w.vault, good.id, { outcome: 'tested', note: 'built the prototype' }); assert.equal(tested.status, 'tested');
  const result = await w.vault.put({ scope: { type: 'global', area: 'shared' }, kind: 'finding', title: 'Prototype result', body: 'The dashboard rendered the API output correctly.' });
  const validated = await recordFeedback(w.vault, good.id, { outcome: 'validated', note: 'worked end to end', validatedBy: 'experiment', evidence: [{ uri: result.uri, revisionId: result.revisionId }], reusedBy: [w.pack.docs.vizDash!.uri] });
  assert.equal(validated.status, 'validated'); assert.equal((validated.metadata.feedback as unknown[]).length, 2); assert.ok(validated.links.some(l => l.type === 'reused_by')); assert.equal((await w.vault.history(good.id)).length, 3, 'every transition is a revision');
  await assert.rejects(recordFeedback(w.vault, good.id, { outcome: 'tested', note: 'again' }), { code: 'INVALID_INPUT' }, 'no going back');
  const rejected = await recordFeedback(w.vault, bad.id, { outcome: 'rejected', note: 'deploys and charts have no real link' }); assert.equal(rejected.status, 'rejected');
  const stats = await readStats(w.vault); const keys = Object.keys(stats); assert.ok(keys.some(k => stats[k]!.validated === 1) && keys.some(k => stats[k]!.rejected === 1));
  const family = (d: typeof good) => `${d.metadata.mode}|${(d.metadata.domains as string[]).sort().join('+')}`; assert.ok(successRate(stats, family(good).replace('micro', 'micro')) > 0.5 && successRate(stats, family(bad)) < 0.5);
  const ctx = async (success?: (f: string) => number) => { const c = await planContext(w.vault, await dreamPool(w.vault), budgetsFor('deep', {}), rngFrom('same')); return success ? { ...c, success } : c; };
  const rank = (plan: ReturnType<typeof planDeep>, d: string) => plan.clusters.findIndex(c => c.hints[0] && c.hints[0].domains.sort().join('+') === d);
  const learned = planDeep(await ctx((f) => (f === 'deep|js-frontend+python-api' ? 0.95 : 0.2)), 0), neutral = planDeep(await ctx(() => 0.5), 0);
  assert.ok(rank(learned, 'js-frontend+python-api') !== -1 && (rank(neutral, 'js-frontend+python-api') === -1 || rank(learned, 'js-frontend+python-api') <= rank(neutral, 'js-frontend+python-api')), 'a family that validated before ranks at least as high');
  // rejected idea: same evidence -> suppressed; new evidence -> eligible again
  const before = (await engine.proposals()).length; await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'opsDeploy', 'vizDash') }); assert.equal((await engine.proposals()).length, before, 'the same evidence is the same proposal: a rejected idea is not regenerated');
  await w.vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Learn observability', body: 'Learn observability for my deploys', status: 'accepted', metadata: { insightSchema: 1, category: 'goal', preferenceKey: 'goal-observability', evidenceClass: 'explicit', confidenceLabel: 'high', scopeLabel: 'global', validFrom: '2026-10-08', visibility: 'user_private', sensitivity: 'none', sources: [] } });
  await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'opsDeploy', 'vizDash') }); const repeat = (await engine.proposals()).at(-1)!; assert.equal(repeat.status, 'rejected'); assert.ok(repeat.flags!.includes('repeat_of_rejected'), `changed goals produce a new proposal, which the critic still refuses: ${repeat.flags}`);
  const fresh = await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Release dashboards', body: 'Teams chart deploy frequency and rollback counts on a release dashboard.', tags: ['domain:data-viz', 'deploy', 'dashboard'] });
  const citing = new IntelligenceEngine(w.vault, dreamer({ override: out => ({ ...out, title: 'Release dashboards fed by deploy telemetry', body: 'Hypothesis: the release dashboard page suggests charting rollback counts per deploy, which the deploy pipeline could emit as a metric stream; a throwaway dashboard fed by one pipeline would show whether the signal is useful.', evidence: [...out.evidence, { uri: fresh.uri, revisionId: fresh.revisionId, span: 'deploy frequency' }] }) })); await enqueueRun(citing, { mode: 'micro', objectIds: [w.pack.ids.opsDeploy!, w.pack.ids.vizDash!, fresh.id] }); const retry = (await citing.proposals()).at(-1)!; assert.equal(retry.status, 'pending', `new evidence reopens the question: ${retry.flags}`);
  await w.vault.patch({ objectId: w.pack.ids.pyApi!, expectedRevisionId: w.pack.docs.pyApi!.revisionId, body: 'Python services now expose JSON and GraphQL.' });
  assert.ok((await staleDiscoveries(w.vault)).some(s => s.id === good.id), 'a discovery whose source changed is flagged for re-examination');
  recordCase({ suite: 'dream', name: 'feedback-learning-suppression', status: 'PASS' });
});

test('model failure modes are safe: malformed, refusing, timing-out, unavailable and cancelled providers never write knowledge', async t => {
  const w = await world(t); const before = (await w.vault.events()).length;
  const attempt = async (override: Parameters<typeof dreamer>[0], signal?: AbortSignal) => { const marker = `failure-${++attemptCounter}`; const e = new IntelligenceEngine(w.vault, dreamer(override)); await e.enqueue('dream', { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash'), instruction: marker }); const jobs = (await e.run({ job: 'dream', limit: 3, ...(signal ? { signal } : {}) })).filter(j => j.input.instruction === marker); return { e, jobs, marker, proposals: await e.proposals() }; };
  const malformed = await attempt({ override: () => ({ kind: 'discovery', title: 'x', body: 'y', evidence: [] }) as ModelProposal }); assert.equal(malformed.jobs[0]!.status, 'dead_letter');
  const refusal = await attempt({ override: () => ({ kind: 'wiki_page', title: 'I cannot help with that', body: 'Sorry, I cannot do that request.', evidence: [] }) as ModelProposal }); assert.equal(refusal.jobs[0]!.status, 'dead_letter');
  const down = await attempt({ throws: () => new ProviderError('Model provider returned HTTP 503', true, 503) }); assert.equal(down.jobs[0]!.status, 'pending', 'transient outage: retried later'); assert.equal(down.jobs[0]!.error, 'Model provider returned HTTP 503');
  const auth = await attempt({ throws: () => new ProviderError('Model provider rejected the credentials', false, 401) }); assert.equal(auth.jobs[0]!.status, 'blocked');
  const timeout = await attempt({ throws: () => new Error('socket hang up SECRET-PROMPT-TEXT') }); assert.equal(timeout.jobs[0]!.error, 'Provider failed; no output committed'); assert.ok(!JSON.stringify(await timeout.e.jobs()).includes('SECRET-PROMPT-TEXT'));
  const ctl = new AbortController(); ctl.abort(); const cancelled = await attempt({}, ctl.signal); assert.deepEqual(cancelled.jobs, []); assert.equal((await cancelled.e.jobs()).find(j => j.input.instruction === cancelled.marker)!.status, 'pending');
  assert.equal((await w.vault.events()).length, before, 'no failure wrote anything'); assert.equal((await discoveries(w.vault)).length, 0); assert.equal((await w.vault.verify()).ok, true);
  recordCase({ suite: 'dream', name: 'dream-failure-modes', status: 'PASS' });
});

test('no runaway dreaming: discoveries never seed dreams, triggers are rate-limited and deduplicated, and every budget is enforced', async t => {
  const w = await world(t, { maxRunsPerDay: 2, maxProposalsPerRun: 2, modes: ['micro', 'deep'], eventDriven: true }); const model = dreamer(); const engine = new IntelligenceEngine(w.vault, model);
  const pool = await dreamPool(w.vault); assert.ok(!pool.some(e => e.kind === 'discovery'), 'discoveries are not dream material');
  await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') }); const p = (await engine.proposals()).at(-1)!; await engine.review(p.id, true);
  const callsAfterApproval = model.calls.length; for (let i = 0; i < 3; i++) await engine.run({ limit: 10 });
  const dreamJobs = (await engine.jobs()).filter(j => j.kind === 'dream' && j.status === 'pending'); assert.equal(dreamJobs.filter(j => j.input.incremental).length <= 1, true);
  assert.ok(!(await engine.jobs()).some(j => j.kind === 'dream' && j.input.objectIds?.some(id => id === p.objectId)), 'an approved discovery never queues a dream about itself');
  const deep = await (async () => { await engine.enqueue('dream', { mode: 'deep' }); await engine.run({ job: 'dream', limit: 1 }); return engine.proposals(); })(); assert.ok(deep.filter(x => x.input.metadata?.mode === 'deep').length <= 2, 'maxProposalsPerRun caps clusters and model calls');
  // event-driven triggers and the daily cap
  const triggered = new IntelligenceEngine(w.vault, dreamer());
  for (let i = 0; i < 4; i++) { await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: `Fresh page ${i}`, body: `Fresh content number ${i} about caches and dashboards.`, tags: ['domain:devops', 'cache', 'dashboard'] }); await triggered.run({ limit: 20 }); }
  const auto = (await triggered.jobs()).filter(j => j.kind === 'dream' && j.input.incremental); assert.ok(auto.length >= 1, 'new knowledge queues a micro dream'); assert.ok(auto.filter(j => j.status === 'complete').length <= 2, 'the daily limit applies to automatic runs'); assert.ok(auto.some(j => j.status === 'blocked' && /daily limit/.test(j.error ?? '')) || auto.length <= 2);
  // budgets: duration and tokens
  const slow = new IntelligenceEngine(w.vault, dreamer({ override: async out => { await new Promise(r => setTimeout(r, 60)); return out; } })); const cfg = await w.vault.config(); cfg.dream.maxDurationMs = 1; await fs.writeFile(path.join(w.root, 'mdb.yaml'), YAML.stringify(cfg));
  await slow.enqueue('dream', { mode: 'deep', instruction: 'duration-test' }); await slow.run({ job: 'dream', limit: 5 }); const trace = (await slow.jobs()).find(j => j.input.instruction === 'duration-test')!.trace as { stoppedBy?: string }; assert.equal(trace.stoppedBy, 'duration');
  cfg.dream.maxDurationMs = 600000; cfg.dream.quietHours = { startHour: (new Date().getHours() + 2) % 24, endHour: (new Date().getHours() + 3) % 24 }; await fs.writeFile(path.join(w.root, 'mdb.yaml'), YAML.stringify(cfg));
  const night = new IntelligenceEngine(w.vault, dreamer()); const quiet = await enqueueRun(night, { mode: 'deep', background: true }); assert.equal(quiet[0]!.status, 'blocked'); assert.match(quiet[0]!.error!, /quiet hours/);
  await night.enqueue('dream', { mode: 'deep', instruction: 'manual-run' }); await night.run({ job: 'dream', limit: 20 }); const manual = (await night.jobs()).find(j => j.input.instruction === 'manual-run')!; assert.notEqual(manual.status, 'blocked', 'an explicit run ignores quiet hours'); void callsAfterApproval;
  recordCase({ suite: 'dream', name: 'no-runaway-and-budgets', status: 'PASS' });
});
