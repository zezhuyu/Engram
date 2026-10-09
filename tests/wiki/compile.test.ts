import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { lintCitations } from '../../packages/intelligence/wiki.js';
import type { Document, ModelProposal, ModelProvider, ModelRequest, Scope } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
const wiki: Scope = { type: 'global', area: 'wiki' };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function world(t: T) {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', ''); await vault.createWorkspace('secret', '');
  const ingest = async (name: string, text: string, scope: Scope = wiki) => { const file = path.join(root, `${name}.md`); await fs.writeFile(file, text); const doc = await vault.ingest(file, scope); const original = path.join(root, String(doc.metadata.originalPath)); return { doc, original, hash: sha(await fs.readFile(original)) }; };
  return { root, vault, ingest };
}
/** A deterministic compiler: updates the supplied page if there is one (carrying its text, citing the page for old claims and the source for new ones), otherwise creates a page. */
function compiler(over: Partial<ModelProposal> = {}, seen: ModelRequest[] = []): ModelProvider & { calls: ModelRequest[] } {
  return { id: 'fake-compiler', calls: seen, async generate(req) {
    seen.push(req); const source = req.documents.find(d => d.kind === 'source')!; const page = req.documents.find(d => d.kind === 'wiki_page');
    const claim = source.body.split('\n').find(l => l.trim() && !l.startsWith('#'))!.trim();
    const evidence = page ? [{ uri: page.uri, revisionId: page.revisionId, span: page.body.split('\n').find(l => l.trim() && !l.startsWith('#'))!.trim().slice(0, 60) }, { uri: source.uri, revisionId: source.revisionId, span: claim.slice(0, 60) }] : [{ uri: source.uri, revisionId: source.revisionId, span: claim.slice(0, 60) }];
    const carried = page ? `${page.body.split('\n').find(l => l.trim() && !l.startsWith('#'))!.trim()} [1]\n\n` : '';
    const fresh = `${claim} [${page ? 2 : 1}]`;
    return { kind: 'wiki_page', title: page ? page.title : `About ${source.title}`, body: `# ${page ? page.title : source.title}\n\n${carried}${fresh}`, evidence, ...(page ? { metadata: { targetPageId: page.id } } : {}), ...over } as ModelProposal; } };
}
const compile = async (engine: IntelligenceEngine, ...ids: string[]) => { await engine.enqueue('wiki', { scope: wiki, objectIds: ids }); return engine.run({ job: 'wiki', limit: 5 }); };
const pages = async (vault: Vault) => (await vault.listDocuments()).filter(d => d.kind === 'wiki_page');

test('a new source becomes a cited, reviewable page with dependency edges; the original bytes never change', async t => {
  const w = await world(t); const a = await w.ingest('cache-notes', '# Cache notes\n\nCache invalidation must happen when the tenant configuration changes.\n');
  const provider = compiler(); const engine = new IntelligenceEngine(w.vault, provider);
  await engine.run({ limit: 10 }); // the source event itself queues the compile job
  assert.equal(provider.calls.length, 1); assert.deepEqual(provider.calls[0]!.documents.map(d => d.id), [a.doc.id], 'a first source has no existing pages to consider');
  const proposal = (await engine.proposals()).find(p => p.input.kind === 'wiki_page')!; assert.equal(proposal.status, 'pending');
  assert.deepEqual(proposal.input.links, [{ type: 'derived_from', target: a.doc.uri, revisionId: a.doc.revisionId }], 'dependency edges are derived by the engine, not taken from model text');
  assert.equal((await pages(w.vault)).length, 0, 'nothing is committed before review');
  const page = await w.vault.get((await engine.review(proposal.id, true)).objectId!);
  assert.match(page.body, /\[1\]/); assert.equal(page.links[0]!.target, a.doc.uri); assert.deepEqual(page.metadata.sourceIds, [a.doc.id]); assert.equal(page.evidence[0]!.uri, a.doc.uri);
  assert.equal(sha(await fs.readFile(a.original)), a.hash, 'the imported original is byte-identical'); assert.equal((await w.vault.verify()).ok, true);
  recordCase({ suite: 'wiki', name: 'source-to-page', status: 'PASS' });
});

test('incremental compile: a related source updates only the affected page as a new revision; unrelated pages and the rest of the wiki are untouched', async t => {
  const w = await world(t);
  const s1 = await w.ingest('cache', '# Caching\n\nCache invalidation is triggered by configuration changes.\n'), s2 = await w.ingest('auth', '# OAuth\n\nOAuth refresh tokens expire after thirty days of inactivity.\n');
  const seed = new IntelligenceEngine(w.vault, compiler());
  for (const s of [s1, s2]) { await compile(seed, s.doc.id); const p = (await seed.proposals()).filter(x => x.status === 'pending').at(-1)!; await seed.review(p.id, true); }
  const cachePage = (await pages(w.vault)).find(p => /cache\.md/.test(p.title))!, authPage = (await pages(w.vault)).find(p => /auth\.md/.test(p.title))!;
  for (let i = 0; i < 20; i++) await w.vault.put({ scope: wiki, kind: 'wiki_page', title: `Unrelated page ${i}`, body: `Page about gardening topic number ${i}.` });
  const b = await w.ingest('ttl', '# Cache TTL\n\nCache invalidation can also be driven by a time to live on each entry.\n');
  const provider = compiler(); const engine = new IntelligenceEngine(w.vault, provider);
  await compile(engine, b.doc.id);
  const supplied = provider.calls[0]!.documents.map(d => d.id);
  assert.ok(supplied.includes(b.doc.id) && supplied.includes(cachePage.id), 'the new source and the page about the same topic were supplied');
  assert.ok(!supplied.includes(authPage.id), 'the unrelated OAuth page was not supplied'); assert.ok(supplied.length <= 4, `bounded context, not the whole wiki (${supplied.length} documents of ${(await w.vault.listDocuments()).length})`);
  const proposal = (await engine.proposals()).at(-1)!; assert.equal(proposal.input.metadata!.targetPageId, cachePage.id); assert.equal(proposal.input.metadata!.targetRevisionId, cachePage.revisionId);
  const updated = await w.vault.get((await engine.review(proposal.id, true)).objectId!);
  assert.equal(updated.id, cachePage.id, 'the same page, not a copy'); assert.equal(updated.revisionNumber, cachePage.revisionNumber + 1);
  assert.equal((await w.vault.get(cachePage.id, cachePage.revisionId)).body, cachePage.body, 'the earlier revision is preserved');
  assert.ok(updated.links.some(l => l.target === s1.doc.uri) && updated.links.some(l => l.target === b.doc.uri), 'old and new dependencies are both kept');
  assert.deepEqual([...(updated.metadata.sourceIds as string[])].sort(), [s1.doc.id, b.doc.id].sort());
  const authAfter = await w.vault.get(authPage.id); assert.equal(authAfter.revisionId, authPage.revisionId, 'the unrelated page has no new revision');
  for (const s of [s1, s2, b]) assert.equal(sha(await fs.readFile(s.original)), s.hash);
  recordCase({ suite: 'wiki', name: 'incremental-affected-page', status: 'PASS', detail: { suppliedDocuments: supplied.length } });
});

test('dependency edges find affected pages without keyword overlap, and a source on a new topic creates a new page', async t => {
  const w = await world(t);
  const d = await w.ingest('deploy', '# Zebra procedure\n\nThe release train departs every second Tuesday.\n');
  const dependent = await w.vault.put({ scope: wiki, kind: 'wiki_page', title: 'Completely different words', body: 'Rollout cadence summary.', links: [{ type: 'derived_from', target: d.doc.uri, revisionId: d.doc.revisionId }] });
  const provider = compiler(); const engine = new IntelligenceEngine(w.vault, provider);
  await compile(engine, d.doc.id);
  assert.ok(provider.calls[0]!.documents.some(x => x.id === dependent.id), 'a page that derives from the source is affected even though the words differ');
  const novel = await w.ingest('quantum', '# Quantum error correction\n\nSurface codes protect logical qubits against local noise.\n');
  const fresh = compiler(); const second = new IntelligenceEngine(w.vault, fresh); await compile(second, novel.doc.id);
  assert.deepEqual(fresh.calls[0]!.documents.map(x => x.id), [novel.doc.id], 'nothing related exists: only the source is supplied');
  const created = await w.vault.get((await second.review((await second.proposals()).at(-1)!.id, true)).objectId!);
  assert.match(created.title, /quantum\.md/); assert.equal((await pages(w.vault)).filter(p => /quantum\.md/.test(p.title)).length, 1);
  recordCase({ suite: 'wiki', name: 'dependency-edges-and-new-topic', status: 'PASS' });
});

test('citation lint and target validation: uncited claims, bad citation numbers, unsupplied or source-less targets never become knowledge', async t => {
  assert.equal(lintCitations('# T\n\nA sourced statement that is long enough to need a citation [1].\n\nAn own conclusion that is long enough to count as a claim (inference).', 1).ok, true);
  assert.equal(lintCitations('A statement that is long enough to need a citation but has none.', 1).ok, false);
  assert.match(lintCitations('A statement long enough to need a citation and cites a missing entry [3].', 2).problems[0]!, /does not refer to an evidence entry/);
  assert.equal(lintCitations('# Only a heading\n\n---', 1).ok, false);
  assert.equal(lintCitations('A claim long enough to need a citation here [1].\n\n- What was the baseline configuration behind the measured figure?\n- Did the cold cache case differ from the warm one at all?', 1).ok, true, 'open questions are not claims');
  assert.equal(lintCitations('- The first statement is long enough to need a citation [1].\n- The second statement is also long enough to need a citation.', 1).ok, false, 'each list item is judged on its own');
  const w = await world(t); const s = await w.ingest('s', '# Source\n\nThe sky over the harbour turns orange at dusk in autumn.\n'); const other = await w.vault.put({ scope: wiki, kind: 'wiki_page', title: 'Not supplied', body: 'Some other page body text here.' });
  const attempt = async (over: Partial<ModelProposal>) => { const e = new IntelligenceEngine(w.vault, compiler(over)); const jobs = await compile(e, s.doc.id); return { jobs, proposals: await e.proposals() }; };
  const uncited = await attempt({ body: '# Page\n\nThe sky over the harbour turns orange at dusk in autumn.' }); assert.equal(uncited.proposals.at(-1)!.status, 'rejected'); assert.ok(uncited.proposals.at(-1)!.flags!.includes('uncited_claims'));
  const outOfRange = await attempt({ body: '# Page\n\nThe sky over the harbour turns orange at dusk in autumn [4].' }); assert.ok(outOfRange.proposals.at(-1)!.reason!.includes('does not refer'));
  const wrongTarget = await attempt({ metadata: { targetPageId: other.id } }); assert.equal(wrongTarget.jobs[0]!.status, 'dead_letter'); assert.match(wrongTarget.jobs[0]!.error!, /not supplied/);
  const fabricated = await attempt({ evidence: [{ uri: s.doc.uri, revisionId: 'rev_doesnotexist', span: 'x' }] }); assert.equal(fabricated.jobs[0]!.status, 'dead_letter');
  const pageOnly = new IntelligenceEngine(w.vault, { id: 'p', async generate({ documents }) { const pg = documents.find(d => d.kind === 'wiki_page') ?? documents[0]!; return { kind: 'wiki_page', title: 'X', body: 'A claim that only cites the page itself and nothing else [1].', evidence: [{ uri: pg.uri, revisionId: pg.revisionId }], metadata: { targetPageId: pg.id } } as ModelProposal; } });
  const onlyPage = await w.vault.put({ scope: wiki, kind: 'wiki_page', title: 'Harbour sky', body: 'Notes about the harbour sky.' });
  await pageOnly.enqueue('wiki', { scope: wiki, objectIds: [s.doc.id] }); const r = await pageOnly.run({ job: 'wiki', limit: 3 }); void onlyPage; assert.equal(r[0]!.status === 'dead_letter' || (await pageOnly.proposals()).at(-1)?.status === 'rejected', true);
  assert.equal((await pages(w.vault)).length, 2, 'no rejected or dead-lettered output became a page');
  recordCase({ suite: 'wiki', name: 'citation-lint-and-targets', status: 'PASS' });
});

test('privacy and consistency: private sources are never compiled into the global wiki, a page that changed since compilation is not overwritten, repeated events are idempotent', async t => {
  const w = await world(t);
  const priv = await w.ingest('private-notes', '# Private\n\nThe confidential merger closes in March.\n', { type: 'workspace', workspaceId: 'secret' });
  const pub = await w.ingest('public', '# Public\n\nThe public roadmap lists three milestones.\n');
  const provider = compiler(); const engine = new IntelligenceEngine(w.vault, provider);
  await engine.run({ limit: 20 });
  for (const call of provider.calls) for (const d of call.documents) assert.ok(!/confidential merger/.test(d.body) || d.scope.type === 'workspace', 'private text only reaches jobs scoped to its own workspace');
  assert.ok(!provider.calls.some(c => c.documents.some(d => d.scope.type === 'workspace') && c.documents.some(d => d.scope.type === 'global' && d.kind === 'wiki_page')), 'a workspace compile never mixes in global pages');
  const workspaceProposal = (await engine.proposals()).find(p => p.input.scope.type === 'workspace'); assert.ok(workspaceProposal, 'the private source compiles inside its own workspace'); assert.equal((workspaceProposal!.input.scope as { workspaceId: string }).workspaceId, 'secret');
  const globalPages = (await engine.proposals()).filter(p => p.input.scope.type === 'global'); assert.ok(globalPages.every(p => !JSON.stringify(p.input).includes('merger')), 'nothing about the private source appears in a global proposal');
  // idempotent events
  const before = (await engine.proposals()).length; await engine.run({ limit: 20 }); await compile(engine, pub.doc.id); await compile(engine, pub.doc.id); assert.equal((await engine.proposals()).length, before, 'the same source compiled again is the same proposal');
  // stale page
  const approve = (await engine.proposals()).find(p => p.input.scope.type === 'global' && p.status === 'pending')!; const page = await w.vault.get((await engine.review(approve.id, true)).objectId!);
  const more = await w.ingest('public-more', '# Public roadmap\n\nThe public roadmap also lists a fourth milestone for autumn.\n');
  const e2 = new IntelligenceEngine(w.vault, compiler()); await compile(e2, more.doc.id); const update = (await e2.proposals()).at(-1)!; assert.equal(update.input.metadata!.targetPageId, page.id);
  await w.vault.patch({ objectId: page.id, expectedRevisionId: page.revisionId, body: page.body + '\n\nA human edit made while the proposal was waiting for review.' });
  const refused = await e2.review(update.id, true); assert.equal(refused.status, 'rejected'); assert.ok(refused.flags!.includes('page_changed'));
  assert.match((await w.vault.get(page.id)).body, /human edit/, 'the human edit survives; the stale proposal did not overwrite it');
  recordCase({ suite: 'wiki', name: 'privacy-staleness-idempotency', status: 'PASS' });
});

test('one bounded repair attempt: a model that fixes its citations is accepted, one that does not is still rejected, and there is never a loop', async t => {
  const w = await world(t); const s = await w.ingest('repair', '# Repair\n\nThe lighthouse keeper logs every passing ship before midnight.\n');
  const calls: string[] = [];
  const fixes: ModelProvider = { id: 'fixer', async generate({ documents, instruction }) { calls.push(instruction); const src = documents.find(d => d.kind === 'source')!; const repaired = /REJECTED by a mechanical citation check/.test(instruction); return { kind: 'wiki_page', title: 'Repair page', body: `# Repair\n\nThe lighthouse keeper logs every passing ship before midnight${repaired ? ' [1]' : ''}.`, evidence: [{ uri: src.uri, revisionId: src.revisionId, span: 'logs every passing ship' }] } as ModelProposal; } };
  const good = new IntelligenceEngine(w.vault, fixes); await compile(good, s.doc.id);
  assert.equal(calls.length, 2); assert.match(calls[1]!, /uncited claim/); assert.equal((await good.proposals()).at(-1)!.status, 'pending');
  const stubborn: string[] = []; const never: ModelProvider = { id: 'never', async generate({ documents, instruction }) { stubborn.push(instruction); const src = documents.find(d => d.kind === 'source')!; return { kind: 'wiki_page', title: 'Never', body: '# Never\n\nThe lighthouse keeper logs every passing ship before midnight.', evidence: [{ uri: src.uri, revisionId: src.revisionId, span: 'logs every passing ship' }] } as ModelProposal; } };
  const bad = new IntelligenceEngine(await (async () => { const v = new Vault(w.root, { actorId: 'other-actor', permissions: ['*'] }); return v; })(), never); await compile(bad, s.doc.id);
  assert.equal(stubborn.length, 2, 'exactly one repair attempt'); const last = (await bad.proposals()).at(-1)!; assert.equal(last.status, 'rejected'); assert.ok(last.flags!.includes('uncited_claims'));
  recordCase({ suite: 'wiki', name: 'bounded-repair', status: 'PASS' });
});
