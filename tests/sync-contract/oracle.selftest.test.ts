import test from 'node:test';
import assert from 'node:assert/strict';
import { historyHash, runEvents, stateHash, type SyncEvent } from './oracle.js';
import { minimize } from './minimizer.js';
import { schedule, runSeed } from './scheduler.js';
import { checkState } from './invariants.js';

test('seeded schedules and history hashes replay byte-identically',()=>{
  for(const seed of [0,1,0x12345678,0xffffffff]){
    const a=runSeed(seed,24),b=runSeed(seed,24);
    assert.deepEqual(a.events,b.events);assert.deepEqual(a.history,b.history);assert.equal(historyHash(a),historyHash(b));
  }
});
test('scheduler emits supported faults and all crash boundaries',()=>{
  const events=schedule(71,100);
  const boundaries=new Set(events.filter((event):event is Extract<SyncEvent,{type:'crash'}>=>event.type==='crash').map(event=>event.boundary));
  assert.ok(boundaries.size>0);assert.ok(events.some(event=>event.type==='partition'));assert.ok(events.some(event=>event.type==='restoreBackup'));
});
test('minimizer returns a 1-minimal failing event sequence',()=>{
  const input=[1,2,3,4,5,6];const result=minimize(input,candidate=>candidate.includes(3)&&candidate.includes(5));
  assert.deepEqual(result,[3,5]);
});
test('accepted operations produce immutable revisions and duplicate retries are idempotent',()=>{
  const events:SyncEvent[]=[{type:'localWrite',device:'d1',actor:'alice',objectId:'a',content:'first',opId:'same'},{type:'deliver',device:'d1',direction:'push'},{type:'deliver',device:'d1',direction:'push'}];
  const run=runEvents(1,events);assert.equal(run.state.journal.filter(id=>id==='d1:same').length,1);assert.equal(Object.keys(run.state.revisions).length,1);assert.deepEqual(checkState(run.state),[]);
});
test('operation result identity is device-scoped and delete creates a tombstone revision',()=>{
  const events:SyncEvent[]=[
    {type:'localWrite',device:'d1',actor:'alice',objectId:'a',content:'one',opId:'shared'},
    {type:'localWrite',device:'d2',actor:'alice',objectId:'b',content:'two',opId:'shared'},
    {type:'deliver',device:'d1',direction:'push'},{type:'deliver',device:'d2',direction:'push'},
    {type:'localDelete',device:'d1',actor:'alice',objectId:'a',opId:'delete-a'},
    {type:'deliver',device:'d1',direction:'push'},
  ];
  const run=runEvents(2,events);
  assert.equal(run.state.journal.filter(id=>id==='d1:shared').length,1);
  assert.equal(run.state.journal.filter(id=>id==='d2:shared').length,1);
  assert.equal(run.state.revisions[run.state.serverHeads.a!]!.deleted,true);
  assert.deepEqual(checkState(run.state),[]);
});
test('deterministic model convergence campaign: 10,000 seeds', {timeout:60_000},()=>{
  const start=performance.now();let historyEntries=0,checked=0;const first=10000,last=19999;
  for(let seed=first;seed<=last;seed++){
    const run=runSeed(seed,8);historyEntries+=run.history.length;
    const violations=checkState(run.state,true);
    assert.equal(violations.length,0,`seed ${seed} failed; replay with: SYNC_CONTRACT_SEED=${seed} npm run test:sync-contract`);checked++;
  }
  const elapsed=performance.now()-start;
  console.log(`sync-contract convergence seeds ${first}-${last}: ${checked} runs, ${historyEntries} events, ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed<60_000,`10k seeds took ${elapsed.toFixed(1)} ms`);
});
test('representative model state hash is stable',()=>{
  const run=runEvents(42,[{type:'localWrite',device:'d1',actor:'alice',objectId:'a',content:'stable'},{type:'deliver',device:'d1',direction:'push'}]);
  assert.equal(stateHash(run.state),stateHash(runEvents(42,run.events).state));
});
