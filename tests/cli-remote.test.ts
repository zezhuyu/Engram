import './helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../packages/sdk/index.js';
import { createHttpCredential, revokeHttpCredential } from '../packages/mcp/credentials.js';
import { listClientPresence } from '../packages/mcp/client-presence.js';
import { toolsFor } from '../packages/mcp/index.js';
import { assertDisposable } from './helpers/disposable-vault.js';
import { stopOwnedChildProcess } from './helpers/owned-process.js';
import { waitForDrainIdle } from '../packages/memory/capture.js';
import { recordCase } from './helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js'), MDB = resolve('bin/mdb.js');
const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
async function world(t: Cleanup, toolset?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'engram-cli-remote-root-'));
  let child: ChildProcess | undefined;
  const stop = async () => { const c = child; child = undefined; if (c) await stopOwnedChildProcess(c, 2_000); };
  // The server must stop before its disposable vault is removed. Register the
  // server cleanup first; node:test invokes after hooks in registration order.
  t.after(stop);
  t.after(async () => { assertDisposable(root); await waitForDrainIdle(root); await rm(root, { recursive: true, force: true }); });
  const owner = new Engram(root); await owner.vault.init(); await owner.createWorkspace('proj');
  const cred = await createHttpCredential(owner.vault, 'agent-cli', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-cli', ['read', 'write']);
  const port = await freePort(); const url = `http://127.0.0.1:${port}/mcp`;
  const start = async () => { const c = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port), ...(toolset ? { MDB_MCP_TOOLSET: toolset } : {}) } }); child = c; let err = ''; await new Promise<void>((res, rej) => { c.stderr!.setEncoding('utf8'); c.stderr!.on('data', (d: string) => { err += d; if (/MCP HTTP listening/.test(err)) res(); }); c.once('exit', code => rej(new Error(`server exit ${code}`))); }); };
  await start();
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

test('client heartbeat is scoped to a revocable credential and never appears as an MCP tool', async t => {
  const w = await world(t);
  const body = {schemaVersion:1,clientId:'00000000-0000-4000-8000-000000000001',displayName:'Studio Air',hostLabel:'macOS',appVersion:'1.0',mode:'syncing',lastSync:{serverContactAt:null,outboxDeliveredAt:null,fileSyncCommittedAt:null,contextFetchedAt:null},queues:{outbox:0,fileSync:0,capture:0,queuedBytes:0},projects:[]};
  const send = (token?: string, payload: unknown = body) => fetch(w.url.replace('/mcp','/client/heartbeat'),{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(payload)});
  assert.equal((await send()).status,401);
  assert.equal((await send('not-a-token')).status,401);
  const accepted = await send(w.env.TK); assert.equal(accepted.status,202); assert.ok((await accepted.json() as any).serverReceivedAt);
  assert.equal((await send(w.env.TK,{...body,actorId:'owner'})).status,400);
  assert.equal((await send(w.env.TK)).status,202);
  const limited = await send(w.env.TK); assert.equal(limited.status,429); assert.equal(limited.headers.get('retry-after'),'60');
  const oversized = await fetch(w.url.replace('/mcp','/client/heartbeat'),{method:'POST',headers:{Authorization:'Bearer '+w.env.TK,'Content-Type':'application/json'},body:' '.repeat(16*1024+1)}); assert.equal(oversized.status,413);
  const second = await createHttpCredential(w.owner.vault,'agent-second',['workspace:proj:read']);
  assert.equal((await send(second.token)).status,202);
  let records = await listClientPresence(w.root); assert.equal(records.length,2); assert.deepEqual(new Set(records.map(row=>row.credentialId)).size,2);
  const tools = w.mdb(['remote','tools',...w.remote,'--json']).json as Array<{name:string}>; assert.ok(tools.every(tool=>!/client.*heartbeat|presence/i.test(tool.name)));
  for (const toolset of [undefined,'remote-web','keyed-gateway']) assert.ok(toolsFor(w.owner,toolset).every(tool=>!/client.*heartbeat|presence/i.test(tool.name)),String(toolset)+' toolset contains no presence tools');
  assert.equal(await revokeHttpCredential(w.owner.vault,second.id),true);
  assert.equal((await send(second.token)).status,401);
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

test('on a Client-only machine a bare mdb command talks to the server and never builds a private vault; a machine with server config, --local and --root stay local', async t => {
  const w = await world(t);
  const home = path.join(w.base, 'client-home'), config = path.join(home, '.config', 'engram'), localVault = path.join(home, '.Engram');
  await mkdir(config, { recursive: true });
  const tokenFile = path.join(config, 'client.token'); await writeFile(tokenFile, w.env.TK + '\n', { mode: 0o600 });
  await writeFile(path.join(config, 'client.env'), `ENGRAM_MCP_URL=${w.url}\nENGRAM_TOKEN_FILE=${tokenFile}\nENGRAM_WORKSPACE=proj\n`, { mode: 0o600 });
  const env = { ...w.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } as NodeJS.ProcessEnv; delete env.ENGRAM_URL; delete env.ENGRAM_TOKEN; delete env.MDB_ROOT; delete env.ENGRAM_DATA_DIR;
  const mdb = (args: string[], over: NodeJS.ProcessEnv = env) => w.mdb(args, { env: over });

  // No server flag, no environment variable, no project: the Client's saved URL and token file are used.
  const put = mdb(['put', '--kind', 'note', '--title', 'Client machine note', '--body', 'CLIENTONLY-4821 written with a bare mdb command.', '--json']); assert.equal(put.status, 0, put.stderr);
  const id = put.json.id as string; assert.ok(id);
  assert.equal(mdb(['get', id, '--json']).json.body, 'CLIENTONLY-4821 written with a bare mdb command.');
  assert.equal((await w.owner.vault.get(id)).body, 'CLIENTONLY-4821 written with a bare mdb command.', 'the note is in the SERVER vault');
  assert.ok(JSON.stringify(mdb(['workspace', 'list', '--json']).json).includes('proj'));
  await assert.rejects(access(localVault), 'no local vault was created on the client machine');

  // --local keeps a command on a local vault, even on a client machine.
  const local = path.join(w.base, 'forced-local'); assert.equal(mdb(['init', '--root', local, '--no-sqlite']).status, 0);
  assert.equal(JSON.stringify(mdb(['workspace', 'list', '--root', local, '--json']).json).includes('proj'), false, '--root means the local vault');

  // A machine that also has Server configuration keeps working on its own vault.
  await writeFile(path.join(config, 'server.env'), 'MDB_MCP_HTTP_PORT=3333\n', { mode: 0o600 });
  const serverMachine = mdb(['workspace', 'list', '--json'], { ...env, MDB_ROOT: local });
  assert.equal(JSON.stringify(serverMachine.json).includes('proj'), false, 'with server.env the command is local');
  await rm(path.join(config, 'server.env'));

  // A token file anyone else could read is refused with a clear message instead of being sent.
  await chmod(tokenFile, 0o644);
  const unsafe = mdb(['workspace', 'list', '--json']); assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /token file .* mode 0600 or 0400/);
});

test('against the production remote-web tool set a Client-only machine runs the everyday commands through the engram_* tools, and says plainly what that server cannot do', async t => {
  const w = await world(t, 'remote-web');
  const home = path.join(w.base, 'web-home'), config = path.join(home, '.config', 'engram'); await mkdir(config, { recursive: true });
  const tokenFile = path.join(config, 'client.token'); await writeFile(tokenFile, w.env.TK + '\n', { mode: 0o600 });
  await writeFile(path.join(config, 'client.env'), `ENGRAM_MCP_URL=${w.url}\nENGRAM_TOKEN_FILE=${tokenFile}\nENGRAM_WORKSPACE=proj\n`, { mode: 0o600 });
  const env = { ...w.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } as NodeJS.ProcessEnv; delete env.ENGRAM_URL; delete env.ENGRAM_TOKEN; delete env.MDB_ROOT; delete env.ENGRAM_DATA_DIR;
  const mdb = (args: string[]) => w.mdb(args, { env });
  const put = mdb(['put', '--kind', 'note', '--title', 'Web toolset note', '--body', 'WEBSET-9913 written through engram_create.', '--workspace', 'proj', '--json']); assert.equal(put.status, 0, put.stderr);
  const id = (put.json.id ?? put.json.objectId) as string; assert.ok(id, JSON.stringify(put.json));
  assert.equal((await w.owner.vault.get(id)).body, 'WEBSET-9913 written through engram_create.', 'the note is on the server');
  const got = mdb(['get', id, '--json']); assert.equal(got.status, 0, got.stderr); assert.equal(got.json.body, 'WEBSET-9913 written through engram_create.');
  assert.equal(mdb(['history', id, '--json']).status, 0);
  assert.ok(JSON.stringify(mdb(['search', 'WEBSET-9913', '--scope', 'workspace:proj', '--json']).json).includes('WEBSET-9913'));
  const patched = mdb(['patch', id, '--revision', got.json.revisionId, '--body', 'WEBSET-9913 edited.', '--json']); assert.equal(patched.status, 0, patched.stderr);
  assert.equal(mdb(['memory', 'recent', '--workspace', 'proj', '--limit', '3', '--json']).status, 0);
  assert.equal(mdb(['capabilities', '--json']).status, 0);
  const unsupported = mdb(['workspace', 'list', '--json']); assert.notEqual(unsupported.status, 0); assert.match(unsupported.stderr, /not available through this server's remote tool set/);
});
