import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { disposableVault } from '../helpers/disposable-vault.js';
import { Vault } from '../../packages/core/vault.js';
import { lintWiki } from '../../packages/intelligence/wiki-lint.js';
import type { Document, Scope } from '../../packages/core/types.js';
import { execute } from '../../packages/cli/index.js';
import { Engram } from '../../packages/sdk/index.js';
import { toolsFor } from '../../packages/mcp/index.js';
import { mapCommand } from '../../packages/cli/remote.js';
import { recordCase } from '../helpers/report.js';

type T = { after(fn: () => void | Promise<void>): void };
const wiki: Scope = { type: 'global', area: 'wiki' };
const execFileAsync = promisify(execFile);

test('wiki lint reports deterministic defect classes, compatibility fields, filters and truncation', async t => {
  const { vault } = await disposableVault(t);
  const source = await vault.put({ scope: wiki, kind: 'note', title: 'source', body: 'The service deploys every Thursday.' });
  const compiled = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Build cadence', body: '## Heading\n\nThe service deploys every Thursday [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId, span: 'not present' }], links: [{ type: 'derived_from', target: source.uri, revisionId: source.revisionId }], tags: ['Release Notes'] });
  await vault.patch({ objectId: source.id, expectedRevisionId: source.revisionId, body: 'The service now deploys every Monday.' });
  await vault.put({ scope: wiki, kind: 'wiki_page', title: ' build-cadence ', body: compiled.body, tags: ['release_notes'] });
  await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Uncited', body: 'Unique body with an uncited claim that is more than thirty characters long.', evidence: [{ uri: 'mdb://objects/obj_hidden', revisionId: 'rev_hidden' }] });
  await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Broken', body: 'See [[Absent page]] and mdb://wiki/objects/obj_missing.' });
  await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Empty', body: '# Heading only\n\n   ' });
  const result = await lintWiki(vault);
  const codes = new Set(result.issues.map(issue => issue.issue));
  for (const code of ['missing_evidence', 'evidence_span_not_found', 'broken_wikilink', 'dangling_reference', 'orphan_page', 'duplicate_title', 'duplicate_content', 'stale_source', 'empty_page']) assert.ok(codes.has(code as never), `expected ${code}`);
  assert.equal(result.semanticTruthVerified, false); assert.equal(result.checked, 6);
  const unresolvedDoc = { ...compiled, id: 'obj_lint', evidence: [{ uri: 'mdb://objects/obj_hidden', revisionId: 'rev_hidden' }] };
  const unresolved = await lintWiki({ listDocuments: async () => [unresolvedDoc], get: async () => { throw new Error('inaccessible'); } } as never);
  assert.equal(unresolved.issues[0]?.issue, 'unresolved_or_inaccessible_evidence');
  const uncitedDoc = { ...unresolvedDoc, id: 'obj_uncited', body: 'A substantive claim that is more than thirty characters long without citation.' };
  const uncited = await lintWiki({ listDocuments: async () => [uncitedDoc], get: async () => compiled } as never);
  assert.ok(uncited.issues.some(i => i.issue === 'uncited_claim'));
  assert.ok(result.issues.every(i => ['error', 'warning', 'info'].includes(i.severity) && i.message && i.suggestedAction));
  assert.ok(result.summary.bySeverity.warning > 0); assert.equal(result.truncated, false);
  const duplicateTitle = result.issues.filter(issue => issue.issue === 'duplicate_title'); assert.equal(duplicateTitle.length, 1); assert.equal(duplicateTitle[0]?.memberObjectIds?.length, 2);
  const limited = await lintWiki(vault, { limit: 1 }); assert.equal(limited.issues.length, 1); assert.equal(limited.truncated, true);
  const errors = await lintWiki(vault, { minSeverity: 'error' }); assert.ok(errors.issues.every(i => i.severity === 'error'));
  const selected = await lintWiki(vault, { checks: ['empty_page'] }); assert.ok(selected.issues.length > 0 && selected.issues.every(i => i.issue === 'empty_page'));
  const zero = await lintWiki(vault, { limit: 0 }); assert.equal(zero.issues.length, 0); assert.equal(zero.truncated, true);
  void compiled;
});

test('wiki lint ACL result matches a vault without hidden documents and never leaks hidden duplicate/backlink details', async t => {
  const { root, vault: owner } = await disposableVault(t); await owner.createWorkspace('secret', '');
  const visible: Scope = wiki, hidden: Scope = { type: 'workspace', workspaceId: 'secret' };
  const page = await owner.put({ scope: visible, kind: 'wiki_page', title: 'Visible title', body: 'A visible claim with more than enough characters to be uncited.' });
  await owner.put({ scope: hidden, kind: 'wiki_page', title: 'Visible title', body: page.body, links: [{ type: 'related', target: page.uri }] });
  const guest = new Vault(root, { actorId: 'guest', permissions: ['global:wiki:read'] });
  const result = await lintWiki(guest, { scopes: [visible, hidden] });
  const isolated = await disposableVault(t); const isolatedPage = await isolated.vault.put({ scope: visible, kind: 'wiki_page', title: 'Visible title', body: page.body });
  const control = await lintWiki(isolated.vault, { scopes: [visible] });
  const shape = (r: Awaited<ReturnType<typeof lintWiki>>) => ({
    checked: r.checked,
    issues: r.issues.map(i => ({ ...i, objectId: '<visible>', ...(i.memberObjectIds ? { memberObjectIds: i.memberObjectIds.map(() => '<visible>') } : {}), ...(i.relatedObjectIds ? { relatedObjectIds: i.relatedObjectIds.map(() => '<visible>') } : {}) })),
    semanticTruthVerified: r.semanticTruthVerified,
    summary: r.summary,
    truncated: r.truncated
  });
  assert.deepEqual(shape(result), shape(control)); assert.equal(result.checked, 1);
  assert.ok(!JSON.stringify(result).includes(isolatedPage.id)); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.issues.some(i => i.issue === 'duplicate_title' || i.issue === 'duplicate_content'), false);
});

test('wiki lint ignores deleted pages and normalizes tags consistently', async t => {
  const { vault } = await disposableVault(t);
  const live = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Live', body: 'An active page with substantive text and evidence [1].', tags: ['Release Notes'] });
  await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Tag variant', body: 'A second page body with a different statement [1].', tags: ['release_notes'] });
  await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Deleted', body: 'duplicate content', tags: ['release_notes'] }).then(d => vault.delete(d.id, d.revisionId));
  const result = await lintWiki(vault); assert.ok(result.issues.some(i => i.issue === 'tag_inconsistency' && i.objectId === live.id));
  assert.ok(!result.issues.some(i => i.issue === 'duplicate_content'));
  const source = await vault.put({ scope: wiki, kind: 'note', title: 'old source', body: 'Old source body supports this.' });
  const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Page with deleted source', body: 'A sufficiently long assertion that should be supported by deleted evidence [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }], links: [{ type: 'derived_from', target: source.uri, revisionId: source.revisionId }] });
  await vault.delete(source.id, source.revisionId);
  const deletedSourceResult = await lintWiki(vault); assert.ok(deletedSourceResult.issues.some(i => i.objectId === page.id && i.issue === 'source_deleted'));
});

test('inline code spans pair exact delimiter lengths without hiding later wikilinks', async () => {
  const page: Document = { id: 'obj_inline', revisionId: 'rev_inline', revisionNumber: 1, scope: wiki, kind: 'wiki_page', title: 'Inline spans', body: '`code ``inside` then `` [[Missing after code]].', tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: 'mdb://wiki/objects/obj_inline' };
  const result = await lintWiki({ listDocuments: async () => [page], get: async () => { throw new Error('unused'); } } as never, { checks: ['broken_wikilink'] });
  assert.deepEqual(result.issues.map(issue => issue.issue), ['broken_wikilink']);
});

test('wiki lint reports unreadable structured and evidence refs without exposing their target or count', async t => {
  const { root, vault: owner } = await disposableVault(t);
  await owner.createWorkspace('private', '');
  const privateScope: Scope = { type: 'workspace', workspaceId: 'private' };
  const hidden = await owner.put({ scope: privateScope, kind: 'note', title: 'Private source title', body: 'Private source content.' });
  const page = await owner.put({ scope: wiki, kind: 'wiki_page', title: 'Public page', body: 'A public statement with enough words to be meaningful.', evidence: [{ uri: hidden.uri, revisionId: hidden.revisionId }], links: [{ type: 'related', target: hidden.uri }] });
  const guest = new Vault(root, { actorId: 'wiki-reader', permissions: ['global:wiki:read'] });
  const result = await lintWiki(guest);
  assert.ok(result.issues.some(issue => issue.objectId === page.id && issue.issue === 'unresolved_or_inaccessible_evidence'));
  assert.ok(result.issues.some(issue => issue.objectId === page.id && issue.issue === 'dangling_reference'));
  assert.equal(JSON.stringify(result).includes(hidden.id), false);
  assert.equal(JSON.stringify(result).includes(hidden.title), false);
  const ordinaryRead = await guest.listDocuments();
  assert.deepEqual(ordinaryRead.find(doc => doc.id === page.id)?.evidence, []);
  assert.deepEqual(ordinaryRead.find(doc => doc.id === page.id)?.links, []);
});

test('wiki lint scales linearly across 2,000 pages', async () => {
  const docs = Array.from({ length: 2000 }, (_, i) => ({ id: `obj_${i}`, revisionId: `rev_${i}`, revisionNumber: 1, scope: wiki, kind: 'wiki_page', title: `Page ${i}`, body: `Distinct page body ${i} with useful factual material.`, tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: `mdb://wiki/objects/obj_${i}` }));
  const start = performance.now(); const result = await lintWiki({ listDocuments: async () => docs, get: async () => { throw new Error('unused'); } } as never); const elapsed = performance.now() - start;
  assert.equal(result.checked, 2000); assert.ok(elapsed < 10000, `lint took ${elapsed.toFixed(0)} ms`);
});

test('wiki lint bounds duplicate member details and output for 50,000 pages', async () => {
  const docs = Array.from({ length: 50_000 }, (_, i) => ({ id: `obj_${i.toString().padStart(5, '0')}`, revisionId: `rev_${i}`, revisionNumber: 1, scope: wiki, kind: 'wiki_page', title: 'Same title', body: 'Same duplicate body.', tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: `mdb://wiki/objects/obj_${i}` }));
  const start = performance.now();
  const result = await lintWiki({ listDocuments: async () => docs, get: async () => { throw new Error('unused'); } } as never, { limit: 100 });
  const elapsed = performance.now() - start;
  const duplicate = result.issues.find(issue => issue.issue === 'duplicate_content');
  assert.equal(result.checked, 50_000); assert.equal(result.issues.length, 100); assert.equal(result.truncated, true);
  assert.equal(duplicate?.memberCount, 50_000); assert.equal(duplicate?.membersTruncated, true);
  assert.equal(duplicate?.memberObjectIds?.length, 100); assert.equal(duplicate?.relatedObjectIds?.length, 99);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100_000); assert.ok(elapsed < 60_000, `lint took ${elapsed.toFixed(0)} ms`);
  recordCase({ suite: 'wiki', name: 'wiki-lint-50k-output-bounded', status: 'PASS' });
});

test('wiki lint skips oversized body checks promptly and bounds pathological delimiters', async () => {
  const fragments = ['`'.repeat(180_000), '~'.repeat(180_000), '[['.repeat(100_000), ']('.repeat(100_000), 'mdb://wiki/objects/obj_missing '.repeat(5_000), 'x'.repeat(300_000)];
  const body = fragments.join('').slice(0, 900 * 1024);
  const doc = { id: 'obj_pathological', revisionId: 'rev_pathological', revisionNumber: 1, scope: wiki, kind: 'wiki_page', title: 'Pathological', body, tags: Array.from({ length: 20_000 }, (_, i) => `tag-${i}`), links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: 'mdb://wiki/objects/obj_pathological' } satisfies Document;
  const start = performance.now();
  const second = { ...doc, id: 'obj_pathological_2', revisionId: 'rev_pathological_2', title: 'Pathological copy', uri: 'mdb://wiki/objects/obj_pathological_2' };
  const result = await lintWiki({ listDocuments: async () => [doc, second], get: async () => { throw new Error('unused'); } } as never);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1_000, `oversized pathological lint took ${elapsed.toFixed(1)} ms`);
  assert.ok(result.issues.some(issue => issue.issue === 'page_too_large_for_body_checks' && issue.severity === 'info'));
  assert.equal(result.issues.some(issue => ['broken_wikilink', 'dangling_reference', 'empty_page', 'uncited_claim'].includes(issue.issue)), false);
  assert.equal(result.issues.some(issue => issue.issue === 'duplicate_content'), false, 'content-level duplicate checks are also skipped above the size threshold');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10_000);
  const unicodeBody = { ...doc, id: 'obj_unicode_large', revisionId: 'rev_unicode_large', title: 'Unicode large', body: 'é'.repeat(102_401), uri: 'mdb://wiki/objects/obj_unicode_large' };
  assert.ok(unicodeBody.body.length < 200 * 1024 && Buffer.byteLength(unicodeBody.body) > 200 * 1024);
  const unicodeResult = await lintWiki({ listDocuments: async () => [unicodeBody], get: async () => { throw new Error('unused'); } } as never);
  assert.ok(unicodeResult.issues.some(issue => issue.objectId === unicodeBody.id && issue.issue === 'page_too_large_for_body_checks'), 'the 200 KiB limit is measured in UTF-8 bytes');
  recordCase({ suite: 'wiki', name: 'wiki-lint-900kb-body-check-cutoff', status: 'PASS' });
});

test('scope filters lint targets while readable cross-scope wiki links still resolve', async () => {
  const global: Document = { id: 'obj_global', revisionId: 'rev_global', revisionNumber: 1, scope: wiki, kind: 'wiki_page', title: 'Global target', body: 'A global page.', tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: 'mdb://wiki/objects/obj_global' };
  const workspaceScope: Scope = { type: 'workspace', workspaceId: 'project' };
  const local: Document = { ...global, id: 'obj_local', revisionId: 'rev_local', scope: workspaceScope, title: 'Local page', body: 'Read [[Global target]] for details.', uri: 'mdb://objects/obj_local' };
  const result = await lintWiki({ listDocuments: async () => [global, local], get: async () => global }, { scopes: [workspaceScope], checks: ['broken_wikilink'] } as never);
  assert.equal(result.checked, 1); assert.deepEqual(result.issues, []);
});

test('orphan lint exempts overview pages and counts structured links and alias wikilinks as inbound', async () => {
  const source: Document = { id: 'obj_source', revisionId: 'rev_source', revisionNumber: 1, scope: wiki, kind: 'note', title: 'Source', body: 'The cadence stays weekly.', tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: 'mdb://wiki/objects/obj_source' };
  const makePage = (id: string, title: string, body: string, extra: Partial<Document> = {}): Document => ({ ...source, id, revisionId: `rev_${id}`, kind: 'wiki_page', title, body, evidence: [{ uri: source.uri, revisionId: source.revisionId, span: 'cadence stays weekly' }], links: [], metadata: {}, uri: `mdb://wiki/objects/${id}`, ...extra });
  const overview = makePage('obj_overview', 'Project overview', '## Summary\n\nThe cadence stays weekly [1].');
  const structuredTarget = makePage('obj_structured', 'Structured target', 'The cadence stays weekly [1].');
  const aliasTarget = makePage('obj_alias', 'Alias target', 'The cadence stays weekly [1].', { metadata: { aliases: ['Legacy alias'] } });
  const links = makePage('obj_links', 'Links', 'The cadence stays weekly [1]. See [[Legacy alias|old name]].', { links: [{ type: 'related', target: structuredTarget.uri }] });
  const result = await lintWiki({ listDocuments: async () => [source, overview, structuredTarget, aliasTarget, links], get: async () => source } as never);
  assert.deepEqual(result.issues.filter(issue => issue.issue === 'orphan_page').map(issue => issue.objectId), ['obj_links']);
  assert.deepEqual(result.issues.filter(issue => issue.issue === 'broken_wikilink'), []);
  const isolated = makePage('obj_isolated', 'Isolated', 'The cadence stays weekly [1].');
  const withOrphan = await lintWiki({ listDocuments: async () => [source, overview, structuredTarget, aliasTarget, links, isolated], get: async () => source } as never);
  assert.deepEqual(withOrphan.issues.filter(issue => issue.issue === 'orphan_page').map(issue => issue.objectId), ['obj_links', 'obj_isolated']);
});

test('wiki lint CLI JSON and MCP tool use the actor-bound deterministic linter', async t => {
  const { root, vault } = await disposableVault(t); const page = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Lint me', body: '' });
  const cli = await execute(['wiki', 'lint', '--scope', 'wiki', '--check', 'empty_page', '--root', root, '--json']) as Awaited<ReturnType<typeof lintWiki>>;
  assert.equal(cli.issues.length, 1); assert.equal(cli.issues[0]?.issue, 'empty_page'); assert.equal(cli.issues[0]?.objectId, page.id);
  const client = new Engram(root); const tools = toolsFor(client); const tool = tools.find(item => item.name === 'mdb_wiki_lint'); assert.ok(tool);
  const mcp = await tool!.execute({ scopes: [wiki], checks: ['empty_page'], limit: 20 }) as Awaited<ReturnType<typeof lintWiki>>;
  assert.deepEqual(mcp.issues.map(issue => issue.issue), ['empty_page']);
  assert.ok(tool!.inputSchema.properties?.checks); assert.equal(tool!.inputSchema.additionalProperties, false);
  await vault.createWorkspace('hidden', ''); await vault.put({ scope: { type: 'workspace', workspaceId: 'hidden' }, kind: 'wiki_page', title: 'Secret title', body: '' });
  const guest = new Engram(root, { actorId: 'guest', permissions: [] }); const guestTool = toolsFor(guest).find(item => item.name === 'mdb_wiki_lint')!;
  const denied = await guestTool.execute({ scopes: [{ type: 'workspace', workspaceId: 'hidden' }] }) as Awaited<ReturnType<typeof lintWiki>>;
  assert.equal(denied.checked, 0); assert.equal(JSON.stringify(denied).includes('Secret title'), false);
  const { stdout } = await execFileAsync(process.execPath, ['bin/mdb.js', 'wiki', 'lint', '--scope', 'wiki', '--check', 'empty_page', '--root', root, '--json']);
  const parsed = JSON.parse(stdout) as Awaited<ReturnType<typeof lintWiki>>; assert.equal(parsed.issues[0]?.issue, 'empty_page');
  const remote = await mapCommand('wiki', ['wiki', 'lint'], { scope: 'wiki,workspace:proj', check: 'empty_page,orphan_page', 'min-severity': 'warning', limit: '25' });
  assert.deepEqual(remote, { tool: 'mdb_wiki_lint', input: { scopes: [wiki, { type: 'workspace', workspaceId: 'proj' }], checks: ['empty_page', 'orphan_page'], minSeverity: 'warning', limit: 25 } });
});

test('CLI accumulates repeated equals and separate scope/check forms and accepts equals scalar options', async t => {
  const { root } = await disposableVault(t);
  const original = Engram.prototype.wikiLint;
  let received: unknown;
  Engram.prototype.wikiLint = async function (options) { received = options; return { checked: 0, issues: [], semanticTruthVerified: false, summary: { byCode: {}, bySeverity: { error: 0, warning: 0, info: 0 } }, truncated: false }; };
  try {
    await execute(['wiki', 'lint', '--scope=wiki', '--scope', 'workspace:alpha', '--scope=global:shared', '--check=empty_page', '--check', 'orphan_page', '--check=missing_evidence', '--min-severity=warning', '--limit=17', '--root', root, '--json']);
  } finally {
    Engram.prototype.wikiLint = original;
  }
  assert.deepEqual(received, {
    scopes: [wiki, { type: 'workspace', workspaceId: 'alpha' }, { type: 'global', area: 'shared' }],
    checks: ['empty_page', 'orphan_page', 'missing_evidence'],
    minSeverity: 'warning',
    limit: 17
  });
});
