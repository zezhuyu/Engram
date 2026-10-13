import './helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../packages/sdk/index.js';
import { createHttpCredential } from '../packages/mcp/credentials.js';
import { disposableVault } from './helpers/disposable-vault.js';
import { recordCase } from './helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js'), MDB = resolve('bin/mdb.js');
const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
async function world(t: Cleanup) {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj');
  const cred = await createHttpCredential(owner.vault, 'agent-cli', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-cli', ['read', 'write']);
  const port = await freePort(); const url = `http://127.0.0.1:${port}/mcp`; let child: ChildProcess | undefined;
  const start = async () => { const c = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port) } }); child = c; let err = ''; await new Promise<void>((res, rej) => { c.stderr!.setEncoding('utf8'); c.stderr!.on('data', (d: string) => { err += d; if (/MCP HTTP listening/.test(err)) res(); }); c.once('exit', code => rej(new Error(`server exit ${code}`))); }); };
  const stop = async () => { const c = child; child = undefined; if (c && c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise<void>(r => c.once('exit', () => r())); } };
  t.after(stop); await start();
  const base = await mkdtemp(path.join(tmpdir(), 'engram-cli-remote-')); t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, TK: cred.token, ENGRAM_OUTBOX: path.join(base, 'outbox'), ENGRAM_TRUST_FILE: path.join(base, 'trust.json'), ENGRAM_USER_CONFIG: path.join(base, 'user.json'), ENGRAM_CACHE_DIR: path.join(base, 'cache'), ENGRAM_REMOTE_SPOOL: path.join(base, 'spool') } as NodeJS.ProcessEnv; delete env.ENGRAM_URL;
  const mdb = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => { const r = spawnSync(process.execPath, [MDB, ...args], { cwd: options.cwd ?? base, env: options.env ?? env, encoding: 'utf8', timeout: 60000 }); let json: any; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ } return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }; };
  const remote = ['--server', url, '--token-env', 'TK', '--workspace', 'proj'];
  return { owner, mdb, remote, stop, start, base, env, url, root };
}

test('any client runs the everyday CLI commands against the server: put, get, patch, history, search, memory, workspace, capabilities, and every server tool through `remote`', async t => {
  const w = await world(t);
  const put = w.mdb(['put', '--kind', 'note', '--title', 'Remote note', '--body', 'The RAINBOW-7731 plan.', ...w.remote, '--json']); assert.equal(put.status, 0, put.stderr); const id = put.json.id as string; assert.ok(id);
  const get = w.mdb(['get', id, ...w.remote, '--json']); assert.equal(get.json.body, 'The RAINBOW-7731 plan.');
  const patched = w.mdb(['patch', id, '--revision', get.json.revisionId, '--body', 'The RAINBOW-7731 plan, edited.', ...w.remote, '--json']); assert.equal(patched.status, 0, patched.stderr);
  assert.equal(w.mdb(['history', id, ...w.remote, '--json']).json.length, 2);
  assert.ok(JSON.stringify(w.mdb(['search', 'RAINBOW-7731', ...w.remote, '--json']).json).includes('RAINBOW-7731'));
  assert.ok(JSON.stringify(w.mdb(['grep', 'RAINBOW', ...w.remote, '--json']).json).includes('RAINBOW'));
  assert.equal(w.mdb(['memory', 'recent', '--limit', '3', ...w.remote, '--json']).status, 0); assert.equal(w.mdb(['workspace', 'list', ...w.remote, '--json']).status, 0); assert.equal(w.mdb(['capabilities', ...w.remote, '--json']).status, 0);
  const tools = w.mdb(['remote', 'tools', ...w.remote, '--json']).json as Array<{ name: string }>; assert.ok(tools.some(x => x.name === 'engram_task_upsert') && tools.some(x => x.name === 'mdb_search') && tools.length > 20);
  assert.equal(w.mdb(['remote', 'call', 'mdb_get', '--input', JSON.stringify({ objectId: id }), ...w.remote, '--json']).json.id, id);
  const stale = w.mdb(['patch', id, '--revision', 'rev_stale', '--body', 'x', ...w.remote, '--json']); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /CONFLICT/);
  recordCase({ suite: 'cli', name: 'remote-mode-everyday-commands', status: 'PASS' });
});

test('the typed commands the CLI never had (task, note, handoff) work remotely; while the server is down they are kept locally, reads fail honestly, and `outbox drain` merges them in on recovery', async t => {
  const w = await world(t); const scope = { type: 'workspace' as const, workspaceId: 'proj' };
  const up = w.mdb(['task', 'upsert', '--id', 'T-1', '--title', 'Rotate key', '--status', 'open', '--body', 'Owner: studio.\nWaiting.', ...w.remote, '--json']); assert.equal(up.json.persistence, 'COMMITTED', up.stderr);
  assert.equal(w.mdb(['note', 'upsert', '--id', 'n/1', '--title', 'N', '--body', 'one', ...w.remote, '--json']).json.persistence, 'COMMITTED');
  assert.equal(w.mdb(['handoff', 'write', '--session', 'sess-1', '--state', 'ended', '--completed', 'a,b', '--next', 'c', ...w.remote, '--json']).json.persistence, 'COMMITTED');
  await w.stop();
  const queued = w.mdb(['task', 'upsert', '--id', 'T-1', '--title', 'Rotate key', '--status', 'in_progress', '--body', 'Owner: studio.\nWaiting.\nOffline line.', ...w.remote, '--json']); assert.equal(queued.status, 0); assert.equal(queued.json.persistence, 'QUEUED_OFFLINE');
  assert.equal(w.mdb(['outbox', '--json']).json.queued, 1); const read = w.mdb(['search', 'anything', ...w.remote, '--json']); assert.notEqual(read.status, 0); assert.match(read.stderr, /SERVER_UNREACHABLE/);
  await w.start(); const head = (await w.owner.vault.listDocuments({ scopes: [scope] })).find(d => d.metadata.stableId === 'T-1')!; // somebody else edits the first line while this client was offline
  await w.owner.patch({ objectId: head.id, expectedRevisionId: head.revisionId, body: 'Owner: alice.\nWaiting.' });
  const drained = w.mdb(['outbox', 'drain', '--url', w.url, '--token-env', 'TK', '--workspace', 'proj', '--json']); assert.equal(drained.json.queued, 0, drained.stderr);
  const merged = (await w.owner.vault.listDocuments({ scopes: [scope] })).find(d => d.metadata.stableId === 'T-1')!; assert.equal(merged.body, 'Owner: alice.\nWaiting.\nOffline line.'); assert.equal(merged.metadata.taskStatus, 'in_progress');
  assert.ok(w.mdb(['outbox', 'log', '--json']).json.some((l: { event: string }) => l.event === 'merged'));
  recordCase({ suite: 'cli', name: 'remote-mode-typed-writes-offline-merge', status: 'PASS' });
});

test('inside a project bound to a server the plain commands go to that server with no flags; --root and --local keep a local vault; ENGRAM_URL selects a server; a missing credential is a clear error', async t => {
  const w = await world(t); const dir = path.join(w.base, 'bound'); await mkdir(dir);
  const init = w.mdb(['init', '--project', '--host', 'claude-code', '--project-dir', dir, '--workspace', 'proj', '--mcp-url', w.url, '--token-env', 'TK', '--json']); assert.equal(init.status, 0, init.stderr);
  const put = w.mdb(['put', '--kind', 'note', '--title', 'From a bound project', '--body', 'BOUND-4419 text', '--json'], { cwd: dir }); assert.equal(put.status, 0, put.stderr);
  assert.ok((await w.owner.vault.listDocuments({ scopes: [{ type: 'workspace', workspaceId: 'proj' }] })).some(d => /BOUND-4419/.test(d.body)), 'it was written on the server, not into a local vault');
  assert.ok(JSON.stringify(w.mdb(['search', 'BOUND-4419', '--json'], { cwd: dir }).json).includes('BOUND-4419'));
  const localRoot = await mkdtemp(path.join(tmpdir(), 'engram-cli-local-')); t.after(() => rm(localRoot, { recursive: true, force: true })); assert.equal(w.mdb(['init', '--root', localRoot, '--json']).status, 0);
  const local = w.mdb(['search', 'BOUND-4419', '--root', localRoot, '--json'], { cwd: dir }); assert.equal(local.status, 0); assert.ok(!JSON.stringify(local.json).includes('BOUND-4419'), '--root stays local');
  const viaEnv = w.mdb(['search', 'BOUND-4419', '--json'], { env: { ...w.env, ENGRAM_URL: w.url, ENGRAM_TOKEN_ENV: 'TK' } }); assert.ok(JSON.stringify(viaEnv.json).includes('BOUND-4419'));
  const noToken = w.mdb(['search', 'x', '--json'], { cwd: dir, env: { ...w.env, TK: '' } }); assert.notEqual(noToken.status, 0); assert.match(noToken.stderr, /TK is not set/);
  recordCase({ suite: 'cli', name: 'remote-mode-bound-project-and-overrides', status: 'PASS' });
});
