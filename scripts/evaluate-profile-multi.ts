import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { createProviderFromConfig } from '../packages/models/factory.js';
import { IntelligenceEngine, PROFILE_MAX_INSIGHTS, type JobTelemetry } from '../packages/intelligence/index.js';
import { inputPath } from './lib/suite.js';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { assertedTermsHit } from './lib/profile-metrics.js';

/**
 * Labeled precision/recall of multi-insight extraction (synthetic batches only). Private conversation data is never used here, and a
 * provider that is not explicitly configured and local is refused: set MDB_TEST_PROVIDER (ollama | openai-compatible on loopback) and MDB_TEST_MODEL.
 */
type Case = { id: string; text: string; gold: string[][]; forbid?: string[][] };
const corpus = JSON.parse(await fs.readFile(inputPath('profile/multi-corpus.json'), 'utf8')) as { version: number; cases: Case[] };
const providerName = process.env.MDB_TEST_PROVIDER, modelName = process.env.MDB_TEST_MODEL;
if (!providerName || !modelName) throw new Error('Explicit local model configuration required: set MDB_TEST_PROVIDER (ollama or openai-compatible) and MDB_TEST_MODEL; no default provider is used for conversation-like data');
const provider = createProviderFromConfig({ provider: providerName, allowNetwork: false, modelName, ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), maxOutputTokens: Number(process.env.MDB_TEST_MAX_OUTPUT ?? 8000), timeoutMs: 300000 });
if (provider.locality !== 'local') throw new Error(`Provider ${provider.id} is not local; refusing to send evaluation text to it`);
const rawOutputDir = path.join('verification/profile/multi-raw-responses', new Date().toISOString().replace(/[:.]/g, '-'));
const safeRaw = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(safeRaw);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeRaw(v)]));
  return value;
};
let rawCalls: Array<Record<string, unknown>> = [];
const generate = provider.generate.bind(provider);
provider.generate = async request => {
  try { const response = await generate(request); rawCalls.push({ request, response }); return response; }
  catch (error) { const e = error as { code?: string; message?: string }; rawCalls.push({ request, error: { code: e.code, message: e.message } }); throw error; }
};
const hit = assertedTermsHit;
const rows: Array<Record<string, unknown>> = [];
for (const item of corpus.cases) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-multi-eval-'));
  try {
    rawCalls = [];
    const vault = new Vault(root); await vault.init(); await vault.createWorkspace('orion', 'Synthetic multi-insight evaluation');
    const config = await vault.config(); config.model.critic = false; await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
    const scope = { type: 'workspace' as const, workspaceId: 'orion' };
    const source = await vault.put({ scope, kind: 'observation', title: `[SYNTHETIC EVAL] ${item.id}`, body: item.text, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', evaluationCase: item.id } });
    const timed = new IntelligenceEngine(vault, provider);
    const batches: Array<{ batch: number; status: string; telemetry?: JobTelemetry }> = [];
    const afterJobs: number[] = [];
    for (let job = 1; job <= 2; job++) {
      const queued = await timed.enqueue('profile', { scope, objectIds: [source.id], instruction: `job ${job}` });
      const [finished] = await timed.run({ job: 'profile', jobId: queued.id, limit: 1 });
      if (!finished) throw new Error(`Evaluation batch ${job} did not execute`);
      batches.push({ batch: job, status: finished.status, telemetry: finished.telemetry });
      const mine = (await timed.proposals()).filter(p => p.input.kind === 'user_insight' && p.status !== 'rejected' && p.input.evidence?.some(e => e.uri === source.uri));
      afterJobs.push(gold(mine.map(p => `${p.input.title} ${p.input.body}`.toLowerCase()), item).matchedGold);
    }
    const proposals = (await timed.proposals()).filter(p => p.input.kind === 'user_insight' && p.status !== 'rejected' && p.input.evidence?.some(e => e.uri === source.uri));
    const claims = proposals.map(p => `${p.input.title} ${p.input.body}`.toLowerCase());
    const grounded = proposals.filter(p => p.input.evidence!.every(e => typeof e.span === 'string' && item.text.includes(e.span))).length;
    const result = gold(claims, item);
    const rawFile = path.join(rawOutputDir, `${item.id}.json`); await fs.mkdir(rawOutputDir, { recursive: true }); await fs.writeFile(rawFile, JSON.stringify(safeRaw({ case: item.id, note: 'Synthetic multi-insight model request/response evidence; local provider only.', calls: rawCalls }), null, 2) + '\n');
    rows.push({ id: item.id, goldCount: item.gold.length, proposals: claims.length, truePositive: result.matchedGold, falsePositive: result.falsePositive, forbidden: result.forbidden, afterOneJob: afterJobs[0], afterTwoJobs: afterJobs[1], grounded, allPending: proposals.every(p => p.status === 'pending'), modelCalls: batches.reduce((sum, b) => sum + (b.telemetry?.modelCalls ?? 0), 0), retries: batches.reduce((sum, b) => sum + (b.telemetry?.retries ?? 0), 0), tokens: { input: batches.reduce((sum, b) => sum + (b.telemetry?.tokens?.input ?? 0), 0), output: batches.reduce((sum, b) => sum + (b.telemetry?.tokens?.output ?? 0), 0), reported: batches.some(b => b.telemetry?.tokens?.reported === true) }, batches, claims, rawEvidence: rawFile });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function gold(claims: string[], item: Case) {
  const matchedClaim = new Map<number, number>();
  const assign = (claimIndex: number, seen: Set<number>): boolean => {
    for (let goldIndex = 0; goldIndex < item.gold.length; goldIndex++) {
      if (seen.has(goldIndex) || !hit(claims[claimIndex]!, item.gold[goldIndex]!)) continue;
      seen.add(goldIndex);
      const previous = [...matchedClaim].find(([, existingClaim]) => existingClaim === goldIndex)?.[0];
      if (previous === undefined || assign(previous, seen)) { matchedClaim.set(claimIndex, goldIndex); return true; }
    }
    return false;
  };
  for (let claimIndex = 0; claimIndex < claims.length; claimIndex++) assign(claimIndex, new Set());
  const matchedGold = matchedClaim.size;
  const forbidden = claims.filter(c => (item.forbid ?? []).some(terms => hit(c, terms))).length;
  return { matchedGold, forbidden, falsePositive: claims.length - matchedClaim.size };
}
const sum = (key: string) => rows.reduce((n, r) => n + Number(r[key]), 0);
const tp = sum('truePositive'), goldTotal = sum('goldCount'), proposed = sum('proposals'), fp = sum('falsePositive');
const evidenceSource = await currentSourceEvidence();
const report = { provider: provider.id, model: modelName, command: `MDB_TEST_PROVIDER=${providerName} MDB_TEST_MODEL=${modelName} npm run eval:profile-multi`, corpus: 'fixtures/inputs/profile/multi-corpus.json', corpusVersion: corpus.version, cases: rows.length, maxInsightsPerJob: PROFILE_MAX_INSIGHTS, rawResponses: rawOutputDir, evidenceSource,
  metrics: { precision: proposed ? (proposed - fp) / proposed : 1, recall: goldTotal ? tp / goldTotal : 1, recallAfterOneJob: goldTotal ? sum('afterOneJob') / goldTotal : 1, proposals: proposed, goldInsights: goldTotal, falsePositives: fp, forbiddenProposals: sum('forbidden'), groundedProposals: sum('grounded'), reviewGated: rows.every(r => r.allPending), meanModelCallsPerCase: sum('modelCalls') / rows.length }, rows };
await fs.mkdir('verification/profile', { recursive: true });
await fs.writeFile('verification/profile/multi-insight-evaluation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: rows.map(({ claims, ...r }) => ({ ...r, claims })) }, null, 2));
