import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { defaultBinding, writeBinding } from '../../packages/core/project-binding.js';
import { trustProject } from '../../packages/core/project-trust.js';
import { isWork, runHandoffHook, toolCalls } from '../../packages/memory/handoff-hook.js';
import { writeHandoff } from '../../packages/memory/workspace-ops.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js'); const scope = { type: 'workspace' as const, workspaceId: 'proj' };
async function temp(t: Cleanup, prefix: string): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), prefix)); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const transcript = (...tools: string[]) => tools.map(name => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name, input: {} }] } })).join('\n') + '\n';
async function setup(t: Cleanup, serverUp = true) {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj');
  const cred = await createHttpCredential(owner.vault, 'agent-h', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-h', ['read', 'write']);
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  let err = ''; const url = await new Promise<string>((res, rej) => { child.stderr.setEncoding('utf8'); child.stderr.on('data', (c: string) => { err += c; const m = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(err); if (m) res(m[1]!); }); child.once('exit', c => rej(new Error(`exit ${c} ${err}`))); });
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(r => child.once('exit', () => r())); } }; t.after(stop); if (!serverUp) await stop();
  const base = await temp(t, 'engram-handoff-'); const dir = path.join(base, 'p'); await mkdir(dir);
  const binding = defaultBinding({ workspaceId: 'proj', serverUrl: url, hosts: ['claude-code'], credentialRef: 'ENGRAM_H_TOKEN', captureConsent: false }); await writeBinding(dir, binding);
  const env = { ...process.env, ENGRAM_H_TOKEN: cred.token, ENGRAM_CACHE_DIR: path.join(base, 'cache'), ENGRAM_USER_CONFIG: path.join(base, 'u.json'), ENGRAM_TRUST_FILE: path.join(base, 't.json') } as NodeJS.ProcessEnv; await trustProject(dir, binding, env);
  const stdin = (extra: Record<string, unknown> = {}, name = 'sess-1') => JSON.stringify({ hook_event_name: 'Stop', session_id: name, cwd: dir, transcript_path: path.join(base, `${name}.jsonl`), ...extra });
  return { owner, dir, base, env, stdin, stop };
}

test('a session that did work and has no handoff is asked, once, to write it; the request names the session and Engram writes nothing itself', async t => {
  const s = await setup(t); await writeFile(path.join(s.base, 'sess-1.jsonl'), transcript('Read', 'Edit', 'Bash'));
  const asked = await runHandoffHook({ host: 'claude-code', stdin: s.stdin(), env: s.env }); assert.equal(asked.outcome, 'requested', JSON.stringify(asked));
  const decision = JSON.parse(asked.output) as { decision: string; reason: string }; assert.equal(decision.decision, 'block'); assert.match(decision.reason, /engram_handoff_write with sessionId "sess-1"/); assert.match(decision.reason, /only what actually happened/);
  assert.equal((await s.owner.listDocuments()).filter(d => d.kind === 'handoff').length, 0, 'Engram never invents a handoff');
  assert.equal((await runHandoffHook({ host: 'claude-code', stdin: s.stdin(), env: s.env })).output, '', 'asked once per session');
  recordCase({ suite: 'memory', name: 'handoff-stop-hook-requests-once', status: 'PASS' });
});

test('it stays silent when there is nothing to hand off or it cannot be sure', async t => {
  const s = await setup(t); const ask = (stdin: string, env = s.env) => runHandoffHook({ host: 'claude-code', stdin, env });
  await writeFile(path.join(s.base, 'sess-read.jsonl'), transcript('Read', 'Grep')); assert.match((await ask(s.stdin({}, 'sess-read'))).reason, /no files or Engram records were written/);
  await writeFile(path.join(s.base, 'sess-loop.jsonl'), transcript('Edit')); assert.match((await ask(s.stdin({ stop_hook_active: true }, 'sess-loop'))).reason, /already continuing/);
  await writeFile(path.join(s.base, 'sess-wrote.jsonl'), transcript('Edit', 'mcp__engram__engram_handoff_write')); assert.match((await ask(s.stdin({}, 'sess-wrote'))).reason, /already wrote a handoff/);
  await writeFile(path.join(s.base, 'sess-exists.jsonl'), transcript('Edit')); await writeHandoff(s.owner, { scope, sessionId: 'sess-exists', state: 'ended', completed: [], next: ['x'], blockers: [], filesTouched: [], openTasks: [] });
  assert.match((await ask(s.stdin({}, 'sess-exists'))).reason, /already exists/);
  assert.match((await ask(s.stdin({ transcript_path: path.join(s.base, 'missing.jsonl') }, 'sess-nofile'))).reason, /not readable/);
  assert.match((await ask(JSON.stringify({ session_id: 'x', cwd: await temp(t, 'engram-else-'), transcript_path: path.join(s.base, 'sess-loop.jsonl') }))).reason, /not trusted or missing/);
  assert.match((await runHandoffHook({ host: 'claude-code', stdin: s.stdin({}, 'sess-loop'), projectRoot: await temp(t, 'engram-notme-'), env: s.env })).reason, /outside this project/);
  const noToken = { ...s.env }; delete noToken.ENGRAM_H_TOKEN; await writeFile(path.join(s.base, 'sess-nt.jsonl'), transcript('Edit')); assert.match((await ask(s.stdin({}, 'sess-nt'), noToken)).reason, /no credential/);
  for (const bad of ['not json', JSON.stringify({ session_id: '../x', cwd: s.dir })]) assert.equal((await ask(bad)).output, '');
  assert.deepEqual((await toolCalls(path.join(s.base, 'sess-wrote.jsonl')))!.map(c => c.name), ['Edit', 'mcp__engram__engram_handoff_write']); assert.equal(await toolCalls(path.join(s.base, 'nope')), undefined);
});

test('when the server cannot be reached the agent is never blocked: no handoff is requested', async t => {
  const s = await setup(t, false); await writeFile(path.join(s.base, 'sess-1.jsonl'), transcript('Edit'));
  const result = await runHandoffHook({ host: 'claude-code', stdin: s.stdin(), env: s.env, timeoutMs: 400 }); assert.equal(result.outcome, 'skipped'); assert.equal(result.output, '');
});

const codexTranscript = (...calls: Array<{ name: string; arguments?: string; kind?: string }>) => [JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }), ...calls.map(c => JSON.stringify({ type: 'response_item', payload: { type: c.kind ?? 'function_call', name: c.name, arguments: c.arguments ?? '{}' } }))].join('\n') + '\n';

test('Codex transcripts are understood: file-changing shell commands, apply_patch and Engram writes count as work; reads do not', async t => {
  const s = await setup(t); const ask = (name: string) => runHandoffHook({ host: 'codex', stdin: s.stdin({}, name), env: s.env });
  const cases: Array<[string, Array<{ name: string; arguments?: string; kind?: string }>, boolean]> = [
    ['cx-read', [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls -la && cat README.md' }) }], false],
    ['cx-grep', [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n "foo" src | head' }) }, { name: 'mdb_search' }], false],
    ['cx-write', [{ name: 'exec_command', arguments: JSON.stringify({ cmd: "printf 'x' > notes.txt" }) }], true],
    ['cx-sed', [{ name: 'exec_command', arguments: JSON.stringify({ cmd: "sed -i '' 's/a/b/' file.ts" }) }], true],
    ['cx-patch', [{ name: 'apply_patch', kind: 'custom_tool_call', arguments: '*** Begin Patch' }], true],
    ['cx-engram', [{ name: 'engram_note_upsert' }], true],
  ];
  for (const [name, calls, expectRequest] of cases) { await writeFile(path.join(s.base, `${name}.jsonl`), codexTranscript(...calls)); const r = await ask(name); assert.equal(r.outcome === 'requested', expectRequest, `${name}: ${r.reason}`); }
  assert.equal(isWork({ name: 'Bash', input: '{"command":"git commit -m x"}' }), true); assert.equal(isWork({ name: 'Bash', input: '{"command":"git status && git log"}' }), false); assert.equal(isWork({ name: 'Read', input: '' }), false);
  recordCase({ suite: 'memory', name: 'handoff-hook-codex-transcripts', status: 'PASS' });
});
