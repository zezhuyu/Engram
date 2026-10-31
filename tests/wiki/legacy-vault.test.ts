import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { Engram } from '../../packages/sdk/index.js';
import { execute } from '../../packages/cli/index.js';
import { recordCase } from '../helpers/report.js';

const fixture = path.resolve('tests/fixtures/wiki-legacy-vault');
const wiki = { type: 'global' as const, area: 'wiki' as const };

test('frozen pre-wiki-change vault opens and retains canonical and intelligence state', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'engram-wiki-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  // These empty directories are not represented in Git archives; exercise the
  // same fixture shape the exported-source verification receives.
  await Promise.all(['workspaces', 'profile', '.mdb/cache'].map(directory => rm(path.join(root, directory), { recursive: true, force: true })));

  const vault = new Vault(root);
  await vault.recover();
  assert.equal((await vault.verify()).ok, true);
  const documents = await vault.listDocuments({ scopes: [wiki] });
  assert.ok(documents.some(document => document.title === 'Legacy observatory'));
  assert.ok(documents.some(document => document.title === 'Legacy approved page'));

  const engine = new IntelligenceEngine(vault);
  const jobs = await engine.jobs();
  assert.deepEqual(jobs.map(job => job.status).sort(), ['completed', 'pending']);
  const priorProposals = await engine.proposals();
  assert.deepEqual(priorProposals.map(proposal => proposal.status).sort(), ['approved', 'pending']);

  assert.equal((await execute(['jobs', 'status', '--root', root]) as unknown[]).length, 2);
  assert.ok((await execute(['wiki', 'lint', '--root', root]) as { checked: number }).checked >= 1);
  assert.equal((await execute(['wiki', 'proposals', '--root', root]) as unknown[]).length, 0, 'legacy proposals are preserved but are not wiki-change proposals');
  assert.equal((await execute(['doctor', '--root', root]) as { root: string }).root, root);
  assert.equal((await execute(['verify', '--root', root]) as { ok: boolean }).ok, true);
  assert.ok(await execute(['recover', '--root', root]));

  const client = new Engram(root);
  const search = client.search as SearchEngine;
  await search.rebuild(wiki);
  assert.ok((await search.query({ query: 'telescope opens every evening', mode: 'keyword', kinds: ['wiki_page'] })).hits.length >= 1);

  const source = documents.find(document => document.kind === 'note')!;
  const skill = await client.runSkill('wiki-page-compiler', { scope: wiki, objectIds: [source.id] });
  assert.equal((skill as { semanticExecutionAvailable: boolean }).semanticExecutionAvailable, false, 'legacy content remains usable while provider-backed execution is unavailable');

  const page = documents.find(document => document.title === 'Legacy observatory')!;
  const rename = await engine.proposeWikiChange({ action: 'rename', targetPageId: page.id, targetRevisionId: page.revisionId, newTitle: 'Legacy telescope guide', reason: 'Exercise the current reviewed path on legacy state.' });
  assert.equal((await execute(['wiki', 'proposals', '--root', root]) as unknown[]).length, 1);
  assert.equal((await engine.review(rename.id, true)).status, 'approved');
  assert.equal((await vault.get(page.id)).title, 'Legacy telescope guide');
  assert.equal((await vault.history(page.id)).length, 2);
  assert.equal((await vault.verify()).ok, true);
  recordCase({ suite: 'wiki', name: 'wiki-legacy-vault-compatibility', status: 'PASS' });
});
