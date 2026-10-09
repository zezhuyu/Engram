import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '../packages/storage-s3/index.js';
import type { CommitEvent } from '../packages/core/types.js';

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
