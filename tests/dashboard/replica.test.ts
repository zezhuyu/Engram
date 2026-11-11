import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { enrollReplicaDevice, listReplicaDevices } from '../../packages/replication/devices.js';

const auth = (root: string) => ({ env: {}, homeDir: root, platform: 'linux' as NodeJS.Platform });
test('client replica routes require session and same-origin mutations; empty state is explicit and token-free', async t => {
  const v = await disposableVault(), replicaDir = path.join(v.root, 'replicas');
  const oldDir = process.env.ENGRAM_REPLICA_DIR; process.env.ENGRAM_REPLICA_DIR = replicaDir;
  const server = await createDashboardServer({ engram: v.engram, host: '127.0.0.1', port: 0, clientMode: true, authLocation: auth(v.root) });
  t.after(async () => { await server.close(); await v.cleanup(); if (oldDir === undefined) delete process.env.ENGRAM_REPLICA_DIR; else process.env.ENGRAM_REPLICA_DIR = oldDir; });
  const origin = 'http://127.0.0.1:' + server.port;
  assert.equal((await fetch(origin + '/api/client/replica')).status, 401);
  const password = 'replica-dashboard-test-password-73';
  const setup = await fetch(origin + '/api/auth/setup', { method:'POST', headers:{Origin:origin,'Content-Type':'application/json'}, body:JSON.stringify({token:server.token,password,confirm:password}) });
  assert.equal(setup.status,200); const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})}); assert.equal(login.status,200); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = () => fetch(origin + '/api/client/replica', { headers:{Cookie:cookie,'X-Engram-Dashboard':'1'} });
  const empty = await get(); assert.equal(empty.status,200); assert.deepEqual(await empty.json(),{enabled:false,state:'disabled',lastSyncAt:null,replicas:[]});
  const withoutOrigin = await fetch(origin + '/api/client/replica/enable',{method:'POST',headers:{Cookie:cookie,'X-Engram-Dashboard':'1','Content-Type':'application/json'},body:'{}'}); assert.equal(withoutOrigin.status,401);
  const enable = await fetch(origin + '/api/client/replica/enable',{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-Engram-Dashboard':'1','Content-Type':'application/json'},body:'{}'}); assert.equal(enable.status,400); assert.match((await enable.text()),/server URL and private token file/);
  const tokenFile=path.join(v.root,'replica-token'); await fs.writeFile(tokenFile,'unused-local-test-token',{mode:0o600});
  const { initializeReplica } = await import('../../packages/replication/client.js'); await initializeReplica({serverUrl:'http://127.0.0.1:45678',tokenFile,name:'test-replica',baseDir:replicaDir});
  const summary=await (await get()).json() as any; assert.equal(summary.enabled,true); assert.equal(summary.replicas[0].state,'Daemon stopped'); assert.equal(summary.replicas[0].status.serverUrl,undefined); assert.equal(summary.replicas[0].status.deviceId,undefined);
  const projects=await fetch(origin+'/api/client/replica/projects',{headers:{Cookie:cookie,'X-Engram-Dashboard':'1'}}); assert.equal(projects.status,200); assert.deepEqual((await projects.json() as any).rows,[]);
});


test('owner device unenrollment requires session, same-origin, password re-auth, and writes an audit record', async t => {
  const v=await disposableVault(),server=await createDashboardServer({engram:v.engram,host:'127.0.0.1',port:0,authLocation:auth(v.root)});t.after(async()=>{await server.close();await v.cleanup()});
  const credential=await createHttpCredential(v.engram.vault,'device-owner',['workspace:proj:read']);const deviceId='00000000-0000-4000-8000-000000000111';await enrollReplicaDevice(v.root,credential.id,'device-owner',deviceId,'Test laptop','proj','scope-v1');
  const origin='http://127.0.0.1:'+server.port,password='unenroll-dashboard-password-73';await fetch(origin+'/api/auth/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:server.token,password,confirm:password})});const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})}),cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const body=JSON.stringify({credentialId:credential.id,deviceId,workspaceId:'proj'}),headers={Cookie:cookie,Origin:origin,'X-Engram-Dashboard':'1','Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/api/clients/unenroll',{method:'POST',headers,body})).status,401);
  assert.equal((await fetch(origin+'/api/clients/unenroll',{method:'POST',headers:{...headers,'X-Engram-Reauth-Password':password},body})).status,200);
  assert.deepEqual((await listReplicaDevices(v.root))[0]?.enrolledScopes,[]);assert.match(await fs.readFile(path.join(v.root,'.mdb/dashboard/audit.jsonl'),'utf8'),/clients\.replica\.unenroll/);
});


test('replica enable uses saved server credentials, fake service manager, and stays idempotent', async t => {
  const v=await disposableVault(),replicaDir=path.join(v.root,'replicas'),tokenFile=path.join(v.root,'server-token'),token='opaque-token-value-must-not-leak';
  await fs.writeFile(tokenFile,token,{mode:0o600});const xdg=path.join(v.root,'xdg'),configDir=path.join(xdg,'engram');await fs.mkdir(configDir,{recursive:true});await fs.writeFile(path.join(configDir,'client.env'),'ENGRAM_MCP_URL=\"http://127.0.0.1:45678\"\nENGRAM_TOKEN_FILE='+JSON.stringify(tokenFile)+'\n',{mode:0o600});const oldDir=process.env.ENGRAM_REPLICA_DIR,oldXdg=process.env.XDG_CONFIG_HOME;process.env.ENGRAM_REPLICA_DIR=replicaDir;process.env.XDG_CONFIG_HOME=xdg;let installs=0;
  const server=await createDashboardServer({engram:v.engram,host:'127.0.0.1',port:0,clientMode:true,authLocation:auth(v.root),serviceManager:async action=>{assert.equal(action,'install');installs++;return{installed:true}}});
  t.after(async()=>{await server.close();await v.cleanup();if(oldDir===undefined)delete process.env.ENGRAM_REPLICA_DIR;else process.env.ENGRAM_REPLICA_DIR=oldDir;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg});
  const origin='http://127.0.0.1:'+server.port,password='replica-enable-dashboard-password-73';await fetch(origin+'/api/auth/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:server.token,password,confirm:password})});const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})}),cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const enable=()=>fetch(origin+'/api/client/replica/enable',{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-Engram-Dashboard':'1','Content-Type':'application/json'},body:'{}'});const first=await enable();assert.equal(first.status,201);const firstText=await first.text();assert.doesNotMatch(firstText,new RegExp(token));const second=await enable();assert.equal(second.status,200);assert.equal(installs,2);
  const configs=await (await import('../../packages/replication/client.js')).listReplicaConfigs(replicaDir);assert.equal(configs.length,1);
});
