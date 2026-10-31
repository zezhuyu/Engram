import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { createProviderFromConfig } from '../packages/models/factory.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { buildNegativeControlDocs, buildPack } from '../tests/dream/pack.js';
import { inputPath } from './lib/suite.js';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { configureDreamEvalVault } from './lib/dream-eval-vault.js';
import { dreamContradictionHandled, dreamHasUnsupportedUniversalClaim, dreamHeuristicQualityPass, dreamMetadataClaimsTraceable, dreamNegativeControlOutcome, dreamNegativeControlsPass, dreamScenarioOutcome, dreamTextMatchesTerms, isUsableDreamCandidate } from './lib/dream-metrics.js';
import { isHonestNoMechanismProposal } from '../packages/intelligence/dream/critic.js';

const spec = JSON.parse(await fs.readFile(inputPath('dream/labeled-scenarios.json'), 'utf8')) as { thresholds: { meanQualityPerMode: number; minimumEvidenceGrounding: number; criticAdversarialRejectionRecall: number; criticSupportedAcceptanceRate: number; feedbackDeterministicInfluence: number }; scenarios: Array<{ id: string; mode: 'micro' | 'deep' | 'strategic'; evidence: string[]; goal: string; relevanceTerms?: string[]; expectedOutcome?: 'candidate' | 'abstention' }>; negativeControls?: Array<{ id: string; evidence: string[]; instruction: string; expectedUsableCandidates: number; minimumProviderCalls: number }>; criticCases: Array<{ id: string; expected: 'accept' | 'reject'; proposal: string; evidence: string[] }> };
const providerName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli';
const modelName = process.env.MDB_TEST_MODEL;
if (!/-cli$|^auto$/.test(providerName) && !modelName) throw new Error('MDB_TEST_MODEL is required for API providers');
const provider = createProviderFromConfig({ provider: providerName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(modelName ? { modelName } : {}), ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), ...(process.env.MDB_TEST_API_KEY_ENV ? { apiKeyEnv: process.env.MDB_TEST_API_KEY_ENV } : {}), timeoutMs: 240_000, maxRetries: 1 });
// Keep exact inputs, outputs and bounded provider errors for this synthetic corpus so a reviewer can rescore the run.
const providerCalls: Array<Record<string, unknown>> = [];
const generate = provider.generate.bind(provider);
provider.generate = async request => {
  try { const response = await generate(request); providerCalls.push({ kind: 'generate', request, response }); return response; }
  catch (error) { const e = error as { code?: string; message?: string }; providerCalls.push({ kind: 'generate', request, error: { code: e.code, message: e.message } }); throw error; }
};
if (provider.critique) {
  const critique = provider.critique.bind(provider);
  provider.critique = async request => {
    try { const response = await critique(request); providerCalls.push({ kind: 'critique', request, response }); return response; }
    catch (error) { const e = error as { code?: string; message?: string }; providerCalls.push({ kind: 'critique', request, error: { code: e.code, message: e.message } }); throw error; }
  };
}
const RUNS = Math.max(1, Number(process.env.MDB_EVAL_RUNS ?? 1));
const results: Array<Record<string, unknown>> = [];
const negativeControlResults: Array<Record<string, unknown>> = [];
const criticResults: Array<Record<string, unknown>> = [];
let criticRawStart = 0;
const rawDir = path.resolve(process.env.MDB_DREAM_RAW_OUTPUT ?? path.join('verification/dream/raw-responses', new Date().toISOString().replace(/[:.]/g, '-')));
const OBSERVABLE = /\b(measure|compare|check|record|observe|count|assert|time|log|render|confirm|verify|inspect|diff|test)\b/i;
const scoreProposal = (scenario: (typeof spec.scenarios)[number], proposal: { input: { title: string; body: string; metadata?: Record<string, unknown>; evidence?: Array<{ uri: string; revisionId: string; span?: string }> } } | undefined, sources: Array<{ uri: string; revisionId: string; body: string }>) => {
  let grounded = false;
  if (proposal) grounded = !!proposal.input.evidence?.length && proposal.input.evidence.every(ref => { const source = sources.find(doc => doc.uri === ref.uri && doc.revisionId === ref.revisionId); return !!source && typeof ref.span === 'string' && ref.span.length > 0 && source.body.includes(ref.span); });
  const m = proposal?.input.metadata ?? {};
  const text = proposal ? `${proposal.input.title} ${proposal.input.body}`.toLowerCase() : '';
  const terms = scenario.relevanceTerms;
  const modeRelevance = terms ? dreamTextMatchesTerms(text, terms) : scenario.mode === 'micro' ? /json|dashboard|widget|api|render|fetch/.test(text) : scenario.mode === 'deep' ? /cache|caching|contradict|conflict|incompatib|uncertain|claim/.test(text) : /goal|personal|metric|dashboard|side project|api|visual/.test(text);
  const legacyFeasibility = !!proposal && /test|experiment|prototype/i.test(proposal.input.body) && /run|build|check|measure|compare|validate|observe|track/i.test(proposal.input.body);
  const steps = Array.isArray(m.testPlan) ? (m.testPlan as unknown[]).filter(x => typeof x === 'string' && x.length >= 15) : [];
  const feasibility = !!proposal && typeof m.proposedValidation === 'string' && m.proposedValidation.length >= 20 && OBSERVABLE.test(m.proposedValidation) && steps.length >= 1;
  const novelty = !!proposal && (m.novelty === 'new_to_user' || /hypothesis|could|might|combine|connect|composition|transfer|opportunity/i.test(proposal.input.body));
  const contradiction = scenario.mode !== 'deep' || scenario.id !== 'deep-cache-contradiction' || dreamContradictionHandled(text);
  const metadataTraceability = !!proposal && dreamMetadataClaimsTraceable(m, sources.map(source => source.body));
  // These deterministic checks are syntax/provenance guards, not semantic
  // entailment. Keep metadata overlap visible as a diagnostic without letting
  // lexical similarity reject a fact that is supported in other words.
  const unattributedUniversalClaimAbsent = !!proposal && !dreamHasUnsupportedUniversalClaim(proposal.input.body);
  const dims: Record<string, boolean> = { novelty, relevance: modeRelevance, feasibility, citationIntegrity: grounded, contradictionHandling: contradiction, unattributedUniversalClaimAbsent };
  if (scenario.mode === 'deep') {
    dims.factSpeculationSeparation = Array.isArray(m.facts) && m.facts.length >= 1 && Array.isArray(m.speculation) && m.speculation.length >= 1 && Array.isArray(m.missingEvidence) && m.missingEvidence.length >= 1;
    dims.multiHop = Array.isArray(m.hops) && m.hops.length >= (m.subtype === 'contradiction' ? 1 : 2);
  }
  const quality = Object.values(dims).filter(Boolean).length / Object.keys(dims).length;
  const legacy = [novelty, modeRelevance, legacyFeasibility, grounded, contradiction, !!proposal && grounded && !/verified fact|proven that|always safe|never leaks/i.test(proposal.input.body)].filter(Boolean).length / 6;
  return { dims, quality, legacy, diagnostics: { metadataClaimLexicalOverlap: metadataTraceability ? 'NO_WARNING' : 'WARNING_ONLY', semanticGrounding: 'NOT_ASSESSED' } };
};
try {
  for (let run = 1; run <= RUNS; run++) for (const scenario of spec.scenarios) {
    const rawCallStart = providerCalls.length;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-dream-eval-'));
    try {
      const vault = new Vault(root); await vault.init();
      await configureDreamEvalVault(vault, root);
      const pack = await buildPack(vault);
      for (const key of ['privApi', 'privDash']) await vault.delete(pack.ids[key]!, pack.docs[key]!.revisionId);
      const engine = new IntelligenceEngine(vault, provider);
      const getSources = async (keys: string[]) => Promise.all(keys.map(key => key === 'goal' ? vault.get(pack.goalId) : vault.get(pack.ids[key]!, pack.docs[key]!.revisionId)));
      if (scenario.mode === 'deep') {
        // Isolate the labeled case so unrelated, higher-ranked bridges cannot crowd it out.
        const keep = new Set(scenario.evidence.map(key => pack.ids[key]!));
        for (const doc of await vault.listDocuments()) if (doc.kind !== 'user_insight' && !keep.has(doc.id)) await vault.delete(doc.id, doc.revisionId);
      }
      const input = scenario.mode === 'micro' ? { mode: scenario.mode, objectIds: scenario.evidence.map(key => pack.ids[key]!) } : { mode: scenario.mode };
      const marker = `labeled-dream-${scenario.id}-r${run}`;
      await engine.enqueue('dream', { ...input, instruction: `${marker}. Goal: ${scenario.goal}` });
      const job = (await engine.run({ job: 'dream', limit: 1 })).find(item => item.input.instruction?.startsWith(marker));
      const proposalSet = (await engine.proposals()).filter(item => item.input.kind === 'discovery' && item.input.metadata?.mode === scenario.mode);
      const sources = await getSources(scenario.evidence);
      const expectedRefs = new Set(sources.map(doc => `${doc.uri}\0${doc.revisionId}`));
      const hasLabeledEvidence = (item: (typeof proposalSet)[number]) => scenario.evidence.every(key => { const doc = sources.find(source => key === 'goal' ? source.id === pack.goalId : source.id === pack.ids[key]); return !!doc && item.input.evidence?.some(ref => ref.uri === doc.uri && ref.revisionId === doc.revisionId); });
      // Deep mode keeps one winner among sibling candidates; the others are recorded as rejected (not_selected). Score the winner, and all siblings for comparison.
      const survivors = proposalSet.filter(isUsableDreamCandidate);
      // The labeled scenario is scored only when an eligible candidate cites the
      // scenario's actual evidence. An unrelated survivor is not a fallback.
      const proposal = survivors.find(hasLabeledEvidence);
      const expectedOutcome = scenario.expectedOutcome ?? 'candidate';
      const providerCallsUsed = providerCalls.length - rawCallStart;
      const skippedReasons = ((job?.trace as { skipped?: Array<{ reason?: unknown }> } | undefined)?.skipped ?? []).map(item => item.reason);
      const actualOutcome = dreamScenarioOutcome({ expected: expectedOutcome, jobStatus: job?.status ?? 'missing', providerCalls: providerCallsUsed, candidateCount: proposalSet.length, usableCandidateCount: survivors.length, skippedReasons });
      const outcomePass = expectedOutcome === 'abstention' ? actualOutcome === 'justified_abstention' : actualOutcome === 'candidate_produced';
      const scored = expectedOutcome === 'candidate' ? scoreProposal(scenario, proposal, sources) : { dims: { expectedAbstention: outcomePass }, quality: null, legacy: null, diagnostics: { semanticGrounding: 'NOT_APPLICABLE_TO_EXPECTED_ABSTENTION' } };
      const siblings = proposalSet.map(item => scoreProposal(scenario, item, sources).quality);
      const exactCitations = (proposal?.input.evidence ?? []).map(ref => ({ ...ref, exactSource: sources.find(source => source.uri === ref.uri && source.revisionId === ref.revisionId)?.body ?? null, spanOccursInSource: !!sources.find(source => source.uri === ref.uri && source.revisionId === ref.revisionId)?.body.includes(ref.span ?? '') }));
      results.push({ id: scenario.id, run, mode: scenario.mode, expectedOutcome, actualOutcome, outcomePass, jobStatus: job?.status ?? 'missing', ...(job?.error ? { error: job.error } : {}), telemetry: job?.telemetry, trace: job?.trace, candidateCount: proposalSet.length, evaluatedCandidateCount: siblings.length, eligibleCandidateCount: survivors.length, rejectedCount: proposalSet.filter(item => item.status === 'rejected').length, usableCandidateCount: survivors.length, notSelected: proposalSet.length - survivors.length, siblingQualities: siblings, selectedByLabeledEvidence: !!proposal && hasLabeledEvidence(proposal), expectedEvidence: [...expectedRefs], evidenceSources: sources.map(source => ({ uri: source.uri, revisionId: source.revisionId, title: source.title, body: source.body })), proposalStatus: proposal?.status ?? 'no_usable_candidate', candidate: proposal ? { id: proposal.id, title: proposal.input.title, body: proposal.input.body, evidence: proposal.input.evidence, metadata: proposal.input.metadata, critic: proposal.critic, flags: proposal.flags, speculativeStatus: proposal.input.status ?? 'hypothesis' } : null, adjudicationPacket: proposal ? { semanticStatus: 'NOT_ASSESSED', candidateText: { title: proposal.input.title, body: proposal.input.body }, claims: { facts: proposal.input.metadata?.facts ?? [], speculation: proposal.input.metadata?.speculation ?? [], hops: proposal.input.metadata?.hops ?? [], mechanism: proposal.input.metadata?.mechanism ?? null }, exactCitations } : null, proposalRecords: proposalSet.map(item => ({ id: item.id, status: item.status, reason: item.reason, flags: item.flags, critic: item.critic, input: item.input })), semanticGrounding: expectedOutcome === 'abstention' ? 'NOT_APPLICABLE' : 'NOT_ASSESSED', dimensions: scored.dims, diagnostics: scored.diagnostics, quality: scored.quality, legacyQuality: scored.legacy });
      await fs.mkdir(rawDir, { recursive: true });
      await fs.writeFile(path.join(rawDir, `${scenario.id}-run-${run}.json`), JSON.stringify({ scenario: scenario.id, run, job: job ? { status: job.status, error: job.error, telemetry: job.telemetry, trace: job.trace } : { status: 'missing' }, calls: providerCalls.slice(rawCallStart) }, null, 2) + '\n');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  criticRawStart = providerCalls.length;
  for (let run = 1; run <= RUNS; run++) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-dream-eval-'));
    try {
      const vault = new Vault(root); await vault.init(); const pack = await buildPack(vault);
      const getSources = async (keys: string[]) => Promise.all(keys.map(key => key === 'goal' ? vault.get(pack.goalId) : vault.get(pack.ids[key]!, pack.docs[key]!.revisionId)));
  for (const testCase of spec.criticCases) {
    const evidence = await getSources(testCase.evidence);
    const request = ({ proposal: { kind: 'discovery', title: testCase.id, body: testCase.proposal, evidence: evidence.map(doc => ({ uri: doc.uri, revisionId: doc.revisionId })) }, evidence, instruction: 'Reject unsupported factual claims, duplicates of evidence, or claims that contradict cited evidence. Accept a novel, evidence-supported composition. Treat hypotheses as hypotheses.' });
    let verdict: { verdict: string; rationale: string } | undefined; let malformed = 0;
    for (let attempt = 0; attempt < 3 && !verdict; attempt++) { try { verdict = await provider.critique!(request); } catch (error) { if ((error as { code?: string }).code !== 'INVALID_MODEL_OUTPUT' && (error as { code?: string }).code !== 'PROVIDER_ERROR') throw error; malformed++; } }
    const final = verdict ?? { verdict: 'malformed', rationale: 'critic output stayed invalid after 3 attempts' };
    criticResults.push({ id: testCase.id, run, expected: testCase.expected, proposal: testCase.proposal, evidenceSources: evidence.map(source => ({ uri: source.uri, revisionId: source.revisionId, title: source.title, body: source.body })), criticMalformedResponses: malformed, verdict: final.verdict, rationale: final.rationale, correct: final.verdict === testCase.expected });
  }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
} finally { /* each scenario owns and removes its vault */ }
for (let run = 1; run <= RUNS; run++) for (const control of spec.negativeControls ?? []) {
  const rawCallStart = providerCalls.length;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-dream-negative-control-'));
  try {
    const vault = new Vault(root); await vault.init();
    await configureDreamEvalVault(vault, root);
    await buildPack(vault);
    const controlDocs = await buildNegativeControlDocs(vault);
    const keep = new Set(control.evidence.map(key => controlDocs[key]?.id));
    if (keep.size !== control.evidence.length || [...keep].some(id => !id)) throw new Error(`Negative control ${control.id} references an unknown source`);
    for (const doc of await vault.listDocuments()) if (doc.kind !== 'user_insight' && !keep.has(doc.id)) await vault.delete(doc.id, doc.revisionId);
    const engine = new IntelligenceEngine(vault, provider); const marker = `labeled-dream-${control.id}-r${run}`;
    await engine.enqueue('dream', { mode: 'deep', instruction: `${marker}. ${control.instruction}` });
    const job = (await engine.run({ job: 'dream', limit: 1 })).find(item => item.input.instruction?.startsWith(marker));
    const candidates = (await engine.proposals()).filter(item => item.input.kind === 'discovery' && item.input.metadata?.mode === 'deep');
    const safeNoMechanism = candidates.filter(candidate => isHonestNoMechanismProposal(candidate.input, candidate.input.metadata ?? {}));
    const safeIds = new Set(safeNoMechanism.map(candidate => candidate.id));
    const usable = candidates.filter(candidate => isUsableDreamCandidate(candidate) && !safeIds.has(candidate.id));
    const unsupportedCandidates = candidates.filter(candidate => !safeIds.has(candidate.id));
    const providerCallsUsed = providerCalls.length - rawCallStart;
    const sources = Object.values(controlDocs).filter(doc => keep.has(doc.id));
    const adjudicationPackets = candidates.map(candidate => ({
      candidateId: candidate.id,
      status: candidate.status,
      deterministicClass: safeIds.has(candidate.id) ? 'honest_no_mechanism' : isUsableDreamCandidate(candidate) ? 'candidate_requires_adjudication' : 'not_usable',
      candidateText: { title: candidate.input.title, body: candidate.input.body },
      claims: { facts: candidate.input.metadata?.facts ?? [], speculation: candidate.input.metadata?.speculation ?? [], hops: candidate.input.metadata?.hops ?? [], mechanism: candidate.input.metadata?.mechanism ?? null },
      rejection: { reason: candidate.reason ?? null, flags: candidate.flags ?? [], critic: candidate.critic ?? null },
      exactCitations: (candidate.input.evidence ?? []).map(ref => {
        const source = sources.find(doc => doc.uri === ref.uri && doc.revisionId === ref.revisionId);
        return { ...ref, exactSource: source?.body ?? null, spanOccursInSource: !!source && typeof ref.span === 'string' && source.body.includes(ref.span) };
      }),
    }));
    const outcome = dreamNegativeControlOutcome({ jobStatus: job?.status ?? 'missing', providerCalls: providerCallsUsed, minimumProviderCalls: control.minimumProviderCalls, expectedUsableCandidates: control.expectedUsableCandidates, usableCandidates: usable.length, unsupportedCandidates: unsupportedCandidates.length });
    const passed = outcome === 'justified_abstention';
    negativeControlResults.push({ id: control.id, run, status: passed ? 'PASS' : 'FAIL', outcome, jobStatus: job?.status ?? 'missing', ...(job?.error ? { error: job.error } : {}), trace: job?.trace, generatedCandidates: candidates.length, evaluatedCandidates: candidates.length, safeNoMechanismCandidates: safeNoMechanism.length, unsupportedCandidates: unsupportedCandidates.length, usableCandidates: usable.length, providerCalls: providerCallsUsed, minimumProviderCalls: control.minimumProviderCalls, expectedUsableCandidates: control.expectedUsableCandidates, adjudicationPackets });
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, `${control.id}-run-${run}.json`), JSON.stringify({ control: control.id, run, instruction: control.instruction, sourceDocuments: sources.map(({ uri, revisionId, title, body }) => ({ uri, revisionId, title, body })), job: job ? { status: job.status, error: job.error, telemetry: job.telemetry, trace: job.trace } : { status: 'missing' }, candidates: candidates.map(item => ({ id: item.id, status: item.status, input: item.input, flags: item.flags, critic: item.critic })), adjudicationPackets, calls: providerCalls.slice(rawCallStart) }, null, 2) + '\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : 0; };
const byMode = Object.fromEntries(['micro', 'deep', 'strategic'].map(mode => {
  const selected = results.filter(row => row.mode === mode && row.expectedOutcome === 'candidate');
  const dimNames = [...new Set(selected.flatMap(row => Object.keys(row.dimensions as object)))];
  const perRun = Array.from({ length: RUNS }, (_, i) => mean(selected.filter(row => row.run === i + 1).map(row => Number(row.quality))));
  const abstentions = results.filter(row => row.mode === mode && row.expectedOutcome === 'abstention');
  return [mode, { count: selected.length, candidateScenarios: new Set(selected.map(row => row.id)).size, expectedAbstentionScenarios: new Set(abstentions.map(row => row.id)).size, expectedAbstentionsPassed: abstentions.filter(row => row.outcomePass === true).length, meanQuality: mean(selected.map(row => Number(row.quality))), legacyMeanQuality: mean(selected.map(row => Number(row.legacyQuality))), perRunMeanQuality: perRun, runStdDev: sd(perRun), minScenarioRunQuality: selected.length ? Math.min(...selected.map(row => Number(row.quality))) : 0, perDimension: Object.fromEntries(dimNames.map(name => [name, mean(selected.map(row => ((row.dimensions as Record<string, boolean>)[name] ? 1 : 0))) ])), jobsCompleted: selected.filter(row => row.jobStatus === 'complete').length, meanCandidatesPerRun: mean(selected.map(row => Number(row.candidateCount))), meanSiblingQuality: mean(selected.flatMap(row => row.siblingQualities as number[])), selectedVsSiblingGain: mean(selected.map(row => Number(row.quality) - mean(row.siblingQualities as number[]))) }];
}));
const rejects = criticResults.filter(row => row.expected === 'reject'); const accepts = criticResults.filter(row => row.expected === 'accept');
const candidateRows = results.filter(row => row.expectedOutcome === 'candidate');
const metrics = { modes: byMode, meanQualityPerModePass: Object.values(byMode).every(row => row.candidateScenarios > 0 && row.meanQuality >= spec.thresholds.meanQualityPerMode), minimumCitationIntegrity: candidateRows.length ? Math.min(...candidateRows.map(row => (row.dimensions as { citationIntegrity: boolean }).citationIntegrity ? 1 : 0)) : 0, semanticGrounding: 'NOT_ASSESSED' as const, criticAdversarialRejectionRecall: rejects.length ? rejects.filter(row => row.correct).length / rejects.length : 1, criticSupportedAcceptanceRate: accepts.length ? accepts.filter(row => row.correct).length / accepts.length : 1, feedbackDeterministicInfluence: 1, feedbackEvidence: 'tests/dream/dream.test.ts: feedback drives status and ranking; rejected ideas do not come back without new evidence; repetition never validates' };
const thresholds = spec.thresholds;
const negativeControlPass = dreamNegativeControlsPass(
  negativeControlResults,
  (spec.negativeControls ?? []).map(control => control.id),
  RUNS,
);
const minimumRunsRequired = 3; const minimumScenarioQuality = 0.75;
const scenarioQualities = results.filter(row => row.expectedOutcome === 'candidate').map(row => ({ id: row.id, run: row.run, mode: row.mode, quality: Number(row.quality), dimensions: row.dimensions as Record<string, boolean> }));
const minimumScenarioRunQuality = scenarioQualities.length ? Math.min(...scenarioQualities.map(row => row.quality)) : 0;
const expectedAbstentionRows = results.filter(row => row.expectedOutcome === 'abstention');
const expectedAbstentionsPass = expectedAbstentionRows.length > 0 && expectedAbstentionRows.every(row => row.outcomePass === true);
const scenarioQualityPass = scenarioQualities.length > 0 && scenarioQualities.every(row => Number.isFinite(row.quality) && row.quality >= minimumScenarioQuality && row.dimensions.contradictionHandling === true && row.dimensions.unattributedUniversalClaimAbsent === true) && expectedAbstentionsPass;
const heuristicPass = dreamHeuristicQualityPass({ runs: RUNS, minimumRuns: minimumRunsRequired, minimumScenarioQuality, scenarios: scenarioQualities, meanQualityPerModePass: metrics.meanQualityPerModePass, minimumCitationIntegrity: candidateRows.length ? Math.min(...candidateRows.map(row => ((row.dimensions as Record<string, boolean>).citationIntegrity ? 1 : 0))) : 0, minimumEvidenceGrounding: thresholds.minimumEvidenceGrounding, criticAdversarialRejectionRecall: metrics.criticAdversarialRejectionRecall, minimumCriticRejectionRecall: thresholds.criticAdversarialRejectionRecall, criticSupportedAcceptanceRate: metrics.criticSupportedAcceptanceRate, minimumCriticSupportedAcceptanceRate: thresholds.criticSupportedAcceptanceRate }) && expectedAbstentionsPass && negativeControlPass;
const generatedCandidates = results.reduce((n, row) => n + Number(row.candidateCount), 0);
const evaluatedCandidates = results.reduce((n, row) => n + Number(row.evaluatedCandidateCount), 0);
const eligibleCandidates = results.reduce((n, row) => n + Number(row.eligibleCandidateCount), 0);
const rejectedCandidates = results.reduce((n, row) => n + Number(row.rejectedCount), 0);
const usableCandidates = results.reduce((n, row) => n + Number(row.usableCandidateCount), 0);
const candidateExpectedRows = results.filter(row => row.expectedOutcome === 'candidate');
const generationCalls = providerCalls.filter(call => call.kind === 'generate');
const generationResponses = generationCalls.filter(call => 'response' in call);
const generationErrors = generationCalls.filter(call => 'error' in call);
const candidateExpectedOutputs = candidateExpectedRows.filter(row => Number(row.usableCandidateCount) > 0).length;
const expectedAbstentionsPassedCount = expectedAbstentionRows.filter(row => row.outcomePass === true).length;
const candidateMetrics = { generatedCandidates, evaluatedCandidates, persistedCandidates: evaluatedCandidates, eligibleCandidates, rejectedCandidates, usableCandidates, candidateYield: evaluatedCandidates ? usableCandidates / evaluatedCandidates : 0, candidateYieldDenominator: 'persisted proposal records enumerated from each scenario vault', successfulProviderGenerationResponses: generationResponses.length, failedProviderGenerationCalls: generationErrors.length, providerGenerationCalls: generationCalls.length, providerResponsesWithoutPersistedCandidateMapping: Math.max(0, generationResponses.length - evaluatedCandidates), scenarioOutputsWithUsableCandidate: results.filter(row => Number(row.usableCandidateCount) > 0).length, scenarioOutputAttempts: results.length, usableOutputYield: results.length ? results.filter(row => Number(row.usableCandidateCount) > 0).length / results.length : 0, candidateExpectedAttempts: candidateExpectedRows.length, candidateExpectedOutputs, candidateOutputYield: candidateExpectedRows.length ? candidateExpectedOutputs / candidateExpectedRows.length : 0, expectedAbstentionAttempts: expectedAbstentionRows.length, expectedAbstentionsPassed: expectedAbstentionsPassedCount, semanticAdjudication: 'NOT_RUN' as const };
const evidenceSource = await currentSourceEvidence();
await fs.mkdir(rawDir, { recursive: true });
await fs.writeFile(path.join(rawDir, `critic-run-${Date.now()}.json`), JSON.stringify({ calls: providerCalls.slice(criticRawStart), scoredCases: criticResults }, null, 2) + '\n');
const report = { status: heuristicPass ? 'INCOMPLETE' : 'FAIL', deterministicChecks: heuristicPass ? 'SATISFIED' : 'FAILED', semanticGrounding: 'NOT_ASSESSED', humanAdjudication: 'NOT_RUN', runs: RUNS, minimumRunsRequired, minimumScenarioQuality, command: `MDB_TEST_PROVIDER=${providerName} MDB_TEST_MODEL=${modelName ?? '(CLI default)'} MDB_EVAL_RUNS=${RUNS} npm run eval:dream`, provider: provider.id, model: modelName ?? null, corpus: 'verification/dream/labeled-scenarios.json', runAt: new Date().toISOString(), thresholds, counts: { dreamScenarios: results.length, criticCases: criticResults.length, ...candidateMetrics, negativeControls: negativeControlResults.length, negativeControlsPassed: negativeControlResults.filter(row => row.status === 'PASS').length }, metrics: { ...metrics, minimumScenarioRunQuality, scenarioQualityPass, negativeControlPass }, scenarios: results, negativeControls: negativeControlResults, criticCases: criticResults, evidenceSource, rawResponses: rawDir, retrieval: { lexicalGraph: 'deterministic evidence: npm run verify:dream', semanticHybrid: 'NOT_RUN; no configured real embedding provider/backend for this run; optional semantic retrieval remains additive' }, limitations: ['The status remains INCOMPLETE whenever deterministic checks pass because semantic grounding and qualified human adjudication have not been completed.', 'A negative-control abstention is a valid outcome when the job completes, meets the provider-call floor, produces no usable candidate, and no unsupported candidate survives; unsupported generated candidates remain separately reported.', 'Dream lexical checks are diagnostics, not entailment. Adjudication packets expose exact cited spans and facts/speculation/hops/mechanism separately; semantic adjudication remains NOT_ASSESSED until a qualified independent review is recorded.', 'Candidate quality, critic rejection accuracy and usable-output yield are separate counts; rejected or not-selected hypotheses are not usable results.', 'Feedback influence is established by deterministic regression testing, not a multi-run model experiment.', 'No production embedding model was configured, so real semantic/hybrid quality comparison was not run.'] };
const reportPath = path.resolve(process.env.MDB_DREAM_OUTPUT ?? 'verification/dream/real-model-evaluation.json');
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
