import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { Vault } from '../packages/core/vault.js';
import { OWNER } from '../packages/core/types.js';
import { SearchEngine } from '../packages/search-files/index.js';

const realUrl=process.env.MDB_TEST_POSTGRES_URL;
const pgvectorEnabled=!!realUrl&&process.env.MDB_TEST_PGVECTOR==='1';

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
  await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Quasar storage',body:'Rareword persistence in markdown.',tags:['indexed'],metadata:{phase:'agent-c'}});
  await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Frequent storage',body:'Rareword persistence and rareword durability and rareword recovery.',tags:['indexed']});
  const removed=await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Deleted storage',body:'Rareword removed revision.'});await vault.delete(removed.id,removed.revisionId);
  await vault.put({scope:{type:'workspace',workspaceId:'private'},kind:'note',title:'Hidden quasar',body:'Rareword private material.'});
  await vault.setConfig(config=>{config.postgres={enabled:true};});
  const search=new SearchEngine(vault,{env:{MDB_POSTGRES_URL:realUrl}});const reader=new SearchEngine(new Vault(root,{actorId:'reader',permissions:['global:shared:read']}),{env:{MDB_POSTGRES_URL:realUrl}});t.after(async()=>{await reader.close();await search.close();});
  await search.rebuild();const result=await reader.query({query:'rareword',mode:'keyword',tags:['indexed'],kinds:['note']});
  assert.equal(result.backend,'postgres');assert.deepEqual(result.hits.map(h=>h.title),['Frequent storage','Quasar storage']);
  assert.equal((await reader.query({query:'rareword',mode:'keyword',until:'2000-01-01T00:00:00.000Z'})).hits.length,0);
  const metadataPool=new Pool({connectionString:realUrl});t.after(()=>metadataPool.end());
  assert.equal((await metadataPool.query("SELECT indexname FROM pg_indexes WHERE indexname='engram_documents_metadata_idx'")).rows.length,1);
  const current=(await vault.listDocuments()).find(d=>d.title==='Quasar storage')!;
  await vault.patch({objectId:current.id,expectedRevisionId:current.revisionId,body:'A revised document without the search term.'});
  await search.sync();assert.deepEqual((await reader.query({query:'rareword',mode:'keyword'})).hits.map(h=>h.title),['Frequent storage']);
  await search.rebuild();assert.deepEqual((await reader.query({query:'rareword',mode:'keyword'})).hits.map(h=>h.title),['Frequent storage']);
  assert.equal((await reader.query({query:'private',mode:'keyword'})).hits.length,0);
});

test('PostgreSQL pgvector semantic and hybrid retrieval use indexed revisions and deterministic embeddings',{skip:!pgvectorEnabled},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'engram-pgvector-integration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=new Vault(root);await vault.init({sqlite:false});
  await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Quasar guide',body:'Astronomy reference.'});
  await vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Needle guide',body:'Needle evidence for keyword and vector fusion.'});
  await vault.setConfig(config=>{config.postgres={enabled:true};});
  const embedder={modelId:'engram-live-test-3d',dimensions:3,locality:'local' as const,async embed(texts:string[]){return texts.map(text=>/needle/i.test(text)?[1,0,0]:/quasar/i.test(text)?[0,1,0]:[0,0,1]);}};
  const search=new SearchEngine(vault,{embedder,env:{MDB_POSTGRES_URL:realUrl}});t.after(()=>search.close());
  await search.rebuild();await search.embedSync();
  const semantic=await search.query({query:'needle',mode:'semantic'});assert.equal(semantic.hits[0]?.title,'Needle guide');
  const hybrid=await search.query({query:'needle',mode:'hybrid'});const fused=hybrid.hits.find(hit=>hit.title==='Needle guide');
  assert.equal(fused?.retrievalMode,'hybrid');assert.deepEqual(new Set(fused?.sources),new Set(['keyword','semantic']));
});
