import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '../packages/storage-s3/index.js';
import { OWNER, type CommitEvent } from '../packages/core/types.js';
import { Vault } from '../packages/core/vault.js';

class MemoryS3 {
  objects = new Map<string, Uint8Array>();
  async send(command: unknown): Promise<unknown> {
    const c=command as {input:Record<string,unknown>}, key=String(c.input.Key), fail=()=>Object.assign(new Error('precondition'),{$metadata:{httpStatusCode:412}}), etag=(b:Uint8Array)=>'"'+createHash('sha256').update(b).digest('hex')+'"';
    if(command instanceof GetObjectCommand){const body=this.objects.get(key);if(!body)throw Object.assign(new Error('missing'),{$metadata:{httpStatusCode:404}});return{Body:{transformToByteArray:async()=>body}};}
    if(command instanceof HeadObjectCommand){const body=this.objects.get(key);if(!body)throw Object.assign(new Error('missing'),{$metadata:{httpStatusCode:404}});return{ETag:etag(body),ContentLength:body.length};}
    if(command instanceof PutObjectCommand){const old=this.objects.get(key);if(c.input.IfNoneMatch==='*'&&old)throw fail();if(typeof c.input.IfMatch==='string'&&(!old||etag(old)!==c.input.IfMatch))throw fail();const body=typeof c.input.Body==='string'?Buffer.from(c.input.Body):Buffer.from(c.input.Body as Uint8Array);this.objects.set(key,body);return{};}
    if(command instanceof ListObjectsV2Command){const prefix=String(c.input.Prefix);return{Contents:[...this.objects].filter(([k])=>k.startsWith(prefix)).map(([Key,b])=>({Key,Size:b.length})),IsTruncated:false};}
    if(command instanceof DeleteObjectCommand){this.objects.delete(key);return{};}
    throw new Error('unexpected S3 command');
  }
}
const event=(sequence:number,objectId:string):CommitEvent=>({sequence,transactionId:`tx${sequence}`,objectId,revisionId:`rev${sequence}`,path:`notes/${objectId}.md`,scope:{type:'global',area:'shared'},operation:'put',timestamp:'2026-01-01T00:00:00.000Z'});

test('S3 journal publishes a conditional immutable chain and reads only committed records',async()=>{
  const mock=new MemoryS3(),store=new S3ObjectStore('bucket',{client:mock as unknown as S3Client,prefix:'tenant'});
  await store.initializeJournal();const first=await store.appendCommittedEvent(event(1,'one'));const second=await store.appendCommittedEvent(event(2,'two'));
  assert.equal(first.sequence,1);assert.equal(second.sequence,2);assert.deepEqual(await store.readCommittedJournal(),[first,second]);
  await store.putImmutable('.mdb/objects/one/revs/rev1.md',Buffer.from('original'));
  await assert.rejects(()=>store.putImmutable('.mdb/objects/one/revs/rev1.md',Buffer.from('different')),{code:'CONFLICT'});
  assert.equal(await store.compareAndSwapPointer('.mdb/events/_commit-head.json','stale','{}'),false);
});

test('S3 journal rewrite atomically removes superseded history records for purge',async()=>{
  const mock=new MemoryS3(),store=new S3ObjectStore('bucket',{client:mock as unknown as S3Client});await store.initializeJournal();
  const a=await store.appendCommittedEvent(event(1,'one')),b=await store.appendCommittedEvent(event(2,'two'));
  await store.rewriteCommittedJournal([{...a,path:'purged'},b]);
  assert.deepEqual((await store.readCommittedJournal()).map(x=>x.path),['purged',b.path]);
  const keys=[...mock.objects.keys()].filter(k=>k.includes('/records/'));assert.equal(keys.length,2);assert(keys.some(k=>k.includes('/rewritten/')));
});

test('S3 readMany preserves key order and rejects unbounded concurrency settings',async()=>{
  const store=new S3ObjectStore('bucket',{client:new MemoryS3() as unknown as S3Client});
  await store.putImmutable('batch/a.md',Buffer.from('a'));await store.putImmutable('batch/b.md',Buffer.from('b'));
  assert.deepEqual((await store.readMany(['batch/b.md','batch/a.md'],2)).map(bytes=>Buffer.from(bytes).toString()),['b','a']);
  await assert.rejects(()=>store.readMany([],33),{code:'INVALID_INPUT'});
});

const liveEndpoint=process.env.MDB_TEST_S3_ENDPOINT;
const liveEnabled=!!liveEndpoint&&process.env.MDB_TEST_S3_CONFIRM==='disposable';
function liveClient():S3Client {
  return new S3Client({region:process.env.MDB_TEST_S3_REGION??'us-east-1',endpoint:liveEndpoint,forcePathStyle:true,
    credentials:{accessKeyId:process.env.MDB_TEST_S3_ACCESS_KEY??'minioadmin',secretAccessKey:process.env.MDB_TEST_S3_SECRET_KEY??'minioadmin'}});
}
function liveStore(bucket:string,prefix:string):S3ObjectStore {
  return new S3ObjectStore(bucket,{region:process.env.MDB_TEST_S3_REGION??'us-east-1',endpoint:liveEndpoint,forcePathStyle:true,
    credentials:{accessKeyId:process.env.MDB_TEST_S3_ACCESS_KEY??'minioadmin',secretAccessKey:process.env.MDB_TEST_S3_SECRET_KEY??'minioadmin'},prefix});
}
async function disposableBucket(t:TestContext,client:S3Client):Promise<string>{
  const bucket=`engram-live-${randomUUID().slice(0,12)}`;
  await client.send(new CreateBucketCommand({Bucket:bucket}));
  t.after(async()=>{try{let token:string|undefined;do{const page=await client.send(new ListObjectsV2Command({Bucket:bucket,ContinuationToken:token}));for(const object of page.Contents??[])if(object.Key)await client.send(new DeleteObjectCommand({Bucket:bucket,Key:object.Key}));token=page.IsTruncated?page.NextContinuationToken:undefined;}while(token);await client.send(new DeleteBucketCommand({Bucket:bucket}));}finally{client.destroy();}});
  return bucket;
}
test('live S3: independent writers serialize journal commits and one stale revision update conflicts',{skip:!liveEnabled},async t=>{
  const client=liveClient(),bucket=await disposableBucket(t,client),prefix=`engram/${randomUUID()}`;
  const oneRoot=await mkdtemp(path.join(tmpdir(),'engram-s3-writer-one-')),twoRoot=await mkdtemp(path.join(tmpdir(),'engram-s3-writer-two-'));
  const one=liveStore(bucket,prefix),two=liveStore(bucket,prefix),a=new Vault(oneRoot,OWNER,{store:one}),b=new Vault(twoRoot,OWNER,{store:two});
  t.after(async()=>{await Promise.all([a.close(),b.close()]);await Promise.all([rm(oneRoot,{recursive:true,force:true}),rm(twoRoot,{recursive:true,force:true})]);});
  await a.init();await b.init();
  const created=await a.put({scope:{type:'global',area:'shared'},kind:'note',title:'Concurrent S3',body:'initial'});
  const [left,right]=await Promise.all([a.get(created.id),b.get(created.id)]);
  const updates=await Promise.allSettled([
    a.patch({objectId:created.id,expectedRevisionId:left.revisionId,body:'writer one'}),
    b.patch({objectId:created.id,expectedRevisionId:right.revisionId,body:'writer two'}),
  ]);
  assert.equal(updates.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(updates.filter(result=>result.status==='rejected'&&(result.reason as {code?:string}).code==='CONFLICT').length,1);
  assert.deepEqual((await a.events()).map(item=>item.sequence),[1,2]);
});

test('live S3: lost immutable-upload response leaves an orphan; lost head response is idempotently recovered',{skip:!liveEnabled},async t=>{
  const client=liveClient(),bucket=await disposableBucket(t,client),prefix=`engram/${randomUUID()}`;
  const root=await mkdtemp(path.join(tmpdir(),'engram-s3-ambiguous-')),store=liveStore(bucket,prefix),vault=new Vault(root,OWNER,{store});
  t.after(async()=>{await vault.close();await rm(root,{recursive:true,force:true});});await vault.init();
  let loseRevision=true;const raw=store.client.send.bind(store.client),typed=store.client as unknown as {send:(command:unknown)=>Promise<unknown>};
  typed.send=async command=>{const response=await raw(command as never);if(loseRevision&&command instanceof PutObjectCommand&&String((command as {input:{Key?:string}}).input.Key).includes('/.mdb/objects/')){loseRevision=false;throw new Error('Injected lost revision response');}return response;};
  await assert.rejects(()=>vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Orphan upload',body:'retry'}),/lost revision response/);
  assert.equal((await vault.events()).length,0);assert.equal((await vault.recover()).orphans,1);
  let loseHead=true;typed.send=async command=>{const response=await raw(command as never);const key=command instanceof PutObjectCommand?String((command as {input:{Key?:string}}).input.Key):'';if(loseHead&&key.endsWith('/.mdb/events/_commit-head.json')){loseHead=false;throw new Error('Injected lost head response');}return response;};
  const input={scope:{type:'global',area:'shared'} as const,kind:'note',title:'Ambiguous commit',body:'committed once',idempotencyKey:'live-lost-head-response'};
  await assert.rejects(()=>vault.put(input),/lost head response/);
  const recovered=await vault.recover();assert.equal(recovered.committed,1);assert.equal(recovered.repaired,1);
  const retried=await vault.put(input);assert.equal(retried.title,input.title);
  assert.equal((await vault.events()).filter(item=>item.idempotencyKey===input.idempotencyKey).length,1);
});

test('live S3: an uploaded journal record stays invisible until head publication and retry commits once',{skip:!liveEnabled},async t=>{
  const client=liveClient(),bucket=await disposableBucket(t,client),prefix=`engram/${randomUUID()}`;
  const root=await mkdtemp(path.join(tmpdir(),'engram-s3-partial-journal-')),store=liveStore(bucket,prefix),vault=new Vault(root,OWNER,{store});
  t.after(async()=>{await vault.close();await rm(root,{recursive:true,force:true});});await vault.init();
  const sender=store.client.send.bind(store.client),typed=store.client as unknown as {send:(command:unknown)=>Promise<unknown>};let loseRecord=true;
  typed.send=async command=>{const response=await sender(command as never),key=command instanceof PutObjectCommand?String((command as {input:{Key?:string}}).input.Key):'';if(loseRecord&&key.includes('/.mdb/events/records/')){loseRecord=false;throw new Error('Injected lost journal-record response');}return response;};
  const input={scope:{type:'global',area:'shared'} as const,kind:'note',title:'Partial journal',body:'head is commit point',idempotencyKey:'live-partial-journal-record'};
  await assert.rejects(()=>vault.put(input),/lost journal-record response/);assert.equal((await vault.events()).length,0);
  const committed=await vault.put(input);assert.equal(committed.title,input.title);
  assert.equal((await vault.events()).filter(item=>item.idempotencyKey===input.idempotencyKey).length,1);
});

test('live S3: interrupted revision request before PutObject creates no visible partial object',{skip:!liveEnabled},async t=>{
  const client=liveClient(),bucket=await disposableBucket(t,client),prefix=`engram/${randomUUID()}`;
  const root=await mkdtemp(path.join(tmpdir(),'engram-s3-interrupted-')),store=liveStore(bucket,prefix),vault=new Vault(root,OWNER,{store});
  t.after(async()=>{await vault.close();await rm(root,{recursive:true,force:true});});await vault.init();
  const sender=store.client.send.bind(store.client),typed=store.client as unknown as {send:(command:unknown)=>Promise<unknown>};let interrupted=false;
  typed.send=async command=>{if(!interrupted&&command instanceof PutObjectCommand&&String((command as {input:{Key?:string}}).input.Key).includes('/.mdb/objects/')){interrupted=true;throw new Error('Injected connection loss before revision request');}return sender(command as never);};
  await assert.rejects(()=>vault.put({scope:{type:'global',area:'shared'},kind:'note',title:'Interrupted upload',body:'not committed'}),/before revision request/);
  assert.equal((await vault.events()).length,0);
  const remaining=[];for await(const item of store.list('.mdb/objects'))remaining.push(item);assert.deepEqual(remaining,[]);
});
