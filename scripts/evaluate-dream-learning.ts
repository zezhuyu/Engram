import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OWNER, type Scope } from '../packages/core/types.js';
import { Vault } from '../packages/core/vault.js';
import type { ManifestEntry } from '../packages/search-files/manifest.js';
import { planDeep, rngFrom } from '../packages/intelligence/dream/plan.js';
import { appendFeedback, learnedParams, learnedSuccess, rateDiscovery, resetLearning } from '../packages/intelligence/dream/learning.js';
import { familyOf, readStats, recordFeedback } from '../packages/intelligence/dream/lifecycle.js';

/**
 * Temporal-holdout evaluation of the Dream feedback loop (deterministic, no model).
 *   TRAIN scenarios come first: the planner picks candidate pairs, a simulated reviewer gives human feedback by a hidden ground truth.
 *   TEST scenarios are LATER and entirely new objects (new ids, new bridge words) in the same domain families, so no example is used for both
 *   training and testing. The metric is precision@K: the share of selected candidate pairs whose family the reviewer values.
 * Controls: model-sourced feedback with the REVERSED truth must change nothing; after a restart (new Vault instance) selection must be identical;
 * after a reset selection must return to the baseline.
 * The acceptance rule below is this evaluation's own (proposed) rule, not a product performance threshold.
 */
const SEEDS = Number(process.env.MDB_LEARN_SEEDS ?? 10), TRAIN = 4, TEST = 20, K = 3;
const DOMAINS = ['kitchen', 'orbit', 'garden', 'finance', 'music', 'maritime']; const FAMILIES = DOMAINS.flatMap((a, i) => DOMAINS.slice(i + 1).map(b => [a, b] as const)).slice(0, 8);
const famKey = (a: string, b: string) => `deep|${[a, b].sort().join('+')}`;
const wiki: Scope = { type: 'global', area: 'wiki' };
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };

function pool(scenario: string, rnd: () => number): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const [a, b] of FAMILIES) {
    const bridge = `bridge${createHash('sha256').update(`${scenario}:${a}:${b}:${rnd()}`).digest('hex').slice(0, 10)}`.replace(/[0-9]/g, c => 'qwertzuiop'[Number(c)]!);
    for (const d of [a, b]) entries.push({ id: `${scenario}-${d}-${a}${b}`, rev: 'r1', first: 1, last: 1, scope: wiki, sk: 'global:wiki', kind: 'wiki_page', title: `item ${scenario} ${d} ${bridge}x`, tags: [`domain:${d}`, bridge], status: 'active', updated: '2027-01-01T00:00:00Z', at: '2027-01-01T00:00:00Z', refs: [], dom: d } as ManifestEntry);
  }
  return entries;
}
const select = (entries: ManifestEntry[], success: (f: string) => number, seed: string): string[] => {
  const { clusters } = planDeep({ pool: entries, graph: { out: () => [], in: () => [] }, budgets: { maxObjects: 24, maxClusters: K, maxPerCluster: 4 }, rng: rngFrom(seed), success, suppressed: () => false }, 0);
  return clusters.map(c => famKey(...(c.hints[0]!.domains as [string, string])));
};

async function evaluateSeed(seed: number) {
  const rnd = rngFrom(`truth-${seed}`); const valuable = new Set(FAMILIES.map(([a, b]) => ({ k: famKey(a, b), r: rnd() })).sort((x, y) => x.r - y.r).slice(0, FAMILIES.length / 2).map(x => x.k));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-learning-')); const vault = new Vault(root); await vault.init();
  const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'experiment record', body: 'recorded outcome' });
  const control = new Vault(await fs.mkdtemp(path.join(os.tmpdir(), 'engram-learning-ctl-'))); await control.init();
  const discovery = async (v: Vault, family: string) => { const [, domains] = family.split('|'); return v.put({ scope: wiki, kind: 'discovery', status: 'candidate', title: `hypothesis ${family} ${Math.random().toString(36).slice(2, 8)}`, body: 'generated hypothesis', metadata: { mode: 'deep', domains: domains!.split('+') } }); };
  const precision = async (v: Vault | undefined, scenarios: string[], successOverride?: (f: string) => number) => {
    const success = successOverride ?? (v ? await learnedSuccess(v, await readStats(v)) : () => 0.5); const per: number[] = [];
    for (const s of scenarios) { const picked = select(pool(s, rngFrom(s)), success, s); per.push(picked.length ? picked.filter(f => valuable.has(f)).length / picked.length : 0); }
    return mean(per);
  };
  const tests = Array.from({ length: TEST }, (_, i) => `test-${seed}-${i}`);
  const baseline = await precision(undefined, tests);
  // TRAIN: earlier scenarios, human feedback on what the planner picked (the first picks are arbitrary, then follow what has been learned).
  let trainFeedback = 0;
  for (let i = 0; i < TRAIN; i++) {
    const s = `train-${seed}-${i}`; const picked = select(pool(s, rngFrom(s)), await learnedSuccess(vault, await readStats(vault)), s);
    for (const [j, family] of picked.entries()) {
      const doc = await discovery(vault, family); const good = valuable.has(family);
      if (j % 2 === 0) await recordFeedback(vault, doc.id, good ? { outcome: 'validated', validatedBy: 'user', origin: 'simulated-reviewer', note: 'reviewer confirmed', evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }] } : { outcome: 'rejected', origin: 'simulated-reviewer', note: 'reviewer rejected' });
      else await rateDiscovery(vault, doc.id, { label: good ? 'useful' : 'not_useful', origin: 'simulated-reviewer', note: 'reviewer rating' });
      trainFeedback++;
    }
  }
  // Control: a model labels the same kinds of candidates with the REVERSED truth; none of it may count.
  for (let i = 0; i < TRAIN; i++) for (const family of select(pool(`train-${seed}-${i}`, rngFrom(`train-${seed}-${i}`)), () => 0.5, `train-${seed}-${i}`)) { const doc = await discovery(control, family); await rateDiscovery(control, doc.id, { label: valuable.has(family) ? 'not_useful' : 'useful', note: 'model self-assessment', source: 'model' }); }
  const learned = await precision(vault, tests); const modelOnly = await precision(control, tests);
  const restarted = await precision(new Vault(root), tests);
  const before = await learnedParams(vault); await resetLearning(vault, 'evaluation reset'); const afterReset = await precision(vault, tests);
  const rolledBack = await learnedParams(vault, { asOfVersion: before.version });
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(control.root, { recursive: true, force: true });
  return { seed, valuableFamilies: [...valuable].sort(), baseline, learned, modelOnly, restarted, afterReset, trainFeedback, paramsVersion: before.version, rollbackReproduces: JSON.stringify(rolledBack.families) === JSON.stringify(before.families) };
}

const runs = []; for (let seed = 1; seed <= SEEDS; seed++) runs.push(await evaluateSeed(seed));
const gains = runs.map(r => r.learned - r.baseline); const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const checks = {
  meanGain: { value: +mean(gains).toFixed(4), required: '>= 0.15', pass: mean(gains) >= 0.15 },
  seedsNotWorse: { value: gains.filter(g => g >= 0).length / runs.length, required: '>= 0.8', pass: gains.filter(g => g >= 0).length / runs.length >= 0.8 },
  modelFeedbackIgnored: { value: runs.every(r => near(r.modelOnly, r.baseline)), required: 'model-only feedback leaves precision at baseline', pass: runs.every(r => near(r.modelOnly, r.baseline)) },
  survivesRestart: { value: runs.every(r => near(r.restarted, r.learned)), required: 'identical after a new Vault instance', pass: runs.every(r => near(r.restarted, r.learned)) },
  resetRestoresBaseline: { value: runs.every(r => near(r.afterReset, r.baseline)), required: 'reset returns to the baseline', pass: runs.every(r => near(r.afterReset, r.baseline)) },
  rollbackReproducible: { value: runs.every(r => r.rollbackReproduces), required: 'asOfVersion reproduces earlier parameters', pass: runs.every(r => r.rollbackReproduces) }
};
const status = Object.values(checks).every(c => c.pass) ? 'PASS' : 'FAIL';
const id = new Date().toISOString().replace(/[:.]/g, '-');
const report = { id, status, method: 'temporal holdout; train and test scenarios share domain families but no objects', seeds: SEEDS, trainScenariosPerSeed: TRAIN, testScenariosPerSeed: TEST, clustersPerScenario: K,
  precisionAtK: { baselineMean: +mean(runs.map(r => r.baseline)).toFixed(4), learnedMean: +mean(runs.map(r => r.learned)).toFixed(4), gainMean: +mean(gains).toFixed(4), gainStdDev: +sd(gains).toFixed(4), min: +Math.min(...gains).toFixed(4), max: +Math.max(...gains).toFixed(4) },
  checks, acceptanceRule: 'Proposed by this evaluation (not a product threshold): mean gain >= 0.15, >= 80% of seeds not worse, model feedback ignored, restart-stable, reset-to-baseline, rollback reproducible.',
  limitations: ['Synthetic pools and a simulated reviewer; it proves the feedback loop changes selection in the right direction and persists, not that real users will find the discoveries more useful.', 'No model call: candidate generation and the critic are covered by eval:dream.'], perSeed: runs };
await fs.mkdir('verification/dream', { recursive: true });
await fs.writeFile(`verification/dream/learning-${id}.json`, JSON.stringify(report, null, 2) + '\n'); await fs.writeFile('verification/dream/learning-latest.json', JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(`verification/dream/learning-${id}.md`, `# Dream learning evaluation ${id}\n\nStatus: **${status}**\n\n${report.method}.\n\n| Metric | Value |\n|---|---|\n| precision@${K} baseline | ${report.precisionAtK.baselineMean} |\n| precision@${K} after feedback | ${report.precisionAtK.learnedMean} |\n| mean gain (sd) | ${report.precisionAtK.gainMean} (${report.precisionAtK.gainStdDev}) |\n\n${Object.entries(checks).map(([k, c]) => `- ${c.pass ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(c.value)} (required ${c.required})`).join('\n')}\n\n${report.acceptanceRule}\n\nLimitations:\n${report.limitations.map(l => `- ${l}`).join('\n')}\n`);
console.log(JSON.stringify({ status, precisionAtK: report.precisionAtK, checks: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.pass])) }, null, 1));
process.exitCode = status === 'PASS' ? 0 : 1; void OWNER; void appendFeedback; void familyOf;
