import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveStoragePath } from '../core/root.js';
import { parseDocument, scopeKey, type Vault } from '../core/vault.js';
import type { ActorContext, CommitEvent } from '../core/types.js';
import { REPLICATION_INSTALL_CAPABILITY } from '../core/replication-capability.js';
import { correctInsight } from '../intelligence/insights.js';
import { looksSecret } from '../memory/redact.js';
import { canonicalOperation, MAX_BATCH_SIZE, sha256, type ReplicaOperation, validateOperation } from './operation.js';
import { replicaFault } from './internals.js';

export type ApplyResult = { status: 'accepted'|'rejected'|'conflict'|'skipped-after-conflict'; code: string; serverSequence?: number; authoritative?: { revisionId:string; revisionSha256:string; serverSequence:number; revisionBytes:string }; profilePull?:boolean; currentHeadId?: string };
const RESULT_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_RESULTS = 10_000;
function resultPath(): string { return path.join(resolveStoragePath('state'), 'replication', 'results.json'); }
type StoredResult={at:number;hash:string;result:ApplyResult};
async function readResults(file: string): Promise<Record<string,StoredResult>> { try { return JSON.parse(await fs.readFile(file,'utf8')) as Record<string,StoredResult>; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; } }
async function writeAtomic(file:string,value:unknown):Promise<void>{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${randomUUID()}.tmp`;try{const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}await fs.rename(temp,file);const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}finally{await fs.rm(temp,{force:true});}}
function idempotencyKey(op:ReplicaOperation):string{return `${op.deviceId}:${op.opId}`;}
export async function applyOperation(vault:Vault, credentialActor:ActorContext, op:ReplicaOperation, options:{resultsFile?:string;now?:()=>number}={}):Promise<ApplyResult>{
  try{validateOperation(op);}catch{return{status:'rejected',code:'INVALID_OPERATION'};}
  const file=options.resultsFile??resultPath(),now=options.now?.()??Date.now();
  const results=await readResults(file);for(const [key,value] of Object.entries(results))if(now-value.at>RESULT_TTL)delete results[key];
  const idem=idempotencyKey(op),fingerprint=sha256(canonicalOperation(op));if(results[idem])return results[idem]!.hash===fingerprint?results[idem]!.result:{status:'rejected',code:'IDEMPOTENCY_KEY_REUSED'};
  const scope=op.scope;
  if(!(await vault.canAccess(scope,'write',credentialActor)))return{status:'rejected',code:'FORBIDDEN'};
  if(op.kind==='preference_statement'){
    if(looksSecret(op.statement!.text))return{status:'rejected',code:'SECRET_CONTENT'};
    const actorVault=new (await import('../core/vault.js')).Vault(vault.root,credentialActor,{store:vault.store});
    try{const document=await correctInsight(actorVault,{scope,storageScope:scope,preferenceKey:op.statement!.preferenceKey,claim:op.statement!.text,category:op.statement!.category,reason:'Explicit preference statement received from replica',sensitive:op.statement!.sensitive,idempotencyKey:idem});const event=(await vault.replicationEvents(REPLICATION_INSTALL_CAPABILITY)).findLast(item=>item.objectId===document.id);const accepted:ApplyResult={status:'accepted',code:'PREFERENCE_RECORDED',...(event?{serverSequence:event.sequence}:{})};await remember(file,results,idem,{at:now,hash:fingerprint,result:accepted});return accepted;}catch(error){const code=(error as {code?:string}).code;return{status:'rejected',code:code==='NOT_FOUND_OR_FORBIDDEN'?'FORBIDDEN':'PREFERENCE_REJECTED'};}
  }
  let incoming;try{incoming=parseDocument(op.revisionBytes);}catch{return{status:'rejected',code:'INVALID_REVISION'};}
  if(incoming.id!==op.objectId||incoming.revisionId!==op.revisionId||scopeKey(incoming.scope)!==scopeKey(scope)||incoming.kind!==op.kind)return{status:'rejected',code:'FORGED_REVISION'};
  if(looksSecret(`${incoming.title}\n${incoming.body}`))return{status:'rejected',code:'SECRET_CONTENT'};
  const events=await vault.events();const current=events.findLast(e=>e.objectId===op.objectId);
  if(await vault.replicationIdentityUsed(op.objectId,op.revisionId,REPLICATION_INSTALL_CAPABILITY)&&!current)return{status:'rejected',code:'ID_COLLISION'};
  if(current?.revisionId===op.revisionId){if(current.idempotencyKey!==idem||current.idempotencyPayloadHash!==fingerprint||current.idempotencyActorId!==credentialActor.actorId)return{status:'rejected',code:'REVISION_ID_REUSED'};const document=await vault.get(op.objectId,op.revisionId),revisionBytes=(await import('../core/vault.js')).serializeDocument(document),accepted:ApplyResult={status:'accepted',code:'IDEMPOTENT',serverSequence:current.sequence,authoritative:{revisionId:document.revisionId,revisionSha256:sha256(revisionBytes),serverSequence:current.sequence,revisionBytes}};await remember(file,results,idem,{at:now,hash:fingerprint,result:accepted});return accepted;}
  if(current&&scopeKey(current.scope)!==scopeKey(scope))return{status:'rejected',code:'OBJECT_ID_COLLISION'};
  if(current&&!op.previousRevisionId)return{status:'rejected',code:'OBJECT_ID_COLLISION'};
  if(op.previousRevisionId&&!current){const rejected:ApplyResult={status:'rejected',code:'PARENT_MISSING'};await remember(file,results,idem,{at:now,hash:fingerprint,result:rejected});return rejected;}if((current?.revisionId??null)!==op.previousRevisionId){let currentHeadId:string|undefined;if(current&&await vault.canAccess(current.scope,'read',credentialActor))currentHeadId=current.revisionId;const conflict:ApplyResult={status:'conflict',code:'STALE_PARENT',...(currentHeadId?{currentHeadId}:{})};await remember(file,results,idem,{at:now,hash:fingerprint,result:conflict});return conflict;}
  if(await vault.replicationRevisionIdUsed(op.revisionId,REPLICATION_INSTALL_CAPABILITY))return{status:'rejected',code:'REVISION_ID_COLLISION'};
  if(op.previousRevisionId&&incoming.previousRevisionId!==op.previousRevisionId)return{status:'rejected',code:'PARENT_MISMATCH'};
  const stamped={...incoming,createdBy:credentialActor.actorId};
  const stampedBytes=Buffer.from((await import('../core/vault.js')).serializeDocument(stamped));
  const event:CommitEvent={sequence:0,transactionId:`replica_${op.opId}`,objectId:op.objectId,revisionId:op.revisionId,...(op.previousRevisionId?{previousRevisionId:op.previousRevisionId}:{}),path:incoming.path,scope,operation:'replica_push',timestamp:incoming.updatedAt,idempotencyKey:idem,idempotencyPayloadHash:fingerprint,idempotencyActorId:credentialActor.actorId,revisionSha256:''};
  try{await vault.installReplicatedRevision(stampedBytes,event,REPLICATION_INSTALL_CAPABILITY);}catch(error){if((error as {code?:string}).code==='CONFLICT'){const head=await vault.events(),latest=head.findLast(e=>e.objectId===op.objectId);const conflict:ApplyResult={status:'conflict',code:'STALE_PARENT',...(latest&&await vault.canAccess(latest.scope,'read',credentialActor)?{currentHeadId:latest.revisionId}:{})};await remember(file,results,idem,{at:now,hash:fingerprint,result:conflict});return conflict;}return{status:'rejected',code:'COMMIT_FAILED'};}
  const latest=await vault.events(),serverSequence=latest.findLast(e=>e.objectId===op.objectId)?.sequence??latest.length;
  const authoritative={revisionId:op.revisionId,revisionSha256:sha256(stampedBytes),serverSequence,revisionBytes:stampedBytes.toString('utf8')};
  const accepted:ApplyResult={status:'accepted',code:'COMMITTED',serverSequence,authoritative};replicaFault('server.after_vault_commit_before_result_store');await remember(file,results,idem,{at:now,hash:fingerprint,result:accepted});replicaFault('server.after_result_store_before_response');return accepted;
}
async function remember(file:string,results:Record<string,StoredResult>,key:string,value:StoredResult):Promise<void>{results[key]=value;const entries=Object.entries(results).sort((a,b)=>b[1].at-a[1].at).slice(0,MAX_RESULTS);await writeAtomic(file,Object.fromEntries(entries));}
export async function storeOperationResult(op:ReplicaOperation,result:ApplyResult,options:{resultsFile:string;now?:number}):Promise<ApplyResult>{const now=options.now??Date.now(),results=await readResults(options.resultsFile),key=idempotencyKey(op),hash=sha256(canonicalOperation(op));for(const [entry,value]of Object.entries(results))if(now-value.at>RESULT_TTL)delete results[entry];const prior=results[key];if(prior)return prior.hash===hash?prior.result:{status:'rejected',code:'IDEMPOTENCY_KEY_REUSED'};await remember(options.resultsFile,results,key,{at:now,hash,result});return result;}
export async function applyBatch(vault:Vault,actor:ActorContext,ops:ReplicaOperation[],limit=MAX_BATCH_SIZE,options:{resultsFile?:string}={}):Promise<ApplyResult[]>{if(!Array.isArray(ops)||ops.length>Math.min(limit,MAX_BATCH_SIZE))throw new Error('batch limit exceeded');const results:ApplyResult[]=[],blocked=new Set<string>();for(const op of ops){const key=`${op.scope?.workspaceId}:${op.objectId}`;if(blocked.has(key)){results.push({status:'skipped-after-conflict',code:'SKIPPED_AFTER_CONFLICT'});continue;}const result=await applyOperation(vault,actor,op,options);results.push(result);if(result.status==='conflict')blocked.add(key);}return results;}
