import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { createProviderFromConfig } from '../packages/sdk/index.js';
import { buildPack } from './dream/pack.js';

/**
 * Opt-in integration test against a real model. Skipped unless MDB_REAL_MODEL_TEST=1.
 *   MDB_TEST_PROVIDER=claude-cli|codex-cli|auto|ollama|openai|openai-compatible   (default claude-cli)
 *   MDB_TEST_MODEL=<model name>                          (required for API providers, optional for CLIs)
 *   MDB_TEST_BASE_URL=<url>                              (optional; ollama defaults to http://127.0.0.1:11434/v1)
 *   MDB_TEST_API_KEY_ENV=<name of env var holding key>   (optional; openai defaults to OPENAI_API_KEY)
 *   MDB_TEST_ALLOW_NETWORK=1                             (required for any non-loopback endpoint)
 * Only synthetic content is sent. Assertions are structural (valid, evidence-bound, staged), never about prose quality.
 */
const enabled = process.env.MDB_REAL_MODEL_TEST === '1';
test('real model: wiki synthesis and critic return schema-valid, evidence-bound, review-gated output', { skip: enabled ? false : 'set MDB_REAL_MODEL_TEST=1 to run', timeout: 300_000 }, async t => {
  const providerName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli'; const modelName = process.env.MDB_TEST_MODEL; if (!/-cli$|^auto$/.test(providerName)) assert.ok(modelName, 'MDB_TEST_MODEL is required for API providers');
  const provider = createProviderFromConfig({ provider: providerName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(modelName ? { modelName } : {}), ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), ...(process.env.MDB_TEST_API_KEY_ENV ? { apiKeyEnv: process.env.MDB_TEST_API_KEY_ENV } : {}), timeoutMs: 240_000, maxRetries: 1 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-real-model-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root); await vault.init();
  const source = await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'source', title: '[SYNTHETIC] Caching note', body: 'A synthetic benchmark found that a warm cache cut median query time from 530 ms to 40 ms. The cold-cache case was not measured.' });
  const engine = new IntelligenceEngine(vault, provider);
  await engine.enqueue('wiki', { scope: { type: 'global', area: 'wiki' }, objectIds: [source.id] });
  const [job] = await engine.run({ job: 'wiki', limit: 1 });
  assert.equal(job?.status, 'complete', job?.error);
  assert.equal((await vault.listDocuments()).filter(doc => doc.kind === 'wiki_page').length, 0, 'staged, not committed');
  const [proposal] = await engine.proposals();
  assert.ok(proposal && proposal.input.evidence!.every(ev => ev.uri === source.uri && ev.revisionId === source.revisionId));
  assert.ok(proposal.critic, 'critic ran');
});

test('real model evaluation: labeled preference extraction and micro/deep/strategic cross-domain hypotheses', { skip: enabled ? false : 'set MDB_REAL_MODEL_TEST=1 to run', timeout: 600_000 }, async t => {
  const providerName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli'; const modelName = process.env.MDB_TEST_MODEL;
  const provider = createProviderFromConfig({ provider: providerName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(modelName ? { modelName } : {}), ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), ...(process.env.MDB_TEST_API_KEY_ENV ? { apiKeyEnv: process.env.MDB_TEST_API_KEY_ENV } : {}), timeoutMs: 240_000, maxRetries: 1 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-real-eval-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root); await vault.init();
  const cfg = await vault.config(); cfg.dream.enabled = true; cfg.dream.eventDriven = false; cfg.dream.modes = ['micro', 'deep', 'strategic']; cfg.dream.maxProposalsPerRun = 2; cfg.model.allowPrivateContentToRemote = true; await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(cfg));
  const pack = await buildPack(vault);
  // The evaluation sends only synthetic public-domain material to the real provider.
  for (const key of ['privApi', 'privDash']) await vault.delete(pack.ids[key]!, pack.docs[key]!.revisionId);
  const engine = new IntelligenceEngine(vault, provider);
  // A job that uses its whole model-call budget stops as "partial" (status pending) and is resumed by the next run, which is the product's designed behaviour; a verbose model needs that. Resume a bounded number of times, then judge.
  const runToCompletion = async (jobId: string) => { let job; for (let attempt = 0; attempt < 3; attempt++) { job = (await engine.run({ jobId }))[0]; if (job?.status !== 'pending') break; } return job; };
  await vault.createWorkspace('preference-eval', 'synthetic preference eval');
  const user = await vault.put({ scope: { type: 'workspace', workspaceId: 'preference-eval' }, kind: 'observation', title: '[SYNTHETIC] Labeled user preference', body: 'I prefer concise code review feedback with concrete tests run and a short explanation of tradeoffs. I dislike hard-coded environment-specific values. For this coding project, favor configurable defaults.', metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
  // Run exactly the job queued here: writing the pack documents also queued automatic jobs, and `run({ job, limit: 1 })` would take the oldest pending one instead (a different document, possibly retried by a weaker model).
  const queuedProfile = await engine.enqueue('profile', { scope: { type: 'workspace', workspaceId: 'preference-eval' }, objectIds: [user.id], instruction: 'Labeled target: preferences concise feedback, tests, explain tradeoffs, avoid hard-coded environment values; scope project only.' });
  const profileJob = await runToCompletion(queuedProfile.id); assert.equal(profileJob?.status, 'complete', `${profileJob?.status}: ${profileJob?.error ?? JSON.stringify(profileJob?.telemetry)}`);
  const profileProposal = (await engine.proposals()).find(p => p.input.kind === 'user_insight'); assert.ok(profileProposal, 'real model extracted an insight');
  assert.ok(profileProposal.input.evidence?.some(e => e.uri === user.uri && e.revisionId === user.revisionId), 'preference evidence points to the labeled source revision');
  assert.equal(profileProposal.input.metadata?.scopeLabel, 'preference-eval'); assert.equal(profileProposal.status, 'pending', 'extraction remains review gated');
  const insightText = `${profileProposal.input.title} ${profileProposal.input.body}`.toLowerCase();
  const preferenceLabels = { conciseFeedback: /concise|brief|short/.test(insightText), tests: /test|verify|validation/.test(insightText), avoidHardCoding: /hard.?cod|environment|configurable/.test(insightText), tradeoffs: /trade.?off|decision|reason/.test(insightText) };
  const scores: Record<string, unknown> = { dataset: 'synthetic-labeled-preference-and-five-domain-pack-v1', preference: { ...preferenceLabels, evidenceGrounded: true, scopeCorrect: true, reviewGated: true, extractedCategory: profileProposal.input.metadata?.category } };
  for (const mode of ['micro', 'deep', 'strategic'] as const) {
    const input = mode === 'micro' ? { mode, objectIds: [pack.ids.pyApi!, pack.ids.jsDash!] } : { mode };
    const queuedDream = await engine.enqueue('dream', { ...input, instruction: `real-eval-${mode}-${Date.now()}` });
    const job = await runToCompletion(queuedDream.id); assert.equal(job?.status, 'complete', `${mode}: ${job?.status} ${job?.error ?? JSON.stringify(job?.telemetry)}`);
    const proposal = (await engine.proposals()).filter(p => p.input.kind === 'discovery' && p.input.metadata?.mode === mode).at(-1);
    if (!proposal) { scores[mode] = { outcome: 'no_candidate', trace: job?.trace, note: 'retrieval produced no model candidate for this labeled scenario' }; continue; }
    const cited = new Set(proposal.input.evidence?.map(e => `${e.uri}\0${e.revisionId}`));
    assert.ok(proposal.input.evidence!.length >= 2 && proposal.input.evidence!.every(e => cited.has(`${e.uri}\0${e.revisionId}`)), `${mode} output carries evidence references`);
    assert.ok(proposal.input.evidence!.every(e => !e.uri.includes('/workspaces/private/')), `${mode} does not cite inaccessible private pack records`);
    assert.ok(['hypothesis', 'candidate'].includes(proposal.input.status ?? 'hypothesis'), `${mode} remains speculative`);
    scores[mode] = { status: proposal.status, evidenceCount: proposal.input.evidence?.length, critic: proposal.critic?.verdict, flags: proposal.flags ?? [], speculativeStatus: proposal.input.status ?? 'hypothesis' };
  }
  console.log(`REAL_MODEL_EVAL ${JSON.stringify({ provider: provider.id, scores })}`);
});
