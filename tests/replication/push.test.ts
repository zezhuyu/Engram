import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReplicaStore } from '../../packages/replication/replica.js';
import { parseDocument, serializeDocument } from '../../packages/core/vault.js';
import { REPLICATION_INSTALL_CAPABILITY } from '../../packages/core/replication-capability.js';
import { sha256 } from '../../packages/replication/operation.js';
import { Vault } from '../../packages/core/vault.js';
import { applyBatch } from '../../packages/replication/server.js';

test('accepted revision reconciliation checks identity, replaces only actor stamp, and is repeatable', async t => {
  const base=await mkdtemp(path.join(tmpdir(),'engram-reconcile-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const store=await ReplicaStore.replicaInit('reconcile','http://127.0.0.1',base);await store.enrollScope({type:'workspace',workspaceId:'project'});
  const local=await store.vault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'Local',body:'same bytes except actor'}),op=store.pendingBatch()[0]!;
  const authoritative=parseDocument(serializeDocument({...local,createdBy:'server-actor'})),bytes=serializeDocument(authoritative),events=await store.vault.replicationEvents(REPLICATION_INSTALL_CAPABILITY),event=events.find(item=>item.revisionId===local.revisionId)!;
  await assert.rejects(()=>store.reconcileAccepted(op.opId,{revisionId:'other',revisionSha256:sha256(bytes),serverSequence:1,revisionBytes:bytes}),/invalid authoritative/);
  await store.reconcileAccepted(op.opId,{revisionId:local.revisionId,revisionSha256:sha256(bytes),serverSequence:1,revisionBytes:bytes});
  assert.equal((await store.vault.get(local.id)).createdBy,'server-actor');assert.equal((await store.verify()).ok,true);
  await store.markResult(op.opId,{status:'accepted',authoritative:{revisionId:local.revisionId,revisionSha256:sha256(bytes),serverSequence:event.sequence,revisionBytes:bytes}});
  assert.equal(store.status().pendingPush,0);
  await assert.rejects(()=>store.vault.installReplicatedRevision(Buffer.from(bytes),event,{}),/capability/i);
  const revisionPath=path.join(store.root,'vault','.mdb','objects',local.id,'revs',`${local.revisionId}.md`);assert.equal(await readFile(revisionPath,'utf8'),bytes);
});

test('reconciliation retries recover crashes before replace and after replace before queue update',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'engram-reconcile-crash-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const store=await ReplicaStore.replicaInit('crash','http://127.0.0.1',base);await store.enrollScope({type:'workspace',workspaceId:'project'});
  const doc=await store.vault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'Crash',body:'candidate'}),op=store.pendingBatch()[0]!,authoritative=parseDocument(serializeDocument({...doc,createdBy:'server'})),bytes=serializeDocument(authoritative),result={status:'accepted',authoritative:{revisionId:doc.revisionId,revisionSha256:sha256(bytes),serverSequence:1,revisionBytes:bytes}};
  store.vault.options.fault=stage=>{if(stage==='replica_reconcile.before_replace')throw new Error('kill-before-replace');};
  await assert.rejects(()=>store.markResult(op.opId,result),/kill-before-replace/);assert.equal((await store.vault.get(doc.id)).createdBy,doc.createdBy);
  store.vault.options.fault=stage=>{if(stage==='replica_reconcile.after_replace')throw new Error('kill-after-replace');};
  await assert.rejects(()=>store.markResult(op.opId,result),/kill-after-replace/);assert.equal((await store.vault.get(doc.id)).createdBy,'server');assert.equal(store.status().pendingPush,1);
  store.vault.options.fault=undefined;await store.markResult(op.opId,result);assert.equal(store.status().pendingPush,0);assert.equal((await store.verify()).ok,true);
});

test('rejected local operations remain terminal until explicit discard and do not resurrect on restart',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'engram-rejected-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const store=await ReplicaStore.replicaInit('rejected','http://127.0.0.1',base);await store.enrollScope({type:'workspace',workspaceId:'project'});const doc=await store.vault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'Rejected',body:'retained'}),op=store.pendingBatch()[0]!;
  await store.markResult(op.opId,{status:'rejected',code:'FORBIDDEN'});assert.equal(store.pendingBatch().length,0);await assert.rejects(()=>store.discardRejected('unknown'),/not found/);await store.discardRejected(op.opId);
  const reopened=await ReplicaStore.replicaInit('rejected','http://127.0.0.1',base);assert.equal(reopened.pendingBatch().length,0);assert.equal((await reopened.vault.get(doc.id)).body,'retained');
});

test('push rechecks write access for each operation after an earlier commit',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'engram-write-recheck-'));t.after(()=>rm(base,{recursive:true,force:true}));const server=new Vault(path.join(base,'server'));await server.init();await server.createWorkspace('project','',{agent:['read','write']});
  const local=await ReplicaStore.replicaInit('writer','http://127.0.0.1',base);await local.enrollScope({type:'workspace',workspaceId:'project'});await local.vault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'First',body:'first'});await local.vault.put({scope:{type:'workspace',workspaceId:'project'},kind:'note',title:'Second',body:'second'});
  let checks=0;const gated=new Proxy(server,{get(target,key){if(key==='canAccess')return async(...args:Parameters<Vault['canAccess']>)=>{checks++;return checks<=1&&target.canAccess(...args);};const value=Reflect.get(target,key,target) as unknown;return typeof value==='function'?(value as (...args:unknown[])=>unknown).bind(target):value;}});
  const results=await applyBatch(gated,{actorId:'agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true},local.pendingBatch(),100,{resultsFile:path.join(base,'results.json')});assert.deepEqual(results.map(result=>result.status),['accepted','rejected']);assert.equal(results[1]?.code,'FORBIDDEN');assert.equal((await server.listDocuments({scopes:[{type:'workspace',workspaceId:'project'}]})).length,1);
});
