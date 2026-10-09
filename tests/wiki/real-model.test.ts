import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { createProviderFromConfig } from '../../packages/sdk/index.js';

/**
 * Opt-in (MDB_REAL_MODEL_TEST=1; provider via MDB_TEST_PROVIDER, default claude-cli). Synthetic text only.
 * The hard assertions are the safety invariants: whatever the model writes, nothing uncited, mis-targeted or unreviewed is committed and sources are untouched.
 * Whether the model produced a rule-compliant page is recorded, not required: model quality is evaluated separately from the deterministic gates.
 */
const enabled = process.env.MDB_REAL_MODEL_TEST === '1';
test('real model: incremental wiki compilation obeys the safety gates (and we record whether it also complied with the citation rules)', { skip: enabled ? false : 'set MDB_REAL_MODEL_TEST=1 to run', timeout: 600_000 }, async t => {
  const providerName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli';
  const provider = createProviderFromConfig({ provider: providerName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(process.env.MDB_TEST_MODEL ? { modelName: process.env.MDB_TEST_MODEL } : {}), timeoutMs: 300_000, maxRetries: 1 });
  const { root, vault } = await disposableVault(t); const wiki = { type: 'global' as const, area: 'wiki' as const };
  const ingest = async (name: string, text: string) => { const file = path.join(root, `${name}.md`); await fs.writeFile(file, text); return vault.ingest(file, wiki); };
  const first = await ingest('cache-basics', '# Cache basics\n\nA synthetic benchmark found a warm cache cut median query time from 530 ms to 40 ms. The cold-cache case was not measured.\n');
  const engine = new IntelligenceEngine(vault, provider);
  const outcome: Record<string, unknown> = { provider: providerName };
  await engine.enqueue('wiki', { scope: wiki, objectIds: [first.id] }); const r1 = await engine.run({ job: 'wiki', limit: 1 });
  assert.equal(r1[0]!.status, 'complete', r1[0]!.error);
  let proposals = await engine.proposals(); const p1 = proposals.at(-1)!; outcome.firstCompile = p1.status; outcome.firstReason = p1.reason ?? null;
  assert.equal((await vault.listDocuments()).filter(d => d.kind === 'wiki_page').length, 0, 'nothing is committed before review');
  if (p1.status === 'pending') { assert.ok(/\[\d+\]/.test(p1.input.body) || /\(inference\)/i.test(p1.input.body)); await engine.review(p1.id, true, 'real-model test'); }
  else assert.ok(p1.flags?.length, 'a refused page has a recorded reason');
  const second = await ingest('cache-ttl', '# Cache TTL\n\nA synthetic follow-up found that a 60 second time to live kept the warm cache hit rate above 90 percent.\n');
  await engine.enqueue('wiki', { scope: wiki, objectIds: [second.id] }); const r2 = await engine.run({ job: 'wiki', limit: 1 });
  assert.equal(r2[0]!.status === 'complete' || r2[0]!.status === 'dead_letter', true);
  proposals = await engine.proposals(); const p2 = proposals.at(-1)!; outcome.secondCompile = r2[0]!.status === 'complete' ? p2.status : 'dead_letter'; outcome.secondTarget = p2.input.metadata?.targetPageId ?? null;
  if (r2[0]!.status === 'complete' && p2.status === 'pending' && p1.status === 'pending') { await engine.review(p2.id, true); const pages = (await vault.listDocuments()).filter(d => d.kind === 'wiki_page'); outcome.pages = pages.length; outcome.updatedInPlace = pages.some(p => p.revisionNumber > 1); }
  for (const doc of [first, second]) assert.equal((await fs.readFile(path.join(root, String(doc.metadata.originalPath)), 'utf8')).includes('synthetic'), true, 'originals untouched');
  assert.equal((await vault.verify()).ok, true);
  for (const page of (await vault.listDocuments()).filter(d => d.kind === 'wiki_page')) assert.ok(page.links.every(l => l.type === 'derived_from') && page.links.length >= 1, 'every committed page has dependency edges');
  recordCase({ suite: 'wiki', name: 'real-model-compile', status: 'PASS', detail: outcome });
  console.log('REAL-MODEL OUTCOME', JSON.stringify(outcome));
});
