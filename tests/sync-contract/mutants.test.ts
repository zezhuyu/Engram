import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, opKey, type ModelState } from './oracle.js';
import { checkState } from './invariants.js';

interface Mutant { name:string; invariant:string; breakModel:(state:ModelState)=>void; }
const mutants:Mutant[]=[
  {name:'drop an ACK',invariant:'INV-01',breakModel:s=>{s.acknowledged.add(opKey('d1','lost'));}},
  {name:'duplicate-apply an operation',invariant:'INV-13',breakModel:s=>{s.acknowledged.add(opKey('d1','dup'));s.pending.d1=[{id:'dup',device:'d1',actor:'alice',localSeq:1,objectId:'a',base:null,content:'x',kind:'note',status:'ACCEPTED'},{id:'dup',device:'d1',actor:'alice',localSeq:2,objectId:'a',base:null,content:'x',kind:'note',status:'ACCEPTED'}];}},
  {name:'ignore epoch after backup restore',invariant:'INV-12',breakModel:s=>{s.epoch='epoch-1';s.replicas['alice:d1']={heads:{a:'r'},objects:{a:'secret'},status:{a:'SYNCED'},epoch:'epoch-0',scopeVersion:0,countsVisible:{}};}},
  {name:'skip ancestry check',invariant:'INV-14',breakModel:s=>{s.serverHeads.a='missing-parent-revision';}},
  {name:'leak a hidden count',invariant:'INV-06',breakModel:s=>{s.grants.bob=new Set(['b']);s.replicas['bob:d2']={heads:{},objects:{},status:{},epoch:s.epoch,scopeVersion:0,countsVisible:{bob:1}};}},
  {name:'resurrect after purge',invariant:'INV-15',breakModel:s=>{s.purged.add('a');s.replicas['alice:d1']={heads:{},objects:{a:'stale'},status:{a:'SYNCED'},epoch:s.epoch,scopeVersion:0,countsVisible:{}};}},
  {name:'accept a gated kind',invariant:'INV-16',breakModel:s=>{s.pending.d1=[{id:'gate',device:'d1',actor:'alice',localSeq:1,objectId:'a',base:null,content:'x',kind:'dream-promote',status:'ACCEPTED'}];}},
  {name:'allow revoked actor push',invariant:'INV-17',breakModel:s=>{s.grants.bob=new Set();s.revokedAt['bob:secret']=0;s.opResults[opKey('d1','revoked')]={result:'r',acceptedAt:1};s.pending.d1=[{id:'revoked',device:'d1',actor:'bob',localSeq:1,objectId:'secret',base:null,content:'x',kind:'note',status:'ACCEPTED'}];}},
  {name:'lose conflict input',invariant:'INV-04',breakModel:s=>{s.pending.d1=[{id:'conflicted',device:'d1',actor:'alice',localSeq:1,objectId:'a',base:null,content:'lost-input',kind:'note',status:'CONFLICT'}];s.conflicts['conflicted']={id:'conflicted',objectId:'a',base:null,head:null,local:'',device:'d1',opId:'conflicted',resolved:false};}},
  {name:'order operations by wall clock',invariant:'INV-11',breakModel:s=>{s.journal=['z-op','a-op'];}},
  {name:'non-atomic state swap',invariant:'INV-18',breakModel:s=>{s.replicas['alice:d1']={heads:{a:'missing'},objects:{},status:{},epoch:s.epoch,scopeVersion:0,countsVisible:{}};}},
  {name:'evict unacknowledged ops.log entry',invariant:'INV-19',breakModel:s=>{s.localDurable.add(opKey('d1','evicted'));s.pending.d1=[];}},
  {name:'reuse cursor across scopeVersion',invariant:'INV-20',breakModel:s=>{s.replicas['alice:d1']={heads:{},objects:{a:'x'},status:{a:'SYNCED'},epoch:s.epoch,scopeVersion:-1,countsVisible:{}};}},
  {name:'auto-merge wiki pages',invariant:'INV-21',breakModel:s=>{s.revisions.r={id:'r',objectId:'wiki',content:'merged',hash:'h',parents:[],author:'d1',opId:'wiki',deleted:false,autoMerged:true};s.serverHeads.wiki='r';s.pending.d1=[{id:'wiki',device:'d1',actor:'alice',localSeq:1,objectId:'wiki',base:null,content:'merged',kind:'wiki',status:'ACCEPTED'}];}},
  {name:'expire operation result too early',invariant:'INV-22',breakModel:s=>{s.acknowledged.add(opKey('d1','expired'));s.journal.push(opKey('d1','expired'));}},
];

test('every deliberately broken oracle is killed by its designated invariant',()=>{
  const report:string[]=[];
  for(const mutant of mutants){const state=createState();mutant.breakModel(state);const found=checkState(state,false,mutant.invariant==='INV-11'?'wall-clock-order':undefined);
    assert.ok(found.some(v=>v.id===mutant.invariant),`${mutant.name} survived; expected ${mutant.invariant}`);report.push(`${mutant.name}\t${mutant.invariant}`);}
  console.log(`mutants caught (${mutants.length}):\n${report.join('\n')}`);
});
