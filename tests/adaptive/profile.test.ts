import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPack } from '../dream/pack.js';
import { recordCase } from '../helpers/report.js';
import { world } from './helpers.js';

const insights = async (w: Awaited<ReturnType<typeof world>>) => (await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.insightSchema === 1);

test('workspace preferences stay scoped; conflicting workspace preferences are preserved, never flattened into a global one', async t => {
  const w = await world(t); await buildPack(w.vault);
  await w.say('alpha', 'I prefer TypeScript for this project [key:language]'); await w.say('beta', 'I prefer Python for this project [key:language]');
  const c = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'scoped-1', respectActivity: false })).cycle!; assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  const docs = (await insights(w)).filter(d => d.metadata.preferenceKey === 'language'); const labels = docs.map(d => d.metadata.scopeLabel).sort();
  assert.deepEqual(labels, ['alpha', 'beta'], 'each workspace keeps its own scoped insight with its scope label'); assert.ok(!docs.some(d => d.metadata.scopeLabel === 'global'));
  assert.ok(docs.every(d => d.status === 'accepted' && d.evidence.length >= 1 && d.metadata.sources), 'exact source revisions are kept');
  assert.ok(c.global.preservedConflicts.includes('language'), 'the conflict is recorded'); assert.ok(c.global.promotions.some(p => p.preferenceKey === 'language' && p.status === 'SKIPPED_CONFLICT'));
  const profile = await fs.readFile(path.join(w.root, 'PROFILE.md'), 'utf8'); assert.match(profile, /Workspace: alpha/); assert.match(profile, /Workspace: beta/); const globalSection = /### Global\n([\s\S]*?)(?=\n### |$)/.exec(profile)?.[1] ?? ''; assert.ok(!/TypeScript|Python/.test(globalSection), 'neither workspace preference appears in the global section');
  recordCase({ suite: 'adaptive', name: 'scoped-insights-not-flattened', status: 'PASS' });
});

test('the same preference supported in two workspaces becomes a review-gated global promotion proposal, not an automatic global truth', async t => {
  const w = await world(t); await buildPack(w.vault);
  await w.say('alpha', 'I prefer concise answers everywhere [key:style]'); await w.say('beta', 'I prefer concise answers everywhere [key:style]');
  const c = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'promo-1', respectActivity: false })).cycle!; assert.equal(c.state, 'COMPLETED', JSON.stringify(c.error));
  const promo = c.global.promotions.find(p => p.preferenceKey === 'style'); assert.equal(promo?.status, 'PROPOSED'); assert.deepEqual(promo!.workspaces.sort(), ['alpha', 'beta']);
  assert.ok(!(await insights(w)).some(d => d.metadata.preferenceKey === 'style' && d.metadata.scopeLabel === 'global'), 'nothing global is committed without review');
  assert.ok(c.global.pendingReview.includes(promo!.proposalId!), 'pending review');
  const acceptedIds = [...c.workspaces.alpha!.accepted, ...c.workspaces.beta!.accepted].map(o => `${o.objectId}@${o.revisionId}`); assert.equal(acceptedIds.length, 2); assert.ok(c.global.roots && acceptedIds.every(id => c.global.roots!.acceptedInsightRevisions.some(r => `${r.objectId}@${r.revisionId}` === id)), 'the root manifest lists the accepted workspace insight revisions'); assert.notEqual(c.global.roots.PROFILE, 'absent');
  recordCase({ suite: 'adaptive', name: 'global-promotion-review-gated', status: 'PASS' });
});

test('with nothing eligible anywhere, global consolidation still checkpoints a root manifest and Dream still explores historical knowledge', async t => {
  const w = await world(t); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  const first = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'idle-1', respectActivity: false })).cycle!; assert.equal(first.state, 'COMPLETED');
  const dreamCallsBefore = w.provider.dreamCalls().length; const second = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'idle-2', respectActivity: false })).cycle!;
  assert.equal(second.state, 'COMPLETED', JSON.stringify(second.error)); assert.ok(Object.values(second.workspaces).every(x => x.outcome === 'NO_ELIGIBLE_CHANGES'), 'zero-change workspaces are explicit successes');
  assert.equal(second.global.status, 'SUCCEEDED'); assert.ok(second.global.roots, 'root manifest is checkpointed even when nothing changed'); assert.equal(second.global.roots!.PROFILE, first.global.roots!.PROFILE, 'idempotent root content');
  assert.ok(w.provider.dreamCalls().length > dreamCallsBefore, 'Dream ran over the authorized corpus although no workspace was active'); assert.equal(second.dream.status, 'SUCCEEDED');
  recordCase({ suite: 'adaptive', name: 'no-active-workspace-dream-explores', status: 'PASS' });
});

test('Dream reads inactive workspaces and root knowledge at or before W, and records the corpus visibility manifest', async t => {
  const w = await world(t, { workspaces: ['alpha', 'dormant'] });
  const py = await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Python JSON APIs', body: 'Python services expose JSON over HTTP using FastAPI.', tags: ['domain:python-api', 'api', 'json', 'provides:json'] });
  const old = await w.vault.put({ scope: { type: 'workspace', workspaceId: 'dormant' }, kind: 'wiki_page', title: 'Old dashboard notes', body: 'Browser dashboards consume JSON through fetch and render widgets.', tags: ['domain:js-frontend', 'dashboard', 'consumes:json'] });
  await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'corpus-0', respectActivity: false, stopAfter: 'workspaces' });
  await w.say('alpha', 'I prefer TypeScript for services [key:lang]'); const c = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'corpus-1', respectActivity: false })).cycle!; assert.equal(c.state, 'COMPLETED', JSON.stringify({ e: c.error, d: c.dream.error }));
  assert.equal(c.workspaces.dormant!.outcome, 'NO_ELIGIBLE_CHANGES'); const seen = new Set(w.provider.dreamCalls().flatMap(call => call.documents.map(d => d.id)));
  assert.ok(seen.has(old.id) && seen.has(py.id), 'a dormant workspace\'s historical page and a global root page both reach Dream');
  assert.ok(c.dream.corpusVisibility!.eligibleScopes.includes('workspace:dormant') && c.dream.corpusVisibility!.eligibleObjects > 0);
  const proposals = c.dream.proposals; assert.ok(proposals.length >= 1); assert.ok(proposals.every(p => p.evidence.length >= 2), 'per-dream evidence manifest lists exact source revisions');
  recordCase({ suite: 'adaptive', name: 'dream-full-corpus', status: 'PASS' });
});
