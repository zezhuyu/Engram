import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { ReplicaStore } from '../../packages/replication/replica.js';
import { fetchEvents, serverEpoch } from '../../packages/replication/feed.js';
import { applyBatch } from '../../packages/replication/server.js';
import { InProcessReplicaTransport, syncOnce } from '../../packages/replication/sync.js';

test('syncOnce retains twenty offline commits and later drains them through the in-process transport',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-sync-offline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const owner=new Vault(path.join(root,'server'));await owner.init();await owner.createWorkspace('project','',{agent:['read','write']});const actor={actorId:'agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true},server=new Vault(path.join(root,'server'),actor),scope={type:'workspace' as const,workspaceId:'project'},feedDir=path.join(root,'feed'),store=await ReplicaStore.replicaInit('offline','http://localhost',path.join(root,'clients'));await store.enrollScope(scope);
  for(let i=0;i<20;i++)await store.vault.put({scope,kind:'note',title:`Offline ${i}`,body:`queued ${i}`});
  const offline=await syncOnce(store,new InProcessReplicaTransport({hello:async()=>{throw new Error('server unavailable');},fetch:async()=>{throw new Error('server unavailable');},push:async()=>{throw new Error('server unavailable');}}));assert.equal(offline.errors.length,1);assert.equal(store.status().pendingPush,20);
  const online=new InProcessReplicaTransport({hello:async()=>({v:1,epoch:await serverEpoch(feedDir),enrolledScopes:[{workspaceId:'project',scopeVersion:'v1',sequenceHead:(await server.events()).length}]}),fetch:async(deviceId,workspaceId,cursor)=>fetchEvents(server,actor,{type:'workspace',workspaceId},deviceId,cursor,100,feedDir),push:async(_deviceId,ops)=>({results:(await applyBatch(server,actor,ops,100,{resultsFile:path.join(root,'results.json')})).map((result,index)=>({opId:ops[index]!.opId,...result}))})});
  const report=await syncOnce(store,online);assert.equal(report.accepted,20);assert.equal(report.pulled,20);assert.equal(report.errors.length,0);assert.equal(store.status().pendingPush,0);assert.equal((await owner.listDocuments({scopes:[scope]})).length,20);assert.equal((await store.verify()).ok,true);
});
