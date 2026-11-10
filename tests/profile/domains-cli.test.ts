import test from 'node:test';
import assert from 'node:assert/strict';
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
  const registry = await execute(['profile', 'domains', 'registry', '--root', root]) as { domains: Array<{ slug: string; evidence: string[] }> };
  assert.ok(registry.domains.some(domain => domain.slug === 'episodic-video'));
});
