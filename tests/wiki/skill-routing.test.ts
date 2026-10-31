import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { applyWikiSkillDelta, IntelligenceEngine, WIKI_SKILL_DIRECTIVES } from '../../packages/intelligence/index.js';
import { runSkill } from '../../packages/skills/index.js';
import type { Document, ModelProposal, ModelProvider, ModelRequest, Scope } from '../../packages/sdk/index.js';
import { Engram } from '../../packages/sdk/index.js';
import { toolsFor } from '../../packages/mcp/index.js';
import { execute } from '../../packages/cli/index.js';
import { generationMessages } from '../../packages/models/prompts.js';

type T = { after(fn: () => void | Promise<void>): void };
const scope: Scope = { type: 'global', area: 'wiki' };
const simple = (req: ModelRequest): ModelProposal => {
  const page = req.documents.find(doc => doc.kind === 'wiki_page');
  const skill = Object.keys(WIKI_SKILL_DIRECTIVES).find(key => req.instruction.startsWith(WIKI_SKILL_DIRECTIVES[key as keyof typeof WIKI_SKILL_DIRECTIVES]));
  const source = skill === 'wiki-page-compiler' ? (req.documents.find(doc => doc.kind !== 'wiki_page') ?? page)! : (page ?? req.documents[0]!);
  if (skill === 'cross-linker') {
    const target = req.documents.find(doc => doc.kind === 'wiki_page' && doc.id !== page?.id)!;
    const anchorText = page!.body.includes('Related astronomy') ? 'Related astronomy' : 'target sentence';
    return { kind: 'wiki_page', title: page!.title, body: 'delta', evidence: [{ uri: page!.uri, revisionId: page!.revisionId }], metadata: { targetPageId: page!.id, delta: { addLinks: [{ targetPageId: target.id, anchorText }] } } };
  }
  if (skill === 'tag-taxonomy') return { kind: 'wiki_page', title: page!.title, body: 'delta', evidence: [{ uri: page!.uri, revisionId: page!.revisionId }], metadata: { targetPageId: page!.id, delta: { tagMapping: { 'AI-tools': 'ai tools' } } } };
  const body = page?.body ?? `# Source\n\nThis evidence-backed sentence is sufficiently detailed for citation [1].`;
  const tags = page?.tags ?? [];
  const links = page?.links ?? [];
  return { kind: 'wiki_page', title: page?.title ?? 'Compiled page', body,
    evidence: [{ uri: source.uri, revisionId: source.revisionId, span: source.body.trim().slice(0, 60) }],
    metadata: { ...(page ? { targetPageId: page.id } : {}) }, tags, links,
    };
};
function provider(calls: ModelRequest[], output: (req: ModelRequest) => ModelProposal = simple): ModelProvider {
  return { id: 'routing-test', async generate(req) { calls.push(req); return output(req); } };
}

test('wiki skills have distinct durable jobs and fixed, distinct provider directives', async t => {
  const { root, vault } = await disposableVault(t); const file = path.join(root, 'input.md'); await fs.writeFile(file, '# Input\n\nPrivate source sentence for the page.');
  const source = await vault.ingest(file, scope); const page = await vault.put({ scope, kind: 'wiki_page', title: 'Target', body: '# Target\n\nRelated astronomy is described here. This target sentence is long enough for citation [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }], tags: ['AI-tools', 'ai_tools'] });
  const related = await vault.put({ scope, kind: 'wiki_page', title: 'Related page', body: 'Related astronomy details.' });
  const calls: ModelRequest[] = []; const engine = new IntelligenceEngine(vault, provider(calls));
  const skills = ['wiki-page-compiler', 'wiki-update', 'wiki-maintenance', 'cross-linker', 'tag-taxonomy'] as const;
  const jobs = [];
  const { lintWiki } = await import('../../packages/intelligence/wiki-lint.js');
  const maintenanceIssue = (await lintWiki(vault)).issues.find(issue => issue.objectId === page.id)!;
  for (const skill of skills) jobs.push(await engine.enqueue('wiki', { scope, objectIds: [source.id, page.id, related.id], skill, ...(skill === 'wiki-page-compiler' ? {} : { targetPageId: page.id }), ...(skill === 'wiki-maintenance' ? { issues: [maintenanceIssue] } : {}) }));
  assert.equal(new Set(jobs.map(job => job.id)).size, skills.length);
  for (const job of jobs) await engine.run({ job: 'wiki', limit: 1 });
  assert.equal(calls.length, skills.length);
  for (let index = 0; index < skills.length; index++) {
    assert.ok(calls[index]!.instruction.startsWith(WIKI_SKILL_DIRECTIVES[skills[index]!]));
    assert.ok(!calls[index]!.instruction.includes('Private source sentence'), 'source text is data, not directive text');
  }
  const crossLinkPrompt = generationMessages(calls[3]!)[0]!.content;
  const tagPrompt = generationMessages(calls[4]!)[0]!.content;
  assert.match(crossLinkPrompt, /Cross-linker example:/);
  assert.match(crossLinkPrompt, /verbatim outside code blocks/);
  assert.match(tagPrompt, /Tag-taxonomy example:/);
  assert.match(tagPrompt, /return no change when there is no real normalization opportunity/);
  assert.equal(new Set(calls.map(call => call.instruction.split('\n')[0])).size, skills.length);
  const proposals = await engine.proposals();
  assert.ok(proposals.some(proposal => proposal.input.metadata?.skill === 'cross-linker'));
  const tagProposal = proposals.find(proposal => proposal.input.metadata?.skill === 'tag-taxonomy')!;
  assert.ok(tagProposal.input.metadata?.targetRevisionId, 'the engine binds the proposal to the supplied page revision');
  const reviewed = await engine.review(tagProposal.id, true);
  assert.equal(reviewed.status, 'approved', reviewed.reason ?? JSON.stringify(reviewed.flags));
  assert.equal((await vault.get(page.id)).tags[0], 'ai tools', 'review commits the normalized tags through Vault');
  recordCase({ suite: 'wiki', name: 'wiki-skill-routing-distinct-directives', status: 'PASS' });
});

test('wiki runSkill owns skill identity and rejects caller spoofing; target preflight is fail-closed', async t => {
  const { vault } = await disposableVault(t); const calls: ModelRequest[] = []; const engine = new IntelligenceEngine(vault, provider(calls));
  const context = { vault, search: { query: async () => ({ hits: [] }), rebuild: async () => {} }, intelligence: engine } as never;
  const page = await vault.put({ scope, kind: 'wiki_page', title: 'Target', body: 'A target page with enough content.' });
  await assert.rejects(runSkill('wiki-update', { scope, objectIds: [page.id], targetPageId: page.id, skill: 'cross-linker' }, context), /skill is selected by the skill registry/);
  await assert.rejects(engine.enqueue('wiki', { scope, objectIds: [], skill: 'wiki-update', targetPageId: 'missing' }), /accessible wiki_page/);
  assert.equal(calls.length, 0);
  recordCase({ suite: 'wiki', name: 'wiki-skill-preflight-and-spoof-protection', status: 'PASS' });
});

test('generic wiki schema failures receive one bounded repair and remain review-gated', async t => {
  const { vault } = await disposableVault(t);
  const source = await vault.put({ scope, kind: 'note', title: 'Source', body: 'A source statement with enough detail to support a compiled wiki page.' });
  const calls: ModelRequest[] = [];
  const p = provider(calls, req => {
    const valid = simple(req);
    if (calls.length === 1) return {
      ...valid,
      evidence: (valid.evidence ?? []).map(ref => ({ ...ref, evidenceSpan: ref.span })),
    } as unknown as ModelProposal;
    return valid;
  });
  const engine = new IntelligenceEngine(vault, p);
  const queued = await engine.enqueue('wiki', { scope, objectIds: [source.id], skill: 'wiki-page-compiler' });
  await engine.run({ job: 'wiki', jobId: queued.id, limit: 1 });

  const job = (await engine.jobs()).find(item => item.id === queued.id)!;
  const proposals = (await engine.proposals()).filter(item => item.input.metadata?.skill === 'wiki-page-compiler');
  assert.equal(calls.length, 2, 'one schema correction is allowed after malformed model output');
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.telemetry?.repairs, 1);
  assert.equal(proposals.length, 1, 'invalid output must not create a proposal');
  assert.equal(proposals[0]!.status, 'pending', 'a corrected proposal still requires human review');
  assert.equal((proposals[0]!.input.evidence ?? [])[0]?.span, source.body.slice(0, 60));

  recordCase({ suite: 'wiki', name: 'wiki-generic-schema-repair-review-gated', status: 'PASS' });
});

test('wiki-maintenance requires every issue to be a current finding on the accessible target', async t => {
  const { vault } = await disposableVault(t);
  const source = await vault.put({ scope, kind: 'note', title: 'Evidence', body: 'A sufficiently detailed source statement for the wiki page.' });
  const page = await vault.put({ scope, kind: 'wiki_page', title: 'Target', body: 'A target claim without a citation marker.', evidence: [{ uri: source.uri, revisionId: source.revisionId }] });
  const hiddenPageId = 'hidden-wiki-object';
  const { lintWiki } = await import('../../packages/intelligence/wiki-lint.js');
  const finding = (await lintWiki(vault)).issues.find(issue => issue.objectId === page.id && issue.issue === 'uncited_claim')!;
  const calls: ModelRequest[] = [];
  const engine = new IntelligenceEngine(vault, provider(calls, () => ({ kind: 'wiki_page', title: page.title, body: 'A target claim with a citation [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId, span: source.body }], metadata: { targetPageId: page.id }, tags: page.tags, links: page.links })));

  const rejected: Array<{ label: string; issues?: import('../../packages/intelligence/wiki-lint.js').WikiLintIssue[] }> = [
    { label: 'missing issues' },
    { label: 'empty issues', issues: [] },
    { label: 'stale issue', issues: [{ ...finding, issue: 'broken_wikilink' }] },
    { label: 'hidden object issue', issues: [{ ...finding, objectId: hiddenPageId }] }
  ];
  for (const item of rejected) {
    await assert.rejects(engine.enqueue('wiki', { scope, objectIds: [source.id, page.id], skill: 'wiki-maintenance', targetPageId: page.id, ...(item.issues === undefined ? {} : { issues: item.issues }) }), /wiki-maintenance/, item.label);
    assert.equal(calls.length, 0, `${item.label} must be rejected before provider invocation`);
  }

  const job = await engine.enqueue('wiki', { scope, objectIds: [source.id, page.id], skill: 'wiki-maintenance', targetPageId: page.id, issues: [finding] });
  await engine.run({ job: 'wiki', limit: 1 });
  assert.equal(calls.length, 1, 'valid current lint findings reach the provider once');
  assert.ok(calls[0]!.instruction.includes(JSON.stringify([finding])));
  const completedJob = (await engine.jobs()).find(item => item.id === job.id)!;
  assert.equal(completedJob.status, 'complete', completedJob.error);

  const queuedBeforeFix = await engine.enqueue('wiki', { scope, objectIds: [source.id, page.id], skill: 'wiki-maintenance', targetPageId: page.id, issues: [finding] });
  const currentPage = await vault.get(page.id);
  await vault.patch({ objectId: page.id, expectedRevisionId: currentPage.revisionId, body: 'A target claim with a citation [1].' });
  await engine.run({ job: 'wiki', jobId: queuedBeforeFix.id, limit: 1 });
  const staleAtExecution = (await engine.jobs()).find(item => item.id === queuedBeforeFix.id)!;
  assert.equal(staleAtExecution.status, 'pending');
  assert.match(staleAtExecution.error ?? '', /current lint findings/);
  assert.equal(calls.length, 1, 'an issue resolved after enqueue must be rejected before the provider call');
  recordCase({ suite: 'wiki', name: 'wiki-maintenance-issues-revalidated', status: 'PASS' });
});

test('wiki suite emitted cases are all declared in release inventory', async () => {
  const inventory = JSON.parse(await fs.readFile(path.join(process.cwd(), 'scripts/lib/suite-inventory.json'), 'utf8')) as { suites: { wiki: { requiredCases: string[] } } };
  const files = ['changes.test.ts', 'compile.test.ts', 'lint.test.ts', 'skill-routing.test.ts', 'legacy-vault.test.ts', 'http-cli-deployment.test.ts'];
  const emitted = new Set<string>();
  for (const file of files) {
    const source = await fs.readFile(path.join(process.cwd(), 'tests/wiki', file), 'utf8');
    for (const match of source.matchAll(/recordCase\(\{\s*suite:\s*'wiki',\s*name:\s*'([^']+)'/gu)) emitted.add(`wiki/${match[1]}`);
  }
  const declared = new Set(inventory.suites.wiki.requiredCases);
  assert.deepEqual([...emitted].filter(name => !declared.has(name)), [], 'every statically named wiki case emitted by recordCase must be inventoried');
});

test('skill constraints reject invalid repaired outputs without creating proposals', async t => {
  const { vault } = await disposableVault(t); const source = await vault.put({ scope, kind: 'note', title: 'Corpus tag', body: 'A source supports this sufficiently detailed claim for citation [1].', tags: ['ai_tools'] });
  const page = await vault.put({ scope, kind: 'wiki_page', title: 'Target', body: '# Target\n\nA sufficiently detailed target statement for citation [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }], tags: ['AI-tools'] });
  for (const skill of ['cross-linker', 'tag-taxonomy', 'wiki-update'] as const) {
    const calls: ModelRequest[] = [];
    const badProvider = provider(calls, req => ({ kind: 'wiki_page', title: page.title,
      body: skill === 'cross-linker' ? `${page.body}\n\nAdded prose outside the task [1].` : skill === 'tag-taxonomy' ? `${page.body}\n\nChanged prose [1].` : page.body,
      evidence: [{ uri: source.uri, revisionId: source.revisionId, span: source.body.slice(0, 30) }],
      ...(skill === 'wiki-update' ? { metadata: {} } : { metadata: { targetPageId: page.id } }),
      tags: page.tags, links: page.links }));
    const engine = new IntelligenceEngine(vault, badProvider);
    await engine.enqueue('wiki', { scope, objectIds: [source.id, page.id], skill, targetPageId: page.id });
    await engine.run({ job: 'wiki', limit: 1 });
    assert.equal(calls.length, 2, `${skill} receives at most one repair`);
    const jobId = (await engine.jobs()).find(job => job.input.skill === skill)!.id;
    const proposals = (await engine.proposals()).filter(proposal => proposal.input.kind === 'wiki_page' && proposal.input.metadata?.jobId === jobId);
    if (skill === 'cross-linker' || skill === 'tag-taxonomy') assert.ok(proposals.length === 1 && proposals[0]!.status === 'rejected' && proposals[0]!.flags?.includes('invalid_delta'));
    else assert.equal(proposals.length, 0);
  }
  recordCase({ suite: 'wiki', name: 'wiki-skill-invalid-output-rejected', status: 'PASS' });
});

test('compact wiki deltas insert links deterministically and reject invalid target, anchor, invented tag and stale page', async t => {
  const { vault } = await disposableVault(t);
  const page = await vault.put({ scope, kind: 'wiki_page', title: 'Delta target', body: 'A reference to Atlas guide appears here.\n\n```\nAtlas guide in code\n```', tags: ['AI-tools'] });
  const target = await vault.put({ scope, kind: 'wiki_page', title: 'Atlas guide', body: 'Target page.' });
  const runDelta = async (skill: 'cross-linker' | 'tag-taxonomy', delta: Record<string, unknown>) => {
    const currentPage = await vault.get(page.id);
    const calls: ModelRequest[] = [];
    const p = provider(calls, req => ({ kind: 'wiki_page', title: currentPage.title, body: 'delta', evidence: [{ uri: currentPage.uri, revisionId: currentPage.revisionId }], metadata: { targetPageId: currentPage.id, delta } }));
    const engine = new IntelligenceEngine(vault, p);
    const job = await engine.enqueue('wiki', { scope, objectIds: [page.id, target.id], skill, targetPageId: page.id, instruction: `Delta fixture ${JSON.stringify(delta)}` });
    await engine.run({ job: 'wiki', jobId: job.id, limit: 1 });
    return { engine, calls, jobId: job.id };
  };

  const valid = await runDelta('cross-linker', { addLinks: [{ targetPageId: target.id, anchorText: 'Atlas guide' }] });
  const linkProposal = (await valid.engine.proposals()).find(item => item.input.metadata?.skill === 'cross-linker')!;
  assert.ok(linkProposal, (await valid.engine.jobs()).map(item => `${item.status}: ${item.error ?? ''}`).join('; ')); assert.match(linkProposal.input.body, /\[\[Atlas guide\|Atlas guide\]\]/, JSON.stringify({ metadata: linkProposal.input.metadata, instruction: valid.calls[0]?.instruction }));
  assert.match(linkProposal.input.body, /```\nAtlas guide in code\n```/, 'fenced code is not linked');
  assert.ok(linkProposal.input.links?.some(link => link.target === target.uri));
  await vault.patch({ objectId: page.id, expectedRevisionId: page.revisionId, body: 'A concurrent human edit.' });
  const staleReview = await valid.engine.review(linkProposal.id, true);
  assert.equal(staleReview.status, 'rejected'); assert.ok(staleReview.flags?.includes('page_changed'), JSON.stringify({ status: staleReview.status, flags: staleReview.flags, reason: staleReview.reason }));

  for (const delta of [
    { addLinks: [{ targetPageId: target.id, anchorText: 'Missing anchor' }] },
    { addLinks: [{ targetPageId: 'obj_unknown', anchorText: 'Atlas guide' }] }
  ]) {
    const bad = await runDelta('cross-linker', delta);
    assert.equal(bad.calls.length, 2, 'invalid delta gets one bounded repair');
    const rejected = (await bad.engine.proposals()).find(item => item.input.metadata?.deterministicDeltaRejection === 'invalid_delta');
    assert.ok(rejected, JSON.stringify({ jobs: await bad.engine.jobs(), proposals: await bad.engine.proposals() }));
    assert.equal(rejected.status, 'rejected'); assert.ok(rejected.flags?.includes('invalid_delta'));
    assert.equal((await bad.engine.jobs()).find(item => item.id === bad.jobId)!.status, 'complete');
  }

  const invented = await runDelta('tag-taxonomy', { tagMapping: { 'AI-tools': 'invented category' } });
  assert.equal(invented.calls.length, 2);
  const rejectedTags = (await invented.engine.proposals()).find(item => item.input.metadata?.deterministicDeltaRejection === 'invalid_delta' && item.input.metadata?.skill === 'tag-taxonomy')!;
  assert.equal(rejectedTags.status, 'rejected'); assert.ok(rejectedTags.flags?.includes('invalid_delta'));
  const noChange = await runDelta('tag-taxonomy', { tagMapping: {} });
  assert.equal(noChange.calls.length, 2);
  const rejectedNoChange = (await noChange.engine.proposals()).find(item => item.input.metadata?.deterministicDeltaRejection === 'tag_delta_no_change')!;
  assert.equal(rejectedNoChange.status, 'rejected'); assert.ok(rejectedNoChange.flags?.includes('tag_delta_no_change'));
  recordCase({ suite: 'wiki', name: 'wiki-compact-delta-validation-and-stale-page', status: 'PASS' });
});

test('cross-link delta scanning stays bounded on a 900 KB delimiter-heavy page', async t => {
  const body = `prefix ${'`'.repeat(450_000)}${'~'.repeat(100_000)}${'[['.repeat(50_000)}${']('.repeat(50_000)}${'x'.repeat(200_000)} Anchor text appears once [1].`;
  assert.ok(Buffer.byteLength(body) >= 900 * 1024);
  const page = { id: 'obj_large', revisionId: 'rev_large', revisionNumber: 1, scope, kind: 'wiki_page', title: 'Large target page', body, tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: '', metadata: {}, path: '', uri: 'mdb://wiki/objects/obj_large' } satisfies Document;
  const target = { ...page, id: 'obj_destination', revisionId: 'rev_destination', title: 'Linked destination', body: 'Destination.', uri: 'mdb://wiki/objects/obj_destination' };
  const output: ModelProposal = { kind: 'wiki_page', title: page.title, body: 'compact', evidence: [], tags: [], links: [], metadata: { targetPageId: page.id, delta: { addLinks: [{ targetPageId: target.id, anchorText: 'Anchor text appears once' }] } } };
  const start = performance.now(); const result = applyWikiSkillDelta(output, 'cross-linker', page, [page, target]); const elapsed = performance.now() - start;
  assert.ok(elapsed < 1_000, `900 KB delta application took ${elapsed.toFixed(1)} ms`);
  assert.ok(result.body.includes('[[Linked destination|Anchor text appears once]]'));
  recordCase({ suite: 'wiki', name: 'wiki-compact-delta-adversarial-900kb-bounded', status: 'PASS' });
});

test('legacy persisted wiki jobs without skill load and execute as generic wiki jobs', async t => {
  const { root, vault } = await disposableVault(t); const file = path.join(root, 'legacy.md'); await fs.writeFile(file, 'Legacy source has enough text for a generated page.'); const source = await vault.ingest(file, scope);
  const key = createHash('sha256').update(JSON.stringify(vault.actor.actorId)).digest('hex');
  await fs.mkdir(path.join(root, '.mdb', 'intelligence'), { recursive: true });
  await fs.writeFile(path.join(root, '.mdb', 'intelligence', `${key}.json`), JSON.stringify({ cursor: 0, proposals: [], jobs: [{ id: 'legacy-job', kind: 'wiki', input: { scope, objectIds: [source.id] }, status: 'pending', attempts: 0, nextAt: 0 }] }));
  const calls: ModelRequest[] = []; const engine = new IntelligenceEngine(vault, provider(calls));
  assert.equal((await engine.jobs())[0]!.input.skill, undefined);
  await engine.run({ job: 'wiki', limit: 1 }); assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.instruction.includes(WIKI_SKILL_DIRECTIVES['wiki-page-compiler']));
  recordCase({ suite: 'wiki', name: 'wiki-legacy-job-without-skill', status: 'PASS' });
});

test('lint proposal dry run is side-effect free and exact duplicate retirement is idempotent', async t => {
  const { vault } = await disposableVault(t); const body = '# Same\n\nIdentical page body.';
  const first = await vault.put({ scope, kind: 'wiki_page', title: 'Same', body });
  const duplicate = await vault.put({ scope, kind: 'wiki_page', title: 'Same copy', body });
  const engine = new IntelligenceEngine(vault);
  const lint = await import('../../packages/intelligence/wiki-lint.js').then(module => module.lintWiki(vault));
  const dry = await engine.proposeFromLint({ issues: lint.issues, dryRun: true });
  assert.ok(dry.created.length >= 1); assert.equal((await engine.proposals()).length, 0); assert.deepEqual(await engine.jobs(), []);
  const result = await engine.proposeFromLint(lint.issues); const again = await engine.proposeFromLint(lint.issues);
  assert.ok(result.created.length > 0); assert.deepEqual(again.created.map(x => x.proposalId), result.created.map(x => x.proposalId));
  assert.ok((await engine.proposals()).every(proposal => proposal.status === 'pending'));
  const source = await vault.put({ scope, kind: 'note', title: 'Changing source', body: 'Source revision one.' });
  const dependent = await vault.put({ scope, kind: 'wiki_page', title: 'Derived', body: '# Derived\n\nA claim with a source citation [1].', evidence: [{ uri: source.uri, revisionId: source.revisionId }], links: [{ type: 'derived_from', target: source.uri, revisionId: source.revisionId }] });
  await vault.patch({ objectId: source.id, expectedRevisionId: source.revisionId, body: 'Source revision two.' });
  const stale = await engine.proposeFromLint(); assert.equal(stale.semanticExecutionAvailable, false); assert.ok(stale.created.some(item => item.objectId === dependent.id && item.action === 'enqueue wiki-maintenance'));
  assert.notEqual(first.id, duplicate.id);
  recordCase({ suite: 'wiki', name: 'wiki-proposals-from-lint-idempotent-dry-run', status: 'PASS' });
});

test('CLI and MCP expose bounded lint proposals with actor ACL parity', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.put({ scope, kind: 'wiki_page', title: 'Empty', body: '# Empty' });
  const cli = await execute(['wiki', 'lint', '--root', root, '--propose', '--dry-run']);
  assert.equal((cli as { dryRun: boolean }).dryRun, true);
  const owner = new Engram(root); const ownerTool = toolsFor(owner).find(tool => tool.name === 'mdb_wiki_lint')!;
  const proposed = await ownerTool.execute({ propose: true, proposalLimit: 1 });
  assert.ok((proposed as { created: unknown[] }).created.length <= 1);
  const guest = new Engram(root, { actorId: 'wiki-guest', permissions: [] });
  const guestTool = toolsFor(guest).find(tool => tool.name === 'mdb_wiki_lint')!;
  const hidden = await guestTool.execute({ propose: true });
  assert.deepEqual((hidden as { created: unknown[] }).created, []);
  assert.equal((await guest.proposals()).length, 0);
  recordCase({ suite: 'wiki', name: 'wiki-lint-proposals-cli-mcp-acl-and-limits', status: 'PASS' });
});
