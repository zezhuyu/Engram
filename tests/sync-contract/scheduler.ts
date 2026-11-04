import { runEvents, type RunResult, type SyncEvent } from './oracle.js';
import { checkState } from './invariants.js';

export const CLIENT_BOUNDARIES = ['B1','B2','B3','B4','B5','B6','B7'] as const;
export const SERVER_BOUNDARIES = ['S1','S2','S3','S4','S5','S6'] as const;
export class SeededRandom {
  private value: number;
  constructor(seed: number) { this.value = seed >>> 0 || 0x9e3779b9; }
  next(): number { let x=this.value; x^=x<<13; x^=x>>>17; x^=x<<5; this.value=x>>>0; return this.value; }
  int(max: number): number { return this.next() % max; }
  bool(): boolean { return (this.next() & 1) === 1; }
}
export function schedule(seed: number, eventCount = 20): SyncEvent[] {
  const rng=new SeededRandom(seed), events:SyncEvent[]=[];
  const devices=['d1','d2'], actors=['alice','bob'], objects=['o1','o2','o3'];
  for(let i=0;i<eventCount;i++){
    const n=rng.int(12), device=devices[rng.int(devices.length)]!, actor='alice', objectId=objects[rng.int(objects.length)]!;
    switch(n){
      case 0: case 1: case 2: events.push({type:'localWrite',device,actor,objectId,content:`${seed}:${i}:${rng.next()}`,kind:(['note','task','wiki'] as const)[rng.int(3)]});break;
      case 3: events.push({type:'localDelete',device,actor,objectId});break;
      case 4: events.push({type:'restore',device,actor,objectId,content:`restore:${seed}:${i}`});break;
      case 5: events.push({type:'deliver',device,direction:'push',drop:rng.bool(),duplicate:rng.bool()});break;
      case 6: events.push({type:'deliver',device,direction:'pull',reorder:rng.bool()});break;
      case 7: events.push({type:rng.bool()?'partition':'heal',device});break;
      case 8: events.push({type:'crash',target:rng.bool()?device:'server',boundary:rng.bool()?CLIENT_BOUNDARIES[rng.int(7)]!:SERVER_BOUNDARIES[rng.int(6)]!});break;
      case 9: events.push({type:rng.bool()?'grant':'revoke',actor,scope:rng.bool()?'*':objectId});break;
      case 10: events.push({type:'restoreBackup'});break;
      default: events.push({type:'purge',objectId});
    }
  }
  for(const device of devices){events.push({type:'heal',device},{type:'deliver',device,direction:'pull'},{type:'deliver',device,direction:'push'},{type:'deliver',device,direction:'pull'});}
  for(const device of devices)events.push({type:'deliver',device,direction:'pull'});
  return events;
}
export function runSeed(seed:number,eventCount=20):RunResult{
  const events=schedule(seed,eventCount);
  return runEvents(seed,events,undefined,(state,index)=>{
    const violations=checkState(state);
    if(violations.length)throw new Error(`seed ${seed} event ${index} failed ${violations.map(v=>`${v.id}:${v.message}`).join('; ')}; replay with: SYNC_CONTRACT_SEED=${seed} npm run test:sync-contract`);
  });
}
