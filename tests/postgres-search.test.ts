import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault } from '../packages/core/vault.js';
import { OWNER } from '../packages/core/types.js';
import { SearchEngine } from '../packages/search-files/index.js';

const realUrl=process.env.MDB_TEST_POSTGRES_URL;

test('PostgreSQL selection degrades to canonical Markdown when the optional service is absent',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'engram-pg-fallback-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=new Vault(root);await vault.init({sqlite:false});await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Storage',body:'Durability relies on immutable revisions.'});
  await vault.setConfig(config=>{config.postgres={enabled:true};});
  const search=new SearchEngine(vault,{env:{}});const result=await search.query({query:'immutable',mode:'keyword'});
  assert.equal(result.hits.length,1);assert.equal(result.hits[0]?.title,'Storage');assert.equal(result.backend,'filesystem');assert.ok(result.fallback?.includes('PostgreSQL unavailable'));
});

test('PostgreSQL FTS indexes committed revisions and filters ACLs before returning hits',{skip:!realUrl},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'engram-pg-integration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=new Vault(root);await vault.init({sqlite:false});await vault.createWorkspace('private', '', {});
  await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Quasar storage',body:'Rareword persistence in markdown.'});
  await vault.put({scope:{type:'workspace',workspaceId:'private'},kind:'note',title:'Hidden quasar',body:'Rareword private material.'});
  await vault.setConfig(config=>{config.postgres={enabled:true};});
  const search=new SearchEngine(vault,{env:{MDB_POSTGRES_URL:realUrl}});const reader=new SearchEngine(new Vault(root,{actorId:'reader',permissions:['global:shared:read']}),{env:{MDB_POSTGRES_URL:realUrl}});t.after(async()=>{await reader.close();await search.close();});
  await search.rebuild();const result=await reader.query({query:'rareword',mode:'keyword'});
  assert.equal(result.backend,'postgres');assert.deepEqual(result.hits.map(h=>h.title),['Quasar storage']);
  const current=(await vault.listDocuments()).find(d=>d.title==='Quasar storage')!;
  await vault.patch({objectId:current.id,expectedRevisionId:current.revisionId,body:'A revised document without the search term.'});
  await search.sync();assert.equal((await reader.query({query:'rareword',mode:'keyword'})).hits.length,0);
});
