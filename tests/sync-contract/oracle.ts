import { createHash } from 'node:crypto';

export type OperationKind = 'note' | 'task' | 'handoff' | 'wiki' | 'wiki-retire' | 'insight-approve' | 'dream-promote' | 'acl-change' | 'credential-change';
export type OpStatus = 'QUEUED' | 'SENDING' | 'ACCEPTED' | 'CONFLICT' | 'REJECTED' | 'QUARANTINE';
export interface Revision { id: string; objectId: string; content: string; hash: string; parents: string[]; author: string; opId: string; deleted: boolean; autoMerged?: boolean; }
export interface PendingOp { id: string; device: string; actor: string; localSeq: number; objectId: string; base: string | null; content: string; kind: OperationKind; deleted?: boolean; status: OpStatus; }
export interface Conflict { id: string; objectId: string; base: string | null; head: string | null; local: string; device: string; opId: string; resolved: boolean; }
export interface Replica { heads: Record<string, string>; objects: Record<string, string>; status: Record<string, 'SYNCED' | 'LOCAL_DURABLE_PENDING' | 'CONFLICT' | 'QUARANTINE' | 'RESYNC'>; epoch: string; scopeVersion: number; countsVisible: Record<string, number>; }
export interface ModelState {
  revisions: Record<string, Revision>; serverHeads: Record<string, string>; epoch: string;
  grants: Record<string, Set<string>>; scopeVersions: Record<string, number>;
  pending: Record<string, PendingOp[]>; replicas: Record<string, Replica>; conflicts: Record<string, Conflict>;
  opResults: Record<string, { result: string; acceptedAt: number }>; purged: Set<string>; journal: string[];
  acknowledged: Set<string>; rejectedGates: Set<string>; localDurable: Set<string>; revokedAt: Record<string,number>; eventNo: number; partitions: Set<string>;
  countsVisible: Record<string, number>; immutableHashes: Record<string, string>;
}
export type SyncEvent =
  | { type: 'localWrite'; device: string; actor: string; objectId: string; content: string; kind?: OperationKind; opId?: string }
  | { type: 'localDelete'; device: string; actor: string; objectId: string; opId?: string }
  | { type: 'restore'; device: string; actor: string; objectId: string; content: string; opId?: string }
  | { type: 'deliver'; device: string; direction: 'push' | 'pull'; drop?: boolean; duplicate?: boolean; reorder?: boolean }
  | { type: 'partition' | 'heal'; device: string }
  | { type: 'crash'; target: string; boundary: string }
  | { type: 'grant' | 'revoke'; actor: string; scope: string }
  | { type: 'restoreBackup' }
  | { type: 'purge'; objectId: string }
  | { type: 'resolve'; device: string; actor: string; conflictId: string; content: string };
export interface HistoryEntry { index: number; event: SyncEvent; outcome: string; stateHash: string; }
export interface RunResult { seed: number; events: SyncEvent[]; history: HistoryEntry[]; state: ModelState; }

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const opKey = (device:string,id:string):string=>`${device}:${id}`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item instanceof Set ? [...item].sort() : item);
export function createState(): ModelState {
  return { revisions: {}, serverHeads: {}, epoch: 'epoch-0', grants: { alice: new Set(['*']) }, scopeVersions: { alice: 0 }, pending: {}, replicas: {}, conflicts: {}, opResults: {}, purged: new Set(), journal: [], acknowledged: new Set(), rejectedGates: new Set(), localDurable: new Set(), revokedAt: {}, eventNo: 0, partitions: new Set(), countsVisible: {}, immutableHashes: {} };
}
function replica(state: ModelState, device: string, actor: string): Replica {
  const key = `${actor}:${device}`;
  return state.replicas[key] ??= { heads: {}, objects: {}, status: {}, epoch: state.epoch, scopeVersion: state.scopeVersions[actor] ?? 0, countsVisible: {} };
}
function canAccess(state: ModelState, actor: string, objectId: string): boolean {
  const scopes = state.grants[actor];
  return !!scopes && (scopes.has('*') || scopes.has(objectId) || scopes.has(`object:${objectId}`) || [...scopes].some(s => s.endsWith(':*') && objectId.startsWith(s.slice(0, -1))));
}
function makeOp(state: ModelState, event: Extract<SyncEvent, {type:'localWrite'|'localDelete'|'restore'}>, kind: OperationKind, content: string, deleted = false): void {
  const r = replica(state, event.device, event.actor);
  if (state.purged.has(event.objectId) || !canAccess(state,event.actor,event.objectId)) return;
  const list = state.pending[event.device] ??= [];
  const seq = (list.at(-1)?.localSeq ?? 0) + 1;
  const id = event.opId ?? `${event.device}-op-${seq}-${hash(`${event.objectId}:${content}`).slice(0, 8)}`;
  if (list.some(op => op.id === id)) return;
  const base = r.heads[event.objectId] ?? null;
  const op: PendingOp = { id, device: event.device, actor: event.actor, localSeq: seq, objectId: event.objectId, base, content: deleted ? '' : content, kind, status: 'QUEUED' };
  op.deleted=deleted;
  list.push(op); r.objects[event.objectId] = deleted ? '' : content; r.status[event.objectId] = 'LOCAL_DURABLE_PENDING';
  state.localDurable.add(opKey(event.device,id));
  if(Object.hasOwn(r.countsVisible,event.actor))r.countsVisible[event.actor]=Object.keys(r.objects).length;
}
function accepted(state: ModelState, op: PendingOp, parents: string[], content = op.content): string {
  const id = `rev-${state.journal.length + 1}-${hash(`${op.id}:${content}`).slice(0, 10)}`;
  const rev: Revision = { id, objectId: op.objectId, content, hash: hash(content), parents, author: op.device, opId: op.id, deleted: op.deleted ?? false };
  const key=opKey(op.device,op.id);
  state.revisions[id] = rev; state.immutableHashes[id] = rev.hash; state.serverHeads[op.objectId] = id; state.journal.push(key); state.acknowledged.add(key);
  state.opResults[key] = { result: id, acceptedAt: state.eventNo };
  op.status = 'ACCEPTED'; return id;
}
function updateLocalFromServer(state: ModelState, actor: string, device: string, objectId: string): void {
  const r = replica(state, device, actor), head = state.serverHeads[objectId];
  r.scopeVersion=state.scopeVersions[actor]??0;
  r.epoch=state.epoch;
  if (head && canAccess(state, actor, objectId)) { r.heads[objectId] = head; r.objects[objectId] = state.revisions[head]!.content; r.status[objectId] = 'SYNCED'; }
  if(Object.hasOwn(r.countsVisible,actor))r.countsVisible[actor]=Object.keys(r.objects).length;
}
function push(state: ModelState, device: string, flags: {drop?:boolean; duplicate?:boolean} = {}): void {
  if (state.partitions.has(device)) return;
  const ops = (state.pending[device] ?? []).filter(op => op.status === 'QUEUED' || op.status === 'SENDING').sort((a,b)=>a.localSeq-b.localSeq);
  for (const op of ops) {
    op.status = 'SENDING';
    const clientReplica=replica(state,device,op.actor);
    if(clientReplica.epoch!==state.epoch){op.status='QUEUED';clientReplica.status[op.objectId]='RESYNC';continue;}
    if (!canAccess(state, op.actor, op.objectId)) { op.status = 'QUARANTINE'; replica(state,device,op.actor).status[op.objectId]='QUARANTINE'; continue; }
    if (op.kind === 'wiki-retire' || op.kind === 'insight-approve' || op.kind === 'dream-promote' || op.kind === 'acl-change' || op.kind === 'credential-change') { op.status='REJECTED'; state.rejectedGates.add(op.id); continue; }
    const key=opKey(op.device,op.id),prior = state.opResults[key];
    if (prior) { op.status='ACCEPTED'; state.acknowledged.add(key); continue; }
    if (state.purged.has(op.objectId)) { op.status='REJECTED'; continue; }
    const head = state.serverHeads[op.objectId] ?? null;
    if (head !== op.base) {
      const conflictId=`conflict-${op.id}`;
      state.conflicts[conflictId]={id:conflictId,objectId:op.objectId,base:op.base,head,local:op.content,device,opId:op.id,resolved:false};
      op.status='CONFLICT'; for(const [replicaKey,replicaState] of Object.entries(state.replicas))if(canAccess(state,replicaKey.split(':')[0]!,op.objectId))replicaState.status[op.objectId]='CONFLICT'; replica(state,device,op.actor).status[op.objectId]='CONFLICT'; continue;
    }
    const id=accepted(state,op,head?[head]:[]);
    if (flags.drop) { op.status='SENDING'; continue; }
    updateLocalFromServer(state,op.actor,device,op.objectId);
    if (flags.duplicate && !state.opResults[key]) accepted(state,op,[id]);
  }
}
function pull(state: ModelState, device: string, actor: string, reorder = false): void {
  if (state.partitions.has(device)) return;
  const r=replica(state,device,actor);
  if (r.epoch !== state.epoch || r.scopeVersion !== (state.scopeVersions[actor]??0)) { r.status=Object.fromEntries(Object.keys(r.heads).map(id=>[id,'RESYNC'])); r.epoch=state.epoch; r.scopeVersion=state.scopeVersions[actor]??0; }
  for(const objectId of Object.keys(r.objects))if(!canAccess(state,actor,objectId)||state.purged.has(objectId)||!state.serverHeads[objectId]){delete r.objects[objectId];delete r.heads[objectId];r.status[objectId]='QUARANTINE';}
  const ids=Object.keys(state.serverHeads); if(reorder) ids.reverse();
  for(const objectId of ids){
    if (!canAccess(state,actor,objectId)) { delete r.objects[objectId]; delete r.heads[objectId]; r.status[objectId]='QUARANTINE'; continue; }
    if (state.purged.has(objectId)) { delete r.objects[objectId]; delete r.heads[objectId]; r.status[objectId]='QUARANTINE'; continue; }
    const serverHead=state.serverHeads[objectId]!, current=r.heads[objectId];
    if(Object.values(state.conflicts).some(conflict=>conflict.objectId===objectId&&!conflict.resolved)){r.status[objectId]='CONFLICT';continue;}
    if (current && current!==serverHead) {
      const lineage = state.revisions[serverHead]!.parents;
      if (!lineage.includes(current)) {
        let cursor: string|undefined=serverHead, found=false;
        while(cursor){if(cursor===current){found=true;break;} cursor=state.revisions[cursor]?.parents[0];}
        if(!found){r.status[objectId]='CONFLICT';continue;}
      }
    }
    const pending=(state.pending[device]??[]).some(op=>op.objectId===objectId && ['QUEUED','SENDING'].includes(op.status));
    if(!pending) {r.heads[objectId]=serverHead;r.objects[objectId]=state.revisions[serverHead]!.content;r.status[objectId]='SYNCED';}
  }
  r.countsVisible[actor]=Object.keys(r.objects).length;
}
export function applyEvent(state: ModelState, event: SyncEvent, mutant?: string): string {
  state.eventNo++;
  switch(event.type){
    case 'localWrite': makeOp(state,event,event.kind??'note',event.content); return 'LOCAL_DURABLE_PENDING';
    case 'localDelete': makeOp(state,event,'note','',true); return 'LOCAL_DURABLE_PENDING';
    case 'restore': makeOp(state,event,'note',event.content); return 'LOCAL_DURABLE_PENDING';
    case 'deliver': if(event.direction==='push') push(state,event.device,{drop:mutant==='drop-ack'&&event.drop,duplicate:mutant==='duplicate-effect'&&event.duplicate}); else {
      const entry=Object.entries(state.replicas).find(([key])=>key.endsWith(`:${event.device}`));
      if(entry) pull(state,event.device,entry[0].split(':')[0]!,event.reorder);
    } return 'DELIVERED';
    case 'partition': state.partitions.add(event.device); return 'PARTITIONED';
    case 'heal': state.partitions.delete(event.device); return 'CONNECTED';
    case 'crash': return `CRASH:${event.target}:${event.boundary}`;
    case 'grant': {const scopes=state.grants[event.actor]??=new Set();scopes.add(event.scope);state.scopeVersions[event.actor]=(state.scopeVersions[event.actor]??0)+1;for(const key of Object.keys(state.revokedAt))if(key.startsWith(`${event.actor}:`)&&(event.scope==='*'||key===`${event.actor}:${event.scope}`||event.scope.endsWith(':*')&&key.slice(event.actor.length+1).startsWith(event.scope.slice(0,-1))))delete state.revokedAt[key];for(const [key,r] of Object.entries(state.replicas))if(key.startsWith(`${event.actor}:`))r.status=Object.fromEntries(Object.keys(r.objects).map(id=>[id,'RESYNC']));return 'GRANTED';}
    case 'revoke': {const scopes=state.grants[event.actor];scopes?.delete(event.scope);state.scopeVersions[event.actor]=(state.scopeVersions[event.actor]??0)+1;for(const op of Object.values(state.pending).flat())if(op.actor===event.actor&&!canAccess(state,event.actor,op.objectId)){state.revokedAt[`${event.actor}:${op.objectId}`]=state.eventNo;if(op.status==='QUEUED')op.status='QUARANTINE';}for(const objectId of Object.keys(state.serverHeads))if(!canAccess(state,event.actor,objectId))state.revokedAt[`${event.actor}:${objectId}`]=state.eventNo;for(const [key,r] of Object.entries(state.replicas))if(key.startsWith(`${event.actor}:`)){for(const objectId of Object.keys(r.objects))if(!canAccess(state,event.actor,objectId)){delete r.objects[objectId];delete r.heads[objectId];r.status[objectId]='QUARANTINE';}for(const objectId of Object.keys(r.objects))r.status[objectId]='RESYNC';r.countsVisible[event.actor]=Object.keys(r.objects).length;}return 'REVOKED';}
    case 'restoreBackup': state.epoch=mutant==='ignore-epoch'?state.epoch:`epoch-${state.eventNo}`;state.serverHeads={};for(const r of Object.values(state.replicas))r.status=Object.fromEntries(Object.keys(r.heads).map(id=>[id,'RESYNC']));return 'RESYNC_REQUIRED';
    case 'purge': state.purged.add(event.objectId);delete state.serverHeads[event.objectId];for(const r of Object.values(state.replicas)){delete r.objects[event.objectId];delete r.heads[event.objectId];r.status[event.objectId]='QUARANTINE';for(const actor of Object.keys(r.countsVisible))r.countsVisible[actor]=Object.keys(r.objects).length;}for(const ops of Object.values(state.pending))for(const op of ops)if(op.objectId===event.objectId)op.status='REJECTED';return 'PURGED';
    case 'resolve': {const c=state.conflicts[event.conflictId];if(!c||c.resolved||!canAccess(state,event.actor,c.objectId))return 'CONFLICT';const op:PendingOp={id:`resolve-${c.id}`,device:event.device,actor:event.actor,localSeq:0,objectId:c.objectId,base:c.head,content:event.content,kind:'note',status:'SENDING'};const current=state.serverHeads[c.objectId]??null;if(current!==c.head)return 'CONFLICT';const id=accepted(state,op,[...(current?[current]:[]),...(c.base?[c.base]:[])]);c.resolved=true;updateLocalFromServer(state,event.actor,event.device,c.objectId);return id;}
  }
}
export function runEvents(seed:number, events:SyncEvent[], mutant?:string, validate?:(state:ModelState,index:number)=>void):RunResult {
  const state=createState(), history:HistoryEntry[]=[];
  for(const event of events){const index=history.length,outcome=applyEvent(state,event,mutant);history.push({index,event:structuredClone(event),outcome,stateHash:hash(canonical(state))});validate?.(state,index);}
  return {seed,events:structuredClone(events),history,state};
}
export function stateHash(state:ModelState):string{return hash(canonical(state));}
export function historyHash(run:RunResult):string{return hash(canonical(run.history));}
export function isAllowedKind(kind:OperationKind):boolean{return ['note','task','handoff','wiki'].includes(kind);}
export function hasAccess(state:ModelState,actor:string,objectId:string):boolean{return canAccess(state,actor,objectId);}
