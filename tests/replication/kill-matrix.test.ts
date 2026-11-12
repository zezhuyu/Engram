import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { Vault, serializeDocument } from '../../packages/core/vault.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { handleReplicaRoute } from '../../packages/mcp/replica-http.js';
import { enrollReplicaDevice } from '../../packages/replication/devices.js';
import { REPLICATION_INSTALL_CAPABILITY } from '../../packages/core/replication-capability.js';
import { initializeReplica, openReplica, enrollWorkspace } from '../../packages/replication/client.js';
import { syncOnce } from '../../packages/replication/sync.js';

const localPoints = [
  ['push request sent', 'sync.after_push_request_sent', 'push'],
  ['server accepted before reconcile', 'sync.after_server_accept_before_reconcile', 'push'],
  ['reconcile before replace', 'reconcile.before_replace', 'push'],
  ['reconcile after replace before queue update', 'reconcile.after_replace_before_queue_update', 'push'],
  ['installRemote before revision write', 'install_remote.before_revision_write', 'pull'],
  ['installRemote after revision write before journal', 'install_remote.after_revision_before_journal', 'pull'],
  ['installRemote after journal before cursor', 'install_remote.after_journal_before_cursor', 'pull'],
  ['installRemote after cursor write', 'install_remote.after_cursor_write', 'pull'],
  ['fork install before conflict record', 'fork_install.before_conflict_record', 'fork'],
  ['fork install after conflict record', 'fork_install.after_conflict_record', 'fork'],
  ['resolveConflict before queue append', 'resolve_conflict.before_queue_append', 'resolve'],
  ['profile snapshot install', 'profile_snapshot.after_install', 'profile'],
] as const;

async function killedChild(point: string, code: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env, ...env, NODE_ENV: 'test', MDB_FAULT_KILL_AT: point }, stdio: 'ignore' });
  const exit = await new Promise<{ signal: NodeJS.Signals | null }>(resolve => child.once('exit', (_code, signal) => resolve({ signal })));
  assert.equal(exit.signal, 'SIGKILL', `${point} must kill a real child process`);
}

test('remaining client crash points recover and converge against a live HTTP origin', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-kill-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new Engram(path.join(root, 'origin'));
  await owner.vault.init(); await owner.createWorkspace('project');
  await owner.vault.grant('project', 'matrix-agent', ['read', 'write']);
  const scope = { type: 'workspace' as const, workspaceId: 'project' };
  const credential = await createHttpCredential(owner.vault, 'matrix-agent', ['workspace:project:read', 'workspace:project:write']);
  const actor = { actorId: 'matrix-agent', permissions: ['workspace:project:read', 'workspace:project:write'], credentialBound: true };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const send = (_res: typeof res, status: number, value?: unknown, headers?: Record<string, string>) => { res.writeHead(status, { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${credential.token}`) { send(res, 401, { error: 'Unauthorized' }); return; }
    try { await handleReplicaRoute(path.join(root, 'origin'), owner.vault, actor, credential.id, req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), async () => JSON.parse(Buffer.concat(chunks).toString('utf8')), send); }
    catch { if (!res.headersSent) send(res, 500, { error: 'internal' }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`, tokenFile = path.join(root, 'token'), baseDir = path.join(root, 'replicas');
  await writeFile(tokenFile, credential.token, { mode: 0o600 });
  const moduleUrl = pathToFileURL(path.resolve('dist/packages/replication/client.js')).href;
  const syncUrl = pathToFileURL(path.resolve('dist/packages/replication/sync.js')).href;
  const hashUrl = pathToFileURL(path.resolve('dist/packages/replication/operation.js')).href;
  const outcomes: Array<{ point: string; outcome: string }> = [];

  for (const [index, [label, point, scenario]] of localPoints.entries()) {
    const id = `matrix-${index}`;
    await initializeReplica({ serverUrl: url, tokenFile, name: id, baseDir });
    let opened = await openReplica(id, baseDir);
    await enrollWorkspace(id, 'project', baseDir, true);
    opened = await openReplica(id, baseDir);
    const base = await owner.vault.put({ scope, kind: 'note', title: `base-${index}`, body: 'base' });
    await syncOnce(opened.store, opened.transport);
    opened = await openReplica(id, baseDir);
    if (scenario === 'push') {
      await opened.store.vault.put({ scope, kind: 'note', title: `push-${index}`, body: `committed-${index}` });
    } else if (scenario === 'pull') {
      await owner.vault.put({ scope, kind: 'note', title: `remote-${index}`, body: `remote-${index}` });
    } else if (scenario === 'fork' || scenario === 'resolve') {
      await opened.store.vault.patch({ objectId: base.id, expectedRevisionId: base.revisionId, body: `local-${index}` });
      await owner.vault.patch({ objectId: base.id, expectedRevisionId: base.revisionId, body: `remote-${index}` });
      if (scenario === 'resolve') await syncOnce(opened.store, opened.transport);
    }
    const script = scenario === 'profile'
      ? `const {openReplica}=await import(${JSON.stringify(moduleUrl)});const {sha256}=await import(${JSON.stringify(hashUrl)});const {store}=await openReplica(process.env.MATRIX_ID,process.env.MATRIX_BASE);const content='# PROFILE\\n';const revisionId=sha256(content);await store.installProfileSnapshot({content,revisionId,etag:'"'+revisionId+'"'});`
      : scenario === 'resolve'
        ? `const {openReplica}=await import(${JSON.stringify(moduleUrl)});const {store}=await openReplica(process.env.MATRIX_ID,process.env.MATRIX_BASE);const conflict=store.conflicts.find(item=>item.state==='open');if(!conflict)throw new Error('expected open conflict');const local=await store.vault.get(conflict.objectId,conflict.localRevisionId);await store.resolveConflict(conflict.objectId,conflict.localRevisionId,local.title,local.body);`
        : `const {openReplica}=await import(${JSON.stringify(moduleUrl)});const {syncOnce}=await import(${JSON.stringify(syncUrl)});const {store,transport}=await openReplica(process.env.MATRIX_ID,process.env.MATRIX_BASE);await syncOnce(store,transport);`;
    await killedChild(point, script, { MATRIX_ID: id, MATRIX_BASE: baseDir });
    opened = await openReplica(id, baseDir);
    await syncOnce(opened.store, opened.transport);
    if (scenario === 'fork' || scenario === 'resolve') {
      let conflict = opened.store.conflicts.find(item => item.state === 'open');
      if (conflict) {
        const local = await opened.store.vault.get(conflict.objectId, conflict.localRevisionId);
        await opened.store.resolveConflict(conflict.objectId, conflict.localRevisionId, local.title, local.body);
        opened = await openReplica(id, baseDir); await syncOnce(opened.store, opened.transport);
      }
    }
    opened = await openReplica(id, baseDir);
    const originDocs = await owner.vault.listDocuments({ scopes: [scope] });
    const replicaDocs = await opened.store.vault.listDocuments({ scopes: [scope] });
    const canonical = (docs: typeof originDocs) => docs.map(doc => serializeDocument(doc)).sort();
    assert.deepEqual(canonical(replicaDocs), canonical(originDocs), `${point}: final documents converge byte-for-byte`);
    assert.equal((await owner.vault.verify()).ok, true, `${point}: origin verify`);
    assert.equal((await opened.store.verify()).ok, true, `${point}: replica verify`);
    assert.equal(opened.store.status().pendingPush, 0, `${point}: pending queue drained`);
    assert.equal(opened.store.conflicts.filter(item => item.state === 'open').length, 0, `${point}: conflict records settled`);
    const revisions = (await owner.vault.events()).map(event => event.revisionId);
    assert.equal(new Set(revisions).size, revisions.length, `${point}: origin has no duplicate revisions`);
    outcomes.push({ point, outcome: 'SIGKILL recovered; live HTTP sync converged; verify ok; queue empty' });
  }
  process.stdout.write(`client crash matrix\n${outcomes.map(row => `${row.point}\t${row.outcome}`).join('\n')}\n`);
});

test('server applyOperation SIGKILL points replay idempotently over real HTTP', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-server-kill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originRoot = path.join(root, 'origin'), owner = new Engram(originRoot);
  await owner.vault.init(); await owner.createWorkspace('project'); await owner.vault.grant('project', 'matrix-agent', ['read', 'write']);
  const scope = { type: 'workspace' as const, workspaceId: 'project' };
  const grants = ['workspace:project:read', 'workspace:project:write'];
  const credential = await createHttpCredential(owner.vault, 'matrix-agent', grants);
  const actor = { actorId: 'matrix-agent', permissions: grants, credentialBound: true };
  const tokenFile = path.join(root, 'token'); await writeFile(tokenFile, credential.token, { mode: 0o600 });
  const baseDir = path.join(root, 'replicas'), id = 'server-matrix';
  await initializeReplica({ serverUrl: 'http://127.0.0.1:0', tokenFile, name: id, baseDir });
  const { store } = await openReplica(id, baseDir);
  const scopeVersion = await owner.vault.replicationScopeVersion(scope, actor, REPLICATION_INSTALL_CAPABILITY);
  await enrollReplicaDevice(originRoot, credential.id, actor.actorId, store.deviceId, id, scope.workspaceId, scopeVersion);
  await store.enrollScope(scope);
  const vaultUrl = pathToFileURL(path.resolve('dist/packages/core/vault.js')).href;
  const routeUrl = pathToFileURL(path.resolve('dist/packages/mcp/replica-http.js')).href;
  const serverCode = `import {createServer} from 'node:http';const {Vault}=await import(${JSON.stringify(vaultUrl)});const {handleReplicaRoute}=await import(${JSON.stringify(routeUrl)});const root=process.env.ORIGIN_ROOT,actor={actorId:'matrix-agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true},vault=new Vault(root,actor);const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const send=(_res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};if(req.headers.authorization!=='Bearer '+process.env.MATRIX_TOKEN){send(res,401,{error:'Unauthorized'});return;}try{await handleReplicaRoute(root,vault,actor,process.env.CREDENTIAL_ID,req,res,new URL(req.url??'/','http://127.0.0.1'),async()=>JSON.parse(Buffer.concat(chunks).toString('utf8')),send);}catch(error){if(!res.headersSent)send(res,500,{error:String(error)});}});server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\\n'));`;
  const startServer = async (point?: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', serverCode], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', ...(point ? { MDB_FAULT_KILL_AT: point } : {}), ORIGIN_ROOT: originRoot, MATRIX_TOKEN: credential.token, CREDENTIAL_ID: credential.id }, stdio: ['ignore', 'pipe', 'inherit'] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let pending = '';
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('HTTP fault server did not start')), 10_000);
      child.stdout!.on('data', (chunk: Buffer) => { pending += chunk.toString(); const newline = pending.indexOf('\n'); if (newline >= 0) { clearTimeout(timeout); resolve((JSON.parse(pending.slice(0, newline)) as { port: number }).port); } });
      child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`HTTP fault server exited before ready (${code}/${signal}): ${pending}`)); });
    });
    return { child, exit, url: `http://127.0.0.1:${port}` };
  };
  const waitForExit = async (exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, context: string) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exit,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${context}: child did not exit within 20 seconds`)), 20_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const stop = async (server: Awaited<ReturnType<typeof startServer>>) => { if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGTERM'); await waitForExit(server.exit, 'HTTP fault server shutdown'); };
  const outcomes: Array<{ point: string; outcome: string }> = [];
  for (const point of ['server.after_vault_commit_before_result_store', 'server.after_result_store_before_response']) {
    await store.vault.put({ scope, kind: 'note', title: `server commit ${point}`, body: 'must survive server process death' });
    const op = store.pendingBatch()[0]!;
    const first = await startServer(point);
    const firstRequest = fetch(`${first.url}/replica/v1/push`, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: store.deviceId, ops: [op] }) });
    try { const response = await firstRequest; const detail = `${point}: expected server SIGKILL, got HTTP ${response.status} ${await response.text()}`; first.child.kill('SIGTERM'); assert.fail(detail); }
    catch (error) { if (String(error).includes('expected server SIGKILL')) throw error; }
    const killed = (await waitForExit(first.exit, `${point}: SIGKILL fault server`)).signal;
    assert.equal(killed, 'SIGKILL', point);
    const second = await startServer();
    try {
      const replay = await fetch(`${second.url}/replica/v1/push`, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: store.deviceId, ops: [op] }) });
      assert.equal(replay.status, 200, point);
      const payload = await replay.json() as { results: Array<{ status: string; code: string }> };
      assert.equal(payload.results[0]?.status, 'accepted', point);
      assert.ok(['COMMITTED', 'IDEMPOTENT'].includes(payload.results[0]?.code ?? ''), point);
      const configPath = path.join(store.root, '.replica', 'config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      await writeFile(configPath, JSON.stringify({ ...config, serverUrl: second.url }), { mode: 0o600 });
      const replicaTransport = (await openReplica(id, baseDir)).transport;
      const synced = await syncOnce(store, replicaTransport);
      assert.deepEqual(synced.errors, [], point);
      const origin = new Vault(originRoot), originEvents = await origin.events();
      assert.equal(originEvents.filter(event => event.objectId === op.objectId && event.revisionId === op.revisionId).length, 1, `${point}: exactly one origin revision`);
      assert.deepEqual((await store.vault.listDocuments({ scopes: [scope] })).map(serializeDocument), (await origin.listDocuments({ scopes: [scope] })).map(serializeDocument), `${point}: origin and replica converge`);
      assert.equal((await origin.verify()).ok, true, point); assert.equal((await store.verify()).ok, true, point);
      assert.equal(store.status().pendingPush, 0, point);
      outcomes.push({ point, outcome: `${payload.results[0]!.code}; one revision; HTTP retry converged; verify ok` });
    } finally { await stop(second); }
  }
  process.stdout.write(`server crash matrix\n${outcomes.map(row => `${row.point}\t${row.outcome}`).join('\n')}\n`);
});
