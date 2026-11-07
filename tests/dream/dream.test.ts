import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { buildNegativeControlDocs, buildPack, type Pack } from './pack.js';
import { dreamer, modeOf } from './helpers.js';
import { Vault } from '../../packages/core/vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { critiqueMessages, generationMessages } from '../../packages/models/prompts.js';
import { ProviderError } from '../../packages/models/errors.js';
import { dreamPool, planContext } from '../../packages/intelligence/dream/context.js';
import { budgetsFor, planDeep, rngFrom } from '../../packages/intelligence/dream/plan.js';
import { readStats, recordFeedback, staleDiscoveries, successRate } from '../../packages/intelligence/dream/lifecycle.js';
import { Engram, type ModelProposal, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';
import { dreamContradictionHandled, dreamHasUnsupportedUniversalClaim, dreamHeuristicQualityPass, dreamMetadataClaimsTraceable, dreamNegativeControlOutcome, dreamNegativeControlsPass, dreamScenarioOutcome, dreamTextMatchesTerms, isUsableDreamCandidate } from '../../scripts/lib/dream-metrics.js';
import { inputPath } from '../../scripts/lib/suite.js';
import { configureDreamEvalVault } from '../../scripts/lib/dream-eval-vault.js';
import { checkDiscovery, isHonestNoMechanismProposal, isLexicalOnlyCrossDomain, judgeDiscovery, scoreCandidate } from '../../packages/intelligence/dream/critic.js';
import { parseDreamResponse } from '../../packages/models/schema.js';
import { SearchEngine } from '../../packages/search-files/index.js';

test('Dream abstention is a valid discriminated result and rejects discovery-shaped abstentions', () => {
  const valid = { kind: 'no_insight', title: 'No supported connection', body: 'The supplied sources do not support a defensible connection.', evidence: [] };
  assert.deepEqual(parseDreamResponse(valid), { type: 'abstain', reason: valid.body });
  assert.throws(() => parseDreamResponse({ ...valid, evidence: [{ uri: 'u', revisionId: 'r' }] }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => parseDreamResponse({ ...valid, metadata: { subtype: 'analogy' } }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => parseDreamResponse({ status: 'abstain' }), { code: 'INVALID_MODEL_OUTPUT' }, 'an untyped or empty response remains a generation failure, not a valid abstention');
  assert.equal(parseDreamResponse({ kind: 'discovery', title: 'A', body: 'Hypothesis: possible', evidence: [{ uri: 'u', revisionId: 'r' }] }).type, 'discovery');
});

type T = { after(fn: () => void | Promise<void>): void };
test('Dream evaluation does not count rejected unsupported candidates as usable output', () => {
  assert.equal(isUsableDreamCandidate({ status: 'rejected' }), false);
  assert.equal(isUsableDreamCandidate({ status: 'pending', flags: ['not_selected'] }), false);
  assert.equal(isUsableDreamCandidate({ status: 'pending' }), true);
  assert.equal(isUsableDreamCandidate({ status: 'approved' }), true);
});

test('Dream evaluator input preserves all declared negative controls', async () => {
  const input = JSON.parse(await fs.readFile(inputPath('dream/labeled-scenarios.json'), 'utf8')) as { negativeControls?: Array<{ id: string; evidence: string[]; instruction: string; expectedUsableCandidates: number; minimumProviderCalls: number }> };
  assert.deepEqual(input.negativeControls?.map(control => control.id), [
    'java-homonym-negative-control',
    'python-homonym-negative-control',
    'bank-homonym-negative-control',
  ]);
  assert.ok(input.negativeControls?.every(control => control.expectedUsableCandidates === 0 && control.minimumProviderCalls > 0 && control.instruction.length >= 80 && control.evidence.length === 2));
});

test('Dream model negative controls reach the provider through distinct-domain lexical decoy clusters', async t => {
  const { vault } = await disposableVault(t, { prefix: 'engram-dream-negative-decoy-' });
  const docs = await buildNegativeControlDocs(vault);
  const pool = await dreamPool(vault);
  const ctx = await planContext(vault, pool, budgetsFor('deep'), rngFrom('negative-decoy-control'), { semantic: false });
  const { clusters } = planDeep(ctx, 0);
  for (const pair of [['javaLanguage', 'javaIsland'], ['pythonLanguage', 'pythonSnake'], ['riverBank', 'financeBank']]) {
    const ids = pair.map(key => docs[key]!.id);
    assert.ok(clusters.some(cluster => ids.every(id => cluster.ids.includes(id))), `planner must present the homonym pair to the model: ${pair.join('/')}`);
  }
});

test('Dream evaluator classifies an honest negative-control abstention separately from unsafe output', async () => {
  const base = { jobStatus: 'complete', providerCalls: 1, minimumProviderCalls: 1, expectedUsableCandidates: 0, usableCandidates: 0 };
  assert.equal(dreamNegativeControlOutcome({ ...base, unsupportedCandidates: 0 }), 'justified_abstention');
  assert.equal(dreamNegativeControlOutcome({ ...base, unsupportedCandidates: 2 }), 'rejected_unsupported_candidates');
  assert.equal(dreamNegativeControlOutcome({ ...base, usableCandidates: 1, unsupportedCandidates: 1 }), 'usable_candidate_leak');
  assert.equal(dreamNegativeControlOutcome({ ...base, jobStatus: 'retryable_failure', unsupportedCandidates: 0 }), 'incomplete');
  assert.equal(dreamNegativeControlOutcome({ ...base, providerCalls: 0, unsupportedCandidates: 0 }), 'incomplete');
  const input = JSON.parse(await fs.readFile(inputPath('dream/labeled-scenarios.json'), 'utf8')) as { scenarios: Array<{ id: string; expectedOutcome?: string }> };
  const scenario = input.scenarios.find(item => item.id === 'deep-cache-deploy');
  assert.equal(scenario?.expectedOutcome, 'abstention', 'the user goal is not evidence and neither source establishes a bridge between this incident and client invalidation');
  const valid = { expected: 'abstention' as const, jobStatus: 'complete', providerCalls: 1, candidateCount: 0, usableCandidateCount: 0, skippedReasons: ['lexical_decoy_suppressed'] };
  assert.equal(dreamScenarioOutcome(valid), 'justified_abstention');
  assert.equal(dreamScenarioOutcome({ ...valid, skippedReasons: ['model_abstained'] }), 'justified_abstention');
  assert.equal(dreamScenarioOutcome({ ...valid, candidateCount: 1 }), 'unexpected_candidate', 'a generated but rejected proposal does not become an abstention');
  assert.equal(dreamScenarioOutcome({ ...valid, jobStatus: 'dead_letter' }), 'incomplete');
  assert.equal(dreamScenarioOutcome({ ...valid, providerCalls: 0 }), 'incomplete');
  assert.equal(dreamScenarioOutcome({ ...valid, expected: 'candidate', skippedReasons: ['model_abstained'] }), 'candidate_missing');
});

test('deep Dream suppresses a fabricated bridge when cross-domain evidence shares only a homonym', async t => {
  const { root, vault } = await disposableVault(t, { prefix: 'engram-dream-lexical-only-' });
  const docs = await buildNegativeControlDocs(vault); const pair = [docs.javaLanguage!, docs.javaIsland!];
  for (const doc of await vault.listDocuments()) if (!pair.some(item => item.id === doc.id) && doc.kind !== 'user_insight') await vault.delete(doc.id, doc.revisionId);
  await configureDreamEvalVault(vault, root);
  const model = dreamer(); const engine = new IntelligenceEngine(vault, model);
  const [job] = await enqueueRun(engine, { mode: 'deep' });
  assert.equal(job?.status, 'complete', job?.error);
  assert.ok(model.calls.length > 0, 'the provider sees the negative control and must choose an abstention or a safe outcome');
  assert.doesNotMatch(model.calls[0]!.instruction, /ANGLE:/, 'a lexical decoy is not paired with an instruction that demands a mechanism or composition');
  assert.match(model.calls[0]!.instruction, /kind":"no_insight"/);
  assert.equal((await engine.proposals()).length, 0, 'an unsupported bridge cannot enter the review queue from a homonym-only pair');
  assert.ok((job?.trace as { skipped: Array<{ reason: string }> }).skipped.some(item => item.reason === 'lexical_decoy_suppressed'));
  recordCase({ suite: 'dream', name: 'lexical-only-bridge-suppressed', status: 'PASS', detail: { providerCalls: model.calls.length, proposals: 0 } });
});

test('a valid lexical-decoy abstention completes once without a discovery repair', async t => {
  const { root, vault } = await disposableVault(t, { prefix: 'engram-dream-valid-abstention-' });
  const docs = await buildNegativeControlDocs(vault); const pair = [docs.javaLanguage!, docs.javaIsland!];
  for (const doc of await vault.listDocuments()) if (!pair.some(item => item.id === doc.id) && doc.kind !== 'user_insight') await vault.delete(doc.id, doc.revisionId);
  await configureDreamEvalVault(vault, root);
  const calls: ModelRequest[] = [];
  const model: ModelProvider = { id: 'explicit-abstention', async generate(request) { calls.push(request); return { kind: 'no_insight', title: 'No supported connection', body: 'The supplied sources do not establish a relationship between the two meanings.', evidence: [] }; } };
  const engine = new IntelligenceEngine(vault, model); const [job] = await enqueueRun(engine, { mode: 'deep' });
  assert.equal(job?.status, 'complete', job?.error);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!.instruction, /ANGLE:/);
  assert.deepEqual((job?.trace as { skipped: Array<{ reason: string }> }).skipped.map(item => item.reason), ['model_abstained']);
  assert.equal((await engine.proposals()).length, 0);
});

test('Dream structural repair permits abstention, while repeated malformed output stays a generation failure', async t => {
  const { root, vault } = await disposableVault(t, { prefix: 'engram-dream-abstention-repair-' });
  const docs = await buildNegativeControlDocs(vault); const pair = [docs.pythonLanguage!, docs.pythonSnake!];
  for (const doc of await vault.listDocuments()) if (!pair.some(item => item.id === doc.id) && doc.kind !== 'user_insight') await vault.delete(doc.id, doc.revisionId);
  await configureDreamEvalVault(vault, root);
  const calls: ModelRequest[] = [];
  const model: ModelProvider = { id: 'repair-to-abstention', async generate(request) { calls.push(request); return calls.length === 1 ? { kind: 'discovery', title: '', body: 'invalid', evidence: [] } : { kind: 'no_insight', title: 'No supported connection', body: 'The sources share a name but establish no relationship.', evidence: [] }; } };
  const engine = new IntelligenceEngine(vault, model); const [job] = await enqueueRun(engine, { mode: 'deep' });
  assert.equal(job?.status, 'complete', job?.error);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.instruction, /valid no_insight abstention/);
  assert.doesNotMatch(calls[1]!.instruction, /Return a corrected discovery object/);
  assert.deepEqual((job?.trace as { skipped: Array<{ reason: string }> }).skipped.map(item => item.reason), ['model_abstained']);

  const { root: malformedRoot, vault: malformedVault } = await disposableVault(t, { prefix: 'engram-dream-malformed-not-abstention-' });
  const malformedDocs = await buildNegativeControlDocs(malformedVault); const malformedPair = [malformedDocs.javaLanguage!, malformedDocs.javaIsland!];
  for (const doc of await malformedVault.listDocuments()) if (!malformedPair.some(item => item.id === doc.id) && doc.kind !== 'user_insight') await malformedVault.delete(doc.id, doc.revisionId);
  await configureDreamEvalVault(malformedVault, malformedRoot);
  const malformedModel: ModelProvider = { id: 'still-malformed', async generate() { return {} as unknown as ModelProposal; } };
  const malformedEngine = new IntelligenceEngine(malformedVault, malformedModel); const [failed] = await enqueueRun(malformedEngine, { mode: 'deep' });
  assert.equal(failed?.status, 'dead_letter');
  assert.match(String(failed?.error), /no valid discovery or explicit abstention/);
});

test('honest no-mechanism notes outrank lexical-decoy bridges and are classified separately', () => {
  const a = { id: 'a', uri: 'mdb://wiki/a', revisionId: 'ra', kind: 'wiki_page', title: 'Java application runtime', body: 'Java is a programming language used to run enterprise applications on virtual machines.', tags: ['domain:programming'], metadata: {}, links: [], status: 'accepted', updatedAt: '', createdAt: '', scope: { type: 'global', area: 'wiki' } } as unknown as import('../../packages/core/types.js').Document;
  const b = { ...a, id: 'b', uri: 'mdb://wiki/b', revisionId: 'rb', title: 'Java island geography', body: 'Java is an island in Indonesia with volcanic mountains and densely populated cities.', tags: ['domain:geography'] };
  assert.equal(isLexicalOnlyCrossDomain([a, b]), true);
  const output: ModelProposal = { kind: 'discovery', title: 'Java name tension', body: 'Both sources use the name Java, but there is no evidence of a cross-domain connection.', evidence: [{ uri: a.uri, revisionId: a.revisionId, span: 'Java is a programming language' }, { uri: b.uri, revisionId: b.revisionId, span: 'Java is an island in Indonesia' }] };
  const safe = { mechanism: 'No cross-domain mechanism is established by the supplied evidence.', hops: ['Java application runtime -> shared name -> Java island geography'], speculation: ['No supported connection is established.'] };
  const invented = { ...safe, mechanism: 'The island volcanic activity could predict JVM crashes.', hops: ['Java island -> has volcanic activity -> potential JVM instability'], speculation: ['The volcano may model runtime crashes.'] };
  assert.equal(isHonestNoMechanismProposal(output, safe), true);
  assert.equal(isHonestNoMechanismProposal(output, invented), false);
  assert.equal(isHonestNoMechanismProposal({ ...output, body: `${output.body} This name connects the island to a runtime mechanism.` }, safe), false, 'a no-mechanism phrase cannot sanitize a simultaneous positive bridge claim');
  assert.equal(scoreCandidate(output, safe, [a, b]).score, 1);
  assert.equal(scoreCandidate(output, invented, [a, b]).score, 0, 'a fluent invented mechanism receives no sibling-selection credit over an honest no-mechanism outcome');
  const related = { ...b, title: 'Token bucket rate limits', body: 'Java services use a token bucket per client to enforce quotas and prevent abuse.', tags: ['domain:security', 'provides:quota'] };
  assert.equal(isLexicalOnlyCrossDomain([a, related]), false, 'explicit relation tags keep a supported cross-domain association eligible');
});

test('cross-domain decoy classification depends on source-level relation evidence, not overlap count', () => {
  const make = (id: string, title: string, body: string, domain: string, tags: string[] = []) => ({
    id, uri: `mdb://wiki/${id}`, revisionId: `rev-${id}`, kind: 'wiki_page', title, body,
    tags: [`domain:${domain}`, ...tags], metadata: {}, links: [], status: 'accepted', updatedAt: '', createdAt: '',
    scope: { type: 'global', area: 'wiki' },
  }) as unknown as import('../../packages/core/types.js').Document;
  for (let count = 1; count <= 4; count++) for (let i = 0; i < 5; i++) {
    const shared = ['orbit', 'signal', 'charge', 'current'].slice(0, count).join(' ');
    const a = make(`decoy-a-${count}-${i}`, `Field ${shared}`, `The ${shared} appears in a measurement report for this domain.`, `science-${count}-${i}`);
    const b = make(`decoy-b-${count}-${i}`, `Field ${shared}`, `The ${shared} appears in an unrelated ledger for this domain.`, `finance-${count}-${i}`);
    assert.equal(isLexicalOnlyCrossDomain([a, b]), true, `${count} shared surface words must not be treated as bridge evidence`);
  }
  const queue = make('queue-a', 'Queue processing', 'Queue processing controls batch admission and uses a fixed token window.', 'runtime', ['provides:quota']);
  const admission = make('queue-b', 'Admission control', 'Admission control is linked to queue processing and fair service.', 'scheduling');
  assert.equal(isLexicalOnlyCrossDomain([queue, admission]), false, 'one-word overlap with a source sentence stating a relation remains eligible');
  const tagged = make('quota-b', 'Quota service', 'A service enforces quotas per client.', 'security', ['consumes:quota']);
  assert.equal(isLexicalOnlyCrossDomain([queue, tagged]), false, 'explicit relation metadata remains eligible');
  recordCase({ suite: 'dream', name: 'source-relation-not-token-count-decoy-classifier', status: 'PASS', detail: { decoys: 20, positiveTextRelation: 1, positiveTagRelation: 1 } });
});

test('Dream evaluation enables the same explicit opt-in for scenario and negative-control vaults', async t => {
  const { root, vault } = await disposableVault(t, { prefix: 'engram-dream-eval-config-' });
  await configureDreamEvalVault(vault, root);
  const config = await vault.config();
  assert.equal(config.dream.enabled, true);
  assert.equal(config.dream.eventDriven, false);
  assert.deepEqual(config.dream.modes, ['micro', 'deep', 'strategic']);
  assert.equal(config.dream.maxProposalsPerRun, 2);
  assert.equal(config.model.critic, true);
});

test('Dream quality gate rejects a failing scenario even when mode means pass and requires three runs', () => {
  const common = { minimumRuns: 3, minimumScenarioQuality: 0.75, meanQualityPerModePass: true, minimumCitationIntegrity: 1, minimumEvidenceGrounding: 1, criticAdversarialRejectionRecall: 1, minimumCriticRejectionRecall: 0.8, criticSupportedAcceptanceRate: 1, minimumCriticSupportedAcceptanceRate: 0.8 };
  const good = { quality: 1, dimensions: { contradictionHandling: true, unattributedUniversalClaimAbsent: true } };
  assert.equal(dreamHeuristicQualityPass({ ...common, runs: 1, scenarios: [good, good, good] }), false, 'single-run scores cannot satisfy the quality gate');
  assert.equal(dreamHeuristicQualityPass({ ...common, runs: 3, scenarios: [good, good, { quality: 0.625, dimensions: { contradictionHandling: false, unattributedUniversalClaimAbsent: false } }] }), false, 'one contradiction/unattributed-universal failure cannot be hidden by the mode mean');
  assert.equal(dreamHeuristicQualityPass({ ...common, runs: 3, scenarios: [good, good, good] }), true);
  const missingGuard = { quality: 1, dimensions: { contradictionHandling: true } };
  assert.equal(dreamHeuristicQualityPass({ ...common, runs: 3, scenarios: [good, good, missingGuard] }), false, 'missing deterministic guard evidence is not equivalent to a pass');
  assert.equal(dreamHeuristicQualityPass({ ...common, runs: 3, scenarios: [{ ...good, quality: Number.NaN }, good, good] }), false, 'non-finite quality cannot pass');
  assert.equal(dreamMetadataClaimsTraceable({ facts: ['A supported fact expressed with different vocabulary'] }, ['The source describes an authorized mechanism using distinct terminology.']), false, 'lexical detector warns, but is not part of the semantic acceptance decision');
  assert.equal(dreamHeuristicQualityPass({ ...common, runs: 3, scenarios: [good, good, good] }), true);
});

test('Dream metadata lexical warning checks asserted facts but does not reject novel mechanisms', () => {
  const source = ['API requests can be rate limited per client using a token bucket.', 'A dashboard can display request counts and response latency.'];
  assert.equal(dreamMetadataClaimsTraceable({ facts: ['The shared cache bypasses authentication and exposes every client token.'] }, source), false);
  assert.equal(dreamMetadataClaimsTraceable({ mechanism: 'The shared cache might connect a quota experiment with per-client traffic.' }, source), true, 'inference vocabulary is not evidence that a cited hypothesis is false');
  assert.equal(dreamMetadataClaimsTraceable({ facts: ['API requests can be rate limited per client.'], hops: ['The dashboard displays request counts.'], mechanism: 'A token bucket rate limits API requests per client.' }, source), true);
});
test('Dream evaluator accepts inflected faithful contradiction wording and rejects resolved or one-sided claims', () => {
  const faithful = 'Source A says caching authenticated responses is unsafe and can leak data. Source B says caching all responses is safe. The conflict remains unresolved.';
  assert.equal(dreamTextMatchesTerms(faithful, ['cache', 'contradict']), true, 'cache/caching and conflict/contradiction are compared by normalized terms');
  assert.equal(dreamContradictionHandled(faithful), true, 'both opposed claims are represented and left unresolved');
  assert.equal(dreamContradictionHandled('Fact 1: Authenticated API responses must not be cached. Fact 2: Caching every API response is always safe. The conflict remains unresolved.'), true,
    'a source-labeled negative cache rule and positive safety claim form the labeled contradiction even without the word unsafe');

  const falseAcceptance = 'Both sources discuss caching. The conflict is resolved: caching is always safe, with no uncertainty.';
  assert.equal(dreamContradictionHandled(falseAcceptance), false, 'mentioning a conflict cannot pass when the candidate resolves it as a fact');
  assert.equal(dreamContradictionHandled('Caching all authenticated responses is safe.'), false, 'a one-sided assertion is not contradiction handling');

  const falseRejectionNovelSynthesis = { mechanism: 'A cross-domain bridge may connect client-side caching to a per-client quota experiment.' };
  assert.equal(dreamMetadataClaimsTraceable(falseRejectionNovelSynthesis, ['Client-side caches reduce repeated fetches.', 'A token bucket enforces request quotas per client.']), true, 'a supported novel synthesis is not rejected solely for vocabulary absent from source wording');
  recordCase({ suite: 'dream', name: 'dream-evaluator-contradiction-lexical-regression', status: 'PASS', detail: { falseRejections: 1, falseAcceptances: 2 } });
});

test('Dream contradiction rubric matches the complete independent 11-case probe inventory', () => {
  const cases: Array<[string, boolean, string]> = [
    ['faithful one', true, 'Fact 1: Caching all API responses is always safe and speeds everything up. Fact 2: Caching authenticated API responses is unsafe and leaks data between users. The conflict remains unresolved.'],
    ['faithful two', true, 'Source A says every cached API response is safe. Source B says cached authenticated responses are unsafe and leak data. These claims conflict and the matter is unresolved.'],
    ['faithful three', true, 'The two sources disagree: one says caching is safe, the other says caching authenticated responses is unsafe. It is uncertain which applies.'],
    ['risky synonym', false, 'One source claims caching every response is safe; the other warns caching authenticated responses is risky. The conflict is unresolved.'],
    ['dangerous without cache', false, 'One note says caching is safe for everything, another says it exposes private data. They contradict each other and remain unresolved.'],
    ['resolved invention', false, 'Caching is safe for public responses and unsafe for authenticated ones, so the conflict is resolved: cache only public responses.'],
    ['unsafe-only unilateral', false, 'Caching authenticated API responses is unsafe and leaks data between users, so it must not be cached.'],
    ['safe-only unilateral', false, 'Caching all API responses is always safe and speeds everything up, so cache everything.'],
    ['cannot but resolved', false, 'The sources conflict, but caching authenticated responses cannot be safe, so the unsafe claim is correct and the conflict is settled.'],
    ['no cache mention', false, 'One claim says it is safe and another says it is unsafe and they conflict, unresolved.'],
    ['negated unresolved', false, 'Caching is safe and unsafe; the conflict is not unresolved, it is resolved by headers.'],
  ];
  for (const [name, expected, text] of cases) assert.equal(dreamContradictionHandled(text), expected, name);
  recordCase({ suite: 'dream', name: 'contradiction-rubric-independent-11-case-probe', status: 'PASS', detail: { cases: cases.length, expectedTrue: cases.filter(row => row[1]).length, expectedFalse: cases.filter(row => !row[1]).length } });
});

test('Dream evaluator distinguishes a labeled source claim from an unsupported universal assertion', () => {
  assert.equal(dreamHasUnsupportedUniversalClaim('Fact 1: Caching authenticated responses is unsafe. Fact 2: Caching all API responses is always safe. The conflict remains unresolved.'), false,
    'explicitly labeled evidence is being reported, not adopted as the candidate conclusion');
  assert.equal(dreamHasUnsupportedUniversalClaim('Caching all API responses is always safe.'), true,
    'an unqualified universal assertion remains a failure');
  assert.equal(dreamHasUnsupportedUniversalClaim('The fact that caching all API responses is always safe is established.'), true,
    'incidental use of the word fact does not count as source attribution');
});
test('Dream negative-control gate requires every declared control in every run', () => {
  const ids = ['unrelated', 'single-source', 'same-domain'];
  const passing = [1, 2].flatMap(run => ids.map(id => ({ id, run, status: 'PASS', providerCalls: 2, usableCandidates: 0, unsupportedCandidates: 0 })));
  assert.equal(dreamNegativeControlsPass(passing, ids, 2), true);
  assert.equal(dreamNegativeControlsPass(passing.slice(0, 3), ids, 2), false, 'a missing run cannot satisfy inventory');
  assert.equal(dreamNegativeControlsPass([...passing.slice(0, 5), { ...passing[4]!, id: passing[3]!.id }], ids, 2), false, 'duplicate id/run pairs cannot inflate coverage');
  assert.equal(dreamNegativeControlsPass([...passing.slice(0, 5), { id: 'unexpected', run: 2, status: 'PASS' }], ids, 2), false, 'unknown controls cannot substitute for a required control');
  assert.equal(dreamNegativeControlsPass([...passing.slice(0, 5), { id: 'same-domain', run: 2, status: 'FAIL' }], ids, 2), false);
  assert.equal(dreamNegativeControlsPass(passing, [...ids, 'duplicate', 'duplicate'], 2), false, 'the declared inventory itself must be unique');
  assert.equal(dreamNegativeControlsPass(passing.map(row => ({ ...row, providerCalls: 0 })), ids, 2), false, 'a deterministic prefilter with no provider call does not test model behavior');
  assert.equal(dreamNegativeControlsPass(passing.map(row => ({ ...row, usableCandidates: 1 })), ids, 2), false, 'any usable candidate is a negative-control failure');
  assert.equal(dreamNegativeControlsPass(passing.map(row => ({ ...row, unsupportedCandidates: 1 })), ids, 2), false, 'a rejected generated bridge cannot disappear from the negative-control safety score');
});
test('deep candidate scoring rewards an observable falsification check', () => {
  const source = { id: 'source', uri: 'mdb://wiki/source', body: 'Python API uses a token bucket to enforce request quotas.' } as import('../../packages/core/types.js').Document;
  const proposal: ModelProposal = { kind: 'discovery', title: 'Quota experiment', body: 'Test token bucket quotas with request counts.', evidence: [{ uri: source.uri, revisionId: 'rev-1', span: 'token bucket to enforce request quotas' }] };
  const base = { facts: ['Python API uses a token bucket to enforce request quotas.'], speculation: ['A measured quota may help compare behavior.'], testPlan: ['Record request counts over time.', 'Compare quota behavior between two intervals.'] };
  const measured = scoreCandidate(proposal, { ...base, proposedValidation: 'Measure request counts over a fixed interval.' }, [source]).components.falsifiability;
  const vague = scoreCandidate(proposal, { ...base, proposedValidation: 'Define a validation plan for later.' }, [source]).components.falsifiability;
  assert.equal(measured, 1);
  assert.equal(vague, 0.5);
  const unsupportedBridge = scoreCandidate(proposal, { ...base, mechanism: 'A fluent but invented mechanism that ties unrelated source vocabulary into a confident causal system.' }, [source]);
  const neutral = scoreCandidate(proposal, { ...base, mechanism: 'No mechanism is established by the supplied evidence.' }, [source]);
  assert.equal(unsupportedBridge.score, neutral.score, 'mechanism wording and lexical overlap never add ranking credit; semantics remain unassessed');
  assert.equal('mechanism' in unsupportedBridge.components, false);
  recordCase({ suite: 'dream', name: 'deep-falsifiability-score-observable-check', status: 'PASS' });
});
test('Dream rejects a citation span that adds punctuation absent from its cited source', () => {
  const docs = [
    { id: 'a', uri: 'mdb://wiki/a', revisionId: 'rev-a', scope: { type: 'global' }, kind: 'wiki_page', title: 'API', body: 'FastAPI emits JSON', tags: ['domain:python-api'], metadata: {} },
    { id: 'b', uri: 'mdb://wiki/b', revisionId: 'rev-b', scope: { type: 'global' }, kind: 'wiki_page', title: 'UI', body: 'Browser UI reads JSON', tags: ['domain:js-ui'], metadata: {} },
  ] as unknown as import('../../packages/core/types.js').Document[];
  const output: ModelProposal = { kind: 'discovery', title: 'API and UI', body: 'A hypothesis to test.', evidence: [
    { uri: docs[0]!.uri, revisionId: docs[0]!.revisionId, span: 'FastAPI emits JSON.' },
    { uri: docs[1]!.uri, revisionId: docs[1]!.revisionId, span: 'Browser UI reads JSON' },
  ], metadata: { subtype: 'composition', novelty: 'new_to_user', reasoningSummary: 'Combine two JSON-connected components for a local experiment.', limitations: ['The integration is not established.'], testPlan: ['Fetch JSON and render a sample widget.'], counterarguments: ['The browser may not reach the API.'], proposedValidation: 'Run a local fetch test and inspect the rendered widget.' } };
  assert.throws(() => checkDiscovery('micro', output, docs, []), /span.*source|source.*span/i);
});
test('deep contradiction candidates cannot turn opposing claims into an invented conditional resolution', () => {
  const docs = [
    { id: 'cache-sec', uri: 'mdb://wiki/cache-sec', revisionId: 'rev-sec', scope: { type: 'global' }, kind: 'wiki_page', title: 'Authenticated caching', body: 'Caching authenticated API responses is unsafe and leaks data between users.', tags: ['domain:security'], metadata: {} },
    { id: 'cache-api', uri: 'mdb://wiki/cache-api', revisionId: 'rev-api', scope: { type: 'global' }, kind: 'wiki_page', title: 'API caching', body: 'Caching all API responses is always safe and speeds everything up.', tags: ['domain:python-api'], metadata: {} },
  ] as unknown as import('../../packages/core/types.js').Document[];
  const base: ModelProposal = {
    kind: 'discovery', title: 'Conflicting cache safety claims',
    body: 'Caching authenticated API responses is unsafe and leaks data between users. Caching all API responses is always safe and speeds everything up. Hypothesis: these source claims remain unresolved and supplied evidence does not establish which applies.',
    evidence: docs.map(d => ({ uri: d.uri, revisionId: d.revisionId, span: d.body })),
    metadata: { subtype: 'contradiction', novelty: 'unclear', reasoningSummary: 'The supplied sources state opposing cache safety claims and provide no resolution.', facts: docs.map(d => d.body), speculation: ['No conclusion about which claim is correct is supported.'], missingEvidence: ['A controlled test or authoritative specification resolving cache behavior.'], hops: ['The security source conflicts with the API source on cache safety.', 'The API source conflicts with the security source on cache safety.'], mechanism: 'No mechanism is established by the supplied conflicting claims.', distance: 'distant', limitations: ['The supplied evidence does not establish whether either claim is accurate.'], testPlan: ['Compare the stated claims against a controlled cache isolation test.'], counterarguments: ['The supplied evidence may omit details needed to resolve the conflict.'], proposedValidation: 'Run a controlled test of authenticated cache behavior and record cross-user exposure.' },
  };
  assert.throws(() => checkDiscovery('deep', { ...base, metadata: { ...base.metadata, subtype: 'composition', reasoningSummary: 'A conditional composition reconciles both cache safety claims.' , mechanism: 'Caching is safe only if authenticated responses are excluded.' }, body: 'Caching is safe only if authenticated responses are excluded.' }, docs, [], ['contradiction']), /planner contradiction/i, 'the original subtype laundering is rejected before proposal persistence');
  assert.throws(() => checkDiscovery('deep', { ...base, body: 'Hypothesis: the claims can be reconciled only if authenticated responses are excluded, which makes all-response caching safe.', metadata: { ...base.metadata, reasoningSummary: 'A conditional explanation resolves both otherwise conflicting claims.', mechanism: 'Caching is safe only if authenticated responses are excluded.' } }, docs, [], ['contradiction']), /unresolved|condition|reconciliation|mechanism/i, 'a contradiction subtype cannot smuggle a resolution through body or mechanism');
  assert.throws(() => checkDiscovery('deep', { ...base, metadata: { ...base.metadata, counterarguments: ['Contextual differences could explain why the sources disagree.'] } }, docs, [], ['contradiction']), /unresolved|condition|reconciliation|mechanism/i, 'a contradiction cannot smuggle an explanation through counterarguments');
  assert.throws(() => checkDiscovery('deep', { ...base, metadata: { ...base.metadata, speculation: ['One source may refer to public endpoints while the other refers to authenticated endpoint types.'] } }, docs, [], ['contradiction']), /unresolved|condition|reconciliation|mechanism/i, 'speculative endpoint distinctions cannot reconcile opposing evidence');
  assert.throws(() => checkDiscovery('deep', { ...base, metadata: { ...base.metadata, speculation: ['It is possible that one source refers to a specific type of caching mechanism.'] } }, docs, [], ['contradiction']), /unresolved|condition|reconciliation|mechanism/i, 'a labeled speculation cannot invent an unsupported source-specific mechanism to reconcile a contradiction');
  assert.throws(() => checkDiscovery('deep', { ...base, metadata: { ...base.metadata, speculation: ['It is uncertain whether the first claim is limited to authenticated responses.'] } }, docs, [], ['contradiction']), /unresolved|condition|reconciliation|mechanism/i, 'a labeled speculation cannot invent a scope restriction absent from either source');
  assert.equal(checkDiscovery('deep', base, docs, [], ['contradiction']).subtype, 'contradiction', 'a source-faithful unresolved contradiction remains eligible for review');
  assert.equal(checkDiscovery('deep', base, docs, [], ['composition']).subtype, 'contradiction', 'ordinary deep candidates keep their existing validation path');
  recordCase({ suite: 'dream', name: 'contradiction-hint-forbids-invented-resolution', status: 'PASS' });
});
test('Dream critic accepts only explicitly uncertain, source-grounded discovery hypotheses for review', () => {
  const discovery = critiqueMessages({ instruction: 'review', proposal: { kind: 'discovery', title: 'A testable link', body: 'Hypothesis: the systems might combine.', evidence: [], metadata: { limitations: ['Compatibility is unverified.'], missingEvidence: ['A compatibility test result.'], testPlan: ['Run a representative integration test.'], proposedValidation: 'Compare the integrated output with the expected result.', internalMarker: 'must-not-enter-critic' } }, evidence: [] }).map(message => message.content).join('\n');
  assert.match(discovery, /body explicitly prefixed with “Hypothesis:” labels the proposed relationship as uncertain/i);
  assert.match(discovery, /limitations and missingEvidence as its stated evidence gaps, and testPlan\/proposedValidation as its proposed test/i);
  assert.match(discovery, /Proposal validation metadata.*limitations.*Compatibility is unverified.*missingEvidence.*A compatibility test result.*testPlan.*Run a representative integration test.*proposedValidation/s);
  assert.doesNotMatch(discovery, /internalMarker|must-not-enter-critic/);
  assert.match(discovery, /Do not reject a discovery merely because its clearly labeled hypothesis is novel/i);
  const ordinary = critiqueMessages({ instruction: 'review', proposal: { kind: 'wiki_page', title: 'A fact', body: 'A claim.', evidence: [], metadata: { limitations: ['private metadata should not be passed'] } }, evidence: [] }).map(message => message.content).join('\n');
  assert.doesNotMatch(ordinary, /Discovery policy:/);
});
test('Dream passes bounded validation metadata to the model critic', async t => {
  const w = await world(t); const model = dreamer(); let captured: Parameters<NonNullable<typeof model.critique>>[0] | undefined;
  model.critique = async input => { captured = input; return { verdict: 'accept', rationale: 'The proposal is a reviewable, testable hypothesis.' }; };
  await enqueueRun(new IntelligenceEngine(w.vault, model), { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') });
  assert.ok(captured);
  assert.ok(Array.isArray(captured.proposal.metadata?.testPlan), 'critic can evaluate the test plan already stored on the proposal');
  assert.equal(typeof captured.proposal.metadata?.proposedValidation, 'string');
  recordCase({ suite: 'dream', name: 'critic-receives-proposal-validation-metadata', status: 'PASS' });
});
test('Dream keeps a distinct candidate over the same evidence after another candidate is rejected', () => {
  const docs = [
    { id: 'a', uri: 'mdb://wiki/a', revisionId: 'rev-a', scope: { type: 'global' }, kind: 'wiki_page', title: 'API quotas', body: 'Python API uses a token bucket to enforce request quotas.', tags: ['domain:python-api'], metadata: {} },
    { id: 'b', uri: 'mdb://wiki/b', revisionId: 'rev-b', scope: { type: 'global' }, kind: 'wiki_page', title: 'Credential abuse', body: 'Rate limits stop credential stuffing against public endpoints.', tags: ['domain:security'], metadata: {} },
  ] as unknown as import('../../packages/core/types.js').Document[];
  const previous = { ...docs[0]!, status: 'rejected', metadata: { subtype: 'contradiction', sourceRefs: docs.map(d => ({ uri: d.uri, revisionId: d.revisionId })) } } as unknown as import('../../packages/core/types.js').Document;
  const verdict = judgeDiscovery({ title: 'Measure abuse signals', body: 'Compare request quotas with failed sign-in counts during a controlled test, then record whether the rates change together.', summary: 'A new measurable relationship between service quotas and security signals.', mode: 'deep', subtype: 'composition', evidence: docs, existing: [previous], nearby: [], goalRefs: [], sourceKeys: docs.map(d => `${d.uri.split('/').at(-1)}@${d.revisionId}`), metadata: { subtype: 'composition' } });
  assert.notEqual(verdict.outcome, 'reject', `a different claim over the same evidence should survive: ${verdict.reasons.join('; ')}`);
});
test('Dream suppresses reworded rejected ideas over unchanged revisions but allows new angles and evidence growth', () => {
  const docs = [
    { id: 'a', uri: 'mdb://wiki/a', revisionId: 'rev-a', scope: { type: 'global' }, kind: 'wiki_page', title: 'API quotas', body: 'Python API uses a token bucket to enforce request quotas.', tags: ['domain:python-api'], metadata: {} },
    { id: 'b', uri: 'mdb://wiki/b', revisionId: 'rev-b', scope: { type: 'global' }, kind: 'wiki_page', title: 'Credential abuse', body: 'Rate limits stop credential stuffing against public endpoints.', tags: ['domain:security'], metadata: {} },
  ] as unknown as import('../../packages/core/types.js').Document[];
  const keys = docs.map(d => `${d.uri.split('/').at(-1)}@${d.revisionId}`);
  const rejected = { ...docs[0]!, uri: 'mdb://discoveries/rejected', status: 'rejected', title: 'Different wording', body: 'A completely different sentence about unrelated vocabulary and a possible connection.', metadata: { subtype: 'composition', jobId: 'new-job', candidateAngle: 'composition:complementary:0', sourceRefs: docs.map(d => ({ uri: d.uri, revisionId: d.revisionId })) } } as unknown as import('../../packages/core/types.js').Document;
  const make = (sourceKeys: string[], candidateAngle = 'composition:complementary:0') => judgeDiscovery({ title: 'Yet another wording', body: 'Another unrelated wording proposing a connection that needs a small experiment to check.', summary: 'A testable relation.', mode: 'deep', subtype: 'composition', evidence: docs, existing: [rejected], nearby: [], goalRefs: [], sourceKeys, metadata: { subtype: 'composition', jobId: 'new-job', candidateAngle } });
  const repeat = make(keys);
  assert.equal(repeat.outcome, 'reject'); assert.ok(repeat.flags.includes('repeat_of_rejected'));
  const distinct = make(keys, 'composition:contradiction:0');
  assert.notEqual(distinct.flags.includes('repeat_of_rejected'), true, 'a distinct planner angle in the same run remains eligible as a sibling');
  const laterRunDistinctAngle = judgeDiscovery({ title: 'Another wording', body: 'A different claim form that still must wait for new source evidence before retrying.', summary: 'Reworded future-run claim.', mode: 'deep', subtype: 'composition', evidence: docs, existing: [{ ...rejected, metadata: { ...rejected.metadata, jobId: 'prior-job' } }], nearby: [], goalRefs: [], sourceKeys: keys, metadata: { subtype: 'composition', jobId: 'new-job', candidateAngle: 'composition:contradiction:0' } });
  assert.ok(laterRunDistinctAngle.flags.includes('repeat_of_rejected'), 'a later job cannot evade rejection by choosing a different angle');
  const grown = make([...keys.slice(0, 1), 'c@rev-c']);
  assert.notEqual(grown.flags.includes('repeat_of_rejected'), true, 'a new source revision or object allows reconsideration');
});
test('micro Dream retries a failed cluster after restart instead of advancing past it', async t => {
  const w = await world(t); let calls = 0;
  const firstProvider = dreamer({ override: (output) => {
    calls++;
    return calls === 1 ? { ...output, evidence: [{ uri: 'mdb://wiki/objects/not-supplied', revisionId: 'missing', span: 'absent' }] } : output;
  } });
  const firstEngine = new IntelligenceEngine(w.vault, firstProvider);
  const first = await enqueueRun(firstEngine, { mode: 'micro' });
  const firstTrace = first[0]!.trace as import('../../packages/intelligence/dream/types.js').Trace;
  assert.ok(firstTrace.retryableSeeds?.length, JSON.stringify(firstTrace));
  const persisted = await firstEngine['state']();
  const failedSeed = firstTrace.retryableSeeds![0]!;
  assert.ok(Object.entries(persisted.dreamProgress ?? {}).some(([key, value]) => key.includes(`|${failedSeed}@`) && value.status === 'retryable'), 'retry status is checkpointed in intelligence state');

  const secondProvider = dreamer(); const restartedEngine = new IntelligenceEngine(w.vault, secondProvider);
  const second = await enqueueRun(restartedEngine, { mode: 'micro' });
  assert.ok(secondProvider.calls.length > 0, 'a fresh engine calls the model for retryable work');
  const after = await restartedEngine['state']();
  assert.ok(Object.entries(after.dreamProgress ?? {}).some(([key, value]) => key.includes(`|${failedSeed}@`) && value.status === 'completed'), 'successful retry is persisted as terminally processed');
});
test('micro Dream immediately reclaims a seed after its owning process is killed', async t => {
  const w = await world(t);
  const child = spawn(process.execPath, [path.resolve('dist/tests/helpers/dream-crash-worker.js'), w.root], { stdio: 'ignore' });
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  assert.equal(code, null); assert.equal(signal, 'SIGKILL', 'only the disposable test child is terminated');
  const firstState = await new IntelligenceEngine(w.vault)['state']();
  const interrupted = Object.entries(firstState.dreamProgress ?? {}).filter(([, value]) => value.status === 'running');
  assert.ok(interrupted.length > 0, 'the crash occurred after a durable running claim was written');
  assert.ok(interrupted.every(([, value]) => value.ownerPid === child.pid), JSON.stringify(interrupted));
  const provider = dreamer(); const recovered = new IntelligenceEngine(w.vault, provider);
  const jobs = await enqueueRun(recovered, { mode: 'micro' });
  assert.equal(jobs[0]?.status, 'complete', jobs[0]?.error); assert.ok(provider.calls.length > 0, 'the dead owner lease is reclaimed without waiting for expiry');
  const after = await recovered['state']();
  assert.ok(interrupted.every(([key]) => after.dreamProgress?.[key]?.status === 'completed'), 'interrupted seeds reach a durable terminal state');
  for (let resume = 0; resume < 4; resume++) await enqueueRun(recovered, { mode: 'micro' });
  const allProposals = await recovered.proposals();
  const signatures = allProposals.map(proposal => JSON.stringify({ subtype: proposal.input.metadata?.subtype, refs: (proposal.input.metadata?.sourceRefs as Array<{ uri: string; revisionId: string }> ?? []).map(ref => `${ref.uri}@${ref.revisionId}`).sort() }));
  assert.equal(new Set(signatures).size, signatures.length, 'resumes do not persist duplicate proposals for the same source revisions and idea subtype');
  const selected = allProposals.find(proposal => proposal.status === 'pending'); assert.ok(selected, 'the retry produced a reviewable proposal');
  await recovered.review(selected.id, true, 'process-crash recovery test');
  const acceptedBefore = (await recovered.proposals()).find(proposal => proposal.id === selected.id)?.objectId;
  await enqueueRun(recovered, { mode: 'micro' });
  assert.equal((await recovered.proposals()).find(proposal => proposal.id === selected.id)?.objectId, acceptedBefore, 'replay does not replace or duplicate the accepted write');
  recordCase({ suite: 'dream', name: 'micro-dead-owner-lease-recovery', status: 'PASS', detail: { interruptedSeeds: interrupted.length, recoveryCalls: provider.calls.length, proposals: allProposals.length } });
});
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

test('Dream provider run writes checkpoints and owned scratch beneath explicit ENGRAM_DATA_DIR', async t => {
  const w = await world(t); const names = ['ENGRAM_DATA_DIR', 'ENGRAM_USER_CONFIG', 'ENGRAM_STATE_DIR', 'ENGRAM_CACHE_DIR', 'ENGRAM_OUTBOX', 'ENGRAM_REMOTE_SPOOL', 'ENGRAM_TEMP_DIR', 'ENGRAM_LOG_DIR', 'ENGRAM_INDEX_SCRATCH_DIR'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]])); process.env.ENGRAM_DATA_DIR = w.root;
  for (const name of names.slice(1)) delete process.env[name];
  t.after(() => { for (const name of names) { const value = saved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const model = dreamer(), engine = new IntelligenceEngine(w.vault, model);
  const jobs = await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') });
  assert.equal(jobs[0]?.status, 'complete', jobs[0]?.error); assert.ok(model.calls.length > 0, 'the deterministic provider was invoked');
  const stateDir = path.join(w.root, '.mdb/intelligence'); const stateFiles = await fs.readdir(stateDir);
  assert.ok(stateFiles.some(name => name.endsWith('.json')), 'the actual Dream job checkpoint is persisted under the configured root');
  const operations = path.join(w.root, '.engram-runtime/tmp/operations');
  assert.deepEqual(await fs.readdir(operations), [], 'normal model/Dream completion removes only its owned scratch directory');
  assert.ok((await engine.proposals()).length > 0, 'the generated, review-gated proposal remains durable');
  recordCase({ suite: 'dream', name: 'dream-data-root-provider-artifacts', status: 'PASS', detail: { stateDir, operations } });
});

test('explicit Dream abstention completes Micro, Deep and Strategic without repair, dead-lettering or proposal writes', async t => {
  const noInsight = { kind: 'no_insight', title: 'No supported connection', body: 'The supplied sources do not establish a defensible connection.', evidence: [] } as ModelProposal;
  const runMode = async (vault: Vault, model: ReturnType<typeof dreamer>, input: NonNullable<Parameters<IntelligenceEngine['enqueue']>[1]>) => {
    const engine = new IntelligenceEngine(vault, model); const [job] = await enqueueRun(engine, input);
    assert.equal(job?.status, 'complete', job?.error);
    assert.ok(model.calls.length > 0);
    assert.ok(model.calls.every(call => !/previous answer was rejected|mechanical check/i.test(call.instruction)), 'valid abstention never triggers forced-discovery repair');
    assert.equal((await engine.proposals()).length, 0);
    const trace = job?.trace as { skipped: Array<{ reason: string }>; retryableSeeds?: string[]; exhaustedSeeds?: string[] };
    assert.ok(trace.skipped.some(item => item.reason === 'model_abstained'));
    assert.deepEqual(trace.retryableSeeds ?? [], []); assert.deepEqual(trace.exhaustedSeeds ?? [], []);
    return trace;
  };
  const microWorld = await world(t); const microModel = dreamer({ override: () => noInsight });
  await runMode(microWorld.vault, microModel, { mode: 'micro', objectIds: ids(microWorld.pack, 'pyApi', 'jsDash') });
  const progress = (await new IntelligenceEngine(microWorld.vault).jobs()).filter(job => job.kind === 'dream');
  assert.equal(progress[0]?.status, 'complete');
  const deepModel = dreamer({ override: () => noInsight });
  const deepWorld = await isolatedDeep(t, ['pyRate', 'secRate'], deepModel);
  await runMode(deepWorld.vault, deepModel, { mode: 'deep' });
  const strategicWorld = await world(t); const strategicModel = dreamer({ override: () => noInsight });
  await runMode(strategicWorld.vault, strategicModel, { mode: 'strategic' });
  recordCase({ suite: 'dream', name: 'explicit-abstention-all-modes', status: 'PASS', detail: { modes: ['micro', 'deep', 'strategic'], noProposalWrites: true } });
});

test('default discovery search hides rejected history; explicit inspection needs both ACL and history permission', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.put({ scope: { type: 'global', area: 'discoveries' }, kind: 'discovery', title: 'Rejected', body: 'private rejected needle', status: 'rejected', metadata: { testPlan: ['review only'], counterarguments: ['not trusted'] } });
  const scopedOnly = new Vault(root, { actorId: 'reviewer', permissions: ['global:discoveries:read'] });
  const ordinary = await new SearchEngine(scopedOnly).query({ query: 'rejected needle', mode: 'keyword', kinds: ['discovery'] });
  assert.equal(ordinary.hits.length, 0);
  await assert.rejects(new SearchEngine(scopedOnly).query({ query: 'rejected needle', mode: 'keyword', kinds: ['discovery'], includeRejected: true }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  const historian = new Vault(root, { actorId: 'historian', permissions: ['global:discoveries:read', 'history:read'] });
  const explicit = await new SearchEngine(historian).query({ query: 'rejected needle', mode: 'keyword', kinds: ['discovery'], includeRejected: true });
  assert.equal(explicit.hits.length, 1);
  recordCase({ suite: 'dream', name: 'rejected-discovery-search-opt-in', status: 'PASS' });
});

test('legacy Dream autoAccept cannot promote a discovery without explicit review', async t => {
  const w = await world(t, { autoAccept: true }); const model = dreamer(); const engine = new IntelligenceEngine(w.vault, model);
  const jobs = await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') });
  assert.equal(jobs[0]?.status, 'complete', jobs[0]?.error);
  const proposal = (await engine.proposals()).at(-1)!;
  assert.equal(proposal.status, 'pending', 'legacy autoAccept is ignored for hypotheses');
  assert.equal((await w.vault.listDocuments()).some(doc => doc.kind === 'discovery' && doc.status === 'accepted'), false);
  recordCase({ suite: 'dream', name: 'dream-autoaccept-review-gate', status: 'PASS' });
});

test('a Python API + JavaScript UI pair yields a candidate composition hypothesis, never a fact or a claim about the user', async t => {
  const w = await world(t); const model = dreamer(); const engine = new IntelligenceEngine(w.vault, model);
  const jobs = await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'pyApi', 'jsDash') }); assert.equal(jobs[0]!.status, 'complete', jobs[0]!.error);
  const proposal = (await engine.proposals()).at(-1)!; assert.equal(proposal.status, 'pending'); assert.equal(proposal.input.status, 'hypothesis');
  const m = proposal.input.metadata!; assert.equal(m.subtype, 'composition'); assert.equal(m.mode, 'micro'); assert.equal(m.novelty, 'new_to_user'); assert.equal(m.promptVersion, 'dream-prompts-5'); assert.deepEqual((m.domains as string[]).sort(), ['js-frontend', 'python-api']);
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
  assert.ok([...calls('micro'), ...calls('deep')].every(c => c.goals === ''), 'micro and deep prompts never receive unrelated profile goals');
  assert.ok(calls('deep').every(c => /Hypothesis:/.test(c.instruction) && /Never state that mechanisms are shared, transferred, compatible, implemented, causal, or effective/.test(c.instruction)), 'deep generation must separate sourced facts from uncertain cross-domain mechanisms');
  assert.ok(calls('deep').every(c => c.documents.length <= 4), 'deep clusters are small and distant, not a dump'); assert.ok(calls('strategic').every(c => c.documents.some(d => d.kind === 'user_insight')), 'strategic always includes the goal');
  const system = (mode: string) => generationMessages({ job: 'dream', documents: [], goals: '', instruction: `MODE:${mode}` })[0]!.content;
  assert.match(system('deep'), /mechanism/); assert.match(system('deep'), /conditional hypothesis/i); assert.match(system('deep'), /not reported as an established mechanism/i); assert.match(system('deep'), /"facts"/); assert.match(system('deep'), /"missingEvidence"/); assert.match(system('strategic'), /goalRefs/); assert.match(system('strategic'), /evidence array MUST include the supplied goal object/i); assert.doesNotMatch(system('micro'), /goalRefs|mechanism \(/); assert.equal(new Set(['micro', 'deep', 'strategic'].map(system)).size, 3);
  assert.ok(calls('strategic').every(c => /A goal is evidence of a stated objective, not of the user’s skills/i.test(c.instruction)));
  assert.ok(calls('strategic').every(c => /at least two distinct non-goal knowledge objects/i.test(c.instruction)), 'the prompt states the same two-evidence-object rule enforced by the validator');
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
  await enqueueRun(engine, { mode: 'micro', objectIds: ids(w.pack, 'opsDeploy', 'vizDash') }); assert.equal((await engine.proposals()).length, before, 'micro discoveries do not change when an unrelated profile goal changes');
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

const deepKeys = ['claimAll', 'claimNone'];
async function isolatedDeep(t: T, keep: string[], model: ReturnType<typeof dreamer>) {
  const w = await world(t); const kept = new Set(keep.map(k => w.pack.ids[k]!));
  for (const doc of await w.vault.listDocuments()) if (doc.kind !== 'user_insight' && !kept.has(doc.id)) await w.vault.delete(doc.id, doc.revisionId);
  return { ...w, engine: new IntelligenceEngine(w.vault, model) };
}
async function addExplicitDeepRelation(w: Awaited<ReturnType<typeof isolatedDeep>>) {
  const source = await w.vault.get(w.pack.ids.pyRate!);
  await w.vault.patch({ objectId: source.id, expectedRevisionId: source.revisionId, body: `${source.body}\nThis Python rate limiting supports abuse prevention on public endpoints.` });
}
test('deep mode generates sibling candidates from different angles, keeps the best, and records the others as rejected, never as knowledge', async t => {
  const words: Record<string, string> = { mechanism: 'throttling quotas bucket refill burst', composition: 'gateway pipeline stitched middleware layering', tension: 'latency fairness starvation tradeoff queueing' };
  const model = dreamer({ override: (out, req) => { const angle = /ANGLE:(\w+)/.exec(req.instruction)![1]!; return { ...out, title: `${out.title} via ${angle}`, body: `${words[angle]} ${words[angle]!.split(' ').reverse().join(' ')} wholly distinct ${angle} reading of the pair, a hypothesis to test by measuring behaviour.`, metadata: { ...out.metadata, ...(angle === 'mechanism' ? {} : { testPlan: ['Write one short example for the first idea'] }) } }; } }); const w = await isolatedDeep(t, ['pyRate', 'secRate'], model); await addExplicitDeepRelation(w);
  const [job] = await enqueueRun(w.engine, { mode: 'deep' }); assert.equal(job!.status, 'complete', job!.error);
  const angles = model.calls.filter(c => modeOf(c) === 'deep').map(c => /ANGLE:(\w+)/.exec(c.instruction)?.[1]); assert.deepEqual(angles, ['mechanism', 'composition', 'tension']);
  assert.match(model.calls[0]!.instruction, /start the proposed connection with the exact label "Hypothesis:".*name the missing evidence/i);
  assert.match(model.calls[0]!.instruction, /Never state that mechanisms are shared, transferred, compatible, implemented, causal, or effective unless the sources directly establish that relationship/i);
  const proposals = (await w.engine.proposals()).filter(p => p.input.kind === 'discovery');
  assert.equal(proposals.length, 3); const rejected = proposals.filter(p => p.flags?.includes('not_selected')); assert.equal(rejected.length, 2);
  assert.ok(rejected.every(p => p.status === 'rejected' && /Not selected/.test(p.reason!)));
  const winner = proposals.find(p => p.status === 'pending')!; const selection = winner.input.metadata!.selection as { candidates: unknown[]; chosenAngle: string };
  assert.equal(selection.candidates.length, 3); assert.ok(typeof winner.input.metadata!.candidateScore === 'number');
  assert.deepEqual((await discoveries(w.vault)), [], 'nothing is in the vault before review');
  recordCase({ suite: 'dream', name: 'deep-sibling-candidates-selection', status: 'PASS' });
});
test('deep discoveries must separate facts from speculation, name missing evidence, and cannot present conjecture as a sourced fact', async t => {
  const bad = dreamer({ override: out => ({ ...out, metadata: { ...out.metadata, facts: ['Quantum teleportation delivers JSON instantly across continents.'] } }) });
  const w = await isolatedDeep(t, ['pyRate', 'secRate'], bad); await addExplicitDeepRelation(w);
  const [job] = await enqueueRun(w.engine, { mode: 'deep' }); assert.notEqual(job!.status, 'complete');
  assert.ok(bad.calls.length >= 4, 'each angle gets one bounded repair'); assert.match(bad.calls[1]!.instruction, /facts must restate a cited source/i);
  assert.equal((await w.engine.proposals()).length, 0);
  const missing = dreamer({ override: out => { const { speculation: _s, ...rest } = out.metadata as Record<string, unknown>; return { ...out, metadata: rest }; } });
  const w2 = await isolatedDeep(t, ['pyRate', 'secRate'], missing); const [job2] = await enqueueRun(w2.engine, { mode: 'deep' }); assert.notEqual(job2!.status, 'complete');
  recordCase({ suite: 'dream', name: 'deep-facts-vs-speculation-enforced', status: 'PASS' });
});
test('a deep candidate that is repaired once is accepted only if the repaired answer passes the same checks', async t => {
  let first = true; const model = dreamer({ override: (out, req) => { if (/ANGLE:mechanism/.test(req.instruction) && first) { first = false; const { hops: _h, ...rest } = out.metadata as Record<string, unknown>; return { ...out, metadata: rest }; } return out; } });
  const w = await isolatedDeep(t, ['pyRate', 'secRate'], model); await addExplicitDeepRelation(w); const [job] = await enqueueRun(w.engine, { mode: 'deep' }); assert.equal(job!.status, 'complete', job!.error);
  assert.equal(model.calls.filter(c => /ANGLE:mechanism/.test(c.instruction)).length, 2); assert.match(model.calls.find(c => /mechanical check/.test(c.instruction))!.instruction, /hops/);
  recordCase({ suite: 'dream', name: 'deep-bounded-repair', status: 'PASS' });
});
test('strategic discoveries get one bounded repair when required goal metadata is missing', async t => {
  let first = true;
  const model = dreamer({ override: out => {
    if (!first) return out;
    first = false;
    const { goalRefs: _goalRefs, prerequisites: _prerequisites, ...metadata } = out.metadata as Record<string, unknown>;
    return { ...out, metadata };
  } });
  const w = await world(t); const engine = new IntelligenceEngine(w.vault, model);
  const [job] = await enqueueRun(engine, { mode: 'strategic' });
  assert.equal(job!.status, 'complete', job!.error);
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1]!.instruction, /goalRefs must be 1\+ concrete strings/i);
  assert.ok((await engine.proposals()).some(p => Array.isArray(p.input.metadata?.goalRefs) && Array.isArray(p.input.metadata?.prerequisites)));
  recordCase({ suite: 'dream', name: 'strategic-bounded-repair', status: 'PASS' });
});
test('strategic repair restores the goal object to evidence when a model omits it', async t => {
  let first = true;
  const model = dreamer({ override: out => {
    if (!first) return out;
    first = false;
    return { ...out, evidence: out.evidence.filter(ref => !ref.uri.startsWith('mdb://profile/')) };
  } });
  const w = await world(t); const engine = new IntelligenceEngine(w.vault, model);
  const [job] = await enqueueRun(engine, { mode: 'strategic' });
  assert.equal(job!.status, 'complete', job!.error);
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1]!.instruction, /strategic discovery must cite the goal it serves/i);
  const proposal = (await engine.proposals()).at(-1)!;
  assert.ok(proposal.input.evidence!.some(ref => ref.uri.startsWith('mdb://profile/')));
  recordCase({ suite: 'dream', name: 'strategic-goal-evidence-repair', status: 'PASS' });
});
test('a contradiction between existing claims is kept as an unresolved deep discovery with one hop and no invented resolution', async t => {
  const model = dreamer({ override: out => ({ ...out, title: 'Unresolved cache safety contradiction', body: 'Caching authenticated API responses is unsafe and leaks data between users. Caching all API responses is always safe and speeds everything up. Hypothesis: these source claims remain unresolved and the supplied evidence does not establish which applies.', metadata: { ...out.metadata, subtype: 'contradiction', mechanism: 'No mechanism is established by the supplied conflicting claims.', facts: ['Caching authenticated API responses is unsafe and leaks data between users.', 'Caching all API responses is always safe and speeds everything up.'], speculation: ['No conclusion about which claim applies is supported.'], missingEvidence: ['A controlled test or authoritative specification resolving cache behavior.'], hops: ['The security source conflicts with the API source on cache safety.'], proposedValidation: 'Run a controlled test of authenticated cache behavior and record whether the claims can be resolved.' } }) });
  let modelCriticCalls = 0;
  model.critique = async () => { modelCriticCalls++; return { verdict: 'reject', rationale: 'The conflict is not a distinct hypothesis.' }; };
  const w = await isolatedDeep(t, deepKeys, model); const [job] = await enqueueRun(w.engine, { mode: 'deep' }); assert.equal(job!.status, 'complete', job!.error);
  assert.match(model.calls[0]!.instruction, /Do not propose a reconciliation, exception, cause, or remedy/i);
  assert.match(model.calls[0]!.instruction, /Do not use conditional explanations .* in any field/i,
    'the prompt prevents the speculative conditional that caused the observed critic rejection');
  const proposal = (await w.engine.proposals()).find(p => p.status === 'pending' && p.input.metadata!.subtype === 'contradiction');
  assert.ok(proposal, 'deterministic source-by-source contradiction checks preserve the faithful review proposal');
  assert.equal(modelCriticCalls, 0, 'a generic critic cannot reject a faithful unresolved contradiction under a conflicting rubric');
  assert.ok(proposal.flags?.includes('model_critic_skipped_contradiction_checklist'));
  recordCase({ suite: 'dream', name: 'deep-contradiction-single-hop', status: 'PASS' });
});

test('fact containment accepts faithful paraphrases of a cited revision and rejects conjecture', async () => {
  const { factContainment } = await import('../../packages/intelligence/dream/critic.js');
  const python = { title: 'Python rate limiting', body: 'Use a token bucket per client to enforce request quotas in a Python API.' };
  const cache = { title: 'Frontend caching', body: 'Client side caches reduce repeated fetches but need ratelimit friendly invalidation.' };
  assert.ok(factContainment('Python rate limiting uses a token bucket per client', python) >= 0.6);
  assert.ok(factContainment('Frontend caching needs rate limit friendly invalidation', cache) >= 0.6);
  assert.ok(factContainment('Token buckets could schedule cache invalidation and mitigate abuse', python) < 0.6);
  assert.ok(factContainment('The database replicates across three regions nightly', cache) < 0.3);
});

test('evaluator quality: a scenario without a candidate scores zero even when a dimension is vacuously true', async () => {
  const { dreamDimensionQuality } = await import('../../scripts/lib/dream-metrics.js');
  const dims = { novelty: false, relevance: false, contradictionHandling: true, citationIntegrity: false };
  assert.equal(dreamDimensionQuality(dims, false), 0);
  assert.equal(dreamDimensionQuality(dims, true), 0.25);
  assert.equal(dreamDimensionQuality({}, true), 0);
  assert.equal(dreamDimensionQuality({ a: true, b: true }, true), 1);
});
