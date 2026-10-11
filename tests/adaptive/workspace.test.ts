import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPack } from '../dream/pack.js';
import { recordCase } from '../helpers/report.js';
import { world, ws } from './helpers.js';
import { Vault } from '../../packages/core/vault.js';
import { AdaptiveIntelligence } from '../../packages/adaptive/index.js';
import { readableEntries, loadDocuments } from '../../packages/intelligence/corpus.js';

const summariesOf = async (vault: Awaited<ReturnType<typeof world>>['vault'], workspaceId: string) => (await vault.listDocuments()).filter(d => d.kind === 'workspace_daily_summary' && d.scope.type === 'workspace' && d.scope.workspaceId === workspaceId);

test('multiple active workspaces get evidence-linked summaries; an inactive workspace is an explicit NO_ELIGIBLE_CHANGES success; no cross-workspace text leaks', async t => {
  const w = await world(t, { workspaces: ['alpha', 'beta', 'gamma'] });
  const a1 = await w.note('alpha', 'note', 'Alpha design note', 'ALPHASECRET design uses a token bucket'); await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  await w.note('beta', 'decision', 'Beta decision', 'BETASECRET choose Postgres for storage'); await w.say('beta', 'I prefer Python for scripts [key:lang]');
  const cycle = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'ws-1', respectActivity: false })).cycle!; assert.equal(cycle.state, 'COMPLETED', JSON.stringify(cycle.error));
  assert.equal(cycle.workspaces.gamma!.outcome, 'NO_ELIGIBLE_CHANGES'); assert.equal(cycle.workspaces.gamma!.status, 'SUCCEEDED'); assert.equal((await summariesOf(w.vault, 'gamma')).length, 0, 'no fabricated summary for an inactive workspace');
  const [sa] = await summariesOf(w.vault, 'alpha'); const [sb] = await summariesOf(w.vault, 'beta'); assert.ok(sa && sb);
  assert.ok(sa.body.includes('ALPHASECRET') && !sa.body.includes('BETASECRET'), 'alpha summary has only alpha text'); assert.ok(sb.body.includes('BETASECRET') && !sb.body.includes('ALPHASECRET'));
  assert.ok(sa.evidence.some(e => e.uri.includes(a1.id)), 'summary cites the exact source object'); assert.equal(sa.metadata.status, 'COMPLETE');
  for (const key of ['workspace_id', 'local_date', 'cycle_id', 'from_committed_sequence_exclusive', 'to_committed_sequence_inclusive', 'source_manifest_hash', 'generator_version']) assert.ok(sa.metadata[key] !== undefined, `frontmatter field ${key}`);
  for (const heading of ['Executive summary', 'Changes made', 'Findings and evidence', 'Decisions and rationale', 'Notes and observations', 'Progress and completed work', 'Open issues, blockers, risks', 'Follow-ups', 'References', 'Confidence / unknowns']) assert.ok(sa.body.includes(`## ${heading}`), heading);
  assert.match(sa.body, /None evidenced/, 'sections without evidence say so instead of inventing content'); assert.ok(!/test(s)? passed|completed work item/i.test(sa.body));
  assert.equal(sa.metadata.baseline, 'INITIAL_BASELINE', 'first run is labelled as a baseline'); assert.equal(cycle.workspaces.alpha!.outcome, 'INITIAL_BASELINE');
  recordCase({ suite: 'adaptive', name: 'workspace-summaries-and-isolation', status: 'PASS' });
});

test('changes are described as the delta between the per-workspace cursor and W: added, edited, deleted, reverted; intermediate revisions are kept', async t => {
  const w = await world(t);
  const kept = await w.note('alpha', 'note', 'Kept', 'line one\nline two'); const gone = await w.note('alpha', 'note', 'Soon deleted', 'temporary'); const reverted = await w.note('alpha', 'note', 'Reverted', 'original text');
  await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'delta-0', respectActivity: false });
  const edited = await w.vault.patch({ objectId: kept.id, expectedRevisionId: kept.revisionId, body: 'line one\nline two\nline three' });
  await w.vault.delete(gone.id, gone.revisionId); const mid = await w.vault.patch({ objectId: reverted.id, expectedRevisionId: reverted.revisionId, body: 'changed text' });
  await w.vault.restore(reverted.id, reverted.revisionId, mid.revisionId); const created = await w.note('alpha', 'finding', 'New finding', 'a new finding body');
  const cycle = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'delta-1', respectActivity: false })).cycle!; assert.equal(cycle.state, 'COMPLETED', JSON.stringify(cycle.error));
  const summaries = (await summariesOf(w.vault, 'alpha')).sort((a, b) => Number(a.metadata.from_committed_sequence_exclusive) - Number(b.metadata.from_committed_sequence_exclusive)); const latest = summaries.at(-1)!;
  assert.equal(latest.metadata.baseline, undefined, 'second run is not a baseline'); assert.ok(Number(latest.metadata.from_committed_sequence_exclusive) > 0);
  assert.match(latest.body, /\*\*modified\*\* Kept/); assert.match(latest.body, /\*\*deleted\*\* Soon deleted/); assert.match(latest.body, /\*\*added\*\* New finding/); assert.match(latest.body, /\*\*restored\*\* Reverted/);
  assert.match(latest.body, /Kept \(note\) — \+1\/-0 lines/, 'diff stat is between the prior revision and the final one');
  const sources = latest.metadata.source_revisions as Array<{ objectId: string; revisionIds: string[] }>; assert.equal(sources.find(s => s.objectId === reverted.id)!.revisionIds.length, 2, 'the intermediate edit and the revert are both recorded');
  assert.ok(edited && created); assert.ok(!latest.body.includes('workspace_daily_summary'), 'summaries are never their own evidence');
  const again = await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'delta-2', respectActivity: false }); assert.equal(again.cycle!.workspaces.alpha!.outcome, 'NO_ELIGIBLE_CHANGES', 'already-summarized ranges are not summarized again (no summary-of-summary feedback)');
  recordCase({ suite: 'adaptive', name: 'workspace-change-manifest', status: 'PASS' });
});

test('a failed workspace job does not advance its cursor, blocks Dream, and only that workspace is retried; a successful workspace is not redone', async t => {
  const w = await world(t); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript for services [key:lang]'); await w.say('beta', 'I prefer Python for scripts [key:lang]');
  let failBeta = true; w.provider.profileFails = req => (failBeta && JSON.stringify(req.documents).includes('Python') ? new Error('beta job failed') : undefined);
  const first = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'cursor-1', respectActivity: false })).cycle!;
  assert.equal(first.workspaces.alpha!.status, 'SUCCEEDED'); assert.equal(first.workspaces.beta!.status, 'FAILED'); assert.equal(first.state, 'RETRY_WAIT'); assert.equal(w.provider.dreamCalls().length, 0);
  const cursors = await w.ai.store.cursors(); assert.equal(cursors.workspaces.alpha, first.watermark); assert.equal(cursors.workspaces.beta ?? 0, 0, 'no premature cursor advance, no gap');
  failBeta = false; const alphaSummaries = (await summariesOf(w.vault, 'alpha')).length; const profileBefore = w.provider.profileCalls().length;
  const second = (await w.ai.resumeCycle(first.id, { respectActivity: false })).cycle!; assert.equal(second.state, 'COMPLETED', JSON.stringify(second.error));
  assert.equal(w.provider.profileCalls().length, profileBefore + 1, 'only the failed workspace was re-run'); assert.equal((await summariesOf(w.vault, 'alpha')).length, alphaSummaries); assert.equal((await w.ai.store.cursors()).workspaces.beta, first.watermark);
  recordCase({ suite: 'adaptive', name: 'per-workspace-recovery', status: 'PASS' });
});

test('historical retrieval: daily list by date range, show by date, and changes since a date with the unsummarized backlog', async t => {
  const w = await world(t); await w.note('alpha', 'note', 'First day', 'day one content'); await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'hist-1', respectActivity: false });
  await w.note('alpha', 'note', 'Second batch', 'later content'); await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'hist-2', respectActivity: false }); await w.note('alpha', 'note', 'Unsummarized', 'not yet');
  const list = await w.ai.dailyList('alpha'); assert.equal(list.length, 2); const today = list[0]!.date; assert.equal((await w.ai.dailyList('alpha', { from: today, to: today })).length, 2); assert.equal((await w.ai.dailyList('alpha', { from: '2999-01-01' })).length, 0);
  const shown = await w.ai.dailyShow('alpha', today); assert.equal(shown.length, 2); assert.ok(shown[0]!.markdown.includes('First day') && shown[1]!.markdown.includes('Second batch'));
  const changes = await w.ai.changesSince('alpha', today); assert.equal(changes.summaries.length, 2); assert.equal(changes.unsummarizedEvents, 1);
  const hits = (await loadDocuments(w.vault, await readableEntries(w.vault, { kinds: ['workspace_daily_summary'] }))).filter(d => d.body.includes('Second batch')); assert.equal(hits.length, 1, 'summaries are ordinary searchable Markdown objects');
  recordCase({ suite: 'adaptive', name: 'historical-retrieval', status: 'PASS' });
});

test('workspace summaries obey workspace ACLs: an agent with no grant cannot see them', async t => {
  const w = await world(t); await w.note('alpha', 'note', 'Private alpha', 'ALPHAONLY text'); await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'acl-1', respectActivity: false });
  const outsider = new Vault(w.root, { actorId: 'agent-x', permissions: ['workspace:beta:read'] }); assert.equal((await outsider.listDocuments()).filter(d => d.kind === 'workspace_daily_summary').length, 0);
  const summary = (await summariesOf(w.vault, 'alpha'))[0]!; await assert.rejects(outsider.get(summary.id), /NOT_FOUND_OR_FORBIDDEN|not found|forbidden/i);
  assert.throws(() => new AdaptiveIntelligence(outsider), /trusted vault owner/);
  recordCase({ suite: 'adaptive', name: 'workspace-summary-acl', status: 'PASS' }); void ws;
});

test('SQLite on/off parity: identical cycle outcomes with and without the optional index', async t => {
  const outcome = async (sqlite: boolean) => { const w = await world(t, { sqlite }); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript for services [key:lang]'); await w.note('beta', 'note', 'Beta note', 'some beta work'); const c = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'parity', respectActivity: false })).cycle!; return { state: c.state, ws: Object.fromEntries(Object.entries(c.workspaces).map(([k, v]) => [k, [v.status, v.outcome, v.accepted.length, v.changes?.documents]])), global: c.global.status, dream: c.dream.status, summaries: (await summariesOf(w.vault, 'alpha')).length + (await summariesOf(w.vault, 'beta')).length }; };
  assert.deepEqual(await outcome(true), await outcome(false)); recordCase({ suite: 'adaptive', name: 'sqlite-on-off-parity', status: 'PASS' });
});
