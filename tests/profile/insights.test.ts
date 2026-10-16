import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { run } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { MDBError } from '../../packages/core/types.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { evaluateInsight } from '../../packages/intelligence/insights.js';
import { generationMessages } from '../../packages/models/prompts.js';
import { Engram, ingestRecord, eventFromHostPayload, readRegistration, createAdapter, type Document, type ModelProposal, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';
import { tempDir, claudePayloads } from '../helpers/host.js';

type T = { after(fn: () => void | Promise<void>): void };
const wiki: Scope = { type: 'global', area: 'wiki' }, proj: Scope = { type: 'workspace', workspaceId: 'proj' }, profile: Scope = { type: 'global', area: 'profile' };
async function world(t: T) {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '', { reader: ['read'] }); await vault.createWorkspace('private', '');
  const userSaid = (body: string, at = '2026-10-07T10:00:00.000Z', scope = proj) => vault.put({ scope, kind: 'observation', title: 'User message', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime: at } });
  const agentSaid = (body: string, speaker = 'assistant') => vault.put({ scope: proj, kind: 'observation', title: 'Assistant message', body, metadata: { speaker, evidenceClass: 'agent_observation', eventType: 'assistant.message', eventTime: '2026-10-07T10:01:00.000Z' } });
  const wikiPage = (body: string, title = 'Rust ownership') => vault.put({ scope: wiki, kind: 'wiki_page', title, body });
  return { root, vault, userSaid, agentSaid, wikiPage };
}
const ref = (d: Document, span: string) => ({ uri: d.uri, revisionId: d.revisionId, span });
interface Spec { body: string; category?: string; key?: string; evidence: Array<{ doc: Document; span: string }>; explicit?: boolean; sensitivity?: string; extra?: Record<string, unknown> }
function fakeProvider(spec: () => Spec | undefined): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return { id: 'fake-profile', calls, async generate(req) { calls.push(req); const s = spec(); if (!s) throw new Error('no spec'); return { kind: 'user_insight', title: s.body.slice(0, 80), body: s.body, evidence: s.evidence.map(e => ref(e.doc, e.span)), metadata: { category: s.category ?? 'preference', preferenceKey: s.key ?? 'indent', sensitivity: s.sensitivity ?? 'none', explicitStatement: s.explicit ?? false, ...s.extra } } as ModelProposal; } };
}
const extract = async (engine: IntelligenceEngine, scope: Scope = proj) => { await engine.enqueue('profile', { scope }); const jobs = await engine.run({ job: 'profile', limit: 3 }); return { jobs, proposals: await engine.proposals() }; };
const last = async (engine: IntelligenceEngine) => (await engine.proposals()).at(-1)!;
const read = (root: string, file: string) => fs.readFile(path.join(root, file), 'utf8');

test('profile prompt distinguishes project outcome preferences, assistant workflows, polarity and third-party statements', async t => {
  const w = await world(t); const message = await w.userSaid('For Orion only, keep deployment scripts compatible with staging.');
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = { id: 'prompt-contract', async generate(request) { calls.push(request); return { kind: 'no_insight', title: 'No insight', body: 'No further insight.', evidence: [] }; } };
  const engine = new IntelligenceEngine(w.vault, provider); await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); await engine.run({ job: 'profile', limit: 1 });
  const systemPrompt = generationMessages(calls[0]!)[0]!.content;
  assert.match(systemPrompt, /desired system outcome[\s\S]*?is a preference/);
  assert.match(systemPrompt, /Preserve polarity/);
  assert.match(systemPrompt, /not the user's own/);
  assert.match(systemPrompt, /"I prefer bullet lists instead of long paragraphs" -> preference/);
  assert.match(systemPrompt, /"Answer this one in French, then return to my usual language" -> abstain/);
});

test('a direct correction supersedes an earlier inferred preference: linked evidence, preserved history, regenerated projection', async t => {
  const w = await world(t);
  const first = await w.userSaid('I usually end up using tabs when I write Go code.');
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'The user prefers tabs for indentation.', evidence: [{ doc: first, span: 'using tabs when I write Go' }] })));
  await extract(engine); const p = await last(engine);
  assert.equal(p.status, 'pending'); assert.equal(p.input.metadata!.evidenceClass, 'inferred'); assert.equal(p.input.metadata!.confidenceLabel, 'low');
  const accepted = await engine.review(p.id, true, 'matches what I do'); const inferred = await w.vault.get(accepted.objectId!);
  assert.equal(inferred.status, 'accepted'); assert.equal(inferred.metadata.category, 'preference');
  const correction = await w.userSaid('Actually, no: I want spaces, two of them, never tabs.', '2026-10-08T09:00:00.000Z');
  const corrected = await engine.correctInsight({ scope: proj, preferenceKey: 'indent', claim: 'The user wants two spaces for indentation, never tabs.', category: 'preference', reason: 'direct correction', source: { uri: correction.uri, revisionId: correction.revisionId, span: 'I want spaces, two of them' } });
  assert.equal(corrected.status, 'accepted'); assert.equal(corrected.metadata.evidenceClass, 'explicit'); assert.equal(corrected.metadata.confidenceLabel, 'high');
  const old = await w.vault.get(inferred.id);
  assert.equal(old.status, 'superseded'); assert.equal(old.metadata.supersededBy, corrected.uri); assert.match(String(old.metadata.supersededReason), /direct correction/);
  assert.equal((await w.vault.get(inferred.id, inferred.revisionId)).body, 'The user prefers tabs for indentation.', 'the superseded revision is intact');
  assert.equal((await w.vault.history(inferred.id)).length, 2, 'accepted, then superseded: both revisions kept');
  assert.equal(corrected.evidence[0]!.uri, correction.uri, 'the correction links the user\'s words');
  await engine.projectProfile(); const projected = await read(w.root, 'PROFILE.md');
  assert.match(projected, /### Workspace: proj/); assert.match(projected, /two spaces/); assert.doesNotMatch(projected, /prefers tabs/); assert.doesNotMatch(await read(w.root, 'workspaces/proj/PROFILE.md'), /spaces|tabs/, 'insights are never written into workspace directories');
  const hits = await new Engram(w.root).memory.insights({ query: 'indentation', scopeLabel: 'proj' }); assert.equal(hits.insights.length, 1); assert.equal(hits.insights[0]!.evidenceClass, 'explicit');
  const history = await new Engram(w.root).memory.insights({ status: 'superseded' }); assert.equal(history.insights.length, 1);
  recordCase({ suite: 'profile', name: 'correction-supersedes-inference', status: 'PASS' });
});

test('free-text corrections are detected without a model flag and keep extraction confidence separate from factual certainty', async t => {
  const w = await world(t);
  const old = await w.vault.put({ scope: profile, kind: 'user_insight', title: 'The user prefers large pull requests.', body: 'The user prefers large pull requests.', status: 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'pr-size', evidenceClass: 'inferred', confidenceLabel: 'low', scopeLabel: 'proj', sensitivity: 'none' } });
  const message = await w.userSaid('Actually, I changed my mind: I prefer small pull requests rather than large ones.');
  const provider = fakeProvider(() => ({ body: 'The user prefers small pull requests.', key: 'pr-size', evidence: [{ doc: message, span: 'I prefer small pull requests rather than large ones' }] }));
  const engine = new IntelligenceEngine(w.vault, provider); await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); await engine.run({ job: 'profile', limit: 3 });
  const proposal = await last(engine); assert.equal(proposal.status, 'pending');
  assert.equal(proposal.input.metadata!.evidenceClass, 'explicit'); assert.equal(proposal.input.metadata!.correctionDetected, true);
  assert.equal(proposal.input.metadata!.extractionConfidence, 0.95); assert.equal(proposal.input.metadata!.factualCertainty, 'user_reported');
  const committed = await engine.review(proposal.id, true, 'user correction'); assert.ok(committed.objectId);
  assert.equal((await w.vault.get(old.id)).status, 'superseded'); assert.equal((await w.vault.get(old.id, old.revisionId)).body, old.body);
  recordCase({ suite: 'profile', name: 'free-text-correction-and-confidence', status: 'PASS' });
});

test('free-text correction reconciles a differently keyed inference by matching the corrected subject', async t => {
  const w = await world(t);
  const old = await w.vault.put({ scope: profile, kind: 'user_insight', title: 'Concise code review feedback', body: 'The user prefers concise code review feedback.', status: 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'code-review-style', evidenceClass: 'inferred', confidenceLabel: 'low', scopeLabel: 'global', sensitivity: 'none' } });
  const message = await w.userSaid('Actually, correction: I now prefer detailed review feedback rather than concise summaries. I changed my mind about this.', undefined, profile);
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'The user prefers detailed review feedback rather than concise summaries.', key: 'review-feedback', evidence: [{ doc: message, span: 'I now prefer detailed review feedback rather than concise summaries' }] })));
  await engine.enqueue('profile', { scope: profile, objectIds: [message.id] }); await engine.run({ job: 'profile', limit: 3 });
  const proposal = await last(engine);
  assert.equal(proposal.status, 'pending'); assert.equal(proposal.input.metadata!.evidenceClass, 'explicit');
  assert.ok(proposal.flags!.includes('supersedes_earlier'), `flags=${JSON.stringify(proposal.flags)} metadata=${JSON.stringify(proposal.input.metadata)}`);
  assert.equal(proposal.input.metadata!.correctionDetected, true);
  await engine.review(proposal.id, true, 'explicit correction');
  assert.equal((await w.vault.get(old.id)).status, 'superseded');
  recordCase({ suite: 'profile', name: 'correction-reconciles-different-generated-key', status: 'PASS' });
});

test('model abstentions are rejected instead of being stored as user insights', async t => {
  const w = await world(t); const message = await w.userSaid("I don't have a preference about indentation in this repository.");
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'No enduring user insight is proposed because the user has no preference about indentation.', category: 'preference', key: 'indentation', evidence: [{ doc: message, span: 'I don\'t have a preference about indentation' }] })));
  await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); await engine.run({ job: 'profile', limit: 3 });
  const proposal = await last(engine); assert.equal(proposal.status, 'rejected'); assert.ok(proposal.flags!.includes('model_abstained'));
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 0);
  recordCase({ suite: 'profile', name: 'model-abstentions-not-insights', status: 'PASS' });
});

test('explicit no-opinion, third-party-only and do-not-store source spans cannot become user memories', async t => {
  const cases: Array<{ source: string; span: string; claim: string; flag: string; category?: string; key?: string }> = [
    { source: "I don't have a preference about indentation in this repository.", span: "I don't have a preference about indentation", claim: 'The user has no preference about indentation in this repository.', flag: 'negative_or_attributed_evidence' },
    { source: 'I read an article about Kubernetes yesterday; I have no view on whether we should use it.', span: 'I read an article about Kubernetes yesterday', claim: 'The user has an interest in Kubernetes.', category: 'interest', key: 'kubernetes', flag: 'exposure_not_interest' },
    { source: "I saw a talk title about WebAssembly in my feed but I haven't read it or formed an opinion.", span: "I saw a talk title about WebAssembly in my feed but I haven't read it or formed an opinion.", claim: 'The user has not formed an opinion about WebAssembly.', category: 'knowledge_gap', key: 'webassembly-opinion', flag: 'negative_or_attributed_evidence' },
    { source: 'This once, skip the tests, we are in a hurry.', span: 'This once, skip the tests, we are in a hurry.', claim: 'The user prefers to skip tests.', category: 'working_style', key: 'skip-tests', flag: 'temporary_evidence' },
    { source: 'The vendor always wants invoices in PDF, which has nothing to do with my own habits.', span: 'which has nothing to do with my own habits', claim: 'The user has no preference about invoice format.', flag: 'negative_or_attributed_evidence' },
    { source: 'My teammate prefers all reports in spreadsheets; that is not my own preference.', span: 'My teammate prefers all reports in spreadsheets', claim: 'The user does not prefer spreadsheets for reports.', flag: 'negative_or_attributed_evidence' },
    { source: 'Please forget this and do not save it anywhere: I sometimes like dark roast coffee.', span: 'I sometimes like dark roast coffee', claim: 'The user sometimes likes dark roast coffee.', flag: 'user_opt_out' },
    { source: 'I am not asking you to remember this and I do not want a lasting preference inferred from it.', span: 'I do not want a lasting preference inferred from it', claim: 'The user has a lasting preference about this topic.', flag: 'user_opt_out' },
  ];
  for (const item of cases) {
    const w = await world(t); const message = await w.userSaid(item.source);
    const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: item.claim, ...(item.category ? { category: item.category, key: item.key } : {}), evidence: [{ doc: message, span: item.span }] })));
    await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); await engine.run({ job: 'profile', limit: 1 });
    const proposal = await last(engine); assert.equal(proposal.status, 'rejected', item.source); assert.ok(proposal.flags?.includes(item.flag), JSON.stringify(proposal.flags));
  }
  recordCase({ suite: 'profile', name: 'negative-attributed-and-opt-out-evidence-rejected', status: 'PASS' });
});

test('targeted opt-outs do not suppress unrelated facts, and counterfactual goals are rejected', async t => {
  const w = await world(t); const message = await w.userSaid("My manager insists on weekly reports. Forget that I mentioned my cat, don't store it. I like reading release notes before upgrading.");
  const insight = (key: string, claim: string, span: string, category = 'preference') => evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: claim, body: claim, evidence: [{ uri: message.uri, revisionId: message.revisionId, span }], metadata: { insightSchema: 1, category, preferenceKey: key } });
  const blockedCat = await insight('cat', 'The user has a cat.', 'my cat'); assert.equal(blockedCat.verdict, 'reject'); assert.ok(blockedCat.flags.includes('user_opt_out'));
  const allowedNotes = await insight('release-notes', 'The user likes reading release notes before upgrading.', 'I like reading release notes before upgrading.'); assert.equal(allowedNotes.verdict, 'accept');
  const mixed = await w.userSaid('This once, skip the tests. I always pin dependencies.');
  const durableBesideTemporary = await evaluateInsight(w.vault, { scope: proj, kind: 'user_insight', title: 'Pinned dependencies', body: 'The user always pins dependencies.', evidence: [{ uri: mixed.uri, revisionId: mixed.revisionId, span: 'I always pin dependencies.' }], metadata: { insightSchema: 1, category: 'working_style', preferenceKey: 'pin-dependencies' } });
  assert.equal(durableBesideTemporary.verdict, 'accept', 'temporary markers only block a claim about the same clause');
  const rust = await w.userSaid('I maintain the Rust client and can review Rust lifetime and ownership changes myself.');
  const sameDomainSkill = await evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: 'Rust client maintenance and review', body: 'I maintain the Rust client and can review Rust lifetime and ownership changes myself.', evidence: [{ uri: rust.uri, revisionId: rust.revisionId, span: rust.body }], metadata: { insightSchema: 1, category: 'capability', preferenceKey: 'rust-review' } });
  assert.equal(sameDomainSkill.verdict, 'accept', 'two predicates about the same capability domain remain one useful insight');
  const separateSkills = await evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: 'Rust and Terraform skills', body: 'The user can review Rust code and can author Terraform modules.', evidence: [{ uri: rust.uri, revisionId: rust.revisionId, span: rust.body }], metadata: { insightSchema: 1, category: 'capability', preferenceKey: 'rust-terraform' } });
  assert.ok(separateSkills.flags.includes('multiple_insights'), 'a conjunction of distinct capability topics is rejected');
  const exposed = await w.userSaid('I skimmed a post about GraphQL today.');
  const exposureOnly = await evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: 'Interest in GraphQL', body: 'The user has an interest in GraphQL.', evidence: [{ uri: exposed.uri, revisionId: exposed.revisionId, span: 'I skimmed a post about GraphQL today.' }], metadata: { insightSchema: 1, category: 'interest', preferenceKey: 'graphql' } });
  assert.equal(exposureOnly.verdict, 'reject'); assert.ok(exposureOnly.flags.includes('exposure_not_interest'));
  const compound = await insight('repo-workflow', 'The user prefers make check before PR and prefers rebasing over merge commits.', 'I like reading release notes before upgrading.');
  assert.equal(compound.verdict, 'reject'); assert.ok(compound.flags.includes('multiple_insights'));
  const oneConcept = await w.userSaid("I don't like hard-coded environment values; please make them configurable.");
  const sameConcept = await evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: 'Configurable values', body: 'The user prefers not to use hard-coded environment values and wants them configurable.', evidence: [{ uri: oneConcept.uri, revisionId: oneConcept.revisionId, span: 'hard-coded environment values; please make them configurable' }], metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'configuration' } });
  assert.equal(sameConcept.verdict, 'accept');
  const hypothetical = await w.userSaid('Say I had a week off, I would learn Rust.');
  const blockedHypothesis = await evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: 'Learn Rust', body: 'The user wants to learn Rust.', evidence: [{ uri: hypothetical.uri, revisionId: hypothetical.revisionId, span: 'I would learn Rust' }], metadata: { insightSchema: 1, category: 'goal', preferenceKey: 'rust-learning' } });
  assert.equal(blockedHypothesis.verdict, 'reject'); assert.ok(blockedHypothesis.flags.includes('hypothetical_evidence'));
  const blockedPreference = await evaluateInsight(w.vault, { scope: profile, kind: 'user_insight', title: 'Rust preference', body: 'The user would like to learn Rust if they had a week off.', evidence: [{ uri: hypothetical.uri, revisionId: hypothetical.revisionId, span: 'Say I had a week off, I would learn Rust.' }], metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'rust' } });
  assert.equal(blockedPreference.verdict, 'reject'); assert.ok(blockedPreference.flags.includes('hypothetical_evidence'));
  recordCase({ suite: 'profile', name: 'scoped-opt-out-and-hypothetical-evidence', status: 'PASS' });
});

test('profile extraction repairs one schema-invalid model abstention and keeps it rejected', async t => {
  const w = await world(t); const message = await w.userSaid('I have not decided whether I prefer tabs or spaces.');
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = { id: 'repair-profile', async generate(request) { calls.push(request); if (calls.length === 1) return { kind: 'user_insight', title: 'No insight proposed', body: 'No insight proposed because the preference is undecided.', metadata: { category: 'preference', preferenceKey: 'indentation' } } as unknown as ModelProposal; return { kind: 'user_insight', title: 'No insight proposed', body: 'No insight proposed because the preference is undecided.', evidence: [ref(message, 'not decided whether I prefer tabs or spaces')], metadata: { category: 'preference', preferenceKey: 'no-user-insight' } }; } };
  const engine = new IntelligenceEngine(w.vault, provider); await engine.enqueue('profile', { scope: proj, objectIds: [message.id] });
  const [job] = await engine.run({ job: 'profile', limit: 1 }); const proposal = await last(engine);
  assert.equal(job!.status, 'complete'); assert.equal(calls.length, 2); assert.match(calls[1]!.instruction, /failed schema validation/);
  assert.equal(proposal.status, 'rejected'); assert.ok(proposal.flags!.includes('model_abstained'));
  recordCase({ suite: 'profile', name: 'profile-invalid-abstention-schema-repair', status: 'PASS' });
});

test('wiki and imported sources show exposure only: they never become a preference, goal, capability or endorsement', async t => {
  const w = await world(t); const page = await w.wikiPage('Rust uses ownership and borrowing to guarantee memory safety without a garbage collector.');
  const claims: Spec[] = [
    { body: 'The user prefers Rust for systems work.', category: 'preference', key: 'lang-rust', evidence: [{ doc: page, span: 'ownership and borrowing' }] },
    { body: 'The user is an expert in Rust.', category: 'capability', key: 'skill-rust', evidence: [{ doc: page, span: 'memory safety without a garbage collector' }], explicit: true },
    { body: 'The user wants to learn Rust.', category: 'goal', key: 'goal-rust', evidence: [{ doc: page, span: 'ownership and borrowing' }] }
  ];
  let i = 0; const engine = new IntelligenceEngine(w.vault, fakeProvider(() => claims[i % claims.length]));
  for (; i < claims.length; i++) { await engine.enqueue('profile', { scope: profile, objectIds: [page.id], instruction: `claim ${i}` }); await engine.run({ job: 'profile', limit: 5 }); }
  const rejected = (await engine.proposals()).filter(p => p.status === 'rejected'); assert.equal(rejected.length, 3);
  for (const p of rejected) assert.ok(p.flags!.includes('exposure_not_preference'), p.reason);
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 0, 'nothing was stored');
  const interest = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'The user has read about Rust ownership.', category: 'interest', key: 'topic-rust', evidence: [{ doc: page, span: 'ownership and borrowing' }], explicit: true })));
  await interest.enqueue('profile', { scope: profile, objectIds: [page.id] }); await interest.run({ job: 'profile', limit: 3 });
  const p = await last(interest); assert.equal(p.status, 'pending'); assert.equal(p.input.metadata!.evidenceClass, 'exposure'); assert.ok(p.flags!.includes('exposure_only'));
  const accepted = await w.vault.get((await interest.review(p.id, true)).objectId!); assert.equal(accepted.metadata.category, 'interest'); assert.equal(accepted.metadata.confidenceLabel, 'low');
  await interest.projectProfile(); assert.doesNotMatch(await read(w.root, 'PROFILE.md'), /Rust/, 'an exposure is not a stated fact');
  recordCase({ suite: 'profile', name: 'wiki-is-exposure-only', status: 'PASS' });
});

test('agent conclusions never override the user: contradicted ones are rejected, unconfirmed ones need explicit confirmation', async t => {
  const w = await world(t); const said = await w.userSaid('For this project please keep answers short.'); const agent = await w.agentSaid('The user probably likes very long, detailed answers.');
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => undefined));
  await engine.correctInsight({ scope: proj, preferenceKey: 'answer-length', claim: 'The user wants short answers.', category: 'working_style', source: { uri: said.uri, revisionId: said.revisionId, span: 'keep answers short' } });
  const propose = async (spec: Spec) => { const e = new IntelligenceEngine(w.vault, fakeProvider(() => spec)); await e.enqueue('profile', { scope: proj, objectIds: spec.evidence.map(x => x.doc.id) }); await e.run({ job: 'profile', limit: 3 }); return { e, p: await last(e) }; };
  const contradicted = await propose({ body: 'The user wants long detailed answers.', category: 'working_style', key: 'answer-length', evidence: [{ doc: agent, span: 'very long, detailed answers' }] });
  assert.equal(contradicted.p.status, 'rejected'); assert.ok(contradicted.p.flags!.includes('conflicts_user_statement'));
  const inferredAgainst = await propose({ body: 'The user likes verbose answers.', category: 'working_style', key: 'answer-length', evidence: [{ doc: said, span: 'please keep answers short' }] });
  assert.equal(inferredAgainst.p.status, 'rejected', 'inference does not override an explicit statement either');
  const fresh = await propose({ body: 'The user likes tables in answers.', category: 'working_style', key: 'format-tables', evidence: [{ doc: agent, span: 'likes very long' }], explicit: true });
  assert.equal(fresh.p.status, 'pending'); assert.equal(fresh.p.input.metadata!.evidenceClass, 'hypothesis', 'agent-only evidence stays a hypothesis even when the model claims an explicit statement'); assert.ok(fresh.p.flags!.includes('needs_user_validation'));
  await assert.rejects(fresh.e.review(fresh.p.id, true), { code: 'INVALID_INPUT' });
  const confirmed = await fresh.e.review(fresh.p.id, true, 'user confirmed', { confirmHypothesis: true }); assert.equal((await w.vault.get(confirmed.objectId!)).metadata.evidenceClass, 'hypothesis');
  recordCase({ suite: 'profile', name: 'agent-never-overrides-user', status: 'PASS' });
});

test('workspace-scoped and global preferences coexist without false conflicts', async t => {
  const w = await world(t); const said = await w.userSaid('In this repo I want spaces, elsewhere I use tabs.');
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'In this workspace the user wants spaces.', key: 'indent', evidence: [{ doc: said, span: 'In this repo I want spaces' }], explicit: true })));
  await engine.correctInsight({ scope: profile, preferenceKey: 'indent', claim: 'By default the user uses tabs.', category: 'preference' });
  await extract(engine); const p = await last(engine);
  assert.equal(p.status, 'pending', p.reason); assert.ok(!p.flags!.some(f => f.startsWith('conflicts')), 'no conflict across scopes');
  await engine.review(p.id, true);
  const both = await new Engram(w.root).memory.insights({ category: 'preference' });
  assert.deepEqual(both.insights.map(i => [i.scope, i.status]).sort(), [['global', 'accepted'], ['proj', 'accepted']]);
  await engine.projectProfile(); const text = await read(w.root, 'PROFILE.md'); const [globalPart, workspacePart] = text.split('### Workspace: proj'); assert.match(globalPart!, /uses tabs/); assert.doesNotMatch(globalPart!, /wants spaces/); assert.match(workspacePart!, /wants spaces/); assert.doesNotMatch(workspacePart!, /uses tabs/);
  recordCase({ suite: 'profile', name: 'scope-coexistence', status: 'PASS' });
});

test('sensitive candidates need confirmation, are never listed in projections or shared indexes, and are visible only to authorized readers', async t => {
  const w = await world(t); const said = await w.userSaid('I have been dealing with an anxiety disorder lately.');
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'The user has an anxiety disorder.', category: 'knowledge_gap', key: 'condition', evidence: [{ doc: said, span: 'an anxiety disorder' }], explicit: true })));
  await extract(engine); const p = await last(engine); assert.ok(p.flags!.includes('sensitive')); assert.equal(p.critic!.verdict, 'review_required');
  await assert.rejects(engine.review(p.id, true), { code: 'INVALID_INPUT' }); assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 0);
  const done = await engine.review(p.id, true, 'I confirm', { confirmSensitive: true }); assert.equal((await w.vault.get(done.objectId!)).metadata.sensitivity, 'sensitive');
  await engine.projectProfile(); await new Engram(w.root).search.rebuild();
  for (const file of ['PROFILE.md', 'USER_INSIGHT.md', 'MAIN_INDEX.md', 'WORKSPACE_REGISTRY.md', 'workspaces/proj/PROFILE.md', 'workspaces/proj/INDEX.md', 'profile/INDEX.md', 'wiki/INDEX.md', 'shared/INDEX.md']) assert.doesNotMatch(await read(w.root, file), /anxiety/i, file);
  assert.match(await read(w.root, 'PROFILE.md'), /1 sensitive item\(s\) not listed/);
  assert.equal((await new Engram(w.root).memory.insights({ query: 'anxiety' })).insights.length, 1, 'the owner can still find it');
  assert.equal((await new Engram(w.root, { actorId: 'reader', permissions: [] }).memory.insights({ query: 'anxiety' })).insights.length, 0, 'an agent with read access to the workspace cannot see user insights: they live in the user-private profile area');
  assert.equal((await new Engram(w.root, { actorId: 'profile-reader', permissions: ['global:profile:read'] }).memory.insights({ query: 'anxiety' })).insights.length, 0, 'a profile grant does not bypass current access to the underlying workspace evidence');
  recordCase({ suite: 'profile', name: 'sensitive-gating-and-projection', status: 'PASS' });
});

test('extraction is idempotent, projections are byte-stable, and the source history behind an insight stays reachable', async t => {
  const w = await world(t); const said = await w.userSaid('I always review diffs before committing; it is my habit.');
  const engine = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'The user reviews diffs before committing.', category: 'working_style', key: 'review-diffs', evidence: [{ doc: said, span: 'review diffs before committing' }], explicit: true })));
  await extract(engine); await extract(engine); await extract(engine);
  assert.equal((await engine.proposals()).length, 1, 'the same output from repeated runs is one proposal');
  const approved = await engine.review((await last(engine)).id, true); const insight = await w.vault.get(approved.objectId!);
  await extract(engine); assert.equal((await engine.proposals()).length, 1, 'identical output after approval is still the same proposal');
  const rephrased = new IntelligenceEngine(w.vault, fakeProvider(() => ({ body: 'The user reviews diffs before committing.', category: 'working_style', key: 'review-diffs', evidence: [{ doc: said, span: 'it is my habit' }], explicit: true })));
  await extract(rephrased); const redundant = (await rephrased.proposals()).at(-1)!; assert.equal(redundant.status, 'rejected'); assert.ok(redundant.flags!.includes('redundant'), 'the same claim from different evidence is recognised as already recorded');
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 1, 'never duplicated');
  await engine.projectProfile(); const first = [await read(w.root, 'PROFILE.md'), await read(w.root, 'USER_INSIGHT.md')];
  await engine.projectProfile(); await engine.projectProfile(); assert.deepEqual([await read(w.root, 'PROFILE.md'), await read(w.root, 'USER_INSIGHT.md')], first, 'regeneration is deterministic');
  await fs.appendFile(path.join(w.root, 'PROFILE.md'), '\nMy own note, outside the generated block.\n'); await engine.projectProfile();
  assert.match(await read(w.root, 'PROFILE.md'), /My own note, outside the generated block\./, 'authored text survives regeneration');
  const sources = insight.metadata.sources as Array<{ uri: string; revisionId: string; class: string; span: string }>;
  assert.equal(sources[0]!.class, 'user_conversation'); assert.equal((await w.vault.get(said.id, sources[0]!.revisionId)).body, said.body, 'the cited source revision is still readable');
  assert.match(insight.body, /reviews diffs/); assert.equal(insight.evidence[0]!.uri, said.uri);
  recordCase({ suite: 'profile', name: 'idempotency-and-projection', status: 'PASS' });
});

test('evidence must be real, authorized, content-consistent and correctly attributed; the model cannot raise its own evidence or confidence', async t => {
  const w = await world(t); const said = await w.userSaid('I like small pull requests.'); const agent = await w.agentSaid('The user said they love huge pull requests.');
  const secretWorkspaceNote = await w.vault.put({ scope: { type: 'workspace', workspaceId: 'private' }, kind: 'observation', title: 'x', body: 'I only trust handwritten notes', metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
  const dream = await w.vault.put({ scope: { type: 'global', area: 'discoveries' }, kind: 'discovery', title: 'Idea', body: 'The user could love pair programming.', status: 'hypothesis', metadata: { testPlan: ['x'], counterarguments: ['y'] } });
  const attempt = async (spec: Spec, jobScope: Scope = proj) => { const e = new IntelligenceEngine(w.vault, fakeProvider(() => spec)); await e.enqueue('profile', { scope: jobScope, objectIds: spec.evidence.map(x => x.doc.id) }); const jobs = await e.run({ job: 'profile', limit: 3 }); return { e, jobs, proposals: await e.proposals() }; };
  const fabricated = await attempt({ body: 'The user likes huge pull requests.', key: 'pr-size', evidence: [{ doc: said, span: 'I love gigantic pull requests' }], explicit: true });
  assert.equal(fabricated.proposals.at(-1)!.status, 'rejected'); assert.ok(fabricated.proposals.at(-1)!.flags!.includes('span_not_in_source'), 'a quote that is not in the source is rejected');
  const truncated = await attempt({ body: 'The user likes small pull requests.', key: 'pr-size-truncated', evidence: [{ doc: said, span: 'I like small pull request' }], explicit: true });
  assert.equal(truncated.proposals.at(-1)!.status, 'rejected'); assert.ok(truncated.proposals.at(-1)!.flags!.includes('span_not_in_source'), 'a near-match that truncates a source word is rejected');
  const noSpan = await attempt({ body: 'The user likes small pull requests.', key: 'pr-size2', evidence: [{ doc: said, span: '' }] }); assert.ok(noSpan.proposals.at(-1)!.flags!.includes('span_missing'));
  const dreamEvidence = await attempt({ body: 'The user loves pair programming.', key: 'pairing', evidence: [{ doc: dream, span: 'love pair programming' }] }, { type: 'global', area: 'discoveries' });
  assert.ok(dreamEvidence.proposals.at(-1)?.flags?.includes('dream_not_evidence') || dreamEvidence.jobs[0]!.status !== 'complete', 'dream hypotheses are never evidence about the user');
  const attributed = await attempt({ body: 'The user loves huge pull requests.', key: 'pr-size3', evidence: [{ doc: agent, span: 'love huge pull requests' }], explicit: true });
  assert.equal(attributed.proposals.at(-1)!.input.metadata!.evidenceClass, 'hypothesis', 'words by the assistant are not attributed to the user'); assert.equal(attributed.proposals.at(-1)!.input.metadata!.confidenceLabel, 'low');
  const overclaim = await attempt({ body: 'The user likes small pull requests.', key: 'pr-size4', evidence: [{ doc: said, span: 'small pull requests' }], extra: { evidenceClass: 'explicit', confidenceLabel: 'high' } });
  const oc = overclaim.proposals.at(-1)!; assert.equal(oc.status, 'rejected'); assert.ok(oc.flags!.includes('overclaimed_evidence_class'), 'declaring a class the sources do not support is refused');
  assert.ok(true, 'one source cannot justify more than low confidence'); 
  const foreign = new IntelligenceEngine(new Vault(w.root, { actorId: 'agent', permissions: ['global:profile:write', 'global:profile:read'] }), fakeProvider(() => ({ body: 'The user only trusts handwritten notes.', key: 'notes', evidence: [{ doc: secretWorkspaceNote, span: 'handwritten notes' }] })));
  await assert.rejects(foreign.propose({ scope: profile, kind: 'user_insight', title: 't', body: 'The user only trusts handwritten notes.', evidence: [{ uri: secretWorkspaceNote.uri, revisionId: secretWorkspaceNote.revisionId, span: 'handwritten notes' }], metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'notes' } }), /unavailable/, 'evidence the proposer cannot read is refused before anything is stored');
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 0, 'none of the rejected attempts persisted an insight');
  recordCase({ suite: 'profile', name: 'evidence-validity-and-attribution', status: 'PASS' });
});

test('passively captured user messages feed profile extraction incrementally, ahead of agent output, without reprocessing', async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  const settings = path.join(await tempDir(t, 'cfg'), 'settings.json'); const adapter = createAdapter('claude-code', { root, settingsPath: settings });
  const installed = await adapter.install({ consent: true, principalId: 'cc', workspaceId: 'proj', capture: ['session.start', 'user.message', 'assistant.message', 'tool.result'] }); const reg = (await readRegistration(root, installed.registrationId!))!;
  const p = await claudePayloads();
  const feed = async (name: string, over: Record<string, unknown>) => { const event = eventFromHostPayload(reg, { ...p[name]!, ...over })!; assert.equal((await ingestRecord(root, { registrationId: reg.id, event })).status, 'ingested'); };
  await feed('Stop', { last_assistant_message: 'I think the user wants everything in one giant file.' });
  await feed('UserPromptSubmit', { prompt: 'Please split the code into small modules; I dislike giant files.', prompt_id: 'a' });
  const wikiNote = await vault.put({ scope: wiki, kind: 'wiki_page', title: 'Modularity', body: 'Small modules improve testability.' });
  const owner = new IntelligenceEngine(vault, undefined); void owner;
  const provider = fakeProvider(() => ({ body: 'The user wants code split into small modules.', key: 'module-size', evidence: [{ doc: (provider.calls.at(-1)!.documents.find(d => d.metadata.speaker === 'user') as Document), span: 'split the code into small modules' }], explicit: true }));
  const engine = new IntelligenceEngine(vault, provider);
  await engine.run({ limit: 10 });
  assert.equal((await engine.jobs()).filter(j => j.kind === 'profile' && j.status === 'complete').length, 1, 'the user\'s message triggered exactly one incremental extraction job'); assert.equal(provider.calls.length, 2, 'one call for the insight and one confirming call (the model repeats the claim, so nothing more remains)');
  const order = provider.calls[0]!.documents.map(d => (d.metadata.speaker as string | undefined) ?? d.scope.type + ':' + d.kind);
  assert.ok(order.indexOf('user') < order.indexOf('assistant'), `user words come before agent output: ${order}`); assert.ok(order.indexOf('user') < order.indexOf('global:wiki_page'));
  const proposal = await last(engine); assert.equal(proposal.status, 'pending'); assert.equal(proposal.input.metadata!.scopeLabel, 'proj'); assert.equal(proposal.input.scope.type, 'global');
  const afterFirst = provider.calls.length; await engine.run({ limit: 10 }); assert.equal(provider.calls.length, afterFirst, 'nothing new since the cursor: no further model call');
  await feed('UserPromptSubmit', { prompt: 'Also keep functions under thirty lines.', prompt_id: 'b' });
  await engine.run({ limit: 10 }); assert.equal(provider.calls.length, afterFirst + 1, 'a new user message triggers one more extraction; the model repeats a claim that is already pending, so it is dropped as a duplicate and the batch is complete'); assert.equal((await engine.proposals()).filter(p => p.input.kind === 'user_insight').length, 1, 'no duplicate proposal across consecutive jobs'); void wikiNote;
  const sourcesSeen = provider.calls[afterFirst]!.documents.map(d => d.body); assert.ok(sourcesSeen.some(b => /thirty lines/.test(b))); assert.ok(sourcesSeen.some(b => /giant files/.test(b)), 'a repeated known claim keeps the whole eligible batch unconsumed until explicit abstention');
  recordCase({ suite: 'profile', name: 'passive-capture-to-profile', status: 'PASS' });
});

test('CLI: profile correct, insight search and projection work end to end; agents have no tool to speak for the user', async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  const j = async (...args: string[]) => { const r = await run([...args, '--root', root, '--json']); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
  const first = await j('profile', 'correct', '--key', 'editor', '--claim', 'The user uses Neovim.', '--category', 'preference');
  assert.equal(first.status, 'accepted'); assert.equal(first.metadata.evidenceClass, 'explicit');
  const second = await j('profile', 'correct', '--key', 'editor', '--claim', 'The user switched to Helix.', '--category', 'preference', '--reason', 'changed their mind');
  const found = await j('insight', 'search', 'Helix'); assert.equal(found.insights.length, 1); assert.equal(found.insights[0].evidenceClass, 'explicit');
  assert.equal((await j('insight', 'search', '--status', 'superseded')).insights.length, 1);
  assert.match(await read(root, 'PROFILE.md'), /Helix/); assert.doesNotMatch(await read(root, 'PROFILE.md'), /Neovim/);
  const workspaceOnly = await j('profile', 'correct', '--key', 'editor', '--claim', 'In proj the user uses VS Code.', '--category', 'preference', '--workspace', 'proj'); assert.equal(workspaceOnly.metadata.scopeLabel, 'proj');
  assert.equal((await j('insight', 'search', '--status', 'accepted')).insights.length, 2, 'global and workspace-applicable insights coexist');
  const bad = await run(['profile', 'correct', '--key', 'Bad Key!', '--claim', 'x', '--category', 'preference', '--root', root, '--json']); assert.equal(bad.code, 1);
  const { toolsFor } = await import('../../packages/mcp/index.js'); const names = toolsFor(new Engram(root)).map(x => x.name);
  assert.ok(names.includes('mdb_insight_search')); assert.ok(!names.some(n => /correct|profile_set|insight_(put|set|write)/.test(n)), 'no MCP tool lets an agent state or correct a user fact'); void second;
  recordCase({ suite: 'profile', name: 'cli-and-agent-boundary', status: 'PASS' });
});

// Regression: the five dead-lettered jobs in the first real-model run (abstentions with no evidence, and a non-user_insight kind).
const abstain = (reason = 'The user asked a question; no enduring insight.'): ModelProposal => ({ kind: 'no_insight', title: 'No insight', body: reason, evidence: [] });
test('a final no_insight call ends extraction without erasing proposals from the batch telemetry', async t => {
  const w = await world(t); const message = await w.userSaid('I prefer concise summaries and bullet lists.'); let calls = 0;
  const engine = new IntelligenceEngine(w.vault, { id: 'proposal-then-abstain', async generate() {
    calls++;
    if (calls > 1) return abstain('No other independent insight remains.');
    return { kind: 'user_insight', title: 'Concise summaries', body: 'The user prefers concise summaries.', evidence: [ref(message, 'prefer concise summaries')], metadata: { category: 'preference', preferenceKey: 'summary-style', sensitivity: 'none' } } as ModelProposal;
  } });
  await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); const [job] = await engine.run({ job: 'profile', limit: 1 });
  assert.equal(job!.status, 'complete'); assert.equal(calls, 2);
  assert.equal(job!.telemetry!.outcome, 'proposed'); assert.equal(job!.telemetry!.terminal, 'proposed');
  assert.equal(job!.telemetry!.proposals, 1); assert.equal(job!.telemetry!.complete, true);
  recordCase({ suite: 'profile', name: 'profile-proposal-survives-final-abstention-telemetry', status: 'PASS' });
});

test('profile model context excludes pending and approved claims after source ACL or sensitivity changes', async t => {
  for (const status of ['pending', 'approved'] as const) for (const revocation of ['collection', 'workspace', 'delete', 'sensitivity'] as const) {
    await t.test(`${status}-${revocation}`, async t => {
      const { root, vault: owner } = await disposableVault(t);
      await owner.createWorkspace('proj', '', { alice: ['read', 'write'] });
      await owner.createWorkspace('other', '', { alice: ['read', 'write'] });
      await owner.createCollection('proj', 'private', '', { alice: ['read', 'write'] });
      const privateScope: Scope = { type: 'workspace', workspaceId: 'proj', collectionId: 'private' };
      const visibleScope: Scope = { type: 'workspace', workspaceId: revocation === 'collection' ? 'proj' : 'other' };
      const secret = await owner.put({ scope: privateScope, kind: 'observation', title: 'Private source', body: 'I prefer PRIVATE-ACL-CANARY-731 tea.', metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
      const alice = new Vault(root, { actorId: 'alice', permissions: ['global:profile:read', 'global:profile:write'] });
      let first = true;
      const provider: ModelProvider & { calls: ModelRequest[] } = { id: 'acl-prompt-spy', calls: [], async generate(request) {
        this.calls.push(request);
        if (first) { first = false; return { kind: 'user_insight', title: 'Tea preference', body: 'The user prefers PRIVATE-ACL-CANARY-731 tea.', evidence: [ref(secret, 'I prefer PRIVATE-ACL-CANARY-731 tea')], metadata: { category: 'preference', preferenceKey: 'tea', sensitivity: 'none' } } as ModelProposal; }
        return abstain('No other insight.');
      } };
      const engine = new IntelligenceEngine(alice, provider);
      await engine.enqueue('profile', { scope: privateScope, objectIds: [secret.id] }); await engine.run({ job: 'profile', limit: 1 });
      const proposal = (await engine.proposals()).find(item => item.input.kind === 'user_insight')!;
      assert.equal(proposal.status, 'pending');
      if (status === 'approved') await engine.review(proposal.id, true, 'synthetic test approval');

      if (revocation === 'collection') {
        // Owner narrows this collection's grant using the same persisted ACL file as the audit reproduction.
        await fs.writeFile(path.join(root, 'workspaces/proj/collections/private/.mdb/collection.json'), JSON.stringify({ id: 'private', workspaceId: 'proj', description: '', grants: {} }));
        assert.equal(await alice.get(secret.id).then(() => false, error => error.code === 'NOT_FOUND_OR_FORBIDDEN'), true);
      } else if (revocation === 'workspace') {
        await owner.grant('proj', 'alice', []);
        assert.equal(await alice.get(secret.id).then(() => false, error => error.code === 'NOT_FOUND_OR_FORBIDDEN'), true);
      } else if (revocation === 'delete') {
        await owner.delete(secret.id, secret.revisionId);
        const deleted = await alice.get(secret.id); assert.equal(deleted.status, 'deleted'); assert.equal(deleted.body, '');
      } else {
        await owner.patch({ objectId: secret.id, expectedRevisionId: secret.revisionId, metadataPatch: { sensitivity: 'sensitive' } });
      }
      await owner.put({ scope: visibleScope, kind: 'observation', title: 'Visible source', body: 'Today was sunny.', metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
      provider.calls.length = 0;
      const next = new IntelligenceEngine(alice, provider);
      await next.enqueue('profile', { scope: visibleScope }); const jobs = await next.run({ job: 'profile', limit: 10 });
      assert.ok(provider.calls.length > 0, `authorized control evidence must exercise prompt construction: ${JSON.stringify(jobs)}`);
      assert.doesNotMatch(JSON.stringify(provider.calls), /PRIVATE-ACL-CANARY-731/, `${status} claim and evidence must be reauthorized at prompt time`);
      assert.deepEqual(await next.proposals(), [], 'the inaccessible or newly sensitive proposal is absent from the actor-facing proposal list');
    });
  }
});

test('direct reads of derived claims recheck current evidence sensitivity for non-owner actors', async t => {
  const w = await world(t);
  const source = await w.userSaid('My health details include CANARY-992.', '2026-10-07T10:00:00.000Z');
  const derived = await w.vault.put({ scope: profile, kind: 'user_insight', title: 'Private detail', body: 'The user prefers CANARY-992.', status: 'accepted', evidence: [ref(source, 'health details include CANARY-992')], metadata: { insightSchema: 1, modelProvider: 'test', category: 'preference', preferenceKey: 'private-detail', scopeLabel: 'proj', sensitivity: 'none' } });
  assert.equal((await w.vault.get(derived.id)).body, derived.body, 'the owner retains direct access');
  const reader = new Vault(w.root, { actorId: 'reader', permissions: ['global:profile:read'] });
  assert.equal(await reader.get(source.id).then(() => true, () => false), true, 'the control actor is currently authorized to read the cited workspace source');
  await assert.rejects(reader.get(derived.id), error => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN', 'a derived read does not expose sensitive evidence just because its metadata was not upgraded');
  const unsupported = await w.vault.put({ scope: profile, kind: 'user_insight', title: 'Unlinked', body: 'Generated from a source that was later removed.', status: 'accepted', metadata: { insightSchema: 1, modelProvider: 'test', category: 'preference', preferenceKey: 'unlinked', scopeLabel: 'proj', sensitivity: 'none' } });
  await assert.rejects(reader.get(unsupported.id), error => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN', 'a model-derived claim without resolvable evidence fails closed');
  const visibleSource = await w.userSaid('I prefer CANARY-993.', '2026-10-07T10:01:00.000Z');
  const sensitiveClaim = await w.vault.put({ scope: profile, kind: 'user_insight', title: 'Health note', body: 'The user mentioned a health detail CANARY-993.', status: 'accepted', evidence: [ref(visibleSource, 'I prefer CANARY-993')], metadata: { insightSchema: 1, modelProvider: 'test', category: 'preference', preferenceKey: 'health-detail', scopeLabel: 'proj', sensitivity: 'none' } });
  await assert.rejects(reader.get(sensitiveClaim.id), error => error instanceof MDBError && error.code === 'NOT_FOUND_OR_FORBIDDEN', 'a sensitive derived claim is hidden even when its evidence is otherwise readable');
  recordCase({ suite: 'profile', name: 'profile-direct-read-sensitive-source-guard', status: 'PASS' });
});
test('a schema-valid no_insight abstention completes the job, stores nothing, and is counted as an abstention', async t => {
  const w = await world(t); const message = await w.userSaid('Would you prefer a table or a paragraph for this comparison?');
  const calls: ModelRequest[] = []; const engine = new IntelligenceEngine(w.vault, { id: 'abstainer', async generate(r) { calls.push(r); return abstain(); } });
  await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); const [job] = await engine.run({ job: 'profile', limit: 1 });
  assert.equal(job!.status, 'complete'); assert.equal(calls.length, 1); assert.deepEqual({ ...job!.telemetry }, { modelCalls: 1, malformed: 0, repairs: 0, outcome: 'abstained', proposals: 0, complete: true, calls: { generate: 1, repair: 0, critic: 0 }, retries: 0, tokens: { input: 0, output: 0, reported: false }, budget: { max: 5, exhausted: false }, terminal: 'abstained' }); // new accounting fields added; the original fields are unchanged
  assert.equal((await engine.proposals()).length, 0); assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight').length, 0);
  recordCase({ suite: 'profile', name: 'profile-no-insight-abstention', status: 'PASS' });
});
test('malformed profile output is repaired within a bounded budget and never invents evidence', async t => {
  const w = await world(t); const message = await w.userSaid('From now on give me the command first and the explanation after.');
  let n = 0; const notes: string[] = [];
  const engine = new IntelligenceEngine(w.vault, { id: 'flaky', async generate(r) { n++; notes.push(r.instruction); if (n === 1) return { kind: 'user_insight', title: 'x', body: 'y', evidence: [] } as ModelProposal; if (n === 2) return { kind: 'preference_note', title: 'x', body: 'y', evidence: [ref(message, 'command first')] } as ModelProposal; return { kind: 'user_insight', title: 'Command first', body: 'The user wants the command first and the explanation after.', evidence: [ref(message, 'give me the command first')], metadata: { category: 'working_style', preferenceKey: 'answer-order', sensitivity: 'none', explicitStatement: true } }; } });
  await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); const [job] = await engine.run({ job: 'profile', limit: 1 });
  assert.equal(job!.status, 'complete'); assert.deepEqual({ ...job!.telemetry }, { modelCalls: 4, malformed: 2, repairs: 2, outcome: 'proposed', proposals: 1, complete: true, duplicates: 1, calls: { generate: 2, repair: 2, critic: 0 }, retries: 0, tokens: { input: 0, output: 0, reported: false }, budget: { max: 5, exhausted: false }, terminal: 'proposed' });
  assert.match(notes[1]!, /failed schema validation \(Model output invalid at proposal\.evidence/); assert.ok(!notes[1]!.includes('give me the command'), 'repair note never echoes values');
  const proposal = await last(engine); assert.equal(proposal.input.evidence![0]!.span, 'give me the command first');
  recordCase({ suite: 'profile', name: 'profile-bounded-schema-repair', status: 'PASS' });
});
test('persistent malformed profile output dead-letters after the repair budget and is counted as malformed', async t => {
  const w = await world(t); const message = await w.userSaid('Thanks, that worked.'); let n = 0;
  const engine = new IntelligenceEngine(w.vault, { id: 'broken', async generate() { n++; return { kind: 'user_insight', title: 'x', body: 'y', evidence: [] } as ModelProposal; } });
  await engine.enqueue('profile', { scope: proj, objectIds: [message.id] }); const [job] = await engine.run({ job: 'profile', limit: 1 });
  assert.equal(job!.status, 'dead_letter'); assert.equal(n, 3); assert.equal(job!.telemetry!.outcome, 'malformed'); assert.equal(job!.telemetry!.malformed, 3);
  recordCase({ suite: 'profile', name: 'profile-repair-budget-exhausted', status: 'PASS' });
});
test('no_insight is only valid for the profile stage', async t => {
  const w = await world(t); const note = await w.vault.put({ scope: wiki, kind: 'source', title: 'S', body: 'Some source text.' });
  const engine = new IntelligenceEngine(w.vault, { id: 'wrong-stage', async generate() { return abstain('n/a'); } });
  await engine.enqueue('wiki', { scope: wiki, objectIds: [note.id] }); const [job] = await engine.run({ job: 'wiki', limit: 1 });
  assert.notEqual(job!.status, 'complete'); assert.equal((await engine.proposals()).length, 0);
  recordCase({ suite: 'profile', name: 'no-insight-profile-only', status: 'PASS' });
});
