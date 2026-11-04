import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleSystem, NotImplementedSystem, type ISyncSystem } from './adapter.js';
import { catalogue } from './scenarios/index.js';
import { checkState } from './invariants.js';

const scenarios=catalogue();
test('catalogue has stable RC-01..RC-26 coverage',()=>{
  assert.equal(scenarios.length,26);
  assert.deepEqual(scenarios.map(s=>s.id),Array.from({length:26},(_,i)=>`RC-${String(i+1).padStart(2,'0')}`));
});
for(const scenario of scenarios){
  test(`oracle ${scenario.id}: ${scenario.title}`,()=>{
    const system:ISyncSystem=new OracleSystem();const result=system.run(scenario.events);
    assert.equal(result.events.length,scenario.events.length);
    assert.deepEqual(checkState(result.state),[],`${scenario.id} oracle invariant failure`);
  });
  test.todo(`real system ${scenario.id}: ${scenario.title}`);
}
test('real-system adapter clearly reports pending ADR implementation',()=>{
  assert.throws(()=>new NotImplementedSystem().snapshot(),/not implemented/);
});
