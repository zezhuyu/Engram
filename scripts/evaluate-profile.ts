import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { createProviderFromConfig } from '../packages/models/factory.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { inputPath } from './lib/suite.js';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { predictionCountsByCase, predictionTermsMatch } from './lib/profile-metrics.js';

type Case = { id: string; scope: 'global' | 'project:orion'; text: string; expected: null | { category: string; key: string; terms: string[]; relation?: { left: string; operator: string; right: string } }; supersedes?: string };
const corpusPath = process.env.MDB_PROFILE_CORPUS ?? 'profile/labeled-corpus.json';
const holdout = corpusPath !== 'profile/labeled-corpus.json';
const corpus = JSON.parse(await fs.readFile(inputPath(corpusPath), 'utf8')) as { version: number; thresholds: { precision: number; recall: number; falsePositiveRate: number; jobSuccessRate: number; scopeAccuracy: number; evidenceGrounding: number }; cases: Case[] };
const providerName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli';
const modelName = process.env.MDB_TEST_MODEL;
if (!/-cli$|^auto$/.test(providerName) && !modelName) throw new Error('MDB_TEST_MODEL is required for API providers');
const provider = createProviderFromConfig({ provider: providerName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(modelName ? { modelName } : {}), ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), ...(process.env.MDB_TEST_API_KEY_ENV ? { apiKeyEnv: process.env.MDB_TEST_API_KEY_ENV } : {}), timeoutMs: 240_000, maxRetries: 3 });
const RUNS = Math.max(1, Number(process.env.MDB_EVAL_RUNS ?? 1));
// Keep run-specific model output under ignored verification evidence; never replace source-controlled evaluation fixtures.
const RAW_OUTPUT_DIR = path.join('verification/profile', holdout ? 'holdout-raw-responses' : 'raw-responses', new Date().toISOString().replace(/[:.]/g, '-'));
const scrub = (text: string) => text.replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
let tap: string[] = [];
let rawCalls: Array<Record<string, unknown>> = [];
(provider as unknown as { onResponse?: (text: string) => void }).onResponse = text => { tap.push(scrub(text)); };
const generate = provider.generate.bind(provider);
provider.generate = async request => {
  try { const response = await generate(request); rawCalls.push({ request, response }); return response; }
  catch (error) { const e = error as { code?: string; message?: string }; rawCalls.push({ request, error: { code: e.code, message: e.message } }); throw error; }
};
const allRuns: Array<Array<Record<string, unknown>>> = [];
const rawByCase = new Map<string, Array<{ run: number; jobStatus: string; responses: string[]; calls: Array<Record<string, unknown>> }>>();
for (let run = 1; run <= RUNS; run++) {
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-profile-eval-'));
const rows: Array<Record<string, unknown>> = [];
try {
  const vault = new Vault(root); await vault.init(); await vault.createWorkspace('orion', 'Synthetic project preference evaluation');
  const config = await vault.config(); config.model.allowPrivateContentToRemote = true; config.model.critic = false;
  await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
  for (const item of corpus.cases) {
    const scope = item.scope === 'global' ? { type: 'global' as const, area: 'profile' as const } : { type: 'workspace' as const, workspaceId: 'orion' };
    // Keep this source user-attributed but do not mark it as newly passively captured;
    // otherwise the event checkpoint adds an extra background profile job.
    const source = await vault.put({ scope, kind: 'observation', title: `[SYNTHETIC EVAL] ${item.id}`, body: item.text, metadata: { speaker: 'user', evaluationCase: item.id } });
    let prior: string | undefined;
    if (item.supersedes) {
      const inferred = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Earlier inferred code review preference', body: 'The user prefers concise code review feedback.', status: 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'code-review-style', evidenceClass: 'inferred', scopeLabel: 'global' } });
      prior = inferred.id;
    }
    const engine = new IntelligenceEngine(vault, provider); tap = []; rawCalls = [];
    await engine.enqueue('profile', { scope, objectIds: [source.id], instruction: 'Extract at most one enduring user preference, goal, interest, capability, or working style from the supplied conversation. Ignore questions, hypotheticals, third-party statements, temporary instructions, ambiguity, and explicit requests not to remember. Do not invent a claim. Use an exact evidence span.' });
    const [job] = await engine.run({ job: 'profile', limit: 1 });
    (rawByCase.get(item.id) ?? rawByCase.set(item.id, []).get(item.id)!).push({ run, jobStatus: job?.status ?? 'missing', responses: [...tap], calls: [...rawCalls] });
    const proposals = (await engine.proposals()).filter(p => p.input.kind === 'user_insight' && p.input.evidence?.some(e => e.uri === source.uri && e.revisionId === source.revisionId));
    const proposal = proposals.at(-1);
    const expected = item.expected;
    const claim = proposal ? `${proposal.input.title} ${proposal.input.body}`.toLowerCase() : '';
    const candidateGenerated = !!proposal;
    const extracted = !!proposal && proposal.status !== 'rejected';
    const relationMatches = !expected?.relation || claim.indexOf(expected.relation.left.toLowerCase()) >= 0 && claim.indexOf(expected.relation.left.toLowerCase()) < claim.indexOf(expected.relation.operator.toLowerCase()) && claim.indexOf(expected.relation.operator.toLowerCase()) < claim.indexOf(expected.relation.right.toLowerCase());
    const matches = extracted && !!expected && proposal!.input.metadata?.category === expected.category && predictionTermsMatch(claim, expected.terms) && relationMatches;
    const scored = proposals.filter(p => p.status !== 'rejected').map(p => {
      const text = `${p.input.title} ${p.input.body}`;
      const rel = !expected?.relation || text.indexOf(expected.relation.left.toLowerCase()) >= 0 && text.indexOf(expected.relation.left.toLowerCase()) < text.indexOf(expected.relation.operator.toLowerCase()) && text.indexOf(expected.relation.operator.toLowerCase()) < text.indexOf(expected.relation.right.toLowerCase());
      const valid = p.input.metadata?.category === expected?.category && !!expected && predictionTermsMatch(text, expected.terms) && rel;
      const refs = p.input.metadata?.sources;
      const grounded = Array.isArray(refs) && refs.some(s => s && typeof s === 'object' && (s as { uri?: string }).uri === source.uri && (s as { revisionId?: string }).revisionId === source.revisionId && typeof (s as { span?: string }).span === 'string' && item.text.includes((s as { span: string }).span));
      return { id: p.id, category: p.input.metadata?.category ?? null, claim: p.input.body, match: valid, sourceValid: grounded, scopeCorrect: p.input.metadata?.scopeLabel === (item.scope === 'global' ? 'global' : 'orion'), status: p.status };
    });
    const sourceRef = proposal?.input.metadata?.sources;
    const sourceValid = Array.isArray(sourceRef) && sourceRef.some(s => s && typeof s === 'object' && (s as { uri?: string }).uri === source.uri && (s as { revisionId?: string }).revisionId === source.revisionId && typeof (s as { span?: string }).span === 'string' && item.text.includes((s as { span: string }).span));
    const wantedScope = item.scope === 'global' ? 'global' : 'orion';
    const scopeCorrect = !!proposal && proposal.input.metadata?.scopeLabel === wantedScope;
    const correctionOverride = !prior || (!!proposal && proposal.input.metadata?.evidenceClass === 'explicit' && (proposal.flags ?? []).includes('supersedes_earlier'));
    rows.push({ id: item.id, expected: expected ? 'insight' : 'none', extracted: scored.length > 0, candidateGenerated: proposals.length > 0, match: matches, predictionMatches: scored.map(p => p.match), predictions: scored, retainedPredictions: scored.length, category: proposal?.input.metadata?.category ?? null, preferenceKey: proposal?.input.metadata?.preferenceKey ?? null, scopeCorrect: extracted && scopeCorrect, sourceValid: extracted && sourceValid, reviewGated: !proposal || proposal.status === 'pending' || proposal.status === 'rejected', correctionOverride, jobStatus: job?.status ?? 'missing', outcome: job?.telemetry?.outcome ?? (job?.status === 'dead_letter' ? 'malformed' : 'none'), modelCalls: job?.telemetry?.modelCalls ?? 0, malformed: job?.telemetry?.malformed ?? 0, repairs: job?.telemetry?.repairs ?? 0, ...(job?.error ? { jobError: job.error } : {}), ...(proposal ? { claim: proposal.input.body, proposalStatus: proposal.status, flags: proposal.flags ?? [] } : {}) });
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
allRuns.push(rows);
}
const ratio = (n: number, d: number) => d ? n / d : 1;
/** Wilson 95% interval for a binomial proportion. */
const wilson = (n: number, d: number): [number, number] => { if (!d) return [0, 1]; const z = 1.96, p = n / d, den = 1 + z * z / d, c = p + z * z / (2 * d), m = z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d)); return [Math.max(0, (c - m) / den), Math.min(1, (c + m) / den)]; };
const rows = allRuns.flat();
const compute = (set: Array<Record<string, unknown>>) => {
  const counts = predictionCountsByCase(set.map(r => ({ expected: r.expected as 'insight' | 'none', predictions: Array.isArray(r.predictionMatches) ? r.predictionMatches as boolean[] : [] })));
  const { positives, negatives, truePositive: tp, truePositiveCases, falseNegative: fn, falsePositive: fp, predicted } = counts;
  const okJobs = set.filter(r => r.jobStatus === 'complete').length;
  return { counts: { total: set.length, ...counts },
    jobs: { attempted: set.length, completed: okJobs, proposals: set.filter(r => r.outcome === 'proposed').length, validAbstentions: set.filter(r => r.outcome === 'abstained').length, deadLettered: set.filter(r => r.jobStatus === 'dead_letter').length, providerFailures: set.filter(r => r.jobStatus !== 'complete' && r.jobStatus !== 'dead_letter').length, jobsWithMalformedResponse: set.filter(r => Number(r.malformed) > 0).length, malformedResponses: set.reduce((n, r) => n + Number(r.malformed), 0), repairRetries: set.reduce((n, r) => n + Number(r.repairs), 0), modelCalls: set.reduce((n, r) => n + Number(r.modelCalls), 0) },
    metrics: { precision: ratio(tp, predicted), recall: ratio(truePositiveCases, positives), falsePositiveRate: ratio(fp, negatives), jobSuccessRate: ratio(okJobs, set.length), scopeAccuracy: ratio(set.reduce((n, r) => n + (Array.isArray(r.predictions) ? (r.predictions as Array<{ scopeCorrect: boolean }>).filter(p => p.scopeCorrect).length : 0), 0), set.reduce((n, r) => n + Number(r.retainedPredictions ?? 0), 0)), evidenceGrounding: ratio(set.reduce((n, r) => n + (Array.isArray(r.predictions) ? (r.predictions as Array<{ sourceValid: boolean }>).filter(p => p.sourceValid).length : 0), 0), set.reduce((n, r) => n + Number(r.retainedPredictions ?? 0), 0)) },
    intervals95: { precision: wilson(tp, predicted), recall: wilson(truePositiveCases, positives), falsePositiveRate: wilson(fp, negatives), jobSuccessRate: wilson(okJobs, set.length) } };
};
const overall = compute(rows);
const v1Ids = new Set(corpus.cases.slice(0, 16).map(c => c.id));
const originalSubset = holdout ? null : compute(rows.filter(r => v1Ids.has(String(r.id))));
const perRun = allRuns.map(run => compute(run).metrics);
const counts = overall.counts;
const metrics = { ...overall.metrics, correctionOverride: rows.filter(r => r.id === 'explicit-correction').every(r => r.correctionOverride), sensitiveReviewCoveredByDeterministicSuite: true };
const thresholds = corpus.thresholds;
const thresholdPass = metrics.precision >= thresholds.precision && metrics.recall >= thresholds.recall && metrics.falsePositiveRate <= thresholds.falsePositiveRate && metrics.jobSuccessRate >= thresholds.jobSuccessRate && metrics.scopeAccuracy >= thresholds.scopeAccuracy && metrics.evidenceGrounding >= thresholds.evidenceGrounding && metrics.correctionOverride;
await fs.mkdir(RAW_OUTPUT_DIR, { recursive: true });
for (const [id, entries] of rawByCase) await fs.writeFile(path.join(RAW_OUTPUT_DIR, `${id}.json`), JSON.stringify({ case: id, note: 'Redacted local model responses for a synthetic case.', attempts: entries }, null, 2) + '\n');
const evidenceSource = await currentSourceEvidence();
const report = { status: thresholdPass ? 'PASS' : 'FAIL', command: `MDB_PROFILE_CORPUS=${corpusPath} MDB_TEST_PROVIDER=${providerName} MDB_TEST_MODEL=${modelName ?? '(CLI default)'} MDB_EVAL_RUNS=${RUNS} npm run eval:profile`, provider: provider.id, model: modelName ?? null, corpus: corpusPath, corpusVersion: corpus.version, holdout, rawResponses: RAW_OUTPUT_DIR, seeding: 'no sampling seed is exposed by the provider; stability is measured by repeated independent runs', runAt: new Date().toISOString(), thresholds, runs: RUNS, counts, jobs: overall.jobs, metrics, intervals95: overall.intervals95, originalV1Subset: originalSubset && { counts: originalSubset.counts, jobs: originalSubset.jobs, metrics: originalSubset.metrics }, perRunMetrics: perRun, cases: rows, evidenceSource, limitations: ['Synthetic corpus is reproducible but is not a sample of real users.', 'Term/category labels are explicit adjudication rules; extraction confidence is not calibrated to factual truth.', 'Sensitive-inference review remains protected by deterministic tests; this corpus does not evaluate sensitive-attribute classification.'] };
await fs.writeFile(holdout ? 'verification/profile/holdout-evaluation.json' : 'verification/profile/real-model-evaluation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!thresholdPass) process.exitCode = 1;
