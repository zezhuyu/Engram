import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initializeReplica, openReplica } from '../../packages/replication/client.js';
import { initializeProject } from '../../packages/project-init.js';
import { runContextHook } from '../../packages/memory/context-hook.js';
import { projectDoctor } from '../../packages/memory/project-doctor.js';

test('replica SessionStart context reads local workspace and profile with no network request', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'engram-replica-context-'));
  const keys=['ENGRAM_REPLICA_DIR','ENGRAM_USER_CONFIG','ENGRAM_STATE_DIR','ENGRAM_OUTBOX'];const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.ENGRAM_REPLICA_DIR=path.join(root,'replicas');process.env.ENGRAM_USER_CONFIG=path.join(root,'config');process.env.ENGRAM_STATE_DIR=path.join(root,'state');process.env.ENGRAM_OUTBOX=path.join(root,'outbox');
  t.after(async()=>{for(const key of keys){const value=old[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});});
  const tokenFile=path.join(root,'token');await writeFile(tokenFile,'test-token',{mode:0o600});
  await initializeReplica({name:'context-client',serverUrl:'https://example.invalid',tokenFile,baseDir:path.join(root,'replicas')});
  const {store}=await openReplica('context-client',path.join(root,'replicas'));
  await store.enrollScope({type:'workspace',workspaceId:'proj'});
  await store.vault.put({scope:{type:'workspace',workspaceId:'proj'},kind:'task',title:'Offline task',body:'Keep this task visible locally'});
  const content='# PROFILE\n\n### Global\n- **preference** — Keep replies concise _(confidence high)_\n\n### Workspace: proj\n- **working_style** — Focus on tests _(confidence high)_\n\n# USER_INSIGHT\n\n### Global\n_No accepted items._\n';
  await store.installProfileSnapshot({content,revisionId:createHash('sha256').update(content).digest('hex'),etag:`"${createHash('sha256').update(content).digest('hex')}"`});
  const project=path.join(root,'project');await initializeProject(undefined,{projectDir:project,host:'claude-code',mode:'replica',replicaId:'context-client',workspaceId:'proj',mcpUrl:'https://example.invalid/mcp'});
  const original=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('network must not be used by replica context');}) as typeof fetch;
  try{
    const result=await runContextHook({host:'claude-code',stdin:JSON.stringify({cwd:project}),projectRoot:project,env:process.env});
    assert.equal(result.outcome,'fresh');assert.match(result.output,/Offline task/);assert.match(result.output,/Keep replies concise/);assert.match(result.output,/Focus on tests/);
  }finally{globalThis.fetch=original;}
  const doctor=await projectDoctor(project);assert.equal(doctor.binding.mode,'replica');assert.equal(doctor.binding.replicaId,'context-client');assert.match(doctor.features.replica.detail,/daemon stopped/);
});
