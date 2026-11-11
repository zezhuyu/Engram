import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { REPLICATION_INSTALL_CAPABILITY } from '../../packages/core/replication-capability.js';
import { ReplicaStore } from '../../packages/replication/replica.js';
import { fetchEvents } from '../../packages/replication/feed.js';
import { canonicalJson, sha256 } from '../../packages/replication/operation.js';

async function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'engram-fork-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const owner=new Vault(path.join(root,'origin'));await owner.init();await owner.createWorkspace('project','',{agent:['read','write']});
  const actor={actorId:'agent',permissions:['workspace:project:read','workspace:project:write'],credentialBound:true},server=new Vault(path.join(root,'origin'),actor),scope={type:'workspace' as const,workspaceId:'project'};
  const replica=await ReplicaStore.replicaInit('client','http://localhost',path.join(root,'clients'));await replica.enrollScope(scope);
  return{root,owner,server,actor,scope,replica,feedDir:path.join(root,'feed')};
}

test('replicated fork requires capability and an actual divergent local head',async t=>{
  const {root,server,actor,scope,replica,feedDir}=await setup(t),base=await server.put({scope,kind:'note',title:'Shared',body:'base'});
  const first=await fetchEvents(server,actor,scope,replica.deviceId,undefined,100,feedDir);await replica.installRemote(first.events,first.cursor,first.epoch,scope.workspaceId);
  const local=await replica.vault.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'local'}),remote=await server.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'server'});
  const page=await fetchEvents(server,actor,scope,replica.deviceId,await replica.cursorFor(scope.workspaceId),100,feedDir),incoming=page.events[0]!;
  await assert.rejects(replica.vault.installReplicatedFork(Buffer.from(incoming.revisionBytes),incoming.event,base.revisionId,[local.revisionId],{}),/not found or not accessible/i);
  const clean=await ReplicaStore.replicaInit('clean','http://localhost',path.join(root,'clients'));await clean.enrollScope(scope);
  await assert.rejects(clean.vault.installReplicatedFork(Buffer.from(incoming.revisionBytes),incoming.event,base.revisionId,[local.revisionId],REPLICATION_INSTALL_CAPABILITY),/base revision is missing|candidate chain|current local head/);
  const result=await replica.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);assert.equal(result.diverged,1);assert.equal(result.deferred,0);assert.equal((await replica.vault.get(base.id)).revisionId,remote.revisionId);
  assert.equal((await replica.verify()).ok,true);assert.ok(await fs.readFile(path.join(replica.root,'vault','.mdb','objects',base.id,'revs',`${local.revisionId}.md`)));
});

test('fork recovery reconstructs conflict after a crash between journal install and conflict state write',async t=>{
  const {root,server,actor,scope,replica,feedDir}=await setup(t),base=await server.put({scope,kind:'note',title:'Crash fork',body:'base'});
  const first=await fetchEvents(server,actor,scope,replica.deviceId,undefined,100,feedDir);await replica.installRemote(first.events,first.cursor,first.epoch,scope.workspaceId);
  const local=await replica.vault.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'candidate'}),remote=await server.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'origin'});
  const page=await fetchEvents(server,actor,scope,replica.deviceId,await replica.cursorFor(scope.workspaceId),100,feedDir),incoming=page.events[0]!;
  await fs.rm(path.join(replica.state,'conflicts.json'),{force:true});
  await replica.vault.installReplicatedFork(Buffer.from(incoming.revisionBytes),incoming.event,base.revisionId,[local.revisionId],REPLICATION_INSTALL_CAPABILITY);
  const reopened=await ReplicaStore.replicaInit('client','http://localhost',path.join(root,'clients'));
  assert.equal(reopened.status().conflicts,1);assert.equal((await reopened.vault.get(base.id)).revisionId,remote.revisionId);assert.equal((await reopened.verify()).ok,true);
});

test('verify rejects a forged fork marker while accepting an intact recorded fork',async t=>{
  const {root,server,actor,scope,replica,feedDir}=await setup(t),base=await server.put({scope,kind:'note',title:'Forged marker',body:'base'});
  const first=await fetchEvents(server,actor,scope,replica.deviceId,undefined,100,feedDir);await replica.installRemote(first.events,first.cursor,first.epoch,scope.workspaceId);
  const local=await replica.vault.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'candidate'});await server.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'origin'});
  const page=await fetchEvents(server,actor,scope,replica.deviceId,await replica.cursorFor(scope.workspaceId),100,feedDir);await replica.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);assert.equal((await replica.verify()).ok,true);
  const journal=path.join(replica.root,'vault','.mdb','events','commits.jsonl'),lines=(await fs.readFile(journal,'utf8')).trim().split('\n'),events=lines.map(line=>JSON.parse(line) as {revisionId:string;replicatedFork?:{baseRevisionId:string}}),marker=events.find(event=>event.revisionId===page.events[0]!.event.revisionId)!;assert.ok(marker.replicatedFork);marker.replicatedFork.baseRevisionId='forged-missing-base';await fs.writeFile(journal,events.map(event=>JSON.stringify(event)).join('\n')+'\n');assert.equal((await replica.verify()).ok,false);assert.ok(await fs.readFile(path.join(replica.root,'vault','.mdb','objects',base.id,'revs',`${local.revisionId}.md`)));
});

test('resolution queue is reconstructed after a crash between revision commit and queue append',async t=>{
  const {root,server,actor,scope,replica,feedDir}=await setup(t),base=await server.put({scope,kind:'note',title:'Resolution recovery',body:'base'});
  const first=await fetchEvents(server,actor,scope,replica.deviceId,undefined,100,feedDir);await replica.installRemote(first.events,first.cursor,first.epoch,scope.workspaceId);
  const local=await replica.vault.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'preserved candidate'});await server.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'server head'});
  const page=await fetchEvents(server,actor,scope,replica.deviceId,await replica.cursorFor(scope.workspaceId),100,feedDir);await replica.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);
  const conflict=replica.conflicts.find(item=>item.state==='open')!;const resolved=await replica.resolveConflict(base.id,conflict.localRevisionId,'Resolution recovery','server head plus candidate');
  await fs.rm(path.join(replica.state,'pending.jsonl'),{force:true});const reopened=await ReplicaStore.replicaInit('client','http://localhost',path.join(root,'clients'));assert.ok(reopened.pendingBatch().some(op=>op.revisionId===resolved.revisionId));
});

test('discard takes the pulled server version and retains immutable candidate history',async t=>{
  const {root,server,actor,scope,replica,feedDir}=await setup(t),base=await server.put({scope,kind:'note',title:'Discard candidate',body:'base'});
  const first=await fetchEvents(server,actor,scope,replica.deviceId,undefined,100,feedDir);await replica.installRemote(first.events,first.cursor,first.epoch,scope.workspaceId);
  const local=await replica.vault.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'discarded candidate'});await server.patch({objectId:base.id,expectedRevisionId:base.revisionId,body:'server head'});
  const page=await fetchEvents(server,actor,scope,replica.deviceId,await replica.cursorFor(scope.workspaceId),100,feedDir);await replica.installRemote(page.events,page.cursor,page.epoch,scope.workspaceId);
  await replica.discardCandidate(base.id);assert.equal(replica.conflicts.find(item=>item.objectId===base.id)?.state,'discarded');assert.equal((await replica.vault.get(base.id)).body,'server head');assert.ok(await fs.readFile(path.join(replica.root,'vault','.mdb','objects',base.id,'revs',`${local.revisionId}.md`)));
});

test('one un-installable event is durably deferred while later objects install; retries stop after three attempts',async t=>{
  const {server,actor,scope,replica,feedDir}=await setup(t),bad=await server.put({scope,kind:'note',title:'Bad parent',body:'defer'}),good=await server.put({scope,kind:'note',title:'Good peer',body:'install'});
  const page=await fetchEvents(server,actor,scope,replica.deviceId,undefined,100,feedDir),events=page.events.map((item,index)=>index===0?{...item,event:{...item.event,previousRevisionId:'missing-parent'}}:item);
  // Rechain the synthetic invalid-parent record while preserving the later event payloads.
  let chain='0'.repeat(64);for(const item of events){item.prevHash=chain;item.eventHash=sha256(`${chain}\n${canonicalJson(item.event)}\n${sha256(item.revisionBytes)}`);chain=item.eventHash;}
  const installed=await replica.installRemote(events,page.cursor,page.epoch,scope.workspaceId);assert.equal(installed.deferred,1);assert.equal(installed.errors[0]?.objectId,bad.id);assert.equal((await replica.vault.get(good.id)).body,'install');assert.equal(replica.status().deferred,1);
  for(let i=0;i<4;i++)await replica.retryDeferred();assert.equal(replica.status().deferred,1);const rows=(await fs.readFile(path.join(replica.state,'deferred.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {attempts:number});assert.equal(rows[0]?.attempts,3);
});
