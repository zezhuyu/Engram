import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { IntelligenceEngine, PROFILE_MAX_INSIGHTS, sameClaim } from '../../packages/intelligence/index.js';
import { MDBError, type Document, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';
import { assertedTermsHit } from '../../scripts/lib/profile-metrics.js';

type T = { after(fn: () => void | Promise<void>): void };
const proj: Scope = { type: 'workspace', workspaceId: 'proj' };
async function world(t: T) {
  const { vault } = await disposableVault(t); await vault.createWorkspace('proj', ''); await vault.createWorkspace('private', '');
  const said = (body: string, scope: Scope = proj, at = '2026-10-07T10:00:00.000Z') => vault.put({ scope, kind: 'observation', title: 'User message', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime: at } });
  return { vault, said };
}
type Step = { claim: string; key: string; doc: Document; span: string } | 'abstain' | Error;
/** A provider that answers from a script, one step per call, and records every request. */
function scripted(steps: Step[]): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return { id: 'scripted', calls, async generate(request) {
    calls.push(request); const step = steps.shift() ?? 'abstain';
    if (step instanceof Error) throw step;
    if (step === 'abstain') return { kind: 'no_insight', title: 'No insight', body: 'Nothing further is stated.', evidence: [] };
    return { kind: 'user_insight', title: step.claim.slice(0, 80), body: step.claim, evidence: [{ uri: step.doc.uri, revisionId: step.doc.revisionId, span: step.span }], metadata: { category: 'preference', preferenceKey: step.key, sensitivity: 'none', explicitStatement: true } };
  } };
}
const FOUR = 'From now on write commit messages in the imperative mood. Always run the linter before committing. I prefer small pull requests. Use tabs, never spaces, in Go files.';
const four = (doc: Document): Step[] => [
  { claim: 'The user wants commit messages in the imperative mood.', key: 'commit-mood', doc, span: 'write commit messages in the imperative mood' },
  { claim: 'The user always runs the linter before committing.', key: 'lint-first', doc, span: 'Always run the linter before committing' },
  { claim: 'The user prefers small pull requests.', key: 'pr-size', doc, span: 'I prefer small pull requests' },
  { claim: 'The user wants tabs, never spaces, in Go files.', key: 'go-tabs', doc, span: 'Use tabs, never spaces, in Go files' }
];
const run = async (engine: IntelligenceEngine) => { await engine.enqueue('profile', { scope: proj, incremental: true }); const [job] = await engine.run({ job: 'profile', limit: 1 }); return job!; };
const pendingInsights = async (engine: IntelligenceEngine) => (await engine.proposals()).filter(p => p.input.kind === 'user_insight' && p.status === 'pending');

test('multi-insight keyword scoring respects explicit negation in a corrected claim', () => {
  const corrected = 'The user prefers two spaces for indentation and never tabs.';
  assert.equal(assertedTermsHit(corrected, ['spaces']), true);
  assert.equal(assertedTermsHit(corrected, ['prefers', 'tabs', 'indentation']), false);
  assert.equal(assertedTermsHit('The user prefers tabs for indentation, not spaces.', ['prefers', 'tabs', 'indentation']), true);
  assert.equal(assertedTermsHit('The user runs the linter before each commit.', ['lint']), true);
  assert.equal(assertedTermsHit('The user has experience with PostgreSQL tuning.', ['postgres']), true);
  assert.equal(assertedTermsHit('The user is interested in compilers.', ['compiler']), true);
  assert.equal(assertedTermsHit('The user prefers pinning dependency versions.', ['pin']), true);
});

test('claim deduplication preserves relation direction, negation and Unicode equivalence', () => {
  assert.equal(sameClaim('I prefer Python over Rust.', 'I prefer Rust over Python.'), false);
  assert.equal(sameClaim('I prefer tabs.', 'I do not prefer tabs.'), false);
  assert.equal(sameClaim('I prefer café!', 'I prefer cafe\u0301!'), true);
  assert.equal(sameClaim('I prefer café.', 'I prefer café!'), false, 'punctuation uncertainty is preserved');
  assert.equal(sameClaim('I prefer Python over Rust.', 'I prefer Python, over Rust!'), false, 'uncertain punctuation differences are retained for review');
  assert.equal(sameClaim('I prefer C over Rust.', 'I prefer C++ over Rust.'), false);
  assert.equal(sameClaim('I prefer C++ over Rust.', 'I prefer C# over Rust.'), false);
  assert.equal(sameClaim('The limit is <= 5.', 'The limit is >= 5.'), false);
  assert.equal(sameClaim('The limit is <= 5.', 'The limit is ≤ 5.'), true, 'mathematical presentation equivalent');
  assert.equal(sameClaim('Use foo::bar.', 'Use foo/bar.'), false);
  assert.equal(sameClaim('Use FooBar.', 'Use foobar.'), false, 'case-sensitive technical identifiers stay distinct');
});

test('incremental profile cursor drains the oldest prefix when more than eight observations arrive', async t => {
  const w = await world(t); const docs: Document[] = [];
  for (let i = 1; i <= 9; i++) docs.push(await w.said(`Observation ${i}: no lasting preference is stated.`, proj, `2026-10-07T10:00:${String(i).padStart(2, '0')}.000Z`));
  const provider = scripted(['abstain', 'abstain']); const engine = new IntelligenceEngine(w.vault, provider);
  await run(engine); assert.equal(provider.calls[0]!.documents.length, 8); assert.ok(provider.calls[0]!.documents.some(d => d.id === docs[0]!.id)); assert.ok(!provider.calls[0]!.documents.some(d => d.id === docs[8]!.id));
  await run(engine); assert.ok(provider.calls[1]!.documents.some(d => d.id === docs[8]!.id), 'the ninth observation remains eligible after the first eight complete');
  recordCase({ suite: 'profile', name: 'profile-cursor-selection-limit-eight', status: 'PASS' });
});

test('token-truncated profile evidence remains eligible on the next process run', async t => {
  const w = await world(t); const large = await w.said(`Long evidence ${'word '.repeat(6000)}`, proj, '2026-10-07T10:00:01.000Z'); await w.said('A later observation has no lasting preference.', proj, '2026-10-07T10:00:02.000Z');
  const config = await w.vault.config(); config.model.maxInputTokens = 2048; await (await import('node:fs/promises')).writeFile(`${w.vault.root}/mdb.yaml`, (await import('yaml')).default.stringify(config));
  const firstProvider = scripted(['abstain']); const first = new IntelligenceEngine(w.vault, firstProvider); await run(first);
  assert.ok(firstProvider.calls[0]!.documents.some(d => d.id === large.id && d.body.length < large.body.length && !d.body.includes('[truncated for token budget]')));
  assert.equal(firstProvider.calls[0]!.documents[0]!.body, large.body.slice(0, firstProvider.calls[0]!.documents[0]!.body.length), 'the first input is a contiguous prefix, never a synthetic truncation marker');
  const secondProvider = scripted(['abstain']); const second = new IntelligenceEngine(w.vault, secondProvider); const retry = await run(second);
  assert.ok(secondProvider.calls[0], `expected the truncated entry to be retried; job=${JSON.stringify(retry)}`);
  assert.ok(secondProvider.calls[0]!.documents.some(d => d.id === large.id && d.body !== firstProvider.calls[0]!.documents[0]!.body), 'a persisted chunk offset resumes after the first input instead of resending the prefix');
  recordCase({ suite: 'profile', name: 'profile-cursor-token-truncation', status: 'PASS' });
});

test('a repeated known claim cannot checkpoint past other claims in the same source chunk', async t => {
  const w = await world(t);
  const body = `I prefer concise summaries. I prefer release notes with examples. ${'filler '.repeat(9000)}`;
  const source = await w.said(body, proj, '2026-10-07T10:00:00.000Z');
  const config = await w.vault.config(); config.model.maxInputTokens = 2048;
  await (await import('node:fs/promises')).writeFile(`${w.vault.root}/mdb.yaml`, (await import('yaml')).default.stringify(config));
  await w.vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'Known', body: 'The user prefers concise summaries.', status: 'accepted', evidence: [{ uri: source.uri, revisionId: source.revisionId }], metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'summary', scopeLabel: 'proj', evidenceClass: 'explicit', sensitivity: 'none', explicitStatement: true } });
  const repeated = scripted([{ claim: 'The user prefers concise summaries.', key: 'summary', doc: source, span: 'I prefer concise summaries' }]);
  const first = await run(new IntelligenceEngine(w.vault, repeated));
  assert.equal(first.telemetry?.complete, false);
  assert.equal(first.telemetry?.partialReason, 'MODEL_REPEATED_KNOWN_CLAIM: cursor remains resumable');
  const next = scripted([{ claim: 'The user prefers release notes with examples.', key: 'release-notes', doc: source, span: 'I prefer release notes with examples' }, 'abstain']);
  await run(new IntelligenceEngine(w.vault, next));
  assert.equal(next.calls[0]!.documents[0]!.body, repeated.calls[0]!.documents[0]!.body, 'the exact same unexhausted source chunk is retried');
  assert.equal((await pendingInsights(new IntelligenceEngine(w.vault, next))).length, 1, 'the later independent claim in the chunk remains extractable');
  recordCase({ suite: 'profile', name: 'profile-chunk-repeated-known-cursor', status: 'PASS' });
});

test('sensitive leading observations are skipped without stalling later eligible evidence', async t => {
  const w = await world(t);
  const privateSource = await w.said('PRIVATE-SENSITIVE-CANARY', proj, '2026-10-07T10:00:00.000Z');
  await w.vault.patch({ objectId: privateSource.id, expectedRevisionId: privateSource.revisionId, metadataPatch: { sensitivity: 'sensitive' } });
  const visible = await w.said('I prefer deterministic tests.', proj, '2026-10-07T10:00:01.000Z');
  const provider = scripted(['abstain']);
  const job = await run(new IntelligenceEngine(w.vault, provider));
  assert.equal(job.status, 'complete');
  assert.ok(provider.calls.length === 1 && provider.calls[0]!.documents.some(doc => doc.id === visible.id));
  assert.ok(!JSON.stringify(provider.calls).includes('PRIVATE-SENSITIVE-CANARY'));
  const after = await w.vault.listDocuments({ scopes: [proj] });
  assert.ok(after.some(doc => doc.id === privateSource.id && doc.metadata.sensitivity === 'sensitive'));
  recordCase({ suite: 'profile', name: 'profile-sensitive-skip-progress', status: 'PASS' });
});

test('48K oldest source is chunked through its tail across process restarts without starving later observations', async t => {
  const w = await world(t);
  const body = `${'x'.repeat(48_000)} TAIL-ONLY-PREFERENCE-CANARY`;
  const large = await w.said(body, proj, '2026-10-07T10:00:00.000Z');
  const later: Document[] = [];
  for (let i = 1; i <= 9; i++) later.push(await w.said(`Observation ${i}: no durable preference.`, proj, `2026-10-07T10:00:${String(i).padStart(2, '0')}.000Z`));
  const config = await w.vault.config(); config.model.maxInputTokens = 2048;
  await (await import('node:fs/promises')).writeFile(`${w.vault.root}/mdb.yaml`, (await import('yaml')).default.stringify(config));
  const chunks: string[] = []; let calls = 0; let proposedTail = false;
  const provider: ModelProvider & { calls: ModelRequest[] } = { id: 'tail-check', calls: [], async generate(request) {
    calls++; this.calls.push(request); const source = request.documents.find(doc => doc.id === large.id);
    if (!source) return { kind: 'no_insight', title: 'No insight', body: 'No enduring insight in this batch.', evidence: [] };
    chunks.push(source.body);
    if (source.body.includes('TAIL-ONLY-PREFERENCE-CANARY') && !proposedTail) { proposedTail = true; return { kind: 'user_insight', title: 'The user prefers the tail canary.', body: 'The user prefers TAIL-ONLY-PREFERENCE-CANARY.', evidence: [{ uri: large.uri, revisionId: large.revisionId, span: 'TAIL-ONLY-PREFERENCE-CANARY' }], metadata: { category: 'preference', preferenceKey: 'tail-canary', sensitivity: 'none' } }; }
    return { kind: 'no_insight', title: 'No insight', body: 'No enduring insight in this chunk.', evidence: [] };
  } };
  let sawTail = false;
  for (let i = 0; i < 60 && !sawTail; i++) {
    const engine = new IntelligenceEngine(w.vault, provider); await run(engine);
    sawTail = chunks.some(chunk => chunk.includes('TAIL-ONLY-PREFERENCE-CANARY'));
  }
  assert.ok(sawTail, `tail evidence eventually reached provider after ${calls} chunk(s)`);
  assert.ok(chunks.length > 1); assert.equal(chunks[0], body.slice(0, chunks[0]!.length));
  assert.ok(chunks.some((chunk, index) => index > 0 && chunk !== chunks[0]), 'resumed chunks advance and include non-prefix regions');
  assert.ok((await new IntelligenceEngine(w.vault, provider).proposals()).some(p => p.input.body.includes('TAIL-ONLY-PREFERENCE-CANARY')), 'a tail-only insight can be proposed with evidence from the final chunk');
  const finalEngine = new IntelligenceEngine(w.vault, provider);
  const laterStart = provider.calls.length;
  for (let i = 0; i < 3; i++) await run(finalEngine);
  const laterSeen = new Set(provider.calls.slice(laterStart).flatMap(call => call.documents.map(doc => doc.id)));
  for (const item of later) assert.ok(laterSeen.has(item.id), `later source ${item.id} eventually reaches extraction`);
  recordCase({ suite: 'profile', name: 'profile-chunked-tail-eventual-progress', status: 'PASS' });
});

test('the observed four-preference batch yields four independent, separately cited proposals; the cursor waits until the model says nothing more remains', async t => {
  const w = await world(t); const message = await w.said(FOUR);
  const provider = scripted(four(message)); const engine = new IntelligenceEngine(w.vault, provider);
  const job1 = await run(engine);
  assert.equal(job1.status, 'complete'); assert.equal(PROFILE_MAX_INSIGHTS, 4);
  const proposals = await pendingInsights(engine); assert.equal(proposals.length, 4);
  for (const [i, p] of proposals.entries()) { assert.equal(p.status, 'pending', 'every proposal needs human review'); assert.equal(p.input.evidence?.length, 1); assert.equal(p.input.evidence![0]!.span, four(message)[i] && (four(message)[i] as { span: string }).span); assert.ok(FOUR.includes(p.input.evidence![0]!.span!), 'span is verbatim source text'); }
  assert.equal(job1.telemetry?.proposals, 4); assert.equal(job1.telemetry?.complete, false, 'the cap was reached: more might remain');
  const callsAfterFirst = provider.calls.length;
  const job2 = await run(engine); // evidence was NOT consumed, so it is shown again, with the four claims excluded
  assert.ok(provider.calls[callsAfterFirst]!.documents.some(d => d.id === message.id), 'unprocessed evidence is reconsidered');
  assert.match(provider.calls[callsAfterFirst]!.instruction, /Already known or already proposed/); assert.match(provider.calls[callsAfterFirst]!.instruction, /imperative mood/);
  assert.equal(job2.telemetry?.complete, true); assert.equal((await pendingInsights(engine)).length, 4, 'no duplicates after the second job');
  const callsAfterSecond = provider.calls.length; await run(engine);
  assert.equal(provider.calls.length, callsAfterSecond, 'now the cursor moved: nothing new, no model call');
  assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.status === 'accepted').length, 0, 'nothing is accepted automatically');
  recordCase({ suite: 'profile', name: 'multi-insight-four-preferences', status: 'PASS' });
});

test('a truncated or failed later call keeps the earlier proposals, reports partial, and does not advance the cursor', async t => {
  const w = await world(t); const message = await w.said(FOUR); const steps = four(message);
  const provider = scripted([steps[0]!, steps[1]!, new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit'), new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit'), new MDBError('INVALID_MODEL_OUTPUT', 'Model output was truncated by the token limit')]);
  const engine = new IntelligenceEngine(w.vault, provider); const job = await run(engine);
  assert.equal(job.status, 'complete'); assert.equal(job.telemetry?.outcome, 'partial'); assert.match(job.telemetry!.partialReason!, /truncated/); assert.equal((await pendingInsights(engine)).length, 2);
  const before = provider.calls.length; provider.calls.length = 0;
  const retry = scripted([steps[2]!, steps[3]!, 'abstain']); const engine2 = new IntelligenceEngine(w.vault, retry); await run(engine2);
  assert.ok(retry.calls[0]!.documents.some(d => d.id === message.id), 'the evidence that was not fully processed is offered again'); void before;
  assert.equal((await pendingInsights(engine2)).length, 4, 'the two earlier claims are not proposed again; only the two missing ones are added');
  recordCase({ suite: 'profile', name: 'multi-insight-truncation-partial', status: 'PASS' });
});

test('a first-call failure proposes nothing and leaves the cursor alone', async t => {
  const w = await world(t); const message = await w.said(FOUR);
  const failing = new IntelligenceEngine(w.vault, scripted([new Error('provider down'), new Error('provider down'), new Error('provider down')]));
  await failing.enqueue('profile', { scope: proj, incremental: true }); const [job] = await failing.run({ job: 'profile', limit: 1 });
  assert.notEqual(job!.status, 'complete'); assert.equal((await pendingInsights(failing)).length, 0);
  const ok = scripted(four(message)); await ((async () => { const e = new IntelligenceEngine(w.vault, ok); await e.enqueue('profile', { scope: proj, incremental: true, instruction: 'retry after outage' }); await e.run({ job: 'profile', limit: 1 }); })()); assert.ok(ok.calls[0]!.documents.some(d => d.id === message.id), 'the evidence was never consumed');
  recordCase({ suite: 'profile', name: 'multi-insight-first-call-failure', status: 'PASS' });
});

test('crash recovery: proposals made before the crash are kept and are not proposed again by the next process', async t => {
  const w = await world(t); const message = await w.said(FOUR); const steps = four(message);
  const crashing = new IntelligenceEngine(w.vault, scripted([steps[0]!, steps[1]!, new Error('process killed')]));
  await run(crashing); const kept = (await pendingInsights(crashing)).length; assert.equal(kept, 2);
  const restarted = new IntelligenceEngine(w.vault, scripted([steps[2]!, steps[3]!, 'abstain']));
  await run(restarted); assert.equal((await pendingInsights(restarted)).length, 4, 'exactly four, no duplicates of the first two');
  recordCase({ suite: 'profile', name: 'multi-insight-crash-recovery', status: 'PASS' });
});

test('SIGKILL during a profile provider call leaves its input cursor unchanged for a fresh process', async t => {
  const w = await world(t); const source = await w.said('I prefer compact release notes.');
  const marker = path.join(os.tmpdir(), `mdb-profile-kill-${process.pid}-${Date.now()}`);
  const intelUrl = new URL('../../packages/intelligence/index.js', import.meta.url).href;
  const vaultUrl = new URL('../../packages/core/vault.js', import.meta.url).href;
  const childCode = `import {writeFileSync} from 'node:fs';
    const {Vault}=await import(${JSON.stringify(vaultUrl)});
    const {IntelligenceEngine}=await import(${JSON.stringify(intelUrl)});
    const vault=new Vault(process.env.MDB_TEST_ROOT);
    const engine=new IntelligenceEngine(vault,{id:'kill-provider',async generate(){writeFileSync(process.env.MDB_TEST_MARKER+'.called','called');await new Promise(()=>{});}});
    const job=await engine.enqueue('profile',{scope:{type:'workspace',workspaceId:'proj'},incremental:true});
    writeFileSync(process.env.MDB_TEST_MARKER,job.id);
    await engine.run({jobId:job.id,limit:1});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env: { ...process.env, MDB_TEST_ROOT: w.vault.root, MDB_TEST_MARKER: marker }, stdio: 'ignore' });
  const childExit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await fs.rm(marker, { force: true }); await fs.rm(`${marker}.called`, { force: true }); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await fs.stat(`${marker}.called`).catch(() => undefined))) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(await fs.stat(`${marker}.called`).catch(() => undefined), 'child process reached the provider call');
  const jobId = await fs.readFile(marker, 'utf8');
  child.kill('SIGKILL'); await childExit;
  const provider = scripted(['abstain']); const restarted = new IntelligenceEngine(w.vault, provider);
  assert.equal(await restarted.retryNow(jobId, { force: true }), true);
  const [job] = await restarted.run({ jobId, limit: 1 });
  assert.equal(job?.status, 'complete'); assert.ok(provider.calls[0]?.documents.some(doc => doc.id === source.id), 'the crashed evidence is supplied again after process restart');
  recordCase({ suite: 'profile', name: 'profile-cursor-sigkill-recovery', status: 'PASS' });
});

test('SIGKILL after a committed chunk checkpoint resumes at the next source offset', async t => {
  const w = await world(t); const source = await w.said(`HEAD-CHECKPOINT ${'large '.repeat(9000)} TAIL-CHECKPOINT`, proj, '2026-10-07T10:00:01.000Z');
  const config = await w.vault.config(); config.model.maxInputTokens = 2048;
  await (await import('node:fs/promises')).writeFile(`${w.vault.root}/mdb.yaml`, (await import('yaml')).default.stringify(config));
  const marker = path.join(os.tmpdir(), `mdb-profile-chunk-kill-${process.pid}-${Date.now()}`);
  const intelUrl = new URL('../../packages/intelligence/index.js', import.meta.url).href;
  const vaultUrl = new URL('../../packages/core/vault.js', import.meta.url).href;
  const childCode = `import {writeFileSync} from 'node:fs';
    const {Vault}=await import(${JSON.stringify(vaultUrl)});
    const {IntelligenceEngine}=await import(${JSON.stringify(intelUrl)});
    const vault=new Vault(process.env.MDB_TEST_ROOT);
    const engine=new IntelligenceEngine(vault,{id:'chunk-checkpoint',async generate(request){writeFileSync(process.env.MDB_TEST_MARKER+'.chunk',request.documents.find(d=>d.id===process.env.MDB_TEST_SOURCE).body);return {kind:'no_insight',title:'No insight',body:'Nothing more in this chunk.',evidence:[]};}});
    const job=await engine.enqueue('profile',{scope:{type:'workspace',workspaceId:'proj'},incremental:true});
    await engine.run({jobId:job.id,limit:1});writeFileSync(process.env.MDB_TEST_MARKER,'checkpoint');await new Promise(()=>{});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env: { ...process.env, MDB_TEST_ROOT: w.vault.root, MDB_TEST_MARKER: marker, MDB_TEST_SOURCE: source.id }, stdio: 'ignore' });
  const childExit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await fs.rm(marker, { force: true }); await fs.rm(`${marker}.chunk`, { force: true }); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(await fs.stat(marker).catch(() => undefined))) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(await fs.stat(marker).catch(() => undefined), 'child committed the offset checkpoint before termination');
  const firstChunk = await fs.readFile(`${marker}.chunk`, 'utf8');
  child.kill('SIGKILL'); await childExit;
  const provider = scripted(['abstain']); const restarted = new IntelligenceEngine(w.vault, provider); await run(restarted);
  const resumed = provider.calls[0]!.documents.find(doc => doc.id === source.id)!.body;
  assert.notEqual(resumed, firstChunk, 'restart resumes after the durable chunk boundary');
  assert.equal(resumed, source.body.slice(firstChunk.length, firstChunk.length + resumed.length), 'the next chunk is contiguous with the prior exact source text');
  recordCase({ suite: 'profile', name: 'profile-chunk-checkpoint-sigkill-recovery', status: 'PASS' });
});

test('duplicates are exact-repeat only: a repeat is dropped, a correction that shares most words is NOT dropped', async t => {
  const w = await world(t); const first = await w.said('I prefer concise code review feedback.');
  const engine = new IntelligenceEngine(w.vault, scripted([{ claim: 'The user prefers concise code review feedback.', key: 'review', doc: first, span: 'I prefer concise code review feedback' }, 'abstain']));
  await run(engine); assert.equal((await pendingInsights(engine)).length, 1);
  const second = await w.said('Still true: I prefer concise code review feedback.', proj, '2026-10-07T11:00:00.000Z');
  const again = new IntelligenceEngine(w.vault, scripted([{ claim: 'The user prefers concise code review feedback.', key: 'review', doc: second, span: 'I prefer concise code review feedback' }]));
  const repeat = await run(again); assert.equal(repeat.status, 'complete'); assert.equal((await pendingInsights(again)).length, 1, 'the exact repeat is not a second proposal'); assert.equal(repeat.telemetry?.duplicates, 1);
  const third = await w.said('Actually I now prefer detailed code review feedback.', proj, '2026-10-07T12:00:00.000Z');
  const correction = new IntelligenceEngine(w.vault, scripted([{ claim: 'The user prefers detailed code review feedback.', key: 'review', doc: third, span: 'I now prefer detailed code review feedback' }, 'abstain']));
  await run(correction); assert.equal((await pendingInsights(correction)).length, 2, 'the correction was proposed for review, not dropped as a near-duplicate');
  recordCase({ suite: 'profile', name: 'multi-insight-duplicates', status: 'PASS' });
});

test('ACL isolation: other workspaces\' evidence and insights never reach the model or the exclusion list', async t => {
  const w = await world(t); const mine = await w.said(FOUR); const secret = await w.said('I always keep the vault password in PRIVATE-MARKER-77.', { type: 'workspace', workspaceId: 'private' });
  await w.vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'x', body: 'The user keeps PRIVATE-MARKER-77 secrets.', status: 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: 'secret', scopeLabel: 'private', sensitivity: 'none', evidenceClass: 'explicit' } });
  void secret; const provider = scripted(four(mine)); await run(new IntelligenceEngine(w.vault, provider));
  assert.ok(provider.calls.length >= 4);
  assert.ok(!JSON.stringify(provider.calls.map(c => [c.documents, c.instruction])).includes('PRIVATE-MARKER-77'), 'the other workspace\'s evidence and its insight claim are in neither the documents nor the exclusion list');
  recordCase({ suite: 'profile', name: 'multi-insight-acl', status: 'PASS' });
});
