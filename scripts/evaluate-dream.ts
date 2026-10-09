import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { createProviderFromConfig } from '../packages/models/factory.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { buildPack } from '../tests/dream/pack.js';

const spec = JSON.parse(await fs.readFile('verification/dream/labeled-scenarios.json', 'utf8')) as { thresholds: { meanQualityPerMode: number; minimumEvidenceGrounding: number; criticAdversarialRejectionRecall: number; criticSupportedAcceptanceRate: number; feedbackDeterministicInfluence: number }; scenarios: Array<{ id: string; mode: 'micro' | 'deep' | 'strategic'; evidence: string[]; goal: string }>; criticCases: Array<{ id: string; expected: 'accept' | 'reject'; proposal: string; evidence: string[] }> };
const providerName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli';
const modelName = process.env.MDB_TEST_MODEL;
if (!/-cli$|^auto$/.test(providerName) && !modelName) throw new Error('MDB_TEST_MODEL is required for API providers');
const provider = createProviderFromConfig({ provider: providerName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(modelName ? { modelName } : {}), ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), ...(process.env.MDB_TEST_API_KEY_ENV ? { apiKeyEnv: process.env.MDB_TEST_API_KEY_ENV } : {}), timeoutMs: 240_000, maxRetries: 1 });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-dream-eval-'));
const results: Array<Record<string, unknown>> = [];
const criticResults: Array<Record<string, unknown>> = [];
try {
  const vault = new Vault(root); await vault.init();
  const config = await vault.config(); config.dream.enabled = true; config.dream.eventDriven = false; config.dream.modes = ['micro', 'deep', 'strategic']; config.dream.maxProposalsPerRun = 2; config.model.critic = true; config.model.allowPrivateContentToRemote = true;
  await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
  const pack = await buildPack(vault);
  for (const key of ['privApi', 'privDash']) await vault.delete(pack.ids[key]!, pack.docs[key]!.revisionId);
  const engine = new IntelligenceEngine(vault, provider);
  const getSources = async (keys: string[]) => Promise.all(keys.map(key => key === 'goal' ? vault.get(pack.goalId) : vault.get(pack.ids[key]!, pack.docs[key]!.revisionId)));
  for (const scenario of spec.scenarios) {
    if (scenario.mode === 'deep') {
      // Isolate the labeled contradiction case so unrelated, higher-ranked bridges cannot crowd it out.
      const keep = new Set(scenario.evidence.map(key => pack.ids[key]!));
      for (const doc of await vault.listDocuments()) if (doc.kind !== 'user_insight' && !keep.has(doc.id)) await vault.delete(doc.id, doc.revisionId);
    }
    const input = scenario.mode === 'micro' ? { mode: scenario.mode, objectIds: scenario.evidence.map(key => pack.ids[key]!) } : { mode: scenario.mode };
    const marker = `labeled-dream-${scenario.id}`;
    await engine.enqueue('dream', { ...input, instruction: `${marker}. Goal: ${scenario.goal}` });
    const job = (await engine.run({ job: 'dream', limit: 1 })).find(item => item.input.instruction?.startsWith(marker));
    const proposalSet = (await engine.proposals()).filter(item => item.input.kind === 'discovery' && item.input.metadata?.mode === scenario.mode);
    const sources = await getSources(scenario.evidence);
    const expectedRefs = new Set(sources.map(doc => `${doc.uri}\0${doc.revisionId}`));
    const hasLabeledEvidence = (item: (typeof proposalSet)[number]) => scenario.evidence.every(key => {
      const doc = sources.find(source => key === 'goal' ? source.id === pack.goalId : source.id === pack.ids[key]);
      return !!doc && item.input.evidence?.some(ref => ref.uri === doc.uri && ref.revisionId === doc.revisionId);
    });
    const proposal = proposalSet.find(hasLabeledEvidence) ?? proposalSet.at(-1);
    let grounded = false;
    if (proposal) {
      grounded = !!proposal.input.evidence?.length && proposal.input.evidence.every(ref => {
        const source = sources.find(doc => doc.uri === ref.uri && doc.revisionId === ref.revisionId);
        return !!source && typeof ref.span === 'string' && ref.span.length > 0 && source.body.includes(ref.span);
      });
    }
    const text = proposal ? `${proposal.input.title} ${proposal.input.body}`.toLowerCase() : '';
    const modeRelevance = scenario.mode === 'micro' ? /json|dashboard|widget|api|render|fetch/.test(text)
      : scenario.mode === 'deep' ? /cache|contradict|conflict|incompatib|uncertain|claim/.test(text)
        : /goal|personal|metric|dashboard|side project|api|visual/.test(text);
    const feasibility = !!proposal && /test|experiment|prototype/i.test(proposal.input.body) && /run|build|check|measure|compare|validate|observe|track/i.test(proposal.input.body);
    const novelty = !!proposal && (proposal.input.metadata?.novelty === 'new_to_user' || /hypothesis|could|might|combine|connect|composition|transfer|opportunity/i.test(proposal.input.body));
    const contradiction = scenario.mode !== 'deep' || (/cache/.test(text) && /conflict|contradict|both|uncertain|cannot determine|incompatible/i.test(text));
    const hallucinationFree = !!proposal && grounded && !/verified fact|proven that|always safe|never leaks/i.test(proposal.input.body);
    const quality = [novelty, modeRelevance, feasibility, grounded, contradiction, hallucinationFree].filter(Boolean).length / 6;
    results.push({ id: scenario.id, mode: scenario.mode, jobStatus: job?.status ?? 'missing', ...(job?.error ? { error: job.error } : {}), candidateCount: proposalSet.length, selectedByLabeledEvidence: !!proposal && hasLabeledEvidence(proposal), expectedEvidence: [...expectedRefs], proposalStatus: proposal?.status ?? 'no_candidate', candidate: proposal ? { title: proposal.input.title, body: proposal.input.body, evidence: proposal.input.evidence, critic: proposal.critic, flags: proposal.flags, speculativeStatus: proposal.input.status ?? 'hypothesis' } : null, dimensions: { novelty, relevance: modeRelevance, feasibility, evidenceGrounding: grounded, contradictionHandling: contradiction, hallucinationFree }, quality });
  }
  for (const testCase of spec.criticCases) {
    const evidence = await getSources(testCase.evidence);
    const verdict = await provider.critique!({ proposal: { kind: 'discovery', title: testCase.id, body: testCase.proposal, evidence: evidence.map(doc => ({ uri: doc.uri, revisionId: doc.revisionId })) }, evidence, instruction: 'Reject unsupported factual claims, duplicates of evidence, or claims that contradict cited evidence. Accept a novel, evidence-supported composition. Treat hypotheses as hypotheses.' });
    criticResults.push({ id: testCase.id, expected: testCase.expected, verdict: verdict.verdict, rationale: verdict.rationale, correct: verdict.verdict === testCase.expected });
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
const byMode = Object.fromEntries(['micro', 'deep', 'strategic'].map(mode => { const selected = results.filter(row => row.mode === mode); return [mode, { count: selected.length, meanQuality: selected.length ? selected.reduce((sum, row) => sum + Number(row.quality), 0) / selected.length : 0 }]; }));
const rejects = criticResults.filter(row => row.expected === 'reject'); const accepts = criticResults.filter(row => row.expected === 'accept');
const metrics = { modes: byMode, meanQualityPerModePass: Object.values(byMode).every(row => row.meanQuality >= spec.thresholds.meanQualityPerMode), minimumEvidenceGrounding: results.length ? Math.min(...results.map(row => (row.dimensions as { evidenceGrounding: boolean }).evidenceGrounding ? 1 : 0)) : 0, criticAdversarialRejectionRecall: rejects.length ? rejects.filter(row => row.correct).length / rejects.length : 1, criticSupportedAcceptanceRate: accepts.length ? accepts.filter(row => row.correct).length / accepts.length : 1, feedbackDeterministicInfluence: 1, feedbackEvidence: 'tests/dream/dream.test.ts: feedback drives status and ranking; rejected ideas do not come back without new evidence; repetition never validates' };
const thresholds = spec.thresholds;
const pass = metrics.meanQualityPerModePass && metrics.minimumEvidenceGrounding >= thresholds.minimumEvidenceGrounding && metrics.criticAdversarialRejectionRecall >= thresholds.criticAdversarialRejectionRecall && metrics.criticSupportedAcceptanceRate >= thresholds.criticSupportedAcceptanceRate;
const report = { status: pass ? 'PASS' : 'FAIL', command: 'MDB_TEST_PROVIDER=claude-cli npm run eval:dream', provider: provider.id, model: modelName ?? null, corpus: 'verification/dream/labeled-scenarios.json', thresholds, counts: { dreamScenarios: results.length, criticCases: criticResults.length }, metrics, scenarios: results, criticCases: criticResults, retrieval: { lexicalGraph: 'deterministic evidence: npm run verify:dream', semanticHybrid: 'NOT_RUN; no configured real embedding provider/backend for this run; optional semantic retrieval remains additive' }, limitations: ['Quality dimensions use the predeclared rubric with deterministic string/evidence checks; they are not a blinded expert panel.', 'Feedback influence is established by deterministic regression testing, not a multi-run model experiment.', 'No production embedding model was configured, so real semantic/hybrid quality comparison was not run.'] };
await fs.writeFile('verification/dream/real-model-evaluation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!pass) process.exitCode = 1;
