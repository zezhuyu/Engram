import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { initializeProject, upsertClaudeMcp, upsertCodexMcp, removeClaudeMcp, removeCodexMcp } from '../../packages/project-init.js';
import { projectDoctor } from '../../packages/memory/project-doctor.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js');
async function temp(t: Cleanup, prefix: string): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), prefix)); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

test('the tailnet plain-HTTP opt-in is written into the proxy command (hosts start it with a minimal environment); https never carries it', async () => {
  const { proxyCommand } = await import('../../packages/memory/mcp-proxy.js'); const before = process.env.MDB_TRANSPORT_TRUST;
  try {
    process.env.MDB_TRANSPORT_TRUST = 'tailscale'; assert.deepEqual(proxyCommand('http://100.64.0.9:8791/mcp', 'T', 'w', '/x/mdb.js').args.slice(-2), ['--transport-trust', 'tailscale']); assert.ok(!proxyCommand('https://h.example/mcp', 'T', 'w', '/x/mdb.js').args.includes('--transport-trust'));
    delete process.env.MDB_TRANSPORT_TRUST; assert.ok(!proxyCommand('http://100.64.0.9:8791/mcp', 'T', 'w', '/x/mdb.js').args.includes('--transport-trust'));
  } finally { if (before === undefined) delete process.env.MDB_TRANSPORT_TRUST; else process.env.MDB_TRANSPORT_TRUST = before; }
  recordCase({ suite: 'memory', name: 'offline-init-transport-trust-pinned', status: 'PASS' });
});

test('init --offline-buffer writes the local proxy as the engram server for Claude Code and Codex, with the token passed through by name only; the entries convert both ways and are removed cleanly', async t => {
  const dir = await temp(t, 'engram-offline-cfg-'); const claude = path.join(dir, '.mcp.json'), codex = path.join(dir, '.codex', 'config.toml'); const url = 'http://127.0.0.1:8791/mcp';
  assert.equal(await upsertClaudeMcp(claude, url, 'ENGRAM_TOKEN', 'proj', { offlineBuffer: true }), true);
  const entry = JSON.parse(await readFile(claude, 'utf8')).mcpServers.engram; assert.equal(entry.type, 'stdio'); assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args.slice(1, 8), ['mcp-proxy', '--url', url, '--token-env', 'ENGRAM_TOKEN', '--workspace', 'proj']); assert.deepEqual(entry.env, { ENGRAM_TOKEN: '${ENGRAM_TOKEN}' });
  assert.ok(!(await readFile(claude, 'utf8')).includes('Bearer'), 'no token or Authorization header in the file');
  assert.equal(await upsertClaudeMcp(claude, url, 'ENGRAM_TOKEN', 'proj', { offlineBuffer: true }), false, 'idempotent');
  assert.equal(await upsertClaudeMcp(claude, url, 'ENGRAM_TOKEN', 'proj'), true, 'switching back to the direct HTTP entry is allowed for our own entry'); assert.equal(JSON.parse(await readFile(claude, 'utf8')).mcpServers.engram.type, 'http');
  await writeFile(claude, JSON.stringify({ mcpServers: { engram: { type: 'stdio', command: 'something-else', args: [] } } })); await assert.rejects(upsertClaudeMcp(claude, url, 'ENGRAM_TOKEN', 'proj', { offlineBuffer: true }), /different mcpServers\.engram/);
  await writeFile(claude, '{}'); await upsertClaudeMcp(claude, url, 'ENGRAM_TOKEN', 'proj', { offlineBuffer: true }); assert.equal(await removeClaudeMcp(claude), true); assert.equal(JSON.parse(await readFile(claude, 'utf8')).mcpServers.engram, undefined);
  await mkdir(path.dirname(codex), { recursive: true }); await upsertCodexMcp(codex, url, 'ENGRAM_TOKEN', 'proj', { offlineBuffer: true });
  const toml = await readFile(codex, 'utf8'); assert.match(toml, /command = ".*"/); assert.match(toml, /args = \[".*mcp-proxy", "--url"|args = \[".*", "mcp-proxy", "--url"/); assert.match(toml, /env_vars = \["ENGRAM_TOKEN"\]/); assert.ok(!/bearer_token_env_var|http_headers|^url =/m.test(toml));
  await upsertCodexMcp(codex, url, 'ENGRAM_TOKEN', 'proj'); assert.match(await readFile(codex, 'utf8'), /bearer_token_env_var = "ENGRAM_TOKEN"/); await upsertCodexMcp(codex, url, 'ENGRAM_TOKEN', 'proj', { offlineBuffer: true }); assert.equal(await removeCodexMcp(codex), true); assert.ok(!(await readFile(codex, 'utf8')).includes('mcp_servers.engram'));
  recordCase({ suite: 'memory', name: 'offline-init-config-shapes', status: 'PASS' });
});

test('the exact command init wrote runs as a real process: tools are listed from the primed cache while the server is down, a write is queued, and it reaches the server when the server returns; doctor reports the proxy and the outbox', async t => {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj');
  const cred = await createHttpCredential(owner.vault, 'agent-i', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-i', ['read', 'write']);
  const port = await freePort(); const url = `http://127.0.0.1:${port}/mcp`; let server: ChildProcess | undefined;
  const start = async () => { const c = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port) } }); server = c; let err = ''; await new Promise<void>((res, rej) => { c.stderr!.setEncoding('utf8'); c.stderr!.on('data', (d: string) => { err += d; if (/MCP HTTP listening/.test(err)) res(); }); c.once('exit', code => rej(new Error(`server exit ${code} ${err}`))); }); };
  const stop = async () => { const c = server; server = undefined; if (c && c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise<void>(r => c.once('exit', () => r())); } }; t.after(stop); await start();
  const dir = await temp(t, 'engram-offline-proj-'); const outbox = await temp(t, 'engram-offline-box-'); process.env.ENGRAM_OUTBOX = outbox; t.after(() => { delete process.env.ENGRAM_OUTBOX; }); process.env.ENGRAM_I_TOKEN = cred.token; t.after(() => { delete process.env.ENGRAM_I_TOKEN; });
  const init = await initializeProject(undefined, { projectDir: dir, hosts: ['claude-code'], workspaceId: 'proj', mcpUrl: url, tokenEnv: 'ENGRAM_I_TOKEN', offlineBuffer: true }); assert.ok(init.mcpConfigFiles?.['claude-code']);
  const entry = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.engram as { command: string; args: string[]; env: Record<string, string> };
  assert.ok((await readdir(outbox)).some(n => n.startsWith('cache-')), 'init primed the proxy cache');
  const report = await projectDoctor(dir, { probeRemote: false }); const hostReport = JSON.stringify(report); assert.match(hostReport, /offline buffering enabled \(local proxy\)/);
  await stop(); // the server is down from now on
  const child = spawn(entry.command, entry.args, { env: { ...process.env, ENGRAM_I_TOKEN: cred.token, ENGRAM_OUTBOX: outbox }, stdio: ['pipe', 'pipe', 'pipe'] }); t.after(() => { child.kill('SIGKILL'); });
  const replies = new Map<number, (m: any) => void>(); let buf = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); } });
  let id = 1; const rpc = (method: string, params?: unknown) => new Promise<any>(res => { const n = id++; replies.set(n, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params ? { params } : {}) })}\n`); });
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } }); assert.ok((await rpc('tools/list')).result.tools.some((x: { name: string }) => x.name === 'engram_note_upsert'), 'tool list served from the cache with the server down');
  const queued = JSON.parse((await rpc('tools/call', { name: 'engram_note_upsert', arguments: { noteId: 'notes/offline', title: 'Offline', body: 'written while the server was down' } })).result.content[0].text); assert.equal(queued.persistence, 'QUEUED_OFFLINE');
  assert.match(JSON.stringify(await projectDoctor(dir, { probeRemote: false })), /1 queued write/);
  await start(); const later = JSON.parse((await rpc('tools/call', { name: 'engram_note_upsert', arguments: { noteId: 'notes/after', title: 'After', body: 'after recovery' } })).result.content[0].text); assert.equal(later.persistence, 'COMMITTED');
  for (let i = 0; i < 60 && (await readdir(outbox)).some(n => /^\d{14}-/.test(n)); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok((await owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'proj' }] })).some(d => d.metadata.stableId === 'notes/offline' && d.body === 'written while the server was down'), 'the queued note reached the server');
  assert.ok(!(await readdir(outbox)).some(n => /^\d{14}-/.test(n)), 'and the local copy is deleted'); child.stdin.end();
  recordCase({ suite: 'memory', name: 'offline-init-real-process-roundtrip', status: 'PASS' });
});
