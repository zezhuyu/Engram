import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enrollReplicaDevice, listReplicaDevices, writeReplicaDeviceRegistry } from '../../packages/replication/devices.js';

test('device registry is private, persistent, pruned, bounded, and survives an interrupted atomic replacement', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'engram-replica-devices-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const device=await enrollReplicaDevice(root,'cred_00000000000000000000','agent','00000000-0000-4000-8000-000000000001','Laptop','workspace-a','v1',Date.now());
  const file=path.join(root,'.mdb','replication-devices.json');assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);assert.equal((await listReplicaDevices(root)).length,1);
  await assert.rejects(writeReplicaDeviceRegistry(root,[{...device,label:'corrupt'}],point=>{if(point==='atomic.before_rename')throw new Error('simulated registry crash')}),/simulated registry crash/);
  assert.equal((await listReplicaDevices(root))[0]?.label,'Laptop');assert.equal((await readdir(path.dirname(file))).some(name=>name.endsWith('.tmp')),false);
  assert.equal((await listReplicaDevices(root,Date.now()+91*24*60*60_000)).length,0);
  for(let i=0;i<50;i++)await enrollReplicaDevice(root,'cred_aaaaaaaaaaaaaaaaaaaa','actor',`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,'Device','workspace-a','v1');
  await assert.rejects(enrollReplicaDevice(root,'cred_aaaaaaaaaaaaaaaaaaaa','actor','00000000-0000-4000-8000-000000000051','Device','workspace-a','v1'),/device limit/);
});
