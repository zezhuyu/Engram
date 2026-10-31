import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { Vault } from '../packages/core/vault.js';
import { cleanupPreview } from '../packages/core/storage-lifecycle.js';
import { IntelligenceEngine } from '../packages/intelligence/index.js';
import { CliAgentProvider, cliArguments, createProviderFromConfig, describeModel, OpenAICompatibleProvider, type Document, type ModelRequest, type ModelConfig } from '../packages/sdk/index.js';

type T = { after(fn: () => void | Promise<void>): void };
const doc: Document = { id: 'obj_1', revisionId: 'rev_1', revisionNumber: 1, scope: { type: 'global', area: 'wiki' }, kind: 'source', title: 'Src', body: 'Evidence: caches help. SECRET-PROMPT-BODY', tags: [], links: [], evidence: [], status: 'active', createdAt: '', updatedAt: '', createdBy: 'o', metadata: {}, path: 'p', uri: 'mdb://wiki/objects/obj_1' };
const request: ModelRequest = { job: 'wiki', documents: [doc], goals: 'goal', instruction: 'be careful' };

const FAKE = (name: string) => `#!/usr/bin/env node
const fs=require('fs');let input='';const launches=process.env.FAKE_AGENT_LAUNCHES;if(launches)fs.appendFileSync(launches,process.pid+'\\n');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const log=process.env.FAKE_AGENT_LOG;
 if(log)fs.appendFileSync(log,JSON.stringify({name:${JSON.stringify(name)},pid:process.pid,argv:process.argv.slice(2),cwd:process.cwd(),cwdReal:fs.realpathSync(process.cwd()),tmpdir:process.env.TMPDIR??null,tmpdirReal:fs.realpathSync(process.env.TMPDIR),tmp:process.env.TMP??null,temp:process.env.TEMP??null,stdin:input,dataDir:process.env.ENGRAM_DATA_DIR??null,mdbRoot:process.env.MDB_ROOT??null})+'\\n');
 const mode=process.env.FAKE_MODE||'ok';
 const out=(t)=>{const i=process.argv.indexOf('-o');if(i>=0)fs.writeFileSync(process.argv[i+1],t);else process.stdout.write(t);};
 if(mode==='fail'){process.stderr.write('SECRET-STDERR '+input.slice(0,80));process.exit(3);}
 if(mode==='hang'){setInterval(()=>{},1000);return;}
 if(mode==='huge'){process.stdout.write('x'.repeat(3000000));return;}
 if(mode==='garbage'){out('I refuse to answer in JSON.');return;}
 if(mode==='empty'){return;}
 if(/strict critic/.test(input)){out(JSON.stringify({verdict:process.env.FAKE_VERDICT||'accept',rationale:'checked by '+${JSON.stringify(name)}}));return;}
 const m=/uri=(\\S+) revision=(\\S+) /.exec(input);
 out('\`\`\`json\\n'+JSON.stringify({kind:'wiki_page',title:'From '+${JSON.stringify(name)},body:'Derived by '+${JSON.stringify(name)}+' from the cited source [1].',evidence:[{uri:m[1],revisionId:m[2]}]})+'\\n\`\`\`');
});
`;
async function fakeAgents(t: T, names = ['claude', 'codex']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-fakebin-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of names) { const file = path.join(dir, name); await fs.writeFile(file, FAKE(name)); await fs.chmod(file, 0o755); }
  const log = path.join(dir, 'calls.jsonl'); const launches = path.join(dir, 'launches.txt');
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { name: string; pid: number; argv: string[]; cwd: string; cwdReal: string; tmpdir: string | null; tmpdirReal: string; tmp: string | null; temp: string | null; stdin: string; dataDir: string | null; mdbRoot: string | null });
  const launchCount = async () => (await fs.readFile(launches, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return { dir, log, calls, launchCount, env: (extra: Record<string, string> = {}) => ({ PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_AGENT_LOG: log, FAKE_AGENT_LAUNCHES: launches, ...extra }) };
}
const base = (over: Partial<ModelConfig> = {}): ModelConfig => ({ provider: 'auto', allowNetwork: false, ...over });
async function vaultWithSource(t: T, scope: 'global' | 'workspace' = 'global') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-agent-vault-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root); await vault.init(); await vault.createWorkspace('ws', '');
  const where = scope === 'global' ? { type: 'global' as const, area: 'wiki' as const } : { type: 'workspace' as const, workspaceId: 'ws' };
  const source = await vault.put({ scope: where, kind: 'source', title: 'Source', body: 'The cache was warm.' });
  return { root, vault, source, where };
}
async function setConfig(root: string, patch: (c: Awaited<ReturnType<Vault['config']>>) => void) { const v = new Vault(root); const c = await v.config(); patch(c); await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(c)); }
const run = (args: string[], env: Record<string, string | undefined>) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => { const c = spawn(process.execPath, args, { env: env as NodeJS.ProcessEnv }); let stdout = '', stderr = ''; c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; }); c.on('close', code => resolve({ code, stdout, stderr })); });

test('claude CLI adapter: tool-free non-interactive flags, prompt on stdin only, isolated cwd, vault env scrubbed', async t => {
  const agents = await fakeAgents(t);
  const provider = createProviderFromConfig(base({ provider: 'claude-cli', modelName: 'sonnet' }), { ...agents.env(), ENGRAM_DATA_DIR: '/secret/vault', MDB_ROOT: '/secret/vault2' });
  assert.equal(provider.id, 'claude-cli:sonnet'); assert.equal(provider.locality, 'remote');
  const remotePiiRequest = { ...request, goals: 'SSN 123-45-6789 card 4111 1111 1111 1111 email jane.doe@example.test', documents: [{ ...doc, body: `${doc.body} SSN 123-45-6789 card 4111 1111 1111 1111 email jane.doe@example.test` }] };
  const proposal = await provider.generate(remotePiiRequest);
  assert.equal(proposal.title, 'From claude'); assert.equal(proposal.evidence[0]!.uri, doc.uri);
  const [call] = await agents.calls();
  assert.deepEqual(call!.argv, cliArguments('claude', { model: 'sonnet', cwd: call!.cwd }));
  for (const required of ['-p', '--tools', '--no-session-persistence', '--strict-mcp-config', '--setting-sources']) assert.ok(call!.argv.includes(required), required);
  assert.equal(call!.argv[call!.argv.indexOf('--tools') + 1], '', 'all tools disabled');
  assert.ok(!call!.argv.join(' ').includes('SECRET-PROMPT-BODY'), 'prompt content never appears in argv');
  assert.match(call!.stdin, /<<<DOCUMENT uri=mdb:\/\/wiki\/objects\/obj_1 revision=rev_1/);
  assert.match(call!.stdin, /untrusted data/);
  for (const pii of ['123-45-6789', '4111 1111 1111 1111', 'jane.doe@example.test']) assert.equal(call!.stdin.includes(pii), false, `remote CLI prompt contained PII: ${pii}`);
  assert.match(call!.stdin, /REDACTED SSN/); assert.match(call!.stdin, /REDACTED CARD/); assert.match(call!.stdin, /REDACTED EMAIL/);
  assert.ok(call!.cwd.includes('engram-agent-') && !call!.cwd.includes('secret'), 'runs in a throwaway directory');
  await assert.rejects(fs.stat(call!.cwd), { code: 'ENOENT' }, 'throwaway directory removed');
  assert.equal(call!.dataDir, null); assert.equal(call!.mdbRoot, null);
});

test('explicit data root contains model CLI scratch even when OS TMPDIR is separate', async t => {
  const agents = await fakeAgents(t); const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-model-root-')); const externalTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-model-os-tmp-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(externalTmp, { recursive: true, force: true }); });
  const oldRoot = process.env.ENGRAM_DATA_DIR, oldTmp = process.env.TMPDIR;
  process.env.ENGRAM_DATA_DIR = root; process.env.TMPDIR = externalTmp;
  t.after(() => { if (oldRoot === undefined) delete process.env.ENGRAM_DATA_DIR; else process.env.ENGRAM_DATA_DIR = oldRoot; if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; });
  const provider = createProviderFromConfig(base({ provider: 'claude-cli' }), agents.env()); await provider.generate(request);
  const [call] = await agents.calls(); const canonicalRoot = await fs.realpath(root);
  assert.ok(call!.cwd.startsWith(path.join(canonicalRoot, '.engram-runtime/tmp/operations/engram-agent-')));
  assert.equal(call!.tmpdirReal, call!.cwdReal); assert.equal(call!.tmpdir, call!.tmp); assert.equal(call!.tmpdir, call!.temp);
  await assert.rejects(fs.stat(call!.cwd), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(externalTmp), [], 'the provider wrapper did not write scratch into OS TMPDIR');
});

test('SIGKILL during model scratch leaves a marked orphan that restart reports without deleting', async t => {
  const agents = await fakeAgents(t); const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-model-orphan-root-')); const externalTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-model-orphan-os-tmp-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(externalTmp, { recursive: true, force: true }); });
  const sdkUrl = new URL('../packages/sdk/index.js', import.meta.url).href;
  const source = `import {createProviderFromConfig} from ${JSON.stringify(sdkUrl)};const p=createProviderFromConfig({provider:'claude-cli',allowNetwork:false,maxRetries:0,timeoutMs:30000,maxInputTokens:10000});await p.generate(${JSON.stringify(request)});`;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...agents.env({ FAKE_MODE: 'hang' }), ENGRAM_DATA_DIR: root, TMPDIR: externalTmp }, stdio: 'ignore' });
  let fakePid: number | undefined; let operationDir: string | undefined;
  t.after(async () => {
    if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL');
    if (fakePid && processIsAlive(fakePid)) { try { process.kill(fakePid, 'SIGTERM'); } catch { /* the owned fake provider already exited */ } }
  });
  for (let i = 0; i < 200; i++) {
    const call = (await agents.calls())[0];
    if (call) { fakePid = call.pid; operationDir = call.cwd; break; }
    if (harness.exitCode !== null || harness.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(fakePid && operationDir, 'the fake provider started inside an owned model operation');
  const canonicalRoot = await fs.realpath(root);
  assert.equal(path.relative(path.join(canonicalRoot, '.engram-runtime/tmp/operations'), operationDir!).startsWith('..'), false, `scratch path ${operationDir} should be under ${canonicalRoot}`);
  const marker = JSON.parse(await fs.readFile(path.join(operationDir!, '.engram-operation.json'), 'utf8')) as { pid: number; state: string };
  assert.equal(marker.pid, harness.pid); assert.equal(marker.state, 'active'); assert.deepEqual(await fs.readdir(externalTmp), []);
  const harnessClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => harness.once('close', (code, signal) => resolve({ code, signal })));
  harness.kill('SIGKILL'); assert.deepEqual(await harnessClosed, { code: null, signal: 'SIGKILL' });
  try { process.kill(fakePid!, 'SIGTERM'); } catch { /* child exited with its parent */ }
  for (let i = 0; i < 100 && processIsAlive(fakePid!); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(processIsAlive(fakePid!), false, 'the only terminated descendant is the PID recorded by this test fake');
  const report = await cleanupPreview({ ENGRAM_DATA_DIR: root }); assert.equal(report.deleted, 0); assert.ok(report.candidates.some(candidate => candidate.directory === operationDir), 'restart reports the interrupted scratch as an orphan');
  assert.ok(await fs.stat(path.join(operationDir!, '.engram-operation.json')), 'reporting an orphan does not delete recovery evidence');
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // On Linux, a terminated orphan can remain as a zombie until PID 1 reaps
    // it. kill(pid, 0) still succeeds for that PID, but it cannot execute or
    // write. Treat only a confirmed /proc zombie as exited; never infer exit
    // from an unreadable procfs entry.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = /^\d+ \(.*\) ([A-Z]) /.exec(stat)?.[1];
      if (state === 'Z' || state === 'X') return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

test('codex CLI adapter: read-only sandbox, ephemeral, last-message file, prompt on stdin', async t => {
  const agents = await fakeAgents(t);
  const provider = createProviderFromConfig(base({ provider: 'codex-cli' }), agents.env());
  assert.equal((await provider.generate(request)).title, 'From codex');
  const [call] = await agents.calls();
  assert.equal(call!.argv[0], 'exec'); assert.equal(call!.argv.at(-1), '-');
  assert.equal(call!.argv[call!.argv.indexOf('--sandbox') + 1], 'read-only');
  for (const flag of ['--ephemeral', '--skip-git-repo-check', '-o', '-C']) assert.ok(call!.argv.includes(flag), flag);
  assert.equal(path.basename(call!.argv[call!.argv.indexOf('-C') + 1]!), path.basename(call!.cwd), 'codex is rooted in the throwaway directory');
  assert.ok(!call!.argv.join(' ').includes('SECRET-PROMPT-BODY'));
  assert.equal((await provider.critique!({ proposal: { kind: 'wiki_page', title: 't', body: 'b', evidence: [] }, evidence: [doc], instruction: 'x' })).verdict, 'accept');
});

test('agent CLI failures are sanitized, bounded and cancellable', async t => {
  const agents = await fakeAgents(t);
  const make = (mode: string, extra: Partial<ModelConfig> = {}) => createProviderFromConfig(base({ provider: 'claude-cli', maxRetries: 0, ...extra }), agents.env({ FAKE_MODE: mode }));
  await assert.rejects(make('fail').generate(request), (e: Error & { retryable?: boolean }) => { assert.match(e.message, /exited with status 3/); const text = `${e.message}${e.stack}${JSON.stringify(e)}`; assert.ok(!text.includes('SECRET-STDERR') && !text.includes('SECRET-PROMPT-BODY')); return true; });
  await assert.rejects(make('garbage').generate(request), { code: 'INVALID_MODEL_OUTPUT' });
  await assert.rejects(make('empty').generate(request), { code: 'INVALID_MODEL_OUTPUT' });
  await assert.rejects(make('huge').generate(request), /size limit/);
  await assert.rejects(make('hang', { timeoutMs: 300 }).generate(request), /timed out/);
  const controller = new AbortController(); const before = await agents.launchCount();
  const pending = make('hang', { timeoutMs: 20000 }).generate(request, { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const started = Date.now(); await assert.rejects(pending, { code: 'CANCELLED' }); assert.ok(Date.now() - started < 5000, 'child is killed promptly');
  assert.equal(await agents.launchCount(), before + 1);
  await assert.rejects(make('ok').generate(request, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const retrying = createProviderFromConfig(base({ provider: 'claude-cli', maxRetries: 1, timeoutMs: 1200 }), agents.env({ FAKE_MODE: 'hang' }));
  const count = await agents.launchCount(); await assert.rejects(retrying.generate(request), /retries exhausted/); assert.equal((await agents.launchCount()) - count, 2, 'one retry after a timeout');
  const tiny = createProviderFromConfig(base({ provider: 'claude-cli', maxInputTokens: 500 }), agents.env());
  const calls = await agents.launchCount(); await assert.rejects(tiny.generate({ ...request, documents: [{ ...doc, body: 'x'.repeat(5000) }] }), { code: 'CAPABILITY_UNAVAILABLE' }); assert.equal(await agents.launchCount(), calls, 'over-budget input never reaches the CLI');
});

test('backend selection: auto prefers claude then codex; env and config swap it; missing CLIs are reported, never executed by doctor', async t => {
  const both = await fakeAgents(t), onlyCodex = await fakeAgents(t, ['codex']), none = await fakeAgents(t, []);
  assert.equal(createProviderFromConfig(base(), both.env()).id, 'claude-cli');
  assert.equal(createProviderFromConfig(base(), onlyCodex.env({ PATH: onlyCodex.dir })).id, 'codex-cli');
  assert.throws(() => createProviderFromConfig(base(), { PATH: none.dir }), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(createProviderFromConfig(base({ provider: 'claude-cli' }), both.env({ ENGRAM_MODEL_PROVIDER: 'codex-cli' })).id, 'codex-cli', 'environment overrides mdb.yaml');
  assert.equal(createProviderFromConfig(base({ provider: 'claude-cli', locality: 'local' }), both.env()).locality, 'local');
  assert.throws(() => createProviderFromConfig(base({ provider: 'claude-cli', command: '/no/such/agent' }), both.env()), /not found/);
  const custom = path.join(both.dir, 'codex'); assert.equal(createProviderFromConfig(base({ provider: 'codex-cli', command: custom }), both.env()).id, 'codex-cli');
  const described = describeModel(base({ provider: 'claude-cli' }), both.env()); assert.equal(described.available, true); assert.equal(described.locality, 'remote');
  assert.equal(describeModel(base({ provider: 'claude-cli' }), { PATH: none.dir }).available, false);
  assert.equal(describeModel(base({ provider: null }), both.env()).available, false);
  assert.equal(describeModel(base({ provider: 'ollama', modelName: 'm' }), both.env()).locality, 'local');
  assert.deepEqual(await both.calls(), [], 'doctor and factory never run the agent');
  assert.throws(() => createProviderFromConfig(base({ provider: 'claude-cli', timeoutMs: 5 }), both.env()), { code: 'INVALID_INPUT' });
});

test('jobs run through the agent CLI; private workspace content is blocked unless the owner opts in', async t => {
  const agents = await fakeAgents(t);
  const { root, vault, source } = await vaultWithSource(t, 'global');
  const engine = new IntelligenceEngine(vault, createProviderFromConfig(base({ provider: 'claude-cli' }), agents.env()));
  await engine.enqueue('wiki', { scope: { type: 'global', area: 'wiki' }, objectIds: [source.id] });
  assert.equal((await engine.run({ job: 'wiki', limit: 1 }))[0]!.status, 'complete');
  const [proposal] = await engine.proposals(); assert.equal(proposal!.status, 'pending'); assert.equal(proposal!.input.metadata!.modelProvider, 'claude-cli');
  assert.equal((await vault.listDocuments()).filter(d => d.kind === 'wiki_page').length, 0, 'staged until reviewed');
  assert.equal((await engine.review(proposal!.id, true)).status, 'approved');

  const priv = await vaultWithSource(t, 'workspace');
  const privateEngine = new IntelligenceEngine(priv.vault, createProviderFromConfig(base({ provider: 'codex-cli' }), agents.env()));
  await privateEngine.enqueue('wiki', { scope: priv.where, objectIds: [priv.source.id] });
  const calls = (await agents.calls()).length;
  const blocked = await privateEngine.run({ job: 'wiki', limit: 1 });
  assert.equal(blocked[0]!.status, 'blocked'); assert.match(blocked[0]!.error!, /allowPrivateContentToRemote/);
  assert.equal((await agents.calls()).length, calls, 'agent CLI was never started for private content');
  await setConfig(priv.root, c => { c.model.allowPrivateContentToRemote = true; });
  assert.equal((await privateEngine.run({ job: 'wiki', limit: 1 }))[0]!.status, 'complete');
  void root;
});

test('swapping the backend in mdb.yaml or by environment changes which agent serves `mdb intelligence run`, including an OpenAI-compatible API', async t => {
  const agents = await fakeAgents(t);
  const { root, vault } = await vaultWithSource(t, 'global');
  const mdb = path.resolve('bin/mdb.js');
  const seen: string[] = [];
  const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => { const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push(`${req.url}|${body.model}`); const text = body.messages[1].content as string; const m = /uri=(\S+) revision=(\S+) /.exec(text)!; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'wiki_page', title: 'From API', body: 'Derived over HTTP from the cited source [1].', evidence: [{ uri: m[1], revisionId: m[2] }] }) } }] })); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const env = (extra: Record<string, string> = {}) => ({ ...agents.env(), ...extra, ENGRAM_DATA_DIR: undefined, MDB_ROOT: undefined });
  const titles = async () => (await vault.listDocuments()).concat([]).length && JSON.parse((await run([mdb, 'intelligence', 'proposals', '--root', root, '--json'], env())).stdout) as { input: { title: string; metadata: { modelProvider: string } }; status: string }[];
  const addSource = (title: string) => vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'source', title, body: `${title} body text differs` });

  await setConfig(root, c => { c.model.provider = 'claude-cli'; });
  let result = await run([mdb, 'intelligence', 'run', '--job', 'wiki', '--root', root, '--json'], env()); assert.equal(result.code, 0, result.stderr);
  await addSource('Second source');
  await setConfig(root, c => { c.model.provider = 'codex-cli'; });
  result = await run([mdb, 'intelligence', 'run', '--job', 'wiki', '--root', root, '--json'], env()); assert.equal(result.code, 0, result.stderr);
  await addSource('Third source');
  result = await run([mdb, 'intelligence', 'run', '--job', 'wiki', '--root', root, '--json'], env({ ENGRAM_MODEL_PROVIDER: 'claude-cli' })); assert.equal(result.code, 0, result.stderr);
  await addSource('Fourth source');
  await setConfig(root, c => { c.model.provider = 'openai-compatible'; c.model.baseUrl = baseUrl; c.model.modelName = 'tiny'; });
  result = await run([mdb, 'intelligence', 'run', '--job', 'wiki', '--root', root, '--json'], env()); assert.equal(result.code, 0, result.stderr);

  const providers = new Set((await titles() as { input: { metadata: { modelProvider: string } } }[]).map(p => p.input.metadata.modelProvider));
  assert.deepEqual([...providers].sort(), ['claude-cli', 'codex-cli', 'openai-compatible:tiny']);
  assert.deepEqual(seen.every(s => s === '/v1/chat/completions|tiny'), true); assert.ok(seen.length >= 1);
  const calls = await agents.calls(); assert.ok(calls.some(c => c.name === 'claude') && calls.some(c => c.name === 'codex'));
  assert.ok(calls.every(c => c.dataDir === null && c.mdbRoot === null));
});

test('default configuration uses a local agent CLI when one exists, and is deterministic-only when none does', async t => {
  const agents = await fakeAgents(t), empty = await fakeAgents(t, []);
  const { root } = await vaultWithSource(t, 'global');
  const mdb = path.resolve('bin/mdb.js');
  assert.equal((await new Vault(root).config()).model.provider, 'auto');
  const withAgent = JSON.parse((await run([mdb, 'doctor', '--root', root, '--json'], agents.env())).stdout).capabilities.model;
  assert.equal(withAgent.available, true); assert.match(withAgent.provider, /^claude-cli/);
  const without = JSON.parse((await run([mdb, 'doctor', '--root', root, '--json'], { PATH: empty.dir, HOME: process.env.HOME })).stdout).capabilities.model;
  assert.equal(without.available, false); assert.match(without.reason, /No local agent CLI/);
  const job = await run([mdb, 'intelligence', 'run', '--job', 'wiki', '--root', root, '--json'], { PATH: `${empty.dir}:/usr/bin:/bin`, HOME: process.env.HOME });
  assert.equal(job.code, 0, job.stderr); assert.match(job.stdout, /blocked/);
});

test('OpenAI-compatible API: path, headers, body, content-part arrays and response_format fallback all behave', async t => {
  const seen: { url?: string; auth?: string; body: Record<string, unknown> }[] = [];
  let reject400 = true;
  const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => { const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push({ url: req.url, auth: req.headers.authorization, body });
    if ('response_format' in body && reject400) { res.writeHead(400); return res.end('{"error":"response_format unsupported SECRET-BODY"}'); }
    const m = /uri=(\S+) revision=(\S+) /.exec(body.messages[1].content as string)!;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: '{"kind":"wiki_page","title":"Parts","body":"b",' }, { type: 'text', text: `"evidence":[{"uri":"${m[1]}","revisionId":"${m[2]}"}]}` }] } }] })); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  const provider = new OpenAICompatibleProvider({ id: 'api', baseUrl, model: 'm1', apiKey: 'sk-abc', locality: 'local', timeoutMs: 3000, maxRetries: 1, maxInputTokens: 12000, maxOutputTokens: 500, sleep: async () => undefined });
  const result = await provider.generate(request);
  assert.equal(result.title, 'Parts', 'content arrays are joined');
  assert.equal(seen.length, 2, 'first attempt with response_format, one retry without it'); assert.ok('response_format' in seen[0]!.body); assert.ok(!('response_format' in seen[1]!.body));
  assert.equal(seen[1]!.url, '/v1/chat/completions', 'trailing slash in baseUrl is normalized');
  assert.equal(seen[1]!.auth, 'Bearer sk-abc'); assert.equal(seen[1]!.body.model, 'm1'); assert.equal(seen[1]!.body.stream, false); assert.equal(seen[1]!.body.max_tokens, 500);
  await provider.generate(request); assert.ok(!('response_format' in seen.at(-1)!.body), 'the fallback is remembered');
  const keyless = new OpenAICompatibleProvider({ id: 'api2', baseUrl, model: 'm1', locality: 'local', timeoutMs: 3000, maxRetries: 0, maxInputTokens: 12000, maxOutputTokens: 500, jsonMode: false });
  await keyless.generate(request); assert.equal(seen.at(-1)!.auth, undefined, 'no Authorization header without a key');
  reject400 = false;
});
