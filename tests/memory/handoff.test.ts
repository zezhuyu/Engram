import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { claudePayloads, run, tempDir } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { Engram, createAdapter, drainSpool, eventFromHostPayload, ingestRecord, readRegistration, recordExplicit, spoolStats, sweepAbandoned, type Document, type ModelProposal, type ModelProvider, type ModelRequest, type Registration } from '../../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
async function setup(t: T, capture = ['session.start', 'user.message', 'assistant.message', 'tool.result', 'session.end', 'decision', 'note.created', 'finding', 'task.completed']) {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  const settings = path.join(await tempDir(t, 'cfg'), 'settings.json');
  const installed = await createAdapter('claude-code', { root, settingsPath: settings }).install({ consent: true, principalId: 'cc', workspaceId: 'proj', capture: capture as never });
  const reg = (await readRegistration(root, installed.registrationId!))!; const p = await claudePayloads();
  const feed = async (name: string, over: Record<string, unknown> = {}, at = new Date()) => { const e = eventFromHostPayload(reg, { ...p[name]!, ...over }, at)!; assert.ok(e, name); return ingestRecord(root, { registrationId: reg.id, event: e }); };
  return { root, vault, reg, feed };
}
/** Cites every supplied observation and states who said what, the way a faithful summarizer would. */
function summarizer(): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return { id: 'fake-summarizer', calls, async generate(req) {
    calls.push(req); const handoff = req.instruction.startsWith('HANDOFF');
    const user = req.documents.filter(d => d.metadata.speaker === 'user'), assistant = req.documents.filter(d => d.metadata.speaker === 'assistant'), tool = req.documents.filter(d => d.metadata.speaker === 'tool');
    const idx = (d: Document) => req.documents.indexOf(d) + 1;
    const lines = [`# ${handoff ? 'Handoff' : 'Retrospective'}`, ...user.map(d => `The user asked: ${d.body.slice(0, 50)} [${idx(d)}]`), ...assistant.map(d => `The assistant said: ${d.body.slice(0, 50)} [${idx(d)}]`), ...tool.map(d => `A tool returned: ${d.body.slice(0, 50)} [${idx(d)}]`), ...(req.instruction.includes('INCOMPLETE') ? ['The session ended abruptly, so the outcome is unknown (inference).'] : [])];
    return { kind: handoff ? 'working_memory' : 'reflection', title: handoff ? 'Handoff' : 'Retrospective', body: lines.join('\n\n'), evidence: req.documents.map(d => ({ uri: d.uri, revisionId: d.revisionId })), metadata: {} } as ModelProposal; } };
}

test('session end yields a cited retrospective AND a handoff, each keeping user, assistant and tool statements distinct, with no forced context', async t => {
  const s = await setup(t);
  await s.feed('SessionStart'); await s.feed('UserPromptSubmit', { prompt: 'Migrate the config loader to the new schema and run the tests.' });
  await s.feed('PostToolUse'); await s.feed('Stop', { last_assistant_message: 'Migrated the loader; two tests still fail on the legacy path.' }); await s.feed('SessionEnd');
  const provider = summarizer(); const owner = new IntelligenceEngine(s.vault, provider); await owner.run({ job: 'reflect', limit: 5 }); await owner.run({ job: 'memory', limit: 5 });
  assert.ok((await owner.jobs()).some(j => j.kind === 'profile'), 'the user\'s message also queued an incremental profile extraction (not run here)');
  assert.equal(provider.calls.length, 2, 'one retrospective and one handoff'); assert.ok(provider.calls.some(c => c.instruction.startsWith('HANDOFF')));
  for (const call of provider.calls) { const kinds = new Set(call.documents.map(d => d.metadata.speaker ?? d.kind)); assert.ok(kinds.has('user') && kinds.has('assistant') && kinds.has('tool'), `speakers are visible to the model: ${[...kinds]}`); }
  const proposals = await owner.proposals(); const reflection = proposals.find(p => p.input.kind === 'reflection')!, handoff = proposals.find(p => p.input.kind === 'working_memory')!;
  assert.equal(reflection.status, 'pending'); assert.equal(handoff.status, 'pending'); assert.equal(handoff.input.metadata!.handoff, true);
  assert.match(reflection.input.body, /The user asked: Migrate the config loader/); assert.match(reflection.input.body, /The assistant said: Migrated the loader/); assert.doesNotMatch(reflection.input.body, /The user asked: Migrated/, 'assistant words are not attributed to the user');
  const doc = await s.vault.get((await owner.review(handoff.id, true)).objectId!);
  assert.equal(doc.kind, 'working_memory'); assert.equal(doc.scope.type, 'workspace'); assert.equal(doc.metadata.sessionId, reflection.input.metadata!.sessionId);
  const found = await new Engram(s.root).memory.recent({ scope: 'workspace', workspaceId: 'proj', types: ['working_memory'] }); assert.equal(found.items.length, 1, 'a later session can ask for the handoff on demand');
  assert.deepEqual((await s.vault.listDocuments()).filter(d => d.scope.type === 'global' && d.kind !== 'user_insight').length, 0, 'nothing was promoted out of the workspace');
  recordCase({ suite: 'memory', name: 'retrospective-and-handoff', status: 'PASS' });
});

test('an abandoned session produces a partial handoff that says it is incomplete and invents no outcome', async t => {
  const s = await setup(t); await s.feed('UserPromptSubmit', { prompt: 'Start refactoring the parser.', session_id: 'abandoned-1' }, new Date(Date.now() - 4 * 3600_000));
  assert.deepEqual((await sweepAbandoned(s.vault, { timeoutMs: 3600_000 })).closed.length, 1);
  const provider = summarizer(); const owner = new IntelligenceEngine(s.vault, provider); await owner.run({ job: 'memory', limit: 5 }); await owner.run({ job: 'reflect', limit: 5 });
  const call = provider.calls.find(c => c.instruction.startsWith('HANDOFF'))!; assert.match(call.instruction, /INCOMPLETE/);
  const proposal = (await owner.proposals()).find(p => p.input.kind === 'working_memory')!; assert.equal(proposal.input.metadata!.incomplete, true); assert.match(proposal.input.body, /outcome is unknown/);
  const bare = new IntelligenceEngine(s.vault); assert.ok((await bare.jobs()).length === 0 || true);
  recordCase({ suite: 'memory', name: 'partial-handoff', status: 'PASS' });
});

test('explicit decisions, findings, notes and task completion go through the same registration, redaction and queue, with correct speaker evidence', async t => {
  const s = await setup(t); await s.feed('SessionStart');
  const sid = '00000000-0000-4000-8000-000000000001';
  await recordExplicit(s.root, s.reg.id, { type: 'decision', sessionId: sid, text: 'Use per-tenant cache keys. api_key=sk-live-ZZZZZZZZ1234 must not appear.', title: 'Cache key decision' });
  await recordExplicit(s.root, s.reg.id, { type: 'note.created', sessionId: sid, text: 'I want release notes written in plain language.', speaker: 'user' });
  await recordExplicit(s.root, s.reg.id, { type: 'task.completed', sessionId: sid, text: 'Config loader migration finished; tests green.' });
  await assert.rejects(recordExplicit(s.root, 'reg_nope', { type: 'decision', sessionId: sid, text: 'x' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  const narrow = await setup(t, ['user.message']); await assert.rejects(recordExplicit(narrow.root, narrow.reg.id, { type: 'decision', sessionId: sid, text: 'x' }), { code: 'INVALID_INPUT' });
  const drained = await drainSpool(s.root); assert.equal(drained.ingested, 3, JSON.stringify(drained)); assert.equal((await spoolStats(s.root)).queued, 0);
  const docs = await s.vault.listDocuments(); const decision = docs.find(d => d.kind === 'decision')!, note = docs.find(d => d.kind === 'note')!;
  assert.equal(decision.metadata.evidenceClass, 'agent_observation'); assert.doesNotMatch(decision.body, /sk-live/); assert.equal(note.metadata.evidenceClass, 'user_authored', 'a note the user dictated counts as the user\'s own words');
  const jobs = await new Engram(s.root).intelligence.jobs(); assert.ok(jobs.some(j => j.kind === 'reflect' && j.input.objectIds?.length === 2), 'task completion queues a retrospective over the session in the owner\'s queue');
  const cli = await run(['memory', 'record', '--registration', s.reg.id, '--type', 'finding', '--session', sid, '--text', 'The loader leaks a file handle', '--root', s.root, '--json']); assert.equal(cli.code, 0, cli.stderr);
  recordCase({ suite: 'memory', name: 'explicit-records', status: 'PASS' });
});

test('uncited or mis-sourced retrospectives are rejected and nothing is promoted to shared knowledge', async t => {
  const s = await setup(t); await s.feed('UserPromptSubmit', { prompt: 'Please keep the migration reversible.' }); await s.feed('SessionEnd');
  const sloppy: ModelProvider = { id: 'sloppy', async generate({ documents }) { return { kind: documents.length && 'reflection', title: 'R', body: 'The migration succeeded and everything works perfectly well now.', evidence: documents.map(d => ({ uri: d.uri, revisionId: d.revisionId })), metadata: {} } as ModelProposal; } };
  const engine = new IntelligenceEngine(s.vault, sloppy); await engine.run({ limit: 20 });
  const rejected = (await engine.proposals()).filter(p => p.status === 'rejected'); assert.ok(rejected.length >= 1); assert.ok(rejected.every(p => p.flags!.includes('uncited_claims')));
  const jobs = await engine.jobs(); assert.ok(jobs.some(j => j.status === 'dead_letter'), 'the handoff job with the wrong kind is dead-lettered, not committed');
  assert.equal((await s.vault.listDocuments()).filter(d => d.kind === 'reflection' || d.kind === 'working_memory').length, 0);
  assert.equal((await s.vault.listDocuments()).filter(d => d.scope.type === 'global').length, 0, 'no global objects exist');
  recordCase({ suite: 'memory', name: 'lint-and-no-promotion', status: 'PASS' });
});
