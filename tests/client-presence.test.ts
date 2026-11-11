import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listClientPresence, writeClientHeartbeat, validateClientHeartbeat, ClientPresenceError, deleteCredentialPresence, deriveClientPresenceState } from '../packages/mcp/client-presence.js';
import { atomicWrite } from '../packages/storage-local/index.js';

const heartbeat = (clientId = '00000000-0000-4000-8000-000000000001') => ({ schemaVersion:1, clientId, displayName:'Studio Air', hostLabel:'macOS device', appVersion:'1.0.0', mode:'cached', lastSync:{serverContactAt:null,outboxDeliveredAt:null,fileSyncCommittedAt:null,contextFetchedAt:null}, queues:{outbox:0,fileSync:1,capture:0,queuedBytes:12}, projects:[{folderName:'Engram',workspaceId:'proj',contextFetchedAt:null,contextStale:true,fileSyncState:'queued',queuedWrites:1,conflicts:0}] });
test('heartbeat schema rejects unknown fields, path names, bad types, future timestamps, and oversized project lists', () => {
  assert.equal(validateClientHeartbeat(heartbeat()).clientId, '00000000-0000-4000-8000-000000000001');
  for (const input of [ { ...heartbeat(), actorId:'owner' }, { ...heartbeat(), displayName:'<img>' }, { ...heartbeat(), projects:[{...heartbeat().projects[0],folderName:'../secret'}] }, { ...heartbeat(), projects:Array(101).fill(heartbeat().projects[0]) }, { ...heartbeat(), queues:{outbox:-1,fileSync:0,capture:0,queuedBytes:0} }, { ...heartbeat(), lastSync:{...heartbeat().lastSync,serverContactAt:new Date(Date.now()+10*60_000).toISOString()} } ]) assert.throws(() => validateClientHeartbeat(input), ClientPresenceError);
});
test('heartbeat accepts bounded replica status and rejects oversized or malformed replica summaries', () => {
  const replication = { enrolledWorkspaces:[{workspaceId:'proj',pendingPush:3,diverged:1,deferred:0,lastPullAt:'2026-11-10T12:00:00.000Z',lastPushAt:null}],state:'conflict',epochState:'current',profileSnapshotAt:null };
  assert.deepEqual(validateClientHeartbeat({...heartbeat(),replication}).replication,replication);
  for (const value of [
    {...replication,enrolledWorkspaces:Array(21).fill(replication.enrolledWorkspaces[0])},
    {...replication,enrolledWorkspaces:[{...replication.enrolledWorkspaces[0],workspaceId:'../secret'}]},
    {...replication,enrolledWorkspaces:[{...replication.enrolledWorkspaces[0],pendingPush:-1}]},
    {...replication,state:'arbitrary'},
    {...replication,extra:'ignored?'}
  ]) assert.throws(()=>validateClientHeartbeat({...heartbeat(),replication:value}),ClientPresenceError);
  assert.equal(validateClientHeartbeat(heartbeat()).replication,undefined);
});
test('presence state uses server receipt time with a strict two minute connected boundary', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  assert.deepEqual(deriveClientPresenceState('2026-11-10T11:58:00.001Z',now),{state:'Connected',stale:false});
  assert.deepEqual(deriveClientPresenceState('2026-11-10T11:58:00.000Z',now),{state:'Last seen',stale:true});
});
test('presence persists atomically, prunes TTL, replaces latest, rate limits by credential/client, and deletes by credential', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'engram-presence-')); t.after(() => rm(root,{recursive:true,force:true}));
  const body = heartbeat(), start = Date.now();
  const first = await writeClientHeartbeat(root,'cred_a','agent-a',body,'127.0.0.0/24',start);
  assert.equal(first.serverReceivedAt,new Date(start).toISOString());
  const file = path.join(root,'.mdb/client-presence.json'); assert.equal((await stat(file)).mode & 0o777,0o600);
  const second = await writeClientHeartbeat(root,'cred_a','agent-a',body,'127.0.0.0/24',start+1000);
  await writeFile(file+'.interrupted.tmp','{ partial');
  await assert.rejects(atomicWrite(root,'.mdb/client-presence.json','{ partial',(point)=>{if(point==='atomic.before_rename')throw new Error('simulated process crash')}),/simulated process crash/);
  assert.equal((await listClientPresence(root,start+2000)).length,1); assert.equal((await listClientPresence(root,start+2000))[0]?.serverReceivedAt,second.serverReceivedAt);
  await assert.rejects(writeClientHeartbeat(root,'cred_a','agent-a',body,'127.0.0.0/24',start+2000), {status:429});
  await assert.rejects(writeClientHeartbeat(root,'cred_a','agent-a',body,'127.0.0.0/24',start+3000), {status:429});
  assert.equal((await listClientPresence(root,start+7*24*60*60_000+1000)).length,0);
  await writeClientHeartbeat(root,'cred_a','agent-a',body,'127.0.0.0/24',start+8*24*60*60_000);
  await writeClientHeartbeat(root,'cred_b','agent-b',heartbeat('00000000-0000-4000-8000-000000000002'),'127.0.0.0/24',start+8*24*60*60_000);
  await deleteCredentialPresence(root,'cred_a'); assert.deepEqual((await listClientPresence(root,start+8*24*60*60_000)).map(row=>row.credentialId),['cred_b']);
  assert.match(await readFile(file,'utf8'),/"version":1/);
});
