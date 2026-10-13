import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { initializeProject } from '../../packages/project-init.js';
import { projectDoctor } from '../../packages/memory/project-doctor.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MDB = resolve('bin/mdb.js');
async function temp(t: Cleanup, prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const scope = (workspaceId: string) => ({ type: 'workspace' as const, workspaceId });

test('installing the server is enough for a local agent: local init writes the stdio connection to the built-in server for Claude Code and Codex (no token, no network), and doctor reports it', async t => {
  const { root } = await disposableVault(t); const owner = new Engram(root); const dir = await temp(t, 'engram-local-agent-'); await mkdir(path.join(dir, '.git'));
  await initializeProject(owner, { projectDir: dir, hosts: ['claude-code', 'codex'], workspaceId: 'proj', approveEngramTools: true });
  const claude = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.engram; assert.equal(claude.type, 'stdio'); assert.match(claude.args[0], /mdb-mcp\.js$/); assert.deepEqual(claude.args.slice(1), ['--root', owner.vault.root]);
  assert.deepEqual(claude.env, { MDB_ACTOR_ID: 'local-agent', MDB_PERMISSIONS: 'workspace:proj:read,workspace:proj:write', MDB_DEFAULT_WORKSPACE: 'proj' });
  const toml = await readFile(path.join(dir, '.codex', 'config.toml'), 'utf8'); assert.match(toml, /\[mcp_servers\.engram\]\ncommand = ".*"\nargs = \[".*mdb-mcp\.js", "--root", ".*"\]\nenv = \{ MDB_ACTOR_ID = "local-agent"/); assert.ok(!/bearer|token|http_headers|^url =/im.test(toml), 'no credential and no URL in a local connection');
  const report = JSON.stringify(await projectDoctor(dir, { probeRemote: false })); assert.match(report, /local agent connects to the built-in server over stdio/);
  const optOut = await temp(t, 'engram-local-agent-off-'); await initializeProject(owner, { projectDir: optOut, host: 'claude-code', workspaceId: 'proj2', noLocalMcp: true }); await assert.rejects(readFile(path.join(optOut, '.mcp.json'), 'utf8'), /ENOENT/);
  recordCase({ suite: 'memory', name: 'local-agent-builtin-connection-config', status: 'PASS' });
});

test('the exact command init wrote works as a real process: the agent calls tools with no scope (its workspace is bound), writes land in the local vault, and it cannot touch another workspace', async t => {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('other'); const dir = await temp(t, 'engram-local-agent-proc-'); await mkdir(path.join(dir, '.git'));
  await initializeProject(owner, { projectDir: dir, host: 'claude-code', workspaceId: 'proj' });
  const entry = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.engram as { command: string; args: string[]; env: Record<string, string> };
  const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] }); t.after(() => { child.kill('SIGKILL'); });
  const waiting = new Map<number, (m: any) => void>(); let buffer = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (c: string) => { buffer += c; let i; while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); waiting.get(m.id)?.(m); } });
  let id = 1; const rpc = (method: string, params?: unknown) => new Promise<any>(res => { const n = id++; waiting.set(n, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params ? { params } : {}) })}\n`); });
  // regression (found with Claude Code 2.1.287): the stateless-protocol probe must be declined, or the host abandons initialize and gets 'Initialize first' for everything
  assert.equal((await rpc('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })).error.code, -32601);
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } }); const listed = (await rpc('tools/list')).result.tools as Array<{ name: string }>; assert.ok(listed.some(x => x.name === 'engram_task_upsert') && listed.some(x => x.name === 'mdb_search'));
  const call = async (name: string, args: Record<string, unknown>) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { isError: !!r.isError, value: JSON.parse(r.content[0].text) }; };
  const ok = await call('engram_task_upsert', { taskId: 'L-1', title: 'Local task', status: 'open' }); assert.equal(ok.value.persistence, 'COMMITTED');
  assert.ok((await owner.vault.listDocuments({ scopes: [scope('proj')] })).some(d => d.metadata.stableId === 'L-1'), 'it is in the local vault, in the bound workspace');
  const denied = await call('engram_task_upsert', { scope: scope('other'), taskId: 'X-1', title: 'no', status: 'open' }); assert.equal(denied.isError, true); assert.ok(!(await owner.vault.listDocuments({ scopes: [scope('other')] })).length);
  child.stdin.end(); recordCase({ suite: 'memory', name: 'local-agent-builtin-connection-process', status: 'PASS' });
});

test('the CLI works on the server machine with nothing else installed: task, note and handoff run on the local vault, using the bound project workspace when none is given; a remote URL from a server install carries a warning', async t => {
  const { root } = await disposableVault(t); const owner = new Engram(root); const dir = await temp(t, 'engram-local-cli-'); await mkdir(path.join(dir, '.git'));
  await initializeProject(owner, { projectDir: dir, host: 'claude-code', workspaceId: 'proj' });
  const mdb = (args: string[], cwd = dir) => { const r = spawnSync(process.execPath, [MDB, ...args, '--root', root, '--json'], { cwd, env: process.env, encoding: 'utf8' }); let json: any; try { json = JSON.parse(r.stdout); } catch { /* */ } return { status: r.status, json, stderr: r.stderr }; };
  assert.equal(mdb(['task', 'upsert', '--id', 'C-1', '--title', 'From the CLI', '--status', 'open']).json.persistence, 'COMMITTED'); // bound project: no --workspace needed
  assert.equal(mdb(['note', 'upsert', '--id', 'n/c', '--title', 'N', '--body', 'local cli note', '--workspace', 'proj'], tmpdir()).json.persistence, 'COMMITTED');
  assert.equal(mdb(['handoff', 'write', '--session', 'sess-c', '--state', 'ended', '--completed', 'x', '--workspace', 'proj'], tmpdir()).json.persistence, 'COMMITTED');
  assert.equal((await owner.vault.listDocuments({ scopes: [scope('proj')] })).filter(d => ['C-1', 'n/c', 'sess-c'].includes(String(d.metadata.stableId))).length, 3);
  const remote = await initializeProject(undefined, { projectDir: await temp(t, 'engram-warn-'), host: 'claude-code', mcpUrl: 'http://100.64.0.9:8791/mcp', tokenEnv: 'NOT_SET_TOKEN' }); assert.ok(remote.warnings.some(w => /separate client package/.test(w)));
  const loop = await initializeProject(undefined, { projectDir: await temp(t, 'engram-nowarn-'), host: 'claude-code', mcpUrl: 'http://127.0.0.1:8791/mcp', tokenEnv: 'NOT_SET_TOKEN' }); assert.ok(!loop.warnings.some(w => /separate client package/.test(w)));
  recordCase({ suite: 'memory', name: 'local-cli-typed-commands-and-remote-warning', status: 'PASS' });
});
