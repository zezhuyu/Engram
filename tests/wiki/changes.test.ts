import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { disposableVault } from '../helpers/disposable-vault.js';
import { Vault } from '../../packages/core/vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { lintWiki } from '../../packages/intelligence/wiki-lint.js';
import { Engram } from '../../packages/sdk/index.js';
import { toolsFor } from '../../packages/mcp/index.js';
import { execute } from '../../packages/cli/index.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { recordCase } from '../helpers/report.js';
import type { Document, Scope } from '../../packages/core/types.js';

type T = { after(fn: () => void | Promise<void>): void };
const wiki: Scope = { type: 'global', area: 'wiki' };
const body = 'The observatory publishes a calibrated sky survey every autumn [1].';
const execFileAsync = promisify(execFile);

test('retire, restore, rename and merge are proposal gated and preserve revisions', async t => {
  const { root, vault } = await disposableVault(t);
  const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Survey source', body: 'A calibrated sky survey is published every autumn.' });
  const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Old astronomy', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }] });
  const dependent = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Index', body: 'See [[Old astronomy]] for the survey.' });
  const engine = new IntelligenceEngine(vault);
  const search = new SearchEngine(vault); t.after(() => search.close());
  const retire = await engine.proposeWikiChange({ action: 'retire', targetPageId: page.id, targetRevisionId: page.revisionId, reason: 'Superseded by the consolidated guide.' });
  assert.equal(retire.status, 'pending'); assert.equal((await vault.get(page.id)).revisionId, page.revisionId, 'proposal has no write effect');
  const gone = await engine.review(retire.id, true);
  assert.equal(gone.status, 'approved'); assert.equal((await vault.get(page.id)).status, 'deleted');
  assert.equal((await search.query({ query: 'calibrated sky survey', mode: 'grep', kinds: ['wiki_page'] })).hits.some(hit => hit.objectId === page.id), false);
  assert.equal((await vault.history(page.id)).length, 2); assert.ok((await lintWiki(vault)).issues.some(i => i.objectId === dependent.id && i.issue === 'broken_wikilink'));
  const restore = await engine.proposeWikiChange({ action: 'restore', targetPageId: page.id, targetRevisionId: (await vault.get(page.id)).revisionId, restoreRevisionId: page.revisionId, reason: 'The source page is needed again.' });
  const restored = await engine.review(restore.id, true); assert.equal(restored.status, 'approved'); assert.equal((await vault.get(page.id)).status, 'active');
  assert.equal((await search.query({ query: 'calibrated sky survey', mode: 'grep', kinds: ['wiki_page'] })).hits.some(hit => hit.objectId === page.id), true);
  assert.equal((await vault.history(page.id)).length, 3);
  const rename = await engine.proposeWikiChange({ action: 'rename', targetPageId: page.id, targetRevisionId: (await vault.get(page.id)).revisionId, newTitle: 'Astronomy survey', reason: 'Use the current topic name.' });
  const renamed = await engine.review(rename.id, true); assert.equal(renamed.status, 'approved');
  assert.deepEqual((await vault.get(page.id)).metadata.aliases, ['Old astronomy']);
  assert.ok(!(await lintWiki(vault)).issues.some(i => i.objectId === dependent.id && i.issue === 'broken_wikilink'), 'old title resolves through alias');

  const source = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Survey details', body: 'Old survey text.' });
  const merge = await engine.proposeWikiChange({ action: 'merge', targetPageId: page.id, targetRevisionId: (await vault.get(page.id)).revisionId, mergeSources: [{ pageId: source.id, revisionId: source.revisionId }], title: 'Unified astronomy survey', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Consolidate duplicate material.' });
  const targetBefore = await vault.get(page.id); assert.equal(merge.status, 'pending');
  const merged = await engine.review(merge.id, true); const targetAfter = await vault.get(page.id); const sourceAfter = await vault.get(source.id);
  assert.equal(merged.status, 'approved'); assert.equal(targetAfter.title, 'Unified astronomy survey'); assert.match(targetAfter.body, /calibrated sky survey/);
  assert.ok((targetAfter.metadata.aliases as string[]).includes('Survey details')); assert.ok(targetAfter.links.some(l => l.target === source.uri));
  assert.equal(sourceAfter.status, 'deleted'); assert.equal(sourceAfter.metadata.mergedInto, targetAfter.uri);
  assert.equal((await vault.history(page.id)).length, 5); assert.equal((await vault.history(source.id)).length, 3);
  const diff = await vault.diff(page.id, targetBefore.revisionId, targetAfter.revisionId); assert.equal(diff.from, targetBefore.revisionId); assert.match(diff.diff, /calibrated sky survey/);
  recordCase({ suite: 'wiki', name: 'wiki-change-lifecycle', status: 'PASS' });
});

test('stale targets reject, identical proposals deduplicate under concurrency, and approvals are idempotent', async t => {
  const { vault } = await disposableVault(t); const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Stale page', body: 'Current page.' }); const engine = new IntelligenceEngine(vault);
  const input = { action: 'rename' as const, targetPageId: page.id, targetRevisionId: page.revisionId, newTitle: 'Renamed', reason: 'Rename for clarity.' };
  const [a, b, c] = await Promise.all([engine.proposeWikiChange(input), engine.proposeWikiChange(input), engine.proposeWikiChange(input)]);
  assert.equal(new Set([a.id, b.id, c.id]).size, 1);
  await vault.patch({ objectId: page.id, expectedRevisionId: page.revisionId, body: 'Human edit.' });
  const stale = await engine.review(a.id, true); assert.equal(stale.status, 'rejected'); assert.ok(stale.flags?.includes('page_changed'));
  const second = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Idempotent', body: 'Stable page.' });
  const proposal = await engine.proposeWikiChange({ action: 'retire', targetPageId: second.id, targetRevisionId: second.revisionId, reason: 'Remove obsolete page.' });
  const first = await engine.review(proposal.id, true), again = await engine.review(proposal.id, true);
  assert.equal(first.status, 'approved'); assert.equal(again.status, 'approved'); assert.equal((await vault.history(second.id)).length, 2);
  recordCase({ suite: 'wiki', name: 'wiki-change-staleness-dedup-review', status: 'PASS' });
});

test('credential-bound writer cannot self-approve a Wiki change; trusted owner can', async t => {
  const { root, vault } = await disposableVault(t);
  const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Review boundary', body: 'Current content.' });
  const ownerEngine = new IntelligenceEngine(vault);
  const proposal = await ownerEngine.proposeWikiChange({ action: 'retire', targetPageId: page.id, targetRevisionId: page.revisionId, reason: 'No longer needed.' });
  const writerVault = new Vault(root, { actorId: 'agent-writer', permissions: ['global:wiki:write'], credentialBound: true });
  const writerEngine = new IntelligenceEngine(writerVault);
  await assert.rejects(writerEngine.review(proposal.id, true), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND_OR_FORBIDDEN');
  assert.equal((await vault.get(page.id)).status, 'active', 'denied self-approval has no write effect');
  assert.equal((await ownerEngine.review(proposal.id, true)).status, 'approved');
  assert.equal((await vault.get(page.id)).status, 'deleted');
});

test('merge preflights every source before writing and rejects an edited source without touching target history', async t => {
  const { vault } = await disposableVault(t);
  const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'Survey evidence.' });
  const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Target', body: 'Target before merge.' });
  const source = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Source', body: 'Source before merge.' });
  const engine = new IntelligenceEngine(vault);
  const proposal = await engine.proposeWikiChange({ action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId,
    mergeSources: [{ pageId: source.id, revisionId: source.revisionId }], title: 'Merged target', body,
    evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Consolidate the pages.' });
  await vault.patch({ objectId: source.id, expectedRevisionId: source.revisionId, body: 'Human-edited source.' });

  const reviewed = await engine.review(proposal.id, true);
  assert.equal(reviewed.status, 'rejected');
  assert.ok(reviewed.flags?.includes('page_changed'));
  assert.equal(reviewed.reason, 'A merge source changed after this proposal was created.');
  assert.equal((await vault.get(target.id)).revisionId, target.revisionId);
  assert.equal((await vault.get(target.id)).body, 'Target before merge.');
  assert.equal((await vault.history(target.id)).length, 1);
  recordCase({ suite: 'wiki', name: 'wiki-merge-source-preflight-no-target-write', status: 'PASS' });
});

test('wiki change visibility and writes are ACL filtered; read-only actors cannot propose or approve', async t => {
  const { root, vault } = await disposableVault(t); const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Visible', body: 'Visible page.' });
  const owner = new IntelligenceEngine(vault); const proposal = await owner.proposeWikiChange({ action: 'retire', targetPageId: page.id, targetRevisionId: page.revisionId, reason: 'Retire this page.' });
  const hidden = new IntelligenceEngine(new Vault(root, { actorId: 'denied', permissions: [] })); assert.deepEqual(await hidden.proposals(), []);
  const reader = new IntelligenceEngine(new Vault(root, { actorId: 'reader', permissions: ['global:wiki:read'] }));
  assert.deepEqual((await reader.proposals()).map(p => p.id), [proposal.id]);
  await assert.rejects(reader.proposeWikiChange({ action: 'retire', targetPageId: page.id, targetRevisionId: page.revisionId, reason: 'No write permission.' }), /unavailable/);
  await assert.rejects(reader.review(proposal.id, true), /unavailable/);
  const tools = toolsFor(new Engram(root, { actorId: 'denied', permissions: [] })); assert.deepEqual(await tools.find(tool => tool.name === 'mdb_wiki_proposals')!.execute({}), []);
  await assert.rejects(tools.find(tool => tool.name === 'mdb_wiki_propose_change')!.execute({ action: 'retire', targetPageId: page.id, targetRevisionId: page.revisionId, reason: 'Denied' }), /unavailable/);
  const control = await disposableVault(t); assert.deepEqual(await new IntelligenceEngine(control.vault).proposals(), []);
  recordCase({ suite: 'wiki', name: 'wiki-change-acl-visibility', status: 'PASS' });
});

test('merge resumes after a committed Vault operation at every step and after delete ENOSPC', async t => {
  for (let crashAt = 1; crashAt <= 3; crashAt++) {
    const { root, vault } = await disposableVault(t); const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'Survey evidence.' });
    const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Target', body: 'Target before.' }); const source = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Source', body: 'Source before.' });
    const engine = new IntelligenceEngine(vault); const proposal = await engine.proposeWikiChange({ action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId, mergeSources: [{ pageId: source.id, revisionId: source.revisionId }], title: 'Merged', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Merge related pages.' });
    let events = 0, crashed = false; const faulty = new Vault(root, undefined, { fault: stage => { if (!crashed && stage === 'after_journal_append' && ++events === crashAt) { crashed = true; throw new Error('simulated process interruption'); } } });
    await assert.rejects(new IntelligenceEngine(faulty).review(proposal.id, true), /simulated process interruption/); assert.equal(crashed, true);
    const recovered = new Vault(root); await recovered.recover(); const resumed = new IntelligenceEngine(recovered); const final = await resumed.review(proposal.id, true);
    assert.equal(final.status, 'approved'); assert.equal((await recovered.get(source.id)).status, 'deleted'); assert.equal((await recovered.get(target.id)).title, 'Merged');
  }
  const { root, vault } = await disposableVault(t); const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'Survey evidence.' });
  const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Target', body: 'Target before.' }); const source = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Source', body: 'Source before.' });
  const proposal = await new IntelligenceEngine(vault).proposeWikiChange({ action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId, mergeSources: [{ pageId: source.id, revisionId: source.revisionId }], title: 'Merged', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Merge related pages.' });
  let deletes = 0; const full = new Vault(root, undefined, { fault: stage => { if (stage === 'commit.before_revision' && ++deletes === 3) { const error = new Error('disk full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; } } });
  await assert.rejects(new IntelligenceEngine(full).review(proposal.id, true), /disk full/); assert.equal((await new IntelligenceEngine(new Vault(root)).proposals()).find(p => p.id === proposal.id)?.status, 'pending');
  const recovered = new Vault(root); await recovered.recover(); assert.equal((await new IntelligenceEngine(recovered).review(proposal.id, true)).status, 'approved'); assert.equal((await recovered.get(source.id)).status, 'deleted');

  const multi = await disposableVault(t); const multiEvidence = await multi.vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'Survey evidence.' });
  const multiTarget = await multi.vault.put({ scope: wiki, kind: 'wiki_page', title: 'Target', body: 'Target before.' });
  const sourceOne = await multi.vault.put({ scope: wiki, kind: 'wiki_page', title: 'Source one', body: 'First source.' });
  const sourceTwo = await multi.vault.put({ scope: wiki, kind: 'wiki_page', title: 'Source two', body: 'Second source.' });
  const multiProposal = await new IntelligenceEngine(multi.vault).proposeWikiChange({ action: 'merge', targetPageId: multiTarget.id, targetRevisionId: multiTarget.revisionId, mergeSources: [{ pageId: sourceOne.id, revisionId: sourceOne.revisionId }, { pageId: sourceTwo.id, revisionId: sourceTwo.revisionId }], title: 'Merged', body, evidence: [{ uri: multiEvidence.uri, revisionId: multiEvidence.revisionId }], reason: 'Merge both source pages.' });
  let commits = 0; const crashAfterFirstDelete = new Vault(multi.root, undefined, { fault: stage => { if (stage === 'after_journal_append' && ++commits === 3) throw new Error('crash after source one delete'); } });
  await assert.rejects(new IntelligenceEngine(crashAfterFirstDelete).review(multiProposal.id, true), /crash after source one delete/);
  const partial = new Vault(multi.root); await partial.recover(); assert.equal((await partial.get(sourceOne.id)).status, 'deleted'); assert.equal((await partial.get(sourceTwo.id)).status, 'active');
  assert.equal((await new IntelligenceEngine(partial).review(multiProposal.id, true)).status, 'approved');
  assert.equal((await partial.history(sourceOne.id)).length, 3, 'completed source is not patched or deleted twice');
  assert.equal((await partial.history(sourceTwo.id)).length, 3, 'remaining source is marked and deleted exactly once');
  recordCase({ suite: 'wiki', name: 'wiki-merge-crash-resume-enospc', status: 'PASS' });
});

test('retire, restore, rename and every merge commit reject ENOSPC without losing the pending proposal', async t => {
  for (const scenario of ['retire', 'restore', 'rename', 'merge-target', 'merge-source-marker', 'merge-source-delete'] as const) {
    const { root, vault } = await disposableVault(t);
    const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Fault evidence', body: 'A calibrated survey is published each autumn.' });
    const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Fault target', body });
    const source: Document | undefined = scenario.startsWith('merge-') ? await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Fault source', body: 'Source page.' }) : undefined;
    let input: Parameters<IntelligenceEngine['proposeWikiChange']>[0];
    if (scenario === 'retire') input = { action: 'retire', targetPageId: target.id, targetRevisionId: target.revisionId, reason: 'Test ENOSPC admission.' };
    else if (scenario === 'restore') {
      const deleted = await vault.delete(target.id, target.revisionId);
      input = { action: 'restore', targetPageId: target.id, targetRevisionId: deleted.revisionId, restoreRevisionId: target.revisionId, reason: 'Test ENOSPC admission.' };
    } else if (scenario === 'rename') input = { action: 'rename', targetPageId: target.id, targetRevisionId: target.revisionId, newTitle: 'Renamed after retry', reason: 'Test ENOSPC admission.' };
    else input = { action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId, mergeSources: [{ pageId: source!.id, revisionId: source!.revisionId }], title: 'Merged after retry', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Test ENOSPC admission.' };
    const proposal = await new IntelligenceEngine(vault).proposeWikiChange(input);
    const failAt = scenario === 'merge-target' ? 1 : scenario === 'merge-source-marker' ? 2 : scenario === 'merge-source-delete' ? 3 : 1;
    let attempts = 0;
    const constrained = new Vault(root, undefined, { fault: stage => {
      if (stage === 'commit.before_revision' && ++attempts === failAt) { const error = new Error(`ENOSPC at ${scenario}`) as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; }
    } });
    await assert.rejects(new IntelligenceEngine(constrained).review(proposal.id, true), new RegExp(`ENOSPC at ${scenario}`));
    assert.equal((await new IntelligenceEngine(new Vault(root)).proposals()).find(item => item.id === proposal.id)?.status, 'pending');
    const recovered = new Vault(root); await recovered.recover();
    assert.equal((await new IntelligenceEngine(recovered).review(proposal.id, true)).status, 'approved');
    assert.equal((await recovered.verify()).ok, true);
    if (source) {
      const sourceHistory: Awaited<ReturnType<Vault['history']>> = await recovered.history(source.id);
      const tombstones = sourceHistory.filter(revision => revision.status === 'deleted');
      assert.equal(tombstones.length, 1, `${scenario} has exactly one source tombstone`);
    }
  }
  recordCase({ suite: 'wiki', name: 'wiki-change-enospc-all-commit-steps', status: 'PASS' });
});

test('a real SIGKILL during merge resumes from the committed journal and tombstones each source once', async t => {
  const { root, vault } = await disposableVault(t);
  const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'SIGKILL evidence', body: 'A calibrated survey is published each autumn.' });
  const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'SIGKILL target', body: 'Target before merge.' });
  const source = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'SIGKILL source', body: 'Source before merge.' });
  const proposal = await new IntelligenceEngine(vault).proposeWikiChange({ action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId, mergeSources: [{ pageId: source.id, revisionId: source.revisionId }], title: 'SIGKILL merged', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Verify actual process death.' });
  const modulePath = pathToFileURL(`${process.cwd()}/dist/packages/core/vault.js`).href;
  const enginePath = pathToFileURL(`${process.cwd()}/dist/packages/intelligence/index.js`).href;
  const childCode = `const {Vault}=await import(${JSON.stringify(modulePath)}); const {IntelligenceEngine}=await import(${JSON.stringify(enginePath)}); let commits=0; const vault=new Vault(process.env.WIKI_ROOT,undefined,{fault:stage=>{if(stage==='after_journal_append' && ++commits===3) process.kill(process.pid,'SIGKILL')}}); await new IntelligenceEngine(vault).review(process.env.WIKI_PROPOSAL,true);`;
  const killed = await execFileAsync(process.execPath, ['--input-type=module', '-e', childCode], { env: { ...process.env, WIKI_ROOT: root, WIKI_PROPOSAL: proposal.id } }).catch(error => error as NodeJS.ErrnoException & { signal?: string });
  assert.equal((killed as NodeJS.ErrnoException & { signal?: string }).signal, 'SIGKILL', 'child process must die at the third durable merge commit');

  const reopened = new Vault(root); await reopened.recover();
  const resumed = await new IntelligenceEngine(reopened).review(proposal.id, true);
  assert.equal(resumed.status, 'approved');
  assert.equal((await reopened.get(target.id)).title, 'SIGKILL merged');
  assert.equal((await reopened.get(source.id)).status, 'deleted');
  const sourceHistory = await reopened.history(source.id);
  assert.equal(sourceHistory.filter(revision => revision.status === 'deleted').length, 1);
  assert.equal(sourceHistory.length, 3, 'initial revision, merge marker and single tombstone');
  assert.equal((await reopened.verify()).ok, true);
  const commits = await reopened.events();
  assert.ok(commits.every(event => event.objectId && event.revisionId), 'journal records remain complete after restart');
  recordCase({ suite: 'wiki', name: 'wiki-merge-real-sigkill-resume-once', status: 'PASS' });
});

test('storage pressure rejects wiki approval while leaving the proposal pending', async t => {
  const { root, vault } = await disposableVault(t);
  const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Pressure page', body: 'Keep this page.' });
  const engine = new IntelligenceEngine(vault);
  const proposal = await engine.proposeWikiChange({ action: 'retire', targetPageId: page.id, targetRevisionId: page.revisionId, reason: 'Check admission failure.' });
  const previousRoot = process.env.ENGRAM_DATA_DIR;
  const previousReserve = process.env.ENGRAM_STORAGE_DURABLE_RESERVE_BYTES;
  process.env.ENGRAM_DATA_DIR = root;
  process.env.ENGRAM_STORAGE_DURABLE_RESERVE_BYTES = '9000000000000000';
  try {
    await assert.rejects(engine.review(proposal.id, true), /READ_ONLY/);
  } finally {
    if (previousRoot === undefined) delete process.env.ENGRAM_DATA_DIR; else process.env.ENGRAM_DATA_DIR = previousRoot;
    if (previousReserve === undefined) delete process.env.ENGRAM_STORAGE_DURABLE_RESERVE_BYTES; else process.env.ENGRAM_STORAGE_DURABLE_RESERVE_BYTES = previousReserve;
  }
  assert.equal((await engine.proposals()).find(item => item.id === proposal.id)?.status, 'pending');
  assert.equal((await vault.get(page.id)).revisionId, page.revisionId);
  assert.equal((await engine.review(proposal.id, true)).status, 'approved');
  recordCase({ suite: 'wiki', name: 'wiki-change-storage-pressure-pending', status: 'PASS' });
});

test('a source changed after merge begins remains active and the proposal stays pending', async t => {
  const { root, vault } = await disposableVault(t); const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'Survey evidence.' });
  const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Target', body: 'Target before.' });
  const first = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'First', body: 'First source.' }); const later = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Later', body: 'Later source.' });
  const engine = new IntelligenceEngine(vault); const proposal = await engine.proposeWikiChange({ action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId, mergeSources: [{ pageId: first.id, revisionId: first.revisionId }, { pageId: later.id, revisionId: later.revisionId }], title: 'Merged', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Merge the pages.' });
  let writes = 0; const fault = new Vault(root, undefined, { fault: stage => { if (stage === 'after_journal_append' && ++writes === 3) throw new Error('stop after first source delete'); } });
  await assert.rejects(new IntelligenceEngine(fault).review(proposal.id, true), /stop after first source delete/);
  const resumedVault = new Vault(root); await resumedVault.recover(); const currentLater = await resumedVault.get(later.id);
  await resumedVault.patch({ objectId: later.id, expectedRevisionId: currentLater.revisionId, body: 'Human changed the later source.' });
  await assert.rejects(new IntelligenceEngine(resumedVault).review(proposal.id, true), /changed; proposal remains pending/);
  assert.equal((await resumedVault.get(later.id)).status, 'active'); assert.match((await resumedVault.get(later.id)).body, /Human changed/);
  assert.equal((await new IntelligenceEngine(resumedVault).proposals()).find(p => p.id === proposal.id)?.status, 'pending');
  recordCase({ suite: 'wiki', name: 'wiki-merge-changed-later-source-stays-pending', status: 'PASS' });
});

test('merge recovery refuses human edits after a target or source marker patch', async t => {
  for (const changed of ['target', 'source'] as const) {
    const { root, vault } = await disposableVault(t);
    const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'Survey evidence.' });
    const target = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Target', body: 'Target before.' });
    const source = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Source', body: 'Source before.' });
    const proposal = await new IntelligenceEngine(vault).proposeWikiChange({ action: 'merge', targetPageId: target.id, targetRevisionId: target.revisionId, mergeSources: [{ pageId: source.id, revisionId: source.revisionId }], title: 'Merged', body, evidence: [{ uri: evidence.uri, revisionId: evidence.revisionId }], reason: 'Merge related pages.' });
    let appends = 0;
    const interrupted = new Vault(root, undefined, { fault: stage => { if (stage === 'after_journal_append' && ++appends === (changed === 'target' ? 1 : 2)) throw new Error('crash after marker patch'); } });
    await assert.rejects(new IntelligenceEngine(interrupted).review(proposal.id, true), /crash after marker patch/);
    const recovered = new Vault(root); await recovered.recover();
    const edited = await recovered.get(changed === 'target' ? target.id : source.id);
    await recovered.patch({ objectId: edited.id, expectedRevisionId: edited.revisionId, body: `Human edit to ${changed}.` });
    await assert.rejects(new IntelligenceEngine(recovered).review(proposal.id, true), new RegExp(`Merge ${changed} .*changed after its proposal patch`));
    assert.match((await recovered.get(edited.id)).body, /Human edit/);
    assert.equal((await recovered.get(source.id)).status, 'active');
    assert.equal((await new IntelligenceEngine(recovered).proposals()).find(p => p.id === proposal.id)?.status, 'pending');
  }
  recordCase({ suite: 'wiki', name: 'wiki-merge-human-edit-after-marker-conflict', status: 'PASS' });
});

test('delete and restore idempotency keys cannot be replayed across objects or restore payloads', async t => {
  const { vault } = await disposableVault(t);
  const first = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'First', body: 'First revision.' });
  const second = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Second', body: 'Second revision.' });
  const firstDeleted = await vault.delete(first.id, first.revisionId, 'shared-delete-key');
  await assert.rejects(vault.delete(second.id, second.revisionId, 'shared-delete-key'), /Idempotency key was already used/);
  assert.equal((await vault.get(second.id)).status, 'active');

  const firstRestored = await vault.restore(first.id, first.revisionId, firstDeleted.revisionId, 'shared-restore-key');
  const secondDeleted = await vault.delete(second.id, second.revisionId);
  await assert.rejects(vault.restore(second.id, second.revisionId, secondDeleted.revisionId, 'shared-restore-key'), /Idempotency key was already used/);
  assert.equal((await vault.get(second.id)).status, 'deleted');

  const revised = await vault.patch({ objectId: first.id, expectedRevisionId: firstRestored.revisionId, body: 'A different revision.' });
  await assert.rejects(vault.restore(first.id, revised.revisionId, revised.revisionId, 'shared-restore-key'), /Idempotency key was already used/);
  recordCase({ suite: 'wiki', name: 'vault-write-idempotency-cross-object', status: 'PASS' });
});

test('rename crash replay does not approve over a later human head revision', async t => {
  const { root, vault } = await disposableVault(t);
  const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Before crash', body: 'Original page content.' });
  const engine = new IntelligenceEngine(vault);
  const proposal = await engine.proposeWikiChange({ action: 'rename', targetPageId: page.id, targetRevisionId: page.revisionId, newTitle: 'After crash', reason: 'Clarify the page title.' });
  let committed = false;
  const interrupted = new Vault(root, undefined, { fault: stage => { if (!committed && stage === 'after_journal_append') { committed = true; throw new Error('crash after rename commit'); } } });
  await assert.rejects(new IntelligenceEngine(interrupted).review(proposal.id, true), /crash after rename commit/);
  assert.equal((await new Vault(root).get(page.id)).title, 'After crash');
  const head = await new Vault(root).get(page.id);
  const human = await new Vault(root).patch({ objectId: page.id, expectedRevisionId: head.revisionId, body: 'Human-authored follow-up.' });
  await assert.rejects(new IntelligenceEngine(new Vault(root)).review(proposal.id, true), { code: 'CONFLICT' });
  const pending = (await new IntelligenceEngine(new Vault(root)).proposals()).find(item => item.id === proposal.id)!;
  assert.equal(pending.status, 'pending');
  assert.equal((await new Vault(root).get(page.id)).revisionId, human.revisionId);
  assert.equal((await new Vault(root).get(page.id)).body, 'Human-authored follow-up.');
});

test('retire and restore approvals stay pending if a human advances the head after an idempotent replay', async t => {
  for (const action of ['retire', 'restore'] as const) {
    const { root, vault } = await disposableVault(t);
    const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: `${action} race`, body: 'Original page.' });
    const engine = new IntelligenceEngine(vault);
    let targetRevisionId = page.revisionId;
    let restoreRevisionId: string | undefined;
    if (action === 'restore') {
      const deleted = await vault.delete(page.id, page.revisionId);
      targetRevisionId = deleted.revisionId;
      restoreRevisionId = page.revisionId;
    }
    const proposal = await engine.proposeWikiChange({ action, targetPageId: page.id, targetRevisionId, ...(restoreRevisionId ? { restoreRevisionId } : {}), reason: 'Exercise a human edit during replay.' });
    const racingVault = new Vault(root);
    if (action === 'retire') {
      const originalDelete = racingVault.delete.bind(racingVault);
      racingVault.delete = async (...args) => {
        const committed = await originalDelete(...args);
        await racingVault.patch({ objectId: page.id, expectedRevisionId: committed.revisionId, body: 'Human follow-up after retire.' });
        return committed;
      };
    } else {
      const originalRestore = racingVault.restore.bind(racingVault);
      racingVault.restore = async (...args) => {
        const committed = await originalRestore(...args);
        await racingVault.patch({ objectId: page.id, expectedRevisionId: committed.revisionId, body: 'Human follow-up after restore.' });
        return committed;
      };
    }
    await assert.rejects(new IntelligenceEngine(racingVault).review(proposal.id, true), { code: 'CONFLICT' });
    const pending = (await engine.proposals()).find(item => item.id === proposal.id)!;
    assert.equal(pending.status, 'pending');
    assert.match((await vault.get(page.id)).body, /Human follow-up/);
  }
  recordCase({ suite: 'wiki', name: 'wiki-retire-restore-human-head-conflict', status: 'PASS' });
});

test('CLI supports equals and repeated options; MCP exposes propose/list/diff but no approve/delete', async t => {
  const { root, vault } = await disposableVault(t); const evidence = await vault.put({ scope: wiki, kind: 'note', title: 'Evidence', body: 'A source statement.' });
  const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'CLI page', body: 'A page body.' });
  const result = await execute(['wiki', 'propose', 'rename', `--root=${root}`, `--page=${page.id}`, `--revision=${page.revisionId}`, '--title=CLI renamed', '--reason=Better title']);
  assert.equal((result as { status: string }).status, 'pending');
  const mergeTarget = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Merge target', body: 'Target.' }); const mergeSource = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Merge source', body: 'Source.' });
  const mergedProposal = await execute(['wiki', 'propose', 'merge', `--root=${root}`, `--target=${mergeTarget.id}`, `--revision=${mergeTarget.revisionId}`, `--source=${mergeSource.id}:${mergeSource.revisionId}`, `--title=CLI merged`, `--body=${body}`, `--evidence=${evidence.uri}:${evidence.revisionId}`, '--reason=Consolidate']);
  assert.equal((mergedProposal as { status: string }).status, 'pending');
  const names = toolsFor(new Engram(root)).map(tool => tool.name);
  assert.ok(names.includes('mdb_wiki_propose_change') && names.includes('mdb_wiki_proposals') && names.includes('mdb_diff'));
  assert.ok(!names.some(name => /approve|wiki.*delete/.test(name)));
  const { stdout } = await execFileAsync(process.execPath, ['bin/mdb.js', 'wiki', 'proposals', `--root=${root}`, '--json']);
  assert.deepEqual((JSON.parse(stdout) as Array<{ id: string }>).map(p => p.id), [(result as { id: string }).id, (mergedProposal as { id: string }).id]);
  recordCase({ suite: 'wiki', name: 'wiki-change-cli-mcp-surfaces', status: 'PASS' });
});
