import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { createProviderFromConfig } from '../packages/models/factory.js';
import { IntelligenceEngine, PROFILE_MAX_INSIGHTS } from '../packages/intelligence/index.js';
import { inputPath } from './lib/suite.js';

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
const hit = (claim: string, terms: string[]) => terms.every(t => claim.includes(t.toLowerCase()));
const rows: Array<Record<string, unknown>> = [];
for (const item of corpus.cases) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-multi-eval-'));
  try {
    const vault = new Vault(root); await vault.init(); await vault.createWorkspace('orion', 'Synthetic multi-insight evaluation');
    const config = await vault.config(); config.model.critic = false; await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
    const scope = { type: 'workspace' as const, workspaceId: 'orion' };
    const source = await vault.put({ scope, kind: 'observation', title: `[SYNTHETIC EVAL] ${item.id}`, body: item.text, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', evaluationCase: item.id } });
    const engine = new IntelligenceEngine(vault, provider); let calls = 0; const wrapped = { ...provider, id: provider.id, locality: provider.locality, generate: (...a: Parameters<typeof provider.generate>) => { calls++; return provider.generate(...a); } };
    const timed = new IntelligenceEngine(vault, wrapped); void engine;
    const afterJobs: number[] = [];
    for (let job = 1; job <= 2; job++) {
      await timed.enqueue('profile', { scope, objectIds: [source.id], instruction: `job ${job}` }); await timed.run({ job: 'profile', limit: 1 });
      const mine = (await timed.proposals()).filter(p => p.input.kind === 'user_insight' && p.status !== 'rejected' && p.input.evidence?.some(e => e.uri === source.uri));
      afterJobs.push(gold(mine.map(p => `${p.input.title} ${p.input.body}`.toLowerCase()), item).matchedGold);
    }
    const proposals = (await timed.proposals()).filter(p => p.input.kind === 'user_insight' && p.status !== 'rejected' && p.input.evidence?.some(e => e.uri === source.uri));
    const claims = proposals.map(p => `${p.input.title} ${p.input.body}`.toLowerCase());
    const grounded = proposals.filter(p => p.input.evidence!.every(e => typeof e.span === 'string' && item.text.includes(e.span))).length;
    const result = gold(claims, item);
    rows.push({ id: item.id, goldCount: item.gold.length, proposals: claims.length, truePositive: result.matchedGold, falsePositive: result.falsePositive, forbidden: result.forbidden, afterOneJob: afterJobs[0], afterTwoJobs: afterJobs[1], grounded, allPending: proposals.every(p => p.status === 'pending'), modelCalls: calls, claims });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function gold(claims: string[], item: Case) {
  const matchedGold = item.gold.filter(terms => claims.some(c => hit(c, terms))).length;
  const forbidden = claims.filter(c => (item.forbid ?? []).some(terms => hit(c, terms))).length;
  const supported = claims.filter(c => item.gold.some(terms => hit(c, terms))).length;
  return { matchedGold, forbidden, falsePositive: claims.length - supported };
}
const sum = (key: string) => rows.reduce((n, r) => n + Number(r[key]), 0);
const tp = sum('truePositive'), goldTotal = sum('goldCount'), proposed = sum('proposals'), fp = sum('falsePositive');
const report = { provider: provider.id, corpus: 'fixtures/inputs/profile/multi-corpus.json', corpusVersion: corpus.version, cases: rows.length, maxInsightsPerJob: PROFILE_MAX_INSIGHTS,
  metrics: { precision: proposed ? (proposed - fp) / proposed : 1, recall: goldTotal ? tp / goldTotal : 1, recallAfterOneJob: goldTotal ? sum('afterOneJob') / goldTotal : 1, proposals: proposed, goldInsights: goldTotal, falsePositives: fp, forbiddenProposals: sum('forbidden'), groundedProposals: sum('grounded'), reviewGated: rows.every(r => r.allPending), meanModelCallsPerCase: sum('modelCalls') / rows.length }, rows };
await fs.mkdir('verification/profile', { recursive: true });
await fs.writeFile('verification/profile/multi-insight-evaluation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: rows.map(({ claims, ...r }) => ({ ...r, claims })) }, null, 2));
