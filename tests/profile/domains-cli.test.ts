import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultBinding, findBinding, writeBinding } from '../../packages/core/project-binding.js';
import { isTrusted, trustProject } from '../../packages/core/project-trust.js';
import { execute } from '../../packages/cli/index.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { mapCommand, usesServer } from '../../packages/cli/remote.js';

test('profile domains CLI previews suggestions and applies only with --yes using revisions', async t => {
  const { root, vault } = await disposableVault(t);
  const insight = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Risk approach', body: 'The user prefers explicit stock portfolio risk limits.', status: 'accepted', metadata: { category: 'preference', sensitivity: 'none' } });
  const preview = await execute(['profile', 'domains', 'apply', '--root', root]);
  assert.equal((preview as { dryRun: boolean }).dryRun, true);
  assert.deepEqual((await vault.get(insight.id)).metadata.domains, undefined, 'preview does not write');
  const applied = await execute(['profile', 'domains', 'apply', '--yes', '--root', root]);
  assert.equal((applied as { dryRun: boolean }).dryRun, false);
  const current = await vault.get(insight.id);
  assert.notEqual(current.revisionId, insight.revisionId); assert.equal(current.body, insight.body); assert.equal(current.status, 'accepted'); assert.deepEqual(current.metadata.domains, ['investing']);
});

test('profile domain discovery command reports unavailable without a model and leaves the vault unchanged', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.setConfig(config => { config.model.provider = null; });
  const item = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Garden beds', body: 'The user prefers raised garden beds.', status: 'accepted', metadata: { category: 'preference', domains: ['general'] } });
  const result = await execute(['profile', 'domains', 'suggest', '--discover', '--root', root]) as { status: string; note: string };
  assert.equal(result.status, 'unavailable');
  assert.match(result.note, /domain discovery unavailable \(no model\)/);
  assert.equal((await vault.get(item.id)).revisionId, item.revisionId);
});

test('profile domain recheck reports unavailable without a model and preserves discovered tags', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.setConfig(config => { config.model.provider = null; });
  const { registry, revisionId } = await (await import('../../packages/profile/domain-registry.js')).readDomainRegistry(vault);
  registry.domains.push({ slug: 'cooking', label: 'Cooking', description: 'Cooking methods.', keywords: ['vegetable', 'tomato'], origin: 'discovered', firstSeen: new Date().toISOString(), evidence: ['evidence-a', 'evidence-b'], status: 'active' });
  await (await import('../../packages/profile/domain-registry.js')).writeDomainRegistry(vault, registry, revisionId);
  const item = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Garden', body: 'I garden in raised beds with tomatoes.', status: 'accepted', metadata: { category: 'preference', domains: ['cooking'], tagSource: 'model' } });
  const result = await execute(['profile', 'domains', 'suggest', '--discover', '--recheck', '--yes', '--root', root]) as { status: string; note: string };
  assert.equal(result.status, 'unavailable');
  assert.match(result.note, /domain discovery unavailable \(no model\)/);
  assert.equal((await vault.get(item.id)).revisionId, item.revisionId);
});

test('profile domain operations route through the authenticated remote credential path', async () => {
  assert.equal(usesServer('profile', 'domains'), true);
  assert.deepEqual(await mapCommand('profile', ['profile', 'domains', 'set', 'insight-1'], { domains: 'coding,investing' }), {
    tool: 'mdb_profile_domains', input: { action: 'set', id: 'insight-1', domains: ['coding', 'investing'] },
  });
});

test('owner-created domains are revisioned in the profile registry and accepted by the CLI', async t => {
  const { root, vault } = await disposableVault(t);
  const insight = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Episode style', body: 'The user prefers episodic AI video with character bibles.', status: 'accepted', metadata: { category: 'preference', sensitivity: 'none' } });
  const added = await execute(['profile', 'domains', 'add', '--slug', 'episodic-video', '--label', 'Episodic video', '--description', 'Preferences for episodic video.', '--keywords', 'serial-art,scene-bible', '--evidence', insight.id, '--root', root]) as { domain: string };
  assert.equal(added.domain, 'episodic-video');
  const assigned = await execute(['profile', 'domains', 'set', insight.id, '--domains', 'episodic-video', '--root', root]) as { domains: string[] };
  assert.deepEqual(assigned.domains, ['episodic-video']);
  await assert.rejects(execute(['profile', 'domains', 'set', insight.id, '--domains', 'unknown-domain', '--root', root]), /episodic-video/);
  const registry = await execute(['profile', 'domains', 'registry', '--root', root]) as { minEvidence: number; pendingDomainCandidates: unknown[]; domains: Array<{ slug: string; evidence: string[] }> };
  assert.equal(registry.minEvidence, 2);
  assert.deepEqual(registry.pendingDomainCandidates, []);
  assert.ok(registry.domains.some(domain => domain.slug === 'episodic-video'));
});

test('project domains set keeps an already trusted binding trusted and never trusts an untrusted one', async t => {
  const { root } = await disposableVault(t);
  const trustedDir = await mkdtemp(path.join(tmpdir(), 'domains-trusted-')), foreignDir = await mkdtemp(path.join(tmpdir(), 'domains-foreign-'));
  t.after(async () => { await rm(trustedDir, { recursive: true, force: true }); await rm(foreignDir, { recursive: true, force: true }); });
  const binding = defaultBinding({ workspaceId: 'proj' });
  await writeBinding(trustedDir, binding); await trustProject(trustedDir, binding);
  await writeBinding(foreignDir, binding);
  await execute(['project', 'domains', 'set', '--project-dir', trustedDir, '--domains', 'general', '--root', root]);
  await execute(['project', 'domains', 'set', '--project-dir', foreignDir, '--domains', 'general', '--root', root]);
  const trusted = (await findBinding(trustedDir))!, foreign = (await findBinding(foreignDir))!;
  assert.deepEqual(trusted.binding.domains, ['general']);
  assert.equal(await isTrusted(trustedDir, trusted.binding), true, 'an owner edit of a trusted binding must not break its hooks');
  assert.equal(await isTrusted(foreignDir, foreign.binding), false, 'editing an untrusted binding must never trust it');
});
