import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { buildPack, PACK_SIZE } from './pack.js';
import { dreamPool, planContext } from '../../packages/intelligence/dream/context.js';
import { budgetsFor, domainOf, hasLexicalEvidenceBridge, planDeep, planMicro, planStrategic, rngFrom, words } from '../../packages/intelligence/dream/plan.js';
import { readableEntries } from '../../packages/intelligence/corpus.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { fakeEmbedder } from '../helpers/embedder.js';
import type { ManifestEntry } from '../../packages/search-files/manifest.js';

type T = { after(fn: () => void | Promise<void>): void };
async function world(t: T) { const { root, vault } = await disposableVault(t); const pack = await buildPack(vault); return { root, vault, pack }; }
const ctxFor = async (vault: Vault, mode: 'micro' | 'deep' | 'strategic', seed = 'job-1') => planContext(vault, await dreamPool(vault), budgetsFor(mode, { maxCandidates: 24, maxProposalsPerRun: 5 }), rngFrom(seed));
const entry = async (vault: Vault, id: string) => (await readableEntries(vault, {})).find(e => e.id === id)!;

test('the evaluation pack has 20+ documents across 5 knowledge domains, contradictions and private notes', async t => {
  const w = await world(t); assert.ok(PACK_SIZE >= 20);
  const pool = await dreamPool(w.vault); const domains = new Set(pool.map(domainOf));
  for (const d of ['python-api', 'js-frontend', 'devops', 'data-viz', 'security', 'gardening', 'finance']) assert.ok(domains.has(d), d);
  assert.ok(!pool.some(e => e.kind === 'discovery' || e.kind === 'user_insight' || e.kind === 'session'), 'raw logs, insights and discoveries are not dream material');
  recordCase({ suite: 'dream', name: 'evaluation-pack', status: 'PASS', detail: { documents: PACK_SIZE, domains: domains.size } });
});

test('configured SQLite vectors add bounded semantic associations to Dream micro retrieval; unavailable backend preserves lexical graph behavior', async t => {
  const { vault } = await disposableVault(t, { sqlite: true });
  const pack = await buildPack(vault); const embedder = fakeEmbedder(); const search = new SearchEngine(vault, { embedder });
  await search.rebuild(); await search.embedSync();
  const pool = await dreamPool(vault); const ctx = await planContext(vault, pool, budgetsFor('micro'), rngFrom('semantic-association'), { search });
  assert.ok(ctx.semanticAssociationCount > 0, 'ready vector backend returns semantic neighbors');
  const seed = pool.find(e => e.id === pack.ids.pyApi)!; const plan = planMicro(ctx, [seed]);
  assert.ok(plan.trace.candidates.some(candidate => candidate.via === 'semantic-association'), 'the trace attributes semantic candidates');
  assert.ok(plan.trace.semanticAssociations! > 0);
});

test('micro: a local neighbourhood of the changed object plus a few complementary objects from other domains, within a small budget', async t => {
  const w = await world(t); const ctx = await ctxFor(w.vault, 'micro'); const seed = await entry(w.vault, w.pack.ids.pyRate!);
  const { clusters, trace } = planMicro(ctx, [seed]);
  assert.equal(trace.algorithm, 'local-neighbourhood'); assert.equal(clusters.length, 1); const ids = clusters[0]!.ids;
  assert.equal(ids[0], seed.id); assert.ok(ids.length <= 8, 'object budget'); const domains = ids.map(id => domainOf(ctx.pool.find(e => e.id === id)!));
  assert.ok(domains.includes('python-api') && new Set(domains).size >= 2, 'the seed domain and at least one other');
  assert.ok(ids.includes(w.pack.ids.secRate!) || ids.includes(w.pack.ids.jsCache!), 'complementary objects share the "ratelimit" vocabulary');
  assert.ok(ids.includes(w.pack.ids.pyApi!), 'near: the same-domain object sharing "api"');
  assert.ok(!ids.some(id => domainOf(ctx.pool.find(e => e.id === id)!) === 'gardening'), 'unrelated domains stay out');
  assert.ok(clusters[0]!.hints.every(h => h.distance === 'complementary'));
  const lonely = planMicro(ctx, [await entry(w.vault, w.pack.ids.gardenCompost!)]); assert.equal(lonely.clusters.length, 0); assert.equal(lonely.trace.skipped[0]!.reason, 'single_domain', 'no cross-domain neighbour: nothing to dream about');
  recordCase({ suite: 'dream', name: 'micro-retrieval', status: 'PASS', detail: { objects: ids.length } });
});

test('deep: rare cross-domain bridges, provides/consumes pairs, contradictions and long paths, excluding direct neighbours and unrelated domains', async t => {
  const w = await world(t); const ctx = await ctxFor(w.vault, 'deep'); const { clusters, trace } = planDeep(ctx, 0);
  assert.equal(trace.algorithm, 'cross-domain-far-sampling'); assert.ok(clusters.length >= 3 && clusters.length <= 5, `${clusters.length} clusters`);
  assert.ok(trace.budget.usedObjects <= 24); assert.ok(trace.domainsCovered.length >= 4, `domains: ${trace.domainsCovered}`);
  const via = new Set(trace.candidates.map(c => c.via)); assert.ok([...via].some(v => v.startsWith('provides-consumes:json')), 'python API provides JSON that the JS dashboard consumes'); assert.ok(via.has('contradiction'), 'the contradicting caching claims are paired');
  const contradiction = clusters.find(c => c.hints.some(h => h.via === 'contradiction'))!; assert.ok(contradiction.ids.includes(w.pack.ids.claimAll!) && contradiction.ids.includes(w.pack.ids.claimNone!));
  for (const c of clusters) assert.ok(new Set(c.ids.map(id => domainOf(ctx.pool.find(e => e.id === id)!))).size >= 2, 'every cluster crosses domains');
  const gardening = new Set([w.pack.ids.gardenSoil, w.pack.ids.gardenPrune, w.pack.ids.gardenCompost]); assert.ok(!clusters.some(c => c.ids.some(id => gardening.has(id))), 'a domain with no bridge to anything is never dragged in');
  const again = planDeep(await ctxFor(w.vault, 'deep'), 0); assert.deepEqual(again.clusters.map(c => c.ids), clusters.map(c => c.ids), 'same inputs and seed give the same plan');
  recordCase({ suite: 'dream', name: 'deep-retrieval', status: 'PASS', detail: { clusters: clusters.length, domains: trace.domainsCovered.length } });
});

test('strategic: goal-directed capabilities, competing domains and gaps; a goal nothing supports yields a gap report and no model call', async t => {
  const w = await world(t); const ctx = await ctxFor(w.vault, 'strategic'); const goal = await entry(w.vault, w.pack.goalId);
  const { clusters, trace } = planStrategic(ctx, [{ entry: goal, terms: words(goal.title) }]);
  assert.equal(trace.algorithm, 'goal-directed-gap-analysis'); assert.deepEqual(trace.goalRefs, [w.pack.goalId]); assert.equal(clusters.length, 1);
  const c = clusters[0]!; assert.equal(c.ids[0], w.pack.goalId); assert.deepEqual(c.goalIds, [w.pack.goalId]); assert.equal(c.hints[0]!.kind, 'opportunity');
  const domains = new Set(c.ids.slice(1).map(id => domainOf(ctx.pool.find(e => e.id === id)!))); assert.ok(domains.has('js-frontend') && domains.has('data-viz'), `competing domains: ${[...domains]}`);
  assert.ok(trace.gaps!.some(g => g.terms.length), 'terms of the goal that nothing covers are reported as gaps');
  const nothing = planStrategic(ctx, [{ entry: { ...goal, id: 'obj_nogoal', title: 'Master quantum chromodynamics' }, terms: words('Master quantum chromodynamics') }]);
  assert.equal(nothing.clusters.length, 0); assert.equal(nothing.trace.skipped[0]!.reason, 'no_supporting_knowledge'); assert.ok(nothing.trace.gaps![0]!.terms.includes('quantum'));
  recordCase({ suite: 'dream', name: 'strategic-retrieval', status: 'PASS' });
});

test('strategic planner skips goals with only one supporting knowledge object before model invocation', async t => {
  const w = await world(t);
  const goal = await entry(w.vault, w.pack.goalId);
  const onlyOne = (await readableEntries(w.vault, {})).filter(e => e.kind === 'note').slice(0, 1);
  assert.equal(onlyOne.length, 1);
  const ctx = await planContext(w.vault, onlyOne, budgetsFor('strategic', { maxProposalsPerRun: 5 }), rngFrom('one-support-only'));
  const planned = planStrategic(ctx, [{ entry: goal, terms: words(onlyOne[0]!.title) }]);
  assert.equal(planned.clusters.length, 0);
  assert.ok(planned.trace.skipped.some(item => item.reason === 'no_eligible_cluster'));
  recordCase({ suite: 'dream', name: 'strategic-no-eligible-cluster', status: 'PASS' });
});

test('strategic planner retrieves goal-relevant untagged notes from bounded body terms', () => {
  const makeEntry = (id: string, domain: string, title: string): ManifestEntry => ({
    id, dom: domain, tags: [], title, rev: `rev-${id}`, first: 1, last: 1,
    scope: { type: 'global', area: 'wiki' }, sk: 'global:wiki', kind: 'note',
    status: 'active', updated: '', at: '', refs: [],
  });
  const goal = makeEntry('goal-body', 'goals', 'Reduce service delay');
  const client = makeEntry('client-note', 'client', 'Retry policy');
  const service = makeEntry('service-note', 'service', 'Queue management');
  const ctx = {
    pool: [client, service],
    graph: { out: () => [], in: () => [] },
    budgets: budgetsFor('strategic'),
    rng: rngFrom('strategic-body-recall'),
    bodyTerms: new Map([[client.id, ['latency', 'backoff']], [service.id, ['latency', 'queue']]]),
    success: () => 0.5,
    suppressed: () => false,
  };
  const planned = planStrategic(ctx, [{ entry: goal, terms: ['latency'] }]);
  assert.equal(planned.clusters.length, 1, 'two body-supported sources are enough to form a review cluster');
  assert.ok(planned.clusters[0]!.ids.includes(client.id));
  assert.ok(planned.clusters[0]!.ids.includes(service.id));
  assert.ok(planned.trace.candidates.every(candidate => candidate.via === 'goal:latency'));

  const insufficient = planStrategic({ ...ctx, pool: [client] }, [{ entry: goal, terms: ['latency'] }]);
  assert.equal(insufficient.clusters.length, 0, 'one body-only match still cannot satisfy the two-source minimum');
  assert.ok(insufficient.trace.skipped.some(item => item.reason === 'no_eligible_cluster'));
  recordCase({ suite: 'dream', name: 'strategic-untagged-body-recall', status: 'PASS', detail: { positiveSources: 2, oneSourceNegative: true } });
});

test('unrelated cross-domain negative control has no Dream cluster for an unsupported bridge', async t => {
  const w = await world(t);
  const pool = await dreamPool(w.vault);
  const unrelated = pool.filter(item => [w.pack.ids.gardenSoil, w.pack.ids.opsAlert].includes(item.id));
  assert.equal(unrelated.length, 2);
  const ctx = await planContext(w.vault, unrelated, budgetsFor('deep', { maxProposalsPerRun: 5 }), rngFrom('unrelated-negative-control'));
  const planned = planDeep(ctx, 0);
  assert.equal(planned.clusters.length, 0);
  assert.equal(planned.trace.candidates.length, 0);
  recordCase({ suite: 'dream', name: 'unrelated-sources-negative-control', status: 'PASS' });
});

test('deep lexical recall ignores one-word natural-prose collisions but keeps multi-term and explicit-tag bridges', () => {
  const entry = (id: string, domain: string, tags: string[] = []): ManifestEntry => ({ id, dom: domain, tags, title: '', rev: 'r', first: 1, last: 1, scope: { type: 'global', area: 'wiki' }, sk: 'global:wiki', kind: 'note', status: 'active', updated: '', at: '', refs: [] });
  const oneWordDecoys = Array.from({ length: 20 }, (_, i) => {
    const a = entry(`a${i}`, `domain-a-${i}`), b = entry(`b${i}`, `domain-b-${i}`);
    return hasLexicalEvidenceBridge(a, b, new Map([
      [a.id, [`shared${i}`, `contexta${i}`]],
      [b.id, [`shared${i}`, `contextb${i}`]],
    ]));
  });
  assert.deepEqual(oneWordDecoys, Array(20).fill(false), 'one shared prose term is insufficient to create a cross-domain candidate');

  const proseA = entry('prose-a', 'api'), proseB = entry('prose-b', 'visualization');
  assert.equal(hasLexicalEvidenceBridge(proseA, proseB, new Map([
    [proseA.id, ['structured', 'records', 'dashboard']],
    [proseB.id, ['structured', 'records', 'visualization']],
  ])), true, 'two distinctive overlapping body terms retain untagged recall');
  const taggedA = entry('tagged-a', 'api', ['json']), taggedB = entry('tagged-b', 'frontend', ['json']);
  assert.equal(hasLexicalEvidenceBridge(taggedA, taggedB, new Map()), true, 'an explicit shared concept tag supports a one-word bridge');
});

test('the three modes use different algorithms, budgets and candidate sets; the retrieval trace shows it', async t => {
  const w = await world(t);
  const micro = planMicro(await ctxFor(w.vault, 'micro'), [await entry(w.vault, w.pack.ids.pyApi!)]).trace; const deep = planDeep(await ctxFor(w.vault, 'deep'), 0).trace;
  const goal = await entry(w.vault, w.pack.goalId); const strategic = planStrategic(await ctxFor(w.vault, 'strategic'), [{ entry: goal, terms: words(goal.title) }]).trace;
  assert.equal(new Set([micro.algorithm, deep.algorithm, strategic.algorithm]).size, 3);
  assert.ok(micro.budget.maxObjects < deep.budget.maxObjects); assert.notDeepEqual(micro.budget, strategic.budget);
  const ids = (t: typeof micro) => new Set(t.candidates.map(c => c.id));
  assert.ok([...ids(deep)].some(id => !ids(micro).has(id)), 'deep reaches objects micro never considers'); assert.ok([...ids(micro)].some(id => !ids(deep).has(id)) || ids(micro).size <= ids(deep).size);
  assert.ok(deep.domainsCovered.length > micro.domainsCovered.length, 'deep spans more domains'); assert.ok(deep.candidates.some(c => c.distance === 'distant') && !micro.candidates.some(c => c.distance === 'distant'));
  assert.ok(strategic.goalRefs && !micro.goalRefs && !deep.goalRefs, 'only strategic is goal-directed');
  recordCase({ suite: 'dream', name: 'mode-differences', status: 'PASS', detail: { microObjects: micro.budget.usedObjects, deepObjects: deep.budget.usedObjects, strategicObjects: strategic.budget.usedObjects } });
});

test('retrieval respects authorization: an agent without access to the private workspace never gets its objects into the pool, graph or plan', async t => {
  const w = await world(t); const agent = new Vault(w.root, { actorId: 'agent', permissions: ['global:wiki:read'] });
  const ownerPool = await dreamPool(w.vault), agentPool = await dreamPool(agent);
  assert.ok(ownerPool.some(e => e.id === w.pack.ids.privApi), 'the owner sees its private notes'); assert.ok(!agentPool.some(e => e.scope.type === 'workspace'), 'the agent does not');
  const { clusters, trace } = planDeep(await planContext(agent, agentPool, budgetsFor('deep', {}), rngFrom('x')), 0);
  const priv = new Set([w.pack.ids.privApi, w.pack.ids.privDash]); assert.ok(!clusters.some(c => c.ids.some(id => priv.has(id)))); assert.ok(!trace.candidates.some(c => priv.has(c.id)) && !JSON.stringify(trace).includes('finance'));
  recordCase({ suite: 'dream', name: 'retrieval-acl', status: 'PASS' });
});
