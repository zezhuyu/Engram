import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPack } from '../dream/pack.js';
import { recordCase } from '../helpers/report.js';
import { sleep, world, type World } from './helpers.js';
import { AdaptiveStore } from '../../packages/adaptive/state.js';
import { CycleRunner } from '../../packages/adaptive/cycle.js';
import { touchActivity } from '../../packages/adaptive/activity.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import type { Cycle } from '../../packages/adaptive/types.js';

/** Simulates process death: from the k-th durable checkpoint on, every write to cycle/lease state fails and nothing more is persisted. */
class DyingStore extends AdaptiveStore {
  saves = 0; dead = false; constructor(root: string, private readonly dieAt = Number.POSITIVE_INFINITY) { super(root); }
  override async saveCycle(cycle: Cycle): Promise<void> { if (this.dead || ++this.saves >= this.dieAt) { this.dead = true; throw new Error('CRASH'); } return super.saveCycle(cycle); }
  override async renewLease(instance: string, id: string, ttl: number): Promise<boolean> { if (this.dead) throw new Error('CRASH'); return super.renewLease(instance, id, ttl); }
  override async releaseLease(instance: string): Promise<void> { if (this.dead) throw new Error('CRASH'); return super.releaseLease(instance); }
}
async function scenario(t: Parameters<typeof world>[0]): Promise<World> {
  const w = await world(t); await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Python JSON APIs', body: 'Python services expose JSON over HTTP using FastAPI.', tags: ['domain:python-api', 'api', 'json', 'provides:json'] });
  await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'JS dashboards', body: 'Browser dashboards consume JSON through fetch and render widgets.', tags: ['domain:js-frontend', 'dashboard', 'consumes:json'] });
  await w.say('alpha', 'I prefer TypeScript for services [key:lang]'); await w.note('beta', 'note', 'Beta work', 'beta changed something'); return w;
}
const fingerprint = async (w: World) => { const docs = await w.vault.listDocuments(); const eng = new IntelligenceEngine(w.vault); const c = await w.ai.store.cursors();
  return { insights: docs.filter(d => d.kind === 'user_insight' && d.metadata.insightSchema === 1).length, summaries: docs.filter(d => d.kind === 'workspace_daily_summary').length, discoveryProposals: (await eng.proposals()).filter(p => p.input.kind === 'discovery').length, cursors: c, verify: (await w.vault.verify()).ok }; };

test('killing the cycle at every durable checkpoint recovers to the same result: no duplicate insights, summaries or dreams, no cursor skips', async t => {
  const clean = await scenario(t); const counter = new DyingStore(clean.root); const cleanRun = (await new CycleRunner(clean.vault, clean.provider, counter).run({ kind: 'manual', idempotencyKey: 'crash', respectActivity: false })).cycle!;
  assert.equal(cleanRun.state, 'COMPLETED', JSON.stringify(cleanRun.error)); const baseline = await fingerprint(clean); const checkpoints = counter.saves; assert.ok(checkpoints >= 8, `expected several checkpoints, saw ${checkpoints}`);
  const failures: string[] = []; const points = Array.from({ length: checkpoints }, (_, i) => i + 1);
  for (const k of points) {
    const w = await scenario(t); const dying = new DyingStore(w.root, k);
    await assert.rejects(() => new CycleRunner(w.vault, w.provider, dying).run({ kind: 'manual', idempotencyKey: 'crash', respectActivity: false, leaseMs: 20 }), /CRASH/); await sleep(60);
    const before = await w.ai.store.cycle('manual-crash'); const result = (await new CycleRunner(w.vault, w.provider, new AdaptiveStore(w.root)).run({ kind: 'manual', idempotencyKey: 'crash', respectActivity: false })).cycle!;
    if (result.state !== 'COMPLETED') { failures.push(`k=${k}: ${result.state} ${JSON.stringify(result.error)} (before ${before?.state})`); continue; }
    const got = await fingerprint(w); const sameWatermark = !before || before.watermark === result.watermark && before.manifestHash === result.manifestHash;
    if (JSON.stringify({ ...got, cursors: undefined }) !== JSON.stringify({ ...baseline, cursors: undefined }) || !sameWatermark || Object.keys(got.cursors.workspaces).length !== Object.keys(baseline.cursors.workspaces).length) failures.push(`k=${k}: ${JSON.stringify(got)} vs ${JSON.stringify(baseline)} sameSnapshot=${sameWatermark}`);
    for (const [id, cursor] of Object.entries(got.cursors.workspaces)) if (cursor !== result.watermark) failures.push(`k=${k}: cursor ${id}=${cursor} != W ${result.watermark}`);
  }
  assert.deepEqual(failures, []); recordCase({ suite: 'adaptive', name: 'crash-at-every-checkpoint', status: 'PASS', detail: { checkpoints } });
});

test('foreground activity mid-profile cancels promptly with the same sealed inputs; the cycle resumes on the same snapshot and excludes everything committed meanwhile', async t => {
  const w = await scenario(t); w.provider.profileWaitMs = 5000; let announced = false;
  w.provider.onProfile = async () => { if (!announced) { announced = true; setTimeout(() => { void touchActivity(w.root, new Date(Date.now() + 1000)); }, 60); } };
  const started = Date.now(); const first = (await w.ai.runCycle({ kind: 'scheduled', now: new Date(), respectActivity: true })).cycle!; const elapsed = Date.now() - started;
  assert.equal(first.state, 'PAUSED', JSON.stringify(first.error)); assert.equal(first.error!.category, 'CANCELLED_FOR_ACTIVITY'); assert.ok(elapsed < 3000, `paused within ${elapsed} ms, long before the 5 s model call would finish`); assert.equal(first.metrics.activityCancellations, 1);
  const manifest = first.manifestHash, watermark = first.watermark; const late = await w.say('alpha', 'MIDRUN I prefer Go for tools [key:late]'); w.provider.profileWaitMs = 0; w.provider.onProfile = undefined;
  await touchActivity(w.root, new Date(Date.now() - 3 * 3600_000)); // the person has gone idle again
  const second = (await w.ai.resumeCycle(first.id, { respectActivity: false })).cycle!; assert.equal(second.state, 'COMPLETED', JSON.stringify({ e: second.error })); assert.equal(second.manifestHash, manifest); assert.equal(second.watermark, watermark); assert.equal(second.metrics.resumes, 1);
  assert.ok(!JSON.stringify(w.provider.calls).includes('MIDRUN') && !JSON.stringify(w.provider.calls).includes(late.id), 'work committed during the pause never entered this cycle');
  recordCase({ suite: 'adaptive', name: 'activity-pause-resume-same-snapshot', status: 'PASS' });
});

test('purge after sealing: purged text is never sent to the model, and every derived artifact built from it is withdrawn before later stages', async t => {
  const w = await scenario(t); const secret = await w.say('beta', 'PURGEME I prefer COBOL for mainframes [key:cobol]');
  const first = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'purge-1', respectActivity: false, stopAfter: 'workspaces' })).cycle!; assert.equal(first.state, 'WORKSPACES_COMMITTED', JSON.stringify(first.error));
  const accepted = first.workspaces.beta!.accepted[0]!; assert.ok(accepted, 'a derived insight exists from the soon-to-be-purged evidence'); const summaryId = first.workspaces.beta!.summary!.objectId;
  assert.ok((await w.vault.get(summaryId)).body.includes('PURGEME'), 'precondition: the summary quotes the evidence');
  await w.vault.purge(secret.id, true); const callsBefore = w.provider.calls.length;
  const resumed = (await w.ai.resumeCycle(first.id, { respectActivity: false })).cycle!; assert.equal(resumed.state, 'COMPLETED', JSON.stringify({ e: resumed.error, d: resumed.dream.error }));
  assert.ok(!JSON.stringify(w.provider.calls.slice(callsBefore)).includes('PURGEME'), 'no model request after the purge discloses it');
  await assert.rejects(w.vault.get(summaryId), /NOT_FOUND|not found|forbidden/i, 'the summary that quoted the purged evidence is itself purged'); assert.equal((await w.vault.listDocuments()).filter(d => JSON.stringify(d).includes('PURGEME')).length, 0, 'no live document still carries the purged text');
  await assert.rejects(w.vault.get(accepted.objectId), /NOT_FOUND|not found|forbidden/i, 'the insight derived from purged evidence (its evidence span quotes it) is purged too');
  assert.ok(!resumed.permittedDerived.some(o => o.objectId === accepted.objectId), 'the purged insight is no longer a permitted Dream input'); assert.ok(resumed.accessEvents!.length >= 2, 'invalidations are recorded in the cycle');
  const profile = await (await import('node:fs')).promises.readFile((await import('node:path')).join(w.root, 'PROFILE.md'), 'utf8'); assert.ok(!profile.includes('COBOL'), 'root Markdown no longer projects the withdrawn insight');
  recordCase({ suite: 'adaptive', name: 'purge-propagation', status: 'PASS' });
});

test('a permission change after sealing invalidates the snapshot before the next stage instead of publishing results built under the old policy', async t => {
  const w = await scenario(t); const first = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'policy-1', respectActivity: false, stopAfter: 'workspaces' })).cycle!; assert.equal(first.state, 'WORKSPACES_COMMITTED');
  await w.vault.grant('alpha', 'agent-late', ['read']); const resumed = (await w.ai.resumeCycle(first.id, { respectActivity: false })).cycle!;
  assert.equal(resumed.state, 'INVALIDATED'); assert.equal(resumed.error!.category, 'POLICY_INVALIDATED'); assert.equal(w.provider.dreamCalls().length, 0, 'Dream did not run on a stale policy');
  const replacement = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'policy-2', respectActivity: false })).cycle!; assert.equal(replacement.state, 'COMPLETED', JSON.stringify(replacement.error));
  recordCase({ suite: 'adaptive', name: 'policy-change-invalidation', status: 'PASS' }); void buildPack;
});

test('without a model provider model-assisted stages report BLOCKED and never claim success; deterministic summaries still commit', async t => {
  const w = await world(t, { provider: false }); await w.say('alpha', 'I prefer TypeScript for services [key:lang]'); await w.note('beta', 'note', 'Beta only', 'deterministic content');
  const c = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'blocked-1', respectActivity: false })).cycle!;
  assert.equal(c.state, 'BLOCKED'); assert.equal(c.error!.category, 'MODEL_UNAVAILABLE'); assert.equal(c.workspaces.alpha!.status, 'BLOCKED'); assert.equal(c.workspaces.beta!.status, 'SUCCEEDED'); assert.equal(c.dream.status, 'PENDING'); assert.equal(c.global.status, 'PENDING');
  assert.equal((await w.ai.store.cursors()).workspaces.alpha ?? 0, 0, 'blocked workspace is not marked processed'); assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'workspace_daily_summary').length, 2, 'summaries need no model');
  recordCase({ suite: 'adaptive', name: 'model-unavailable-blocked', status: 'PASS' });
});

test('the per-run budget of model-backed stage jobs is enforced: the cycle pauses when it is spent and later resumes to completion on the same snapshot', async t => {
  const w = await world(t, { config: { maxModelCallsPerCycle: 1, dreamMode: 'micro' } }); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript [key:a]'); await w.say('beta', 'I prefer Python [key:b]');
  let result = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'budget', respectActivity: false })).cycle!; const manifest = result.manifestHash; let runs = 1; const jobsPerRun: number[] = [result.metrics.modelCalls ?? 0]; let previous = result.metrics.modelCalls ?? 0;
  // With a one-call segment, each bounded Dream cluster may need its own resume.
  // Bound the test well above the fixture's finite work instead of assuming it
  // can finish in eight segments.
  while (result.state === 'PAUSED' && runs < 32) { assert.equal(result.error!.category, 'RESOURCE_PRESSURE'); result = (await w.ai.resumeCycle(result.id, { respectActivity: false })).cycle!; jobsPerRun.push((result.metrics.modelCalls ?? 0) - previous); previous = result.metrics.modelCalls ?? 0; runs++; assert.equal(result.manifestHash, manifest, 'same sealed snapshot across budget pauses'); }
  assert.equal(result.state, 'COMPLETED', JSON.stringify({ e: result.error, runs })); assert.ok(runs >= 3, `needed ${runs} runs`); assert.ok(jobsPerRun.every(n => n <= 1), `stage jobs per run stayed within the budget: ${jobsPerRun}`);
  recordCase({ suite: 'adaptive', name: 'model-call-budget', status: 'PASS', detail: { runs, jobsPerRun } });
});
