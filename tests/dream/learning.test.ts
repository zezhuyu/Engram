import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import type { Scope } from '../../packages/core/types.js';
import { appendFeedback, learnedParams, rateDiscovery, readFeedbackLog, resetLearning } from '../../packages/intelligence/dream/learning.js';
import { recordFeedback } from '../../packages/intelligence/dream/lifecycle.js';

const wiki: Scope = { type: 'global', area: 'wiki' }; const wsA: Scope = { type: 'workspace', workspaceId: 'a' };
const discovery = (v: Vault, domains: string[], scope: Scope = wiki) => v.put({ scope, kind: 'discovery', status: 'candidate', title: `hypothesis ${domains.join('+')}`, body: 'generated hypothesis', metadata: { mode: 'deep', domains } });
const fam = (d: string[]) => `deep|${[...d].sort().join('+')}`;

test('feedback log is append-only and versioned; validation and ratings move the family in the right direction; incorrect costs more than not_useful', async t => {
  const { vault } = await disposableVault(t); const ev = await vault.put({ scope: wiki, kind: 'note', title: 'experiment', body: 'result' });
  const good = await discovery(vault, ['x', 'y']); const bad = await discovery(vault, ['p', 'q']); const wrong = await discovery(vault, ['m', 'n']); const meh = await discovery(vault, ['u', 'v']);
  await recordFeedback(vault, good.id, { outcome: 'validated', validatedBy: 'experiment', note: 'measured', evidence: [{ uri: ev.uri, revisionId: ev.revisionId }] });
  await recordFeedback(vault, bad.id, { outcome: 'rejected', note: 'no' }); await rateDiscovery(vault, wrong.id, { label: 'incorrect', note: 'factually wrong' }); await rateDiscovery(vault, meh.id, { label: 'not_useful', note: 'boring' });
  const log = await readFeedbackLog(vault); assert.deepEqual(log.map(e => e.v), log.map((_, i) => i + 1), 'versions are consecutive line numbers');
  const p = await learnedParams(vault); assert.ok(p.families[fam(['x', 'y'])]!.mean > 0.5); assert.ok(p.families[fam(['p', 'q'])]!.mean < 0.5);
  assert.ok(p.families[fam(['m', 'n'])]!.mean < p.families[fam(['u', 'v'])]!.mean, 'incorrect is penalized more than not_useful');
  assert.equal((await vault.get(wrong.id)).status, 'candidate', 'a ranking label never changes the discovery status'); assert.ok(((await vault.get(wrong.id)).metadata.feedback as unknown[]).length === 1, 'the rating is a new revision with provenance');
  const before = JSON.stringify(await readFeedbackLog(vault)); await rateDiscovery(vault, good.id, { label: 'useful', note: 'again' }); assert.ok(JSON.stringify(await readFeedbackLog(vault)).startsWith(before.slice(0, -1)), 'earlier events are never rewritten');
  recordCase({ suite: 'dream', name: 'learning-log-direction', status: 'PASS' });
});

test('validation still needs the user or an experiment; ranking labels cannot validate; model-sourced feedback never counts; repetition does not validate', async t => {
  const { vault } = await disposableVault(t); const d = await discovery(vault, ['a1', 'b1']);
  await assert.rejects(() => recordFeedback(vault, d.id, { outcome: 'validated', note: 'trust me' }), /confirmation or an experiment/);
  await assert.rejects(() => rateDiscovery(vault, d.id, { label: 'validated' as never, note: 'x' }), /Label must be/);
  for (let i = 0; i < 5; i++) await rateDiscovery(vault, d.id, { label: 'useful', note: `model says so ${i}`, source: 'model' });
  const p = await learnedParams(vault); assert.equal(p.families[fam(['a1', 'b1'])], undefined, 'five model-sourced ratings left no trace in the ranking'); assert.equal(p.excluded.model, 5);
  assert.equal((await vault.get(d.id)).status, 'candidate');
  recordCase({ suite: 'dream', name: 'learning-no-self-training', status: 'PASS' });
});

test('privacy and deletion: feedback about a deleted discovery or one the actor cannot read is excluded; reset and rollback work; restart keeps the parameters; profile is never written', async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('a', '', { agent: ['read'] }); await vault.createWorkspace('b', '', {});
  const profileBefore = await fs.readFile(path.join(root, 'PROFILE.md'), 'utf8').catch(() => '');
  const pub = await discovery(vault, ['k', 'l']); const priv = await discovery(vault, ['k2', 'l2'], { type: 'workspace', workspaceId: 'b' }); const gone = await discovery(vault, ['k3', 'l3']);
  for (const d of [pub, priv, gone]) await recordFeedback(vault, d.id, { outcome: 'rejected', note: 'no' });
  const v1 = (await learnedParams(vault)).version;
  const agent = new Vault(root, { actorId: 'agent', permissions: ['global:wiki:read', 'workspace:a:read'] }); const seen = await learnedParams(agent);
  assert.ok(seen.families[fam(['k', 'l'])] && !seen.families[fam(['k2', 'l2'])], 'an actor cannot be influenced by feedback on discoveries it cannot read'); assert.ok(seen.excluded.unreadableOrDeleted >= 1);
  await vault.delete(gone.id, (await vault.get(gone.id)).revisionId); assert.equal((await learnedParams(vault)).families[fam(['k3', 'l3'])], undefined, 'deleting a discovery removes its influence');
  const restarted = await learnedParams(new Vault(root)); assert.deepEqual(restarted.families, (await learnedParams(vault)).families);
  await assert.rejects(() => resetLearning(agent, 'nope'), /trusted owner/); const resetV = await resetLearning(vault, 'start over'); const after = await learnedParams(vault); assert.deepEqual(after.families, {}); assert.equal(after.resetAtVersion, resetV);
  assert.ok(Object.keys((await learnedParams(vault, { asOfVersion: v1 })).families).length >= 2, 'history is still re-evaluable as of an earlier version');
  assert.equal(await fs.readFile(path.join(root, 'PROFILE.md'), 'utf8').catch(() => ''), profileBefore, 'ranking feedback never writes the user profile'); assert.equal((await vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 0);
  recordCase({ suite: 'dream', name: 'learning-privacy-reset-rollback', status: 'PASS' });
});

test('first append carries the legacy per-family counters over exactly once', async t => {
  const { root, vault } = await disposableVault(t); await fs.mkdir(path.join(root, '.mdb/intelligence'), { recursive: true });
  await fs.writeFile(path.join(root, '.mdb/intelligence/dream-stats.json'), JSON.stringify({ 'deep|old+fam': { validated: 3, rejected: 0, tested: 1 } }));
  await appendFeedback(vault, { kind: 'reset', note: 'x', source: 'human' }); await appendFeedback(vault, { kind: 'reset', note: 'y', source: 'human' });
  assert.equal((await readFeedbackLog(vault)).filter(e => e.kind === 'legacy').length, 1);
  recordCase({ suite: 'dream', name: 'learning-legacy-carry-over', status: 'PASS' });
});

test('labels keep their origin: real-user, validated-evidence and simulated feedback are counted separately and a report can tell them apart', async t => {
  const { vault } = await disposableVault(t); const a = await discovery(vault, ['o1', 'p1']); const b = await discovery(vault, ['o2', 'p2']); const c = await discovery(vault, ['o3', 'p3']);
  await rateDiscovery(vault, a.id, { label: 'useful', note: 'a person said so' });
  await rateDiscovery(vault, b.id, { label: 'useful', note: 'scripted reviewer', origin: 'simulated-reviewer' });
  await rateDiscovery(vault, c.id, { label: 'useful', note: 'model opinion', source: 'model' });
  const p = await learnedParams(vault); assert.deepEqual(p.byOrigin, { 'real-user': 1, 'simulated-reviewer': 1 }, 'the model-sourced label is excluded, the other two are labeled by origin');
  assert.equal((await readFeedbackLog(vault)).filter(e => e.origin === 'simulated-reviewer').length, 1);
  recordCase({ suite: 'dream', name: 'learning-origin-labels', status: 'PASS' });
});

test('CLI --origin records provenance for ratings and rejects unknown origins', async t => {
  const { root, vault } = await disposableVault(t); const d = await discovery(vault, ['c1', 'c2']); const { execute } = await import('../../packages/cli/index.js');
  await execute(['--root', root, 'dream', 'rate', d.id, '--label', 'useful', '--note', 'scripted', '--origin', 'simulated-reviewer']);
  await execute(['--root', root, 'dream', 'rate', d.id, '--label', 'useful', '--note', 'a person']);
  const status = await execute(['--root', root, 'dream', 'learning', 'status']) as { byOrigin: Record<string, number> }; assert.deepEqual(status.byOrigin, { 'simulated-reviewer': 1, 'real-user': 1 });
  await assert.rejects(() => execute(['--root', root, 'dream', 'rate', d.id, '--label', 'useful', '--note', 'x', '--origin', 'trust-me']), /--origin must be/);
  recordCase({ suite: 'dream', name: 'learning-cli-origin', status: 'PASS' });
});
