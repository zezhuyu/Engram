import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { createProviderFromConfig } from '../packages/models/factory.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { buildPack } from '../tests/dream/pack.js';
import { inputPath } from './lib/suite.js';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { isUsableDreamCandidate } from './lib/dream-metrics.js';

const spec = JSON.parse(await fs.readFile(inputPath('dream/labeled-scenarios.json'), 'utf8')) as { thresholds: { meanQualityPerMode: number; minimumEvidenceGrounding: number; criticAdversarialRejectionRecall: number; criticSupportedAcceptanceRate: number; feedbackDeterministicInfluence: number }; scenarios: Array<{ id: string; mode: 'micro' | 'deep' | 'strategic'; evidence: string[]; goal: string; relevanceTerms?: string[] }>; criticCases: Array<{ id: string; expected: 'accept' | 'reject'; proposal: string; evidence: string[] }> };
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
const criticResults: Array<Record<string, unknown>> = [];
let criticRawStart = 0;
const rawDir = path.join('verification/dream/raw-responses', new Date().toISOString().replace(/[:.]/g, '-'));
const OBSERVABLE = /\b(measure|compare|check|record|observe|count|assert|time|log|render|confirm|verify|inspect|diff|test)\b/i;
const UNIVERSAL = /(always safe|never leaks?|verified fact|proven that|guaranteed)/i;
const ATTRIBUTED = /(claim|claims|says|said|states|stated|asserts?|according|source|note|page|finding|quote|"|\u201c|\*)/i;
/** Unattributed universal claims only: a sentence that quotes or attributes the phrase to a source is reporting the source, not asserting it. */
const unsupportedUniversal = (body: string) => body.split(/(?<=[.!?\n])\s+/).some(sentence => UNIVERSAL.test(sentence) && !ATTRIBUTED.test(sentence));
const scoreProposal = (scenario: (typeof spec.scenarios)[number], proposal: { input: { title: string; body: string; metadata?: Record<string, unknown>; evidence?: Array<{ uri: string; revisionId: string; span?: string }> } } | undefined, sources: Array<{ uri: string; revisionId: string; body: string }>) => {
  let grounded = false;
  if (proposal) grounded = !!proposal.input.evidence?.length && proposal.input.evidence.every(ref => { const source = sources.find(doc => doc.uri === ref.uri && doc.revisionId === ref.revisionId); return !!source && typeof ref.span === 'string' && ref.span.length > 0 && source.body.includes(ref.span); });
  const m = proposal?.input.metadata ?? {};
  const text = proposal ? `${proposal.input.title} ${proposal.input.body}`.toLowerCase() : '';
  const terms = scenario.relevanceTerms;
  const modeRelevance = terms ? terms.every(t => text.includes(t)) || terms.filter(t => text.includes(t)).length >= Math.ceil(terms.length / 2) && terms.length > 1 : scenario.mode === 'micro' ? /json|dashboard|widget|api|render|fetch/.test(text) : scenario.mode === 'deep' ? /cache|contradict|conflict|incompatib|uncertain|claim/.test(text) : /goal|personal|metric|dashboard|side project|api|visual/.test(text);
  const legacyFeasibility = !!proposal && /test|experiment|prototype/i.test(proposal.input.body) && /run|build|check|measure|compare|validate|observe|track/i.test(proposal.input.body);
  const steps = Array.isArray(m.testPlan) ? (m.testPlan as unknown[]).filter(x => typeof x === 'string' && x.length >= 15) : [];
  const feasibility = !!proposal && typeof m.proposedValidation === 'string' && m.proposedValidation.length >= 20 && OBSERVABLE.test(m.proposedValidation) && steps.length >= 1;
  const novelty = !!proposal && (m.novelty === 'new_to_user' || /hypothesis|could|might|combine|connect|composition|transfer|opportunity/i.test(proposal.input.body));
  const contradiction = scenario.mode !== 'deep' || scenario.id !== 'deep-cache-contradiction' || (/cache/.test(text) && /conflict|contradict|both|uncertain|cannot determine|incompatible|unresolved/i.test(text));
  const hallucinationFree = !!proposal && grounded && !unsupportedUniversal(proposal.input.body);
  const dims: Record<string, boolean> = { novelty, relevance: modeRelevance, feasibility, citationIntegrity: grounded, contradictionHandling: contradiction, hallucinationFree };
  if (scenario.mode === 'deep') {
    dims.factSpeculationSeparation = Array.isArray(m.facts) && m.facts.length >= 1 && Array.isArray(m.speculation) && m.speculation.length >= 1 && Array.isArray(m.missingEvidence) && m.missingEvidence.length >= 1;
    dims.multiHop = Array.isArray(m.hops) && m.hops.length >= (m.subtype === 'contradiction' ? 1 : 2);
  }
  const quality = Object.values(dims).filter(Boolean).length / Object.keys(dims).length;
  const legacy = [novelty, modeRelevance, legacyFeasibility, grounded, contradiction, !!proposal && grounded && !/verified fact|proven that|always safe|never leaks/i.test(proposal.input.body)].filter(Boolean).length / 6;
  return { dims, quality, legacy };
};
try {
  for (let run = 1; run <= RUNS; run++) for (const scenario of spec.scenarios) {
    const rawCallStart = providerCalls.length;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-dream-eval-'));
    try {
      const vault = new Vault(root); await vault.init();
      const config = await vault.config(); config.dream.enabled = true; config.dream.eventDriven = false; config.dream.modes = ['micro', 'deep', 'strategic']; config.dream.maxProposalsPerRun = 2; config.model.critic = true; config.model.allowPrivateContentToRemote = true;
      await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
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
      const proposal = survivors.find(hasLabeledEvidence) ?? survivors.at(-1);
      const scored = scoreProposal(scenario, proposal, sources);
      const siblings = proposalSet.map(item => scoreProposal(scenario, item, sources).quality);
      results.push({ id: scenario.id, run, mode: scenario.mode, jobStatus: job?.status ?? 'missing', ...(job?.error ? { error: job.error } : {}), telemetry: job?.telemetry, trace: job?.trace, candidateCount: proposalSet.length, rejectedCount: proposalSet.filter(item => item.status === 'rejected').length, usableCandidateCount: survivors.length, notSelected: proposalSet.length - survivors.length, siblingQualities: siblings, selectedByLabeledEvidence: !!proposal && hasLabeledEvidence(proposal), expectedEvidence: [...expectedRefs], proposalStatus: proposal?.status ?? 'no_usable_candidate', candidate: proposal ? { title: proposal.input.title, body: proposal.input.body, evidence: proposal.input.evidence, metadata: proposal.input.metadata, critic: proposal.critic, flags: proposal.flags, speculativeStatus: proposal.input.status ?? 'hypothesis' } : null, semanticGrounding: 'NOT_ASSESSED', dimensions: scored.dims, quality: scored.quality, legacyQuality: scored.legacy });
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
    criticResults.push({ id: testCase.id, run, expected: testCase.expected, criticMalformedResponses: malformed, verdict: final.verdict, rationale: final.rationale, correct: final.verdict === testCase.expected });
  }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
} finally { /* each scenario owns and removes its vault */ }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : 0; };
const byMode = Object.fromEntries(['micro', 'deep', 'strategic'].map(mode => {
  const selected = results.filter(row => row.mode === mode);
  const dimNames = [...new Set(selected.flatMap(row => Object.keys(row.dimensions as object)))];
  const perRun = Array.from({ length: RUNS }, (_, i) => mean(selected.filter(row => row.run === i + 1).map(row => Number(row.quality))));
  return [mode, { count: selected.length, scenarios: new Set(selected.map(row => row.id)).size, meanQuality: mean(selected.map(row => Number(row.quality))), legacyMeanQuality: mean(selected.map(row => Number(row.legacyQuality))), perRunMeanQuality: perRun, runStdDev: sd(perRun), minScenarioRunQuality: selected.length ? Math.min(...selected.map(row => Number(row.quality))) : 0, perDimension: Object.fromEntries(dimNames.map(name => [name, mean(selected.map(row => ((row.dimensions as Record<string, boolean>)[name] ? 1 : 0))) ])), jobsCompleted: selected.filter(row => row.jobStatus === 'complete').length, meanCandidatesPerRun: mean(selected.map(row => Number(row.candidateCount))), meanSiblingQuality: mean(selected.flatMap(row => row.siblingQualities as number[])), selectedVsSiblingGain: mean(selected.map(row => Number(row.quality) - mean(row.siblingQualities as number[]))) }];
}));
const rejects = criticResults.filter(row => row.expected === 'reject'); const accepts = criticResults.filter(row => row.expected === 'accept');
const metrics = { modes: byMode, meanQualityPerModePass: Object.values(byMode).every(row => row.meanQuality >= spec.thresholds.meanQualityPerMode), minimumCitationIntegrity: results.length ? Math.min(...results.map(row => (row.dimensions as { citationIntegrity: boolean }).citationIntegrity ? 1 : 0)) : 0, semanticGrounding: 'NOT_ASSESSED' as const, criticAdversarialRejectionRecall: rejects.length ? rejects.filter(row => row.correct).length / rejects.length : 1, criticSupportedAcceptanceRate: accepts.length ? accepts.filter(row => row.correct).length / accepts.length : 1, feedbackDeterministicInfluence: 1, feedbackEvidence: 'tests/dream/dream.test.ts: feedback drives status and ranking; rejected ideas do not come back without new evidence; repetition never validates' };
const thresholds = spec.thresholds;
const heuristicPass = metrics.meanQualityPerModePass && metrics.minimumCitationIntegrity >= thresholds.minimumEvidenceGrounding && metrics.criticAdversarialRejectionRecall >= thresholds.criticAdversarialRejectionRecall && metrics.criticSupportedAcceptanceRate >= thresholds.criticSupportedAcceptanceRate;
const candidateMetrics = { generatedCandidates: results.reduce((n, row) => n + Number(row.candidateCount), 0), rejectedCandidates: results.reduce((n, row) => n + Number(row.rejectedCount), 0), usableCandidates: results.reduce((n, row) => n + Number(row.usableCandidateCount), 0), usableOutputYield: results.length ? results.filter(row => Number(row.usableCandidateCount) > 0).length / results.length : 0, semanticAdjudication: 'NOT_RUN' as const };
const evidenceSource = await currentSourceEvidence();
await fs.mkdir(rawDir, { recursive: true });
await fs.writeFile(path.join(rawDir, `critic-run-${Date.now()}.json`), JSON.stringify({ calls: providerCalls.slice(criticRawStart), scoredCases: criticResults }, null, 2) + '\n');
const report = { status: heuristicPass ? 'INCOMPLETE' : 'FAIL', heuristicStatus: heuristicPass ? 'PASS' : 'FAIL', runs: RUNS, command: `MDB_TEST_PROVIDER=${providerName} MDB_TEST_MODEL=${modelName ?? '(CLI default)'} MDB_EVAL_RUNS=${RUNS} npm run eval:dream`, provider: provider.id, model: modelName ?? null, corpus: 'verification/dream/labeled-scenarios.json', thresholds, counts: { dreamScenarios: results.length, criticCases: criticResults.length, ...candidateMetrics }, metrics, scenarios: results, criticCases: criticResults, evidenceSource, rawResponses: rawDir, retrieval: { lexicalGraph: 'deterministic evidence: npm run verify:dream', semanticHybrid: 'NOT_RUN; no configured real embedding provider/backend for this run; optional semantic retrieval remains additive' }, limitations: ['Citation presence and exact source-span integrity are measured separately from whether evidence semantically entails a candidate. Semantic adjudication was NOT_RUN, so a passing deterministic rubric remains INCOMPLETE.', 'Candidate quality, critic rejection accuracy and usable-output yield are separate counts; rejected or not-selected hypotheses are not usable results.', 'Feedback influence is established by deterministic regression testing, not a multi-run model experiment.', 'No production embedding model was configured, so real semantic/hybrid quality comparison was not run.'] };
await fs.writeFile('verification/dream/real-model-evaluation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
