import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeReplica, openReplica } from '../../packages/replication/client.js';
import { runReplicaDaemon } from '../../packages/replication/daemon.js';

test('daemon records credential refusal, preserves replica state, and releases its singleton lock on stop', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-daemon-'));
  const previous = process.env.ENGRAM_REPLICA_DIR;
  process.env.ENGRAM_REPLICA_DIR = path.join(root, 'replicas');
  t.after(async () => { if (previous === undefined) delete process.env.ENGRAM_REPLICA_DIR; else process.env.ENGRAM_REPLICA_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const token = path.join(root, 'token');
  await writeFile(token, 'never-log-this-token', { mode: 0o600 });
  const server = createServer((_request, response) => { response.writeHead(401); response.end('{"error":"revoked"}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === 'object');
  await initializeReplica({ serverUrl: `http://127.0.0.1:${address.port}`, tokenFile: token, name: 'daemon-test' });
  const abort = new AbortController(); let refused = false;
  await runReplicaDaemon({ replicaId: 'daemon-test', intervalMs: 10, signal: abort.signal, onStatus: state => { if (state.state === 'refused') { refused = true; abort.abort(); } } });
  assert.equal(refused, true);
  const statusPath = path.join(root, 'replicas', 'daemon-test', '.replica', 'status.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8')) as { state: string; pid: number; lastError: string | null };
  assert.equal(status.state, 'refused'); assert.equal(status.pid, 0); assert.doesNotMatch(status.lastError ?? '', /never-log-this-token/);
  await assert.rejects(readFile(path.join(root, 'replicas', 'daemon-test', '.replica', 'daemon.lock'), 'utf8'), { code: 'ENOENT' });
});

test('daemon notices a queue file change and pushes it without waiting for the long poll interval',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'engram-replica-debounce-')),previous=process.env.ENGRAM_REPLICA_DIR;process.env.ENGRAM_REPLICA_DIR=path.join(root,'replicas');
  t.after(async()=>{if(previous===undefined)delete process.env.ENGRAM_REPLICA_DIR;else process.env.ENGRAM_REPLICA_DIR=previous;await rm(root,{recursive:true,force:true});});
  const token=path.join(root,'token');await writeFile(token,'debounce-token',{mode:0o600});let pushed!:()=>void;const pushedSignal=new Promise<void>(resolve=>{pushed=resolve;});
  const server=createServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;response.setHeader('content-type','application/json');if(request.url==='/replica/v1/hello'){response.end(JSON.stringify({v:1,epoch:'epoch-a',enrolledScopes:[{workspaceId:'proj',scopeVersion:'1',sequenceHead:0}]}));return;}if(request.url==='/replica/v1/fetch'){response.end(JSON.stringify({events:[],cursor:'cursor',epoch:'epoch-a'}));return;}if(request.url==='/replica/v1/push'){const input=JSON.parse(body) as {ops:Array<{opId:string}>};pushed();response.end(JSON.stringify({results:input.ops.map(op=>({opId:op.opId,status:'rejected',code:'test-terminal'}))}));return;}response.writeHead(404);response.end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  await initializeReplica({serverUrl:url,tokenFile:token,name:'debounce-test'});const {store}=await openReplica('debounce-test');await store.enrollScope({type:'workspace',workspaceId:'proj'});
  const abort=new AbortController(),daemon=runReplicaDaemon({replicaId:'debounce-test',intervalMs:60_000,debounceMs:50,signal:abort.signal});
  await new Promise(resolve=>setTimeout(resolve,200));await store.vault.put({scope:{type:'workspace',workspaceId:'proj'},kind:'note',title:'Local pending',body:'push on queue change'});
  await Promise.race([pushedSignal,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('daemon did not push the changed queue')),5000))]);abort.abort();await daemon;
});
