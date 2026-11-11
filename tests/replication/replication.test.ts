import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault, parseDocument, serializeDocument } from '../../packages/core/vault.js';
import type { Document } from '../../packages/core/types.js';
import { createOperation, validateOperation, sha256, type ReplicaOperation } from '../../packages/replication/operation.js';
import { applyOperation, applyBatch } from '../../packages/replication/server.js';
import { fetchEvents, fetchSourceBlob, listScopes, bumpEpoch } from '../../packages/replication/feed.js';
import { replicaInit } from '../../packages/replication/replica.js';

async function fixture(t: {after(fn:()=>void|Promise<void>):void}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-replica-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const vault=new Vault(path.join(root,'server'));await vault.init();await vault.createWorkspace('project','',{agent:['read','write']});
  const actor={actorId:'agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true};
  return{root,vault,actor,scope:{type:'workspace' as const,workspaceId:'project'},resultsFile:path.join(root,'results.json')};
}
function operationFrom(docText:string,deviceId=randomUUID(),localSeq=1):ReplicaOperation {const doc=parseDocument(docText);return createOperation({deviceId,localSeq,scope:{type:'workspace',workspaceId:doc.scope.type==='workspace'?doc.scope.workspaceId:'invalid'},kind:doc.kind as ReplicaOperation['kind'],objectId:doc.id,revisionId:doc.revisionId,previousRevisionId:doc.previousRevisionId??null,baseRevisionId:doc.previousRevisionId??null,revisionBytes:docText});}
function childRevision(docText:string,revisionId:string,body:string):string {const base=parseDocument(docText);return serializeDocument({...base,revisionId,revisionNumber:base.revisionNumber+1,previousRevisionId:base.revisionId,body,updatedAt:new Date().toISOString()});}

test('operation schema rejects unknown keys, oversized revisions, bad hashes and malformed identifiers',()=>{
  const op=createOperation({deviceId:randomUUID(),localSeq:1,scope:{type:'workspace',workspaceId:'project'},kind:'note',objectId:'obj_1',revisionId:'rev_1',previousRevisionId:null,baseRevisionId:null,revisionBytes:'---\na: b\n---\nhello'});
  validateOperation(op);for(const bad of [{...op,extra:true},{...op,revisionSha256:'0'.repeat(64)},{...op,deviceId:'not-a-uuid'},{...op,localSeq:0},{...op,revisionBytes:'x'.repeat(1024*1024+1)}])assert.throws(()=>validateOperation(bad));
  const statement=createOperation({deviceId:randomUUID(),localSeq:1,scope:{type:'workspace',workspaceId:'project'},kind:'preference_statement',objectId:'obj_1',revisionId:'rev_1',previousRevisionId:null,baseRevisionId:null,revisionBytes:'',statement:{text:'Use concise answers',preferenceKey:'answer-style',category:'preference'}});validateOperation(statement);
  assert.throws(()=>validateOperation({...statement,revisionBytes:'revision'}));
});

test('preference statements use the explicit server path, remain workspace scoped and never accept client revision bytes',async t=>{
  const {vault,actor,scope,resultsFile}=await fixture(t);
  const statement=createOperation({deviceId:randomUUID(),localSeq:1,scope,kind:'preference_statement',objectId:'preference_answer_style',revisionId:'rev_statement_1',previousRevisionId:null,baseRevisionId:null,revisionBytes:'',statement:{text:'Keep replies concise',preferenceKey:'answer-style',category:'preference'}});
  const result=await applyOperation(vault,actor,statement,{resultsFile});assert.equal(result.status,'accepted');assert.equal(result.code,'PREFERENCE_RECORDED');
  const saved=await vault.listDocuments({scopes:[scope]});assert.ok(saved.some(doc=>doc.kind==='user_insight'&&doc.body==='Keep replies concise'&&doc.createdBy==='agent'));
  assert.throws(()=>validateOperation({...statement,revisionBytes:'---\nkind: user_insight\n---\nforged'}));
});

test('server stamps actor, commits once, rejects replay collisions and returns stale-parent conflicts',async t=>{
  const {root,vault,actor,scope,resultsFile}=await fixture(t);const base=await vault.put({scope,kind:'note',title:'Base',body:'base'});
  const make=(revisionId:string,body:string)=>operationFrom(childRevision(serializeDocument(base),revisionId,body),randomUUID());
  const first=make('rev_child_one','one'),second=make('rev_child_two','two');
  const accepted=await applyOperation(vault,actor,first,{resultsFile});assert.equal(accepted.status,'accepted');
  assert.equal((await vault.get(base.id)).createdBy,'agent');
  assert.deepEqual(await applyOperation(vault,actor,first,{resultsFile}),accepted);
  await fs.rm(resultsFile,{force:true});assert.equal((await applyOperation(vault,actor,first,{resultsFile})).status,'accepted');
  assert.equal((await applyOperation(vault,actor,second,{resultsFile})).status,'conflict');
  assert.equal((await vault.get(base.id)).body,'one');
  const forged={...make('rev_forged','f'),objectId:'obj_unrelated'};assert.equal((await applyOperation(vault,actor,forged,{resultsFile})).code,'FORGED_REVISION');
  const collision=operationFrom(serializeDocument(base),randomUUID(),2);assert.equal((await applyOperation(vault,actor,collision,{resultsFile})).status,'rejected');
  const replay=await applyOperation(vault,actor,make('rev_other','x'),{resultsFile});assert.equal(replay.status,'conflict');
  await vault.revoke('project','agent');assert.equal((await applyOperation(vault,actor,make('rev_denied','x'),{resultsFile})).code,'FORBIDDEN');
  assert.equal((await vault.verify()).ok,true);assert.equal((await vault.recover()).committed>0,true);
});

test('partial batch stops later operations for an object after its first conflict',async t=>{
  const {vault,actor,scope,resultsFile}=await fixture(t);const base=await vault.put({scope,kind:'note',title:'Base',body:'base'});
  const one=operationFrom(childRevision(serializeDocument(base),'rev_batch_one','one'));
  const two=operationFrom(childRevision(serializeDocument(base),'rev_batch_two','two'));
  const results=await applyBatch(vault,actor,[one,two,two],100);
  assert.deepEqual(results.map(r=>r.status),['accepted','conflict','skipped-after-conflict']);assert.equal(results[2]?.code,'SKIPPED_AFTER_CONFLICT');
  assert.equal((await vault.get(base.id)).body,'one');assert.ok(resultsFile);
});

test('feed hides unreadable scopes, binds cursors to actor and device, and detects chain tampering',async t=>{
  const {root,vault,actor,scope}=await fixture(t);const feedDir=path.join(root,'feed');const document=await vault.put({scope,kind:'note',title:'Visible',body:'body'});await vault.createWorkspace('empty','Readable empty',{agent:['read']});actor.permissions.push('workspace:empty:read');
  await vault.createWorkspace('hidden','secret title',{});await vault.put({scope:{type:'workspace',workspaceId:'hidden'},kind:'note',title:'Hidden title',body:'secret body'});
  const visible=await listScopes(vault,actor,feedDir);assert.deepEqual(visible.map(x=>x.scope.workspaceId).sort(),['empty','project']);
  const feed=await fetchEvents(vault,actor,scope,'00000000-0000-4000-8000-000000000001',undefined,10,feedDir);assert.equal(feed.events.length,1);assert.ok(!JSON.stringify(feed).includes('hidden'));
  await assert.rejects(()=>fetchEvents(vault,{...actor,actorId:'other'},scope,'00000000-0000-4000-8000-000000000001',feed.cursor,10,feedDir));
  await assert.rejects(()=>fetchEvents(vault,actor,scope,'00000000-0000-4000-8000-000000000002',feed.cursor,10,feedDir));
  const changed={...actor,permissions:[...actor.permissions,'workspace:other:read']};await assert.rejects(()=>fetchEvents(vault,changed,scope,'00000000-0000-4000-8000-000000000001',feed.cursor,10,feedDir));
  assert.equal(feed.events[0]?.event.objectId,document.id);
  const tampered={...feed.events[0]!,revisionBytes:feed.events[0]!.revisionBytes+'tamper'};assert.notEqual(tampered.eventHash,sha256(`${tampered.prevHash}\n${JSON.stringify(tampered.event)}\n${sha256(tampered.revisionBytes)}`));
});

test('source blobs are returned only through an authorized owning workspace and verified by digest',async t=>{
  const {root,vault,actor,scope}=await fixture(t);const source=path.join(root,'source.txt');await fs.writeFile(source,'replicated source bytes');const document=await vault.ingest(source,scope);const digest=String(document.metadata.sha256);
  assert.equal(Buffer.from(await fetchSourceBlob(vault,actor,scope,digest)).toString(),'replicated source bytes');
  await assert.rejects(()=>fetchSourceBlob(vault,{actorId:'stranger',permissions:[]},scope,digest),/forbidden/);
});

test('replica store persists queue, tolerates a torn tail, and blocks on epoch changes until resync',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-replica-local-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const replica=await replicaInit('test-replica','https://user:secret@example.test/mcp?token=hidden',path.join(root,'replicas'));
  const deviceInfo=JSON.parse(await fs.readFile(path.join(replica.state,'device.json'),'utf8')) as {serverUrl:string};assert.equal(deviceInfo.serverUrl,'https://example.test');
  await replica.enrollScope({type:'workspace',workspaceId:'project'});
  await replica.vault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'Local',body:'body'});assert.equal(replica.status().pendingPush,1);
  await fs.appendFile(path.join(replica.state,'pending.jsonl'),'{torn');
  const reopened=await replicaInit('test-replica','local-test',path.join(root,'replicas'));assert.equal(reopened.status().pendingPush,1);
  const remoteVault=new Vault(path.join(root,'origin'));await remoteVault.init();await remoteVault.createWorkspace('project','',{'replica:server':['read','write']});
  const originDoc=await remoteVault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'Remote',body:'remote'});
  const remoteActor={actorId:'replica:server',permissions:['workspace:project:read','workspace:project:write']};
  await reopened.installRemote([], 'initial-cursor', 'epoch-old');
  const originFeed=await fetchEvents(remoteVault,remoteActor,{type:'workspace',workspaceId:'project'},replica.deviceId,undefined,10,path.join(root,'feed'));
  await assert.rejects(()=>reopened.installRemote(originFeed.events as never,originFeed.cursor,originFeed.epoch),/epoch-changed/);
  assert.equal(reopened.status().state,'epoch-changed');assert.throws(()=>reopened.pendingBatch(),/epoch-changed/);
  const stillBlocked=await replicaInit('test-replica','local-test',path.join(root,'replicas'));assert.equal(stillBlocked.status().state,'epoch-changed');assert.throws(()=>stillBlocked.pendingBatch(),/epoch-changed/);
  await reopened.resync('keep-pending-and-refetch');
  const feed=await fetchEvents(remoteVault,remoteActor,{type:'workspace',workspaceId:'project'},replica.deviceId,undefined,10,path.join(root,'feed'));
  const firstEvent=feed.events[0]!;await reopened.vault.store.putImmutable(`.mdb/objects/${firstEvent.event.objectId}/revs/${firstEvent.event.revisionId}.md`,Buffer.from(firstEvent.revisionBytes));
  await reopened.installRemote(feed.events as never,feed.cursor,feed.epoch);assert.equal((await reopened.vault.get(originDoc.id)).body,'remote');assert.equal(reopened.status().pendingPush,1);
  await fs.rm(path.join(reopened.state,'cursor.json'),{force:true});await reopened.installRemote(feed.events as never,feed.cursor,feed.epoch);assert.equal((await reopened.verify()).ok,true);await reopened.recover();
  const localChild=childRevision(serializeDocument(originDoc),'rev_local_conflict','local branch');
  const localOp=createOperation({deviceId:reopened.deviceId,localSeq:2,scope:{type:'workspace',workspaceId:'project'},kind:'note',objectId:originDoc.id,revisionId:'rev_local_conflict',previousRevisionId:originDoc.revisionId,baseRevisionId:originDoc.revisionId,revisionBytes:localChild});
  await reopened.recordLocalCommit(localOp);await reopened.markResult(localOp.opId,{status:'conflict',code:'STALE_PARENT',currentHeadId:originDoc.revisionId});
  assert.equal(reopened.status().conflicts,1);const resolved=await reopened.resolveConflict(originDoc.id,localOp.revisionId,'Resolved','merged body');
  assert.deepEqual(resolved.metadata.resolvedFrom,['rev_local_conflict',originDoc.revisionId]);assert.equal(resolved.previousRevisionId,originDoc.revisionId);assert.equal(reopened.status().conflicts,1);assert.equal(reopened.status().pendingPush,2);assert.equal(reopened.status().held,0);
});

test('200 seeded workspace operations converge by feed parity to two replicas',async t=>{
  const {root,vault,scope}=await fixture(t);
  const a=await replicaInit('parity-a','test-server',path.join(root,'replicas'));
  const b=await replicaInit('parity-b','test-server',path.join(root,'replicas'));
  await a.enrollScope(scope);await b.enrollScope(scope);
  await vault.grant('project',`replica:${a.deviceId}`,['read','write']);
  await vault.grant('project',`replica:${b.deviceId}`,['read','write']);
  let seed=0x29a17;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x1_0000_0000;};
  const docs=new Map<string,Document>();
  for(let i=0;i<200;i++){
    if(!docs.size||random()<0.28){
      const doc=await vault.put({scope,kind:'note',title:`Seeded ${i}`,body:`body-${i}-${random().toString(16)}`,tags:[`group-${Math.floor(random()*5)}`]});
      docs.set(doc.id,doc);
    }else{
      const values=[...docs.values()],old=values[Math.floor(random()*values.length)]!;
      const updated=await vault.patch({objectId:old.id,expectedRevisionId:old.revisionId,body:`body-${i}-${random().toString(16)}`,tags:[`group-${Math.floor(random()*5)}`,`revision-${i%3}`]});
      docs.set(updated.id,updated);
    }
  }
  const feedDir=path.join(root,'parity-feed');
  for(const replica of [a,b]){
    let cursor:string|undefined;
    for(;;){
      const page=await fetchEvents(vault,{actorId:`replica:${replica.deviceId}`,permissions:['workspace:project:read','workspace:project:write']},scope,replica.deviceId,cursor,50,feedDir);
      await replica.installRemote(page.events as never,page.cursor,page.epoch);
      cursor=page.cursor;
      if(page.events.length<50)break;
    }
  }
  const logical=async(store:Vault)=>(await store.listDocuments({scopes:[scope]})).map(doc=>({id:doc.id,revisionId:doc.revisionId,kind:doc.kind,title:doc.title,body:doc.body,tags:doc.tags,status:doc.status})).sort((x,y)=>x.id.localeCompare(y.id));
  const expected=await logical(vault);
  assert.equal(expected.length,docs.size);
  assert.deepEqual(await logical(a.vault),expected);
  assert.deepEqual(await logical(b.vault),expected);
  assert.equal((await a.verify()).ok,true);
  assert.equal((await b.verify()).ok,true);
});

test('replica startup reconstructs a local commit lost between Vault commit and queue append',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-replica-queue-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const replica=await replicaInit('queue-recovery','local-test',path.join(root,'replicas'));
  const scope={type:'workspace' as const,workspaceId:'project'};await replica.enrollScope(scope);
  const vaultWithoutCallback=new Vault(replica.vault.root,replica.vault.actor);
  const committed=await vaultWithoutCallback.put({scope,kind:'note',title:'Committed before crash',body:'recover me'});
  assert.equal(replica.status().pendingPush,0);
  const recovered=await replicaInit('queue-recovery','local-test',path.join(root,'replicas'));
  assert.equal(recovered.status().pendingPush,1);
  assert.equal(recovered.pendingBatch()[0]?.revisionId,committed.revisionId);
  const restarted=await replicaInit('queue-recovery','local-test',path.join(root,'replicas'));
  assert.equal(restarted.status().pendingPush,1);
  assert.equal(restarted.pendingBatch()[0]?.localSeq,1);
});

test('epoch bump changes the feed epoch',async t=>{const {root,vault,actor,scope}=await fixture(t);const feedDir=path.join(root,'feed');await vault.put({scope,kind:'note',title:'N',body:'b'});const before=await fetchEvents(vault,actor,scope,'00000000-0000-4000-8000-000000000003',undefined,100,feedDir);const after=await bumpEpoch(scope,feedDir);assert.notEqual(after,before.epoch);await assert.rejects(()=>fetchEvents(vault,actor,scope,'00000000-0000-4000-8000-000000000003',before.cursor,100,feedDir));});
