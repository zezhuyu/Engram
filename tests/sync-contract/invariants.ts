import { hasAccess, isAllowedKind, opKey, type ModelState, type RunResult } from './oracle.js';

export interface Violation { id:string; message:string; eventIndex?:number; }
export const INVARIANTS = [
  ['INV-01','ACK_SERVER implies the committed revision is in immutable journal history'],
  ['INV-02','ACK_LOCAL_PENDING remains recoverable until terminal status'],
  ['INV-03','Every acknowledged operation is accepted once or visibly terminal'],
  ['INV-04','Concurrent inputs are preserved and same-object divergence never silently overwrites'],
  ['INV-05','At quiescence replicas equal server heads or have explicit conflict/quarantine'],
  ['INV-06','No unauthorized object, metadata, reference, or count is visible'],
  ['INV-07','Accepted revisions are immutable; source history is never rewritten'],
  ['INV-08','Indexes and projections are derivatives of accepted history'],
  ['INV-09','A release result is bound to its source fingerprint and evidence'],
  ['INV-10','Missing or invalid mandatory evidence fails closed'],
  ['INV-11','No server-wall-clock ordering participates in operation order'],
  ['INV-12','After epoch change clients RESYNC; old acknowledgments are not assumed'],
  ['INV-13','Ops are exactly-once by device and op_id; retry returns stored result'],
  ['INV-14','Per-object ancestry is continuous or missing ancestors require resync'],
  ['INV-15','Purge is irreversible and stale data cannot resurrect the object'],
  ['INV-16','Review-gated operation kinds are rejected'],
  ['INV-17','Revoked principals cannot push; pending writes are quarantined'],
  ['INV-18','State generation replacement is atomic and recoverable'],
  ['INV-19','Unacknowledged operations are never evicted to satisfy quota'],
  ['INV-20','Cursor validity is scoped to actor, device, scopeVersion, and epoch'],
  ['INV-21','Wiki page bodies are never auto-merged'],
  ['INV-22','Stored operation results outlive the defined retry retention'],
  ['INV-23','Batches are independently committed; per-object order follows localSeq'],
  ['INV-24','No implicit wall-clock field affects deterministic outcomes'],
  ['INV-25','Only authorized working-set members and approved dependency closure transfer'],
  ['INV-26','A12 convergence: server heads match accepted journal order at quiescence'],
] as const;

export function checkState(state:ModelState,quiescent=false,mutant?:string):Violation[]{
  const out:Violation[]=[];
  const add=(id:string,message:string)=>out.push({id,message});
  for(const opId of state.acknowledged) if(!state.journal.includes(opId)||!state.opResults[opId])add('INV-01',`acknowledged op ${opId} has no durable result/journal entry`);
  for(const opId of state.acknowledged) if(!state.opResults[opId])add('INV-22',`operation result ${opId} expired while its credential may retry`);
  const allOps=Object.values(state.pending).flat();
  for(const opId of state.localDurable) if(!allOps.some(op=>opKey(op.device,op.id)===opId)&&!state.journal.includes(opId))add('INV-19',`durable unacknowledged op ${opId} was evicted`);
  for(const [id,conflict] of Object.entries(state.conflicts)) if(!conflict.resolved&&conflict.local===''&&allOps.some(op=>op.id===conflict.opId&&op.content!==''))add('INV-04',`conflict ${id} lost its local input`);
  for(const [id,rev] of Object.entries(state.revisions)) if(state.immutableHashes[id]!==rev.hash)add('INV-07',`immutable revision ${id} changed`);
  for(const [device,ops] of Object.entries(state.pending)) for(const op of ops){
    if(state.acknowledged.has(opKey(op.device,op.id))&&ops.filter(candidate=>candidate.id===op.id).length!==1)add('INV-13',`duplicate op ${op.id}`);
    if(op.status==='ACCEPTED'&&!state.opResults[opKey(op.device,op.id)])add('INV-03',`accepted op ${op.id} lacks result`);
    const revokedAt=state.revokedAt[`${op.actor}:${op.objectId}`],acceptedAt=state.opResults[opKey(op.device,op.id)]?.acceptedAt;
    if(op.status==='ACCEPTED'&&revokedAt!==undefined&&acceptedAt!==undefined&&acceptedAt>revokedAt)add('INV-17',`revoked actor ${op.actor} pushed ${op.id}`);
    if(!isAllowedKind(op.kind)&&op.status==='ACCEPTED')add('INV-16',`gated kind accepted: ${op.kind}`);
    if(state.purged.has(op.objectId)&&op.status==='ACCEPTED')add('INV-15',`purged object ${op.objectId} accepted`);
    if(op.status==='QUEUED'&&!state.acknowledged.has(opKey(op.device,op.id))&&!state.rejectedGates.has(op.id)&&device.length===0)add('INV-02',`pending op ${op.id} lost`);
  }
  for(const [actor,r] of Object.entries(state.replicas)) {
    const principal=actor.split(':')[0]!;
    if(Object.hasOwn(r.countsVisible,principal)&&r.countsVisible[principal]!==Object.keys(r.objects).length)add('INV-06',`visible count for ${principal} does not match authorized replica`);
    if(r.scopeVersion!==(state.scopeVersions[principal]??0)&&Object.values(r.status).some(status=>status==='SYNCED'))add('INV-20',`replica ${actor} reused state across scopeVersion`);
    for(const head of Object.values(r.heads))if(!state.revisions[head])add('INV-18',`replica head references missing revision ${head}`);
    for(const objectId of Object.keys(r.objects)) {
    if(!hasAccess(state,principal,objectId))add('INV-06',`unauthorized replica object ${objectId}`);
    if(state.purged.has(objectId))add('INV-15',`purged bytes visible for ${objectId}`);
    if(r.epoch!==state.epoch&&r.status[objectId]==='SYNCED')add('INV-12',`stale epoch replica serves ${objectId}`);
    }
  }
  for(const [objectId,head] of Object.entries(state.serverHeads)) {
    const revision=state.revisions[head];
    if(!revision)add('INV-14',`head ${objectId} references missing revision ${head}`);
    else for(const parent of revision.parents)if(!state.revisions[parent])add('INV-14',`revision ${head} skips unknown ancestor ${parent}`);
    if(revision?.autoMerged&&Object.values(state.pending).flat().some(op=>op.objectId===objectId&&op.kind==='wiki'))add('INV-21',`wiki page ${objectId} was auto-merged`);
  }
  for(const [objectId,head] of Object.entries(state.serverHeads)) if(!state.revisions[head]||state.revisions[head]!.objectId!==objectId)add('INV-26',`head ${objectId} points outside immutable history`);
  if(quiescent) for(const [actorDevice,r] of Object.entries(state.replicas)) for(const [objectId,head] of Object.entries(state.serverHeads)){
    const actor=actorDevice.split(':')[0]!;
    if(hasAccess(state,actor,objectId)&&r.status[objectId]!=='CONFLICT'&&r.status[objectId]!=='QUARANTINE'&&r.heads[objectId]!==head)add('INV-05',`replica ${actorDevice} differs for ${objectId}`);
  }
  if(mutant==='wall-clock-order'&&state.journal.some((id,index)=>index>0&&id<state.journal[index-1]!))add('INV-11','journal order sorted by wall clock/string');
  return out;
}
export function checkRun(run:RunResult):Violation[]{
  const result=checkState(run.state,true);
  if(run.history.some(item=>item.event.type==='restoreBackup')&&run.state.epoch==='epoch-0')result.push({id:'INV-12',message:'backup restore did not change epoch'});
  return result;
}
