import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engram } from '../../packages/sdk/index.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { defaultBinding, writeBinding } from '../../packages/core/project-binding.js';
import { bindingFingerprint } from '../../packages/core/project-trust.js';

async function fixture(t: import('node:test').TestContext, options: { clientMode?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-client-workspaces-'));
  const names = ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_DATA_HOME','ENGRAM_DATA_DIR','ENGRAM_TRUST_FILE','ENGRAM_REPLICA_DIR','ENGRAM_OUTBOX','ENGRAM_CACHE_DIR','MDB_DASHBOARD_AUTH_FILE'];
  const old = new Map(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { HOME:path.join(root,'home'), XDG_CONFIG_HOME:path.join(root,'config'), XDG_CACHE_HOME:path.join(root,'cache'), XDG_STATE_HOME:path.join(root,'state'), XDG_DATA_HOME:path.join(root,'data'), ENGRAM_DATA_DIR:path.join(root,'data'), ENGRAM_TRUST_FILE:path.join(root,'trust','trusted-projects.json'), ENGRAM_REPLICA_DIR:path.join(root,'data','.engram-runtime','replicas'), ENGRAM_OUTBOX:path.join(root,'data','.engram-runtime','outbox'), ENGRAM_CACHE_DIR:path.join(root,'data','.engram-runtime','cache'), MDB_DASHBOARD_AUTH_FILE:path.join(root,'auth.json') });
  const e = new Engram(path.join(root,'vault')); await e.init({ sqlite:false });
  const dashboard = await createDashboardServer({ engram:e, clientMode:options.clientMode!==false, host:'127.0.0.1', port:0, idleMs:60_000 });
  const origin=`http://127.0.0.1:${dashboard.port}`, password='workspace-dashboard-password-41';
  await fetch(origin+'/api/auth/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:dashboard.token,password,confirm:password})});
  const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})});
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  t.after(async()=>{await dashboard.close();await e.close();await fs.rm(root,{recursive:true,force:true});for(const [key,value] of old)if(value===undefined)delete process.env[key];else process.env[key]=value;});
  return {root,origin,cookie};
}
const headers=(cookie:string)=>({Cookie:cookie,'X-Engram-Dashboard':'1'});

test('client workspaces requires a local session and is hidden outside client mode', async t => {
  const x=await fixture(t);
  assert.equal((await fetch(x.origin+'/api/client/workspaces')).status,401);
  const response=await fetch(x.origin+'/api/client/workspaces',{headers:headers(x.cookie)});
  assert.equal(response.status,200);assert.deepEqual((await response.json() as any).rows,[]);
  const serverMode=await fixture(t,{clientMode:false});const dashboard=await fetch(serverMode.origin+'/api/client/workspaces',{headers:headers(serverMode.cookie)});assert.equal(dashboard.status,404);
});

test('client workspaces unions server-only, bound, cached and queued workspace metadata without returning secrets', async t => {
  const x=await fixture(t);
  const token='workspace-list-secret-token', tokenFile=path.join(x.root,'client.token');await fs.writeFile(tokenFile,token,{mode:0o600});
  const mcp=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const message=JSON.parse(body);res.setHeader('Content-Type','application/json');if(message.method==='initialize'){res.setHeader('Mcp-Session-Id','fixture');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));}else if(message.method==='tools/list')res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'mdb_workspace_list'}]}}));else res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify([{id:'server-only',name:'Server Only'},{id:'bound-ws',name:'Bound workspace'}])}]}}));});});
  await new Promise<void>(resolve=>mcp.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>mcp.close(()=>resolve())));const address=mcp.address();assert.ok(address&&typeof address!=='string');
  await fs.mkdir(path.join(x.root,'config','engram'),{recursive:true});await fs.writeFile(path.join(x.root,'config','engram','client.env'),`ENGRAM_MCP_URL="http://127.0.0.1:${address.port}/mcp"\nENGRAM_TOKEN_FILE=${JSON.stringify(tokenFile)}\n`);
  const project=path.join(x.root,'projects','Bound folder');await fs.mkdir(project,{recursive:true});const binding={...defaultBinding({workspaceId:'bound-ws'}),mode:'remote' as const,serverUrl:`http://127.0.0.1:${address.port}/mcp`};await writeBinding(project,binding);await fs.mkdir(path.dirname(process.env.ENGRAM_TRUST_FILE!),{recursive:true});await fs.writeFile(process.env.ENGRAM_TRUST_FILE!,JSON.stringify({schemaVersion:1,entries:[{root:project,fingerprint:bindingFingerprint(binding),workspaceId:'bound-ws',mode:'remote'}]}));
  const cacheDir=path.join(process.env.ENGRAM_CACHE_DIR!,'context');await fs.mkdir(cacheDir,{recursive:true});await fs.writeFile(path.join(cacheDir,createHash('sha256').update('cache-fixture').digest('hex').slice(0,24)+'.json'),JSON.stringify({workspaceId:'cache-only',serverUrl:'http://127.0.0.1',fetchedAt:new Date(Date.now()-26*60*60_000).toISOString(),text:'PRIVATE CACHED CONTEXT'}));
  const outbox=process.env.ENGRAM_OUTBOX!;await fs.mkdir(outbox,{recursive:true});await fs.writeFile(path.join(outbox,'20261111120000-00000000-0000-4000-8000-000000000001.json'),JSON.stringify({version:1,workspaceId:'queued-only',arguments:{text:'PRIVATE QUEUED BODY'},token}));await fs.writeFile(path.join(outbox,'20261111120001-00000000-0000-4000-8000-000000000002.json'),JSON.stringify({version:1,workspaceId:'bound-ws',arguments:{text:'PRIVATE BOUND BODY'}}));
  const response=await fetch(x.origin+'/api/client/workspaces',{headers:headers(x.cookie)});assert.equal(response.status,200);const body=await response.text();const data=JSON.parse(body);assert.deepEqual(data.rows.map((row:any)=>row.id).sort(),['bound-ws','cache-only','queued-only','server-only']);
  assert.equal(data.rows.find((row:any)=>row.id==='server-only').connection,'connected');assert.equal(data.rows.find((row:any)=>row.id==='bound-ws').folders[0].name,'Bound folder');assert.equal(data.rows.find((row:any)=>row.id==='bound-ws').queuedWrites,1);assert.equal(data.rows.find((row:any)=>row.id==='cache-only').modes[0],'cache-only');assert.equal(data.rows.find((row:any)=>row.id==='cache-only').cache.stale,true);assert.equal(data.rows.find((row:any)=>row.id==='queued-only').queuedWrites,1);assert.doesNotMatch(body,/PRIVATE CACHED CONTEXT|PRIVATE QUEUED BODY|PRIVATE BOUND BODY|workspace-list-secret-token/);
  await fs.writeFile(path.join(x.root,'config','engram','client.env'),`ENGRAM_MCP_URL=\"http://127.0.0.1:1/mcp\"\nENGRAM_TOKEN_FILE=${JSON.stringify(tokenFile)}\n`);const offline=await fetch(x.origin+'/api/client/workspaces',{headers:headers(x.cookie)}).then(r=>r.json()) as any;assert.equal(offline.stale,true);assert.ok(offline.server.ageMs>=0);assert.equal(offline.rows.find((row:any)=>row.id==='server-only').connection,'unreachable');
});

test('unreachable configured server returns local rows with explicit error and stays bounded', async t => {
  const x=await fixture(t);const tokenFile=path.join(x.root,'token');await fs.writeFile(tokenFile,'local-secret',{mode:0o600});await fs.mkdir(path.join(x.root,'config','engram'),{recursive:true});await fs.writeFile(path.join(x.root,'config','engram','client.env'),`ENGRAM_MCP_URL="http://127.0.0.1:1/mcp"\nENGRAM_TOKEN_FILE=${JSON.stringify(tokenFile)}\n`);
  const project=path.join(x.root,'projects','offline-folder');await fs.mkdir(project,{recursive:true});const binding={...defaultBinding({workspaceId:'a-offline-ws'}),mode:'remote' as const,serverUrl:'http://127.0.0.1:1/mcp'};await writeBinding(project,binding);await fs.mkdir(path.dirname(process.env.ENGRAM_TRUST_FILE!),{recursive:true});await fs.writeFile(process.env.ENGRAM_TRUST_FILE!,JSON.stringify({schemaVersion:1,entries:[{root:project,fingerprint:bindingFingerprint(binding),workspaceId:'a-offline-ws',mode:'remote'}]}));
  const context=path.join(process.env.ENGRAM_CACHE_DIR!,'context');await fs.mkdir(context,{recursive:true});for(let i=0;i<205;i++)await fs.writeFile(path.join(context,i.toString(16).padStart(24,'0')+'.json'),JSON.stringify({workspaceId:'cache-'+String(i).padStart(3,'0'),serverUrl:'http://127.0.0.1:1',fetchedAt:new Date().toISOString(),text:'must not return'}));const response=await fetch(x.origin+'/api/client/workspaces',{headers:headers(x.cookie),signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);const data=await response.json() as any;assert.equal(data.rows.length,200);assert.equal(data.approximate,true);assert.equal(data.rows.find((row:any)=>row.id==='a-offline-ws').connection,'unreachable');assert.match(data.error,/unavailable/);assert.equal(data.stale,false);
});

test('every test spawn of the dashboard CLI disables macOS alerts', async () => {
  const files=await fs.readdir('tests',{recursive:true});const offenders:string[]=[];
  for(const file of files.filter(value=>typeof value==='string'&&/\.(?:ts|mjs|js)$/.test(value))){const source=await fs.readFile(path.join('tests',file),'utf8').catch(()=>undefined);if(!source||!/bin\/mdb\.js/.test(source)||!/['"]dashboard['"]\s*,\s*['"]--root|['"]dashboard['"]\s*,\s*['"]--client/.test(source))continue;if(!/MDB_DASHBOARD_ALERT\s*:\s*['"]false['"]/.test(source))offenders.push(file);}
  assert.deepEqual(offenders,[],'dashboard CLI spawns must pass MDB_DASHBOARD_ALERT=false');
});
