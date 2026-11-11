import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, serializeDocument } from '../../packages/core/vault.js';
import { ReplicaStore } from '../../packages/replication/replica.js';
import { fetchEvents } from '../../packages/replication/feed.js';
import { applyOperation } from '../../packages/replication/server.js';

test('two offline replicas preserve a losing candidate, pull the server head, resolve explicitly, and converge',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-replica-conflict-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const serverOwner=new Vault(path.join(root,'server'));await serverOwner.init();await serverOwner.createWorkspace('project','',{agent:['read','write']});const actor={actorId:'agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true},server=new Vault(path.join(root,'server'),actor);
  const scope={type:'workspace' as const,workspaceId:'project'},base=await server.put({scope,kind:'note',title:'Shared',body:'base'}),feedDir=path.join(root,'feed');
  const a=await ReplicaStore.replicaInit('a','http://localhost',path.join(root,'clients')),b=await ReplicaStore.replicaInit('b','http://localhost',path.join(root,'clients'));
  for(const client of [a,b]){await client.enrollScope(scope);const page=await fetchEvents(server,actor,scope,client.deviceId,undefined,100,feedDir);await client.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);}
  const aDoc=await a.vault.get(base.id),bDoc=await b.vault.get(base.id);await a.vault.patch({objectId:base.id,expectedRevisionId:aDoc.revisionId,body:'edit A'});await b.vault.patch({objectId:base.id,expectedRevisionId:bDoc.revisionId,body:'edit B'});
  const opA=a.pendingBatch()[0]!,opB=b.pendingBatch()[0]!;const accepted=await applyOperation(server,actor,opA,{resultsFile:path.join(root,'results.json')});assert.equal(accepted.status,'accepted');await a.markResult(opA.opId,accepted);
  const conflicted=await applyOperation(server,actor,opB,{resultsFile:path.join(root,'results.json')});assert.equal(conflicted.status,'conflict');assert.equal(conflicted.currentHeadId,opA.revisionId);await b.markResult(opB.opId,conflicted);
  const headPage=await fetchEvents(server,actor,scope,b.deviceId,await b.cursorFor(scope.workspaceId),100,feedDir);await b.installRemote(headPage.events,headPage.cursor,headPage.epoch,scope.workspaceId);assert.equal((await b.vault.get(base.id)).revisionId,opA.revisionId);
  await b.resolveConflict(base.id,opB.revisionId,'Merged','combined A and B');const resolved=b.pendingBatch()[0]!;assert.equal((await applyOperation(server,actor,resolved,{resultsFile:path.join(root,'results.json')})).status,'accepted');const resolutionResult=await applyOperation(server,actor,resolved,{resultsFile:path.join(root,'results.json')});await b.markResult(resolved.opId,resolutionResult);
  for(const client of [a,b]){const page=await fetchEvents(server,actor,scope,client.deviceId,await client.cursorFor(scope.workspaceId),100,feedDir);await client.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);}
  const latest=await server.get(base.id);for(const client of [a,b]){const local=await client.vault.get(base.id);assert.equal(local.revisionId,latest.revisionId);assert.equal(local.body,'combined A and B');const disk=await fs.readFile(path.join(client.root,'vault','.mdb','objects',base.id,'revs',`${latest.revisionId}.md`),'utf8');assert.equal(disk,serializeDocument(latest));assert.equal((await client.verify()).ok,true);}
  const loserPath=path.join(b.root,'vault','.mdb','objects',base.id,'revs',`${opB.revisionId}.md`);assert.match(await fs.readFile(loserPath,'utf8'),/edit B/);
});

test('150 seeded operations converge byte-for-byte across origin and two replicas',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-replica-three-party-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const owner=new Vault(path.join(root,'server'));await owner.init();await owner.createWorkspace('project','',{agent:['read','write']});const actor={actorId:'agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true},server=new Vault(path.join(root,'server'),actor),scope={type:'workspace' as const,workspaceId:'project'},feedDir=path.join(root,'feed');
  const clients=[await ReplicaStore.replicaInit('a','http://localhost',path.join(root,'clients')),await ReplicaStore.replicaInit('b','http://localhost',path.join(root,'clients'))];for(const client of clients)await client.enrollScope(scope);
  let state=0x31f2a9;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
  for(let i=0;i<150;i++){const client=clients[i%2]!,value=random().toString(16);await client.vault.put({scope,kind:'note',title:`Seeded ${i}`,body:`seed=${value}; ordinal=${i}`});}
  for(const client of clients)for(const op of client.pendingBatch(100)){const result=await applyOperation(server,actor,op,{resultsFile:path.join(root,'results.json')});assert.equal(result.status,'accepted');await client.markResult(op.opId,result);}
  for(const client of clients){const page=await fetchEvents(server,actor,scope,client.deviceId,undefined,200,feedDir);assert.equal(page.events.length,150);await client.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);}
  const origin=await server.listDocuments({scopes:[scope]});assert.equal(origin.length,150);for(const client of clients){const replica=await client.vault.listDocuments({scopes:[scope]});assert.equal(replica.length,origin.length);for(const document of origin){const remoteBytes=await fs.readFile(path.join(root,'server','.mdb','objects',document.id,'revs',`${document.revisionId}.md`));const replicaBytes=await fs.readFile(path.join(client.root,'vault','.mdb','objects',document.id,'revs',`${document.revisionId}.md`));assert.deepEqual(replicaBytes,remoteBytes);}assert.equal((await client.verify()).ok,true);}
});
