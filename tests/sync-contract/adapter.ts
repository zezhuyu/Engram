import { applyEvent, createState, type ModelState, type RunResult, type SyncEvent } from './oracle.js';
import { checkState } from './invariants.js';

export interface SyncSnapshot { state: ModelState; }
export interface ISyncSystem {
  localWrite(device:string,actor:string,objectId:string,content:string,kind?:string):void;
  localRead(device:string,actor:string,objectId:string):{content?:string;status?:string};
  runPush(device:string):void;
  runPull(device:string,actor:string):void;
  status(device:string,actor:string):{pending:number;conflicts:number;epoch:string};
  crash(target:string,boundary:string):void;
  restart(device:string):void;
  serverRestore():void;
  grant(actor:string,scope:string):void;
  revoke(actor:string,scope:string):void;
  snapshot():SyncSnapshot;
  run(events:SyncEvent[]):RunResult;
}

export class OracleSystem implements ISyncSystem {
  state=createState();
  localWrite(device:string,actor:string,objectId:string,content:string,kind='note'):void{applyEvent(this.state,{type:'localWrite',device,actor,objectId,content,kind:kind as never});}
  localRead(device:string,actor:string,objectId:string):{content?:string;status?:string}{const r=this.state.replicas[`${actor}:${device}`];return {content:r?.objects[objectId],status:r?.status[objectId]};}
  runPush(device:string):void{applyEvent(this.state,{type:'deliver',device,direction:'push'});}
  runPull(device:string,actor:string):void{applyEvent(this.state,{type:'deliver',device,direction:'pull'});}
  status(device:string,actor:string):{pending:number;conflicts:number;epoch:string}{return {pending:(this.state.pending[device]??[]).filter(op=>['QUEUED','SENDING'].includes(op.status)).length,conflicts:Object.values(this.state.conflicts).filter(c=>!c.resolved).length,epoch:this.state.replicas[`${actor}:${device}`]?.epoch??this.state.epoch};}
  crash(target:string,boundary:string):void{applyEvent(this.state,{type:'crash',target,boundary});}
  restart(_device:string):void{for(const ops of Object.values(this.state.pending))for(const op of ops)if(op.status==='SENDING')op.status='QUEUED';}
  serverRestore():void{applyEvent(this.state,{type:'restoreBackup'});}
  grant(actor:string,scope:string):void{applyEvent(this.state,{type:'grant',actor,scope});}
  revoke(actor:string,scope:string):void{applyEvent(this.state,{type:'revoke',actor,scope});}
  snapshot():SyncSnapshot{return {state:structuredClone(this.state)};}
  run(events:SyncEvent[]):RunResult {const history:RunResult['history']=[];for(const event of events){const index=history.length,outcome=applyEvent(this.state,event);history.push({index,event:structuredClone(event),outcome,stateHash:''});const violations=checkState(this.state);if(violations.length)throw new Error(`${violations[0]!.id}: ${violations[0]!.message}`);}return {seed:0,events:structuredClone(events),history,state:this.state};}
}

/** Placeholder for future product integration; its contract scenarios remain explicit TODOs. */
export class NotImplementedSystem implements ISyncSystem {
  private unavailable():never{throw new Error('real replication system is not implemented (ADR O-05 remains pending)');}
  localWrite():void{this.unavailable();} localRead():{content?:string;status?:string}{return this.unavailable();}
  runPush():void{this.unavailable();} runPull():void{this.unavailable();} status():{pending:number;conflicts:number;epoch:string}{return this.unavailable();}
  crash():void{this.unavailable();} restart():void{this.unavailable();} serverRestore():void{this.unavailable();}
  grant():void{this.unavailable();} revoke():void{this.unavailable();} snapshot():SyncSnapshot{return this.unavailable();}
  run():RunResult{return this.unavailable();}
}
