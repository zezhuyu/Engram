import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { validateConnectorTestUrl, validateConnectorRedirect, connectorConfig, testConnectorConnection, resolveConnectorAddress } from '../../packages/dashboard/connectors.js';
import { openAIConfig, openAIStatus, saveOpenAIConfig, validateWorkspaceRow, discoverTunnelClient, deriveTunnelState, summarizeTunnelClientLog, TUNNEL_HEALTH_PORT, controlOpenAIServices } from '../../packages/dashboard/openai-tunnel.js';
import { assets } from '../../packages/dashboard/ui/view-model.js';
import { resolveHttpActor } from '../../packages/mcp/credentials.js';
import { Vault } from '../../packages/core/vault.js';
import { logoAssets } from '../../packages/dashboard/ui/logo-assets.js';
import { desktopConfigTarget } from '../../packages/dashboard/claude-local.js';
import { saveAnthropicTunnel, anthropicTunnelStatus, generateAnthropicCertificates, anthropicTunnelDir } from '../../packages/dashboard/anthropic-tunnel.js';
import { disposableVault } from './helpers.js';

async function call(port: number, path: string, options: { method?: string; cookie?: string; csrf?: boolean; origin?: boolean; token?: string; reauth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers['X-Engram-Dashboard'] = '1';
  if (options.origin) headers.Origin = `http://127.0.0.1:${port}`;
  if (options.token) headers.Authorization = `Bearer ${options.token}`; if (options.reauth) headers['X-Engram-Reauth-Password'] = options.reauth;
  if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: options.method ?? 'GET', headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  return { status: response.status, headers: response.headers, body: await response.text() };
}
async function signedIn(t: import('node:test').TestContext) {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const setup = await call(dashboard.port, '/api/auth/setup', { method: 'POST', origin: true, csrf: true, body: { token: dashboard.token, password: 'correct horse battery staple', confirm: 'correct horse battery staple' } }); assert.equal(setup.status, 200);
  const login = await call(dashboard.port, '/api/auth/login', { method: 'POST', origin: true, csrf: true, body: { password: 'correct horse battery staple' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return { ...v, dashboard, cookie };
}

test('OpenAI tunnel config is write-only, merged into private env, and leaves legacy fields ignored', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-openai-home-')),bin=path.join(base,'bin');process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});process.env.PATH=bin+path.delimiter+(oldPath??'');
  for(const name of ['launchctl','systemctl'])await fs.writeFile(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o700});
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await fs.rm(base,{recursive:true,force:true})});
  const { root, dashboard, cookie, engram } = await signedIn(t), secret='fixture-tunnel-secret-never-return';
  const legacyFile=path.join(root,'.mdb/dashboard/connectors.json');await fs.mkdir(path.dirname(legacyFile),{recursive:true});await fs.writeFile(legacyFile,JSON.stringify({version:1,connectors:{openai:{publicUrl:'https://legacy.invalid',oauthClientSecret:'legacy-oauth'}}}),{mode:0o600});
  const secretDir=path.join(base,'.config/engram');await fs.mkdir(secretDir,{recursive:true});await fs.writeFile(path.join(secretDir,'chatgpt-tunnel.env'),'PRESERVE_THIS=keep-me\n',{mode:0o600});
  const saved=await call(dashboard.port,'/api/connectors/openai/config',{method:'POST',cookie,csrf:true,origin:true,body:{tunnelId:'tunnel-id-123',apiKey:secret,organizationId:'org-42',profileName:'engram-keyed'}});
  assert.equal(saved.status,200);assert.doesNotMatch(saved.body,/fixture-tunnel-secret|legacy.invalid|legacy-oauth/);
  const envFile=path.join(base,'.config/engram/chatgpt-tunnel.env'),env=await fs.readFile(envFile,'utf8');assert.match(env,/ENGRAM_TUNNEL_ID=/);assert.match(env,/ENGRAM_OPENAI_ORGANIZATION_ID=/);assert.match(env,/ENGRAM_TUNNEL_RUNTIME_KEY=/);assert.match(env,/fixture-tunnel-secret/);assert.equal((await fs.stat(envFile)).mode&0o777,0o600);
  assert.match(env,/PRESERVE_THIS='keep-me'/);assert.deepEqual((await fs.readdir(secretDir)).filter(file=>file.endsWith('.tmp')),[]);
  const profilePath=path.join(secretDir,'tunnel-client/engram-keyed.yaml'),profile=await fs.readFile(profilePath,'utf8');assert.match(profile,/api_key: "env:ENGRAM_TUNNEL_RUNTIME_KEY"/);assert.match(profile,/health:\n  listen_addr: "127\.0\.0\.1:3337"/);assert.match(profile,/127\.0\.0\.1:3335\/mcp/);assert.doesNotMatch(profile,/fixture-tunnel-secret/);assert.equal((await fs.stat(profilePath)).mode&0o777,0o600);
  const state=await call(dashboard.port,'/api/connectors',{cookie,csrf:true});assert.doesNotMatch(state.body,/fixture-tunnel-secret|legacy.invalid|legacy-oauth/);const stateJson=JSON.parse(state.body);assert.equal(stateJson.connectors.openai.publicUrl,undefined);assert.equal(stateJson.connectors.openai.oauthClientId,undefined);assert.equal(stateJson.connectors.openai.apiKeySet,true);assert.equal(stateJson.connectors.openai.tunnelId,'tunnel-id-123');assert.equal(stateJson.connectors.openai.organizationId,'org-42');
  assert.equal(await fs.readFile(legacyFile,'utf8').then(text=>text.includes('legacy.invalid')&&text.includes('legacy-oauth')),true);assert.deepEqual(await connectorConfig(root).then(config=>config.openai),{});
  const oldApi=await call(dashboard.port,'/api/connectors/config',{method:'POST',cookie,csrf:true,origin:true,body:{connector:'openai',values:{publicUrl:'https://legacy.invalid'},confirm:'SAVE OPENAI CONNECTOR'}});assert.equal(oldApi.status,410);
  assert.deepEqual((await openAIConfig(root)).profileName,'engram-keyed');
  await fs.chmod(envFile,0o644);await assert.rejects(()=>saveOpenAIConfig(root,{profileName:'changed'}),/owned regular 0600/);await fs.chmod(envFile,0o600);
  assert.throws(()=>validateWorkspaceRow({name:'BAD NAME',workspace:'alpha'}),/lowercase slug/);
  await assert.rejects(()=>saveOpenAIConfig(root,{apiKey:'bad\nvalue'}),/Invalid/);
  assert.deepEqual(await engram.vault.listWorkspaces().then(items=>items.map(item=>item.id)),['personal']);
});
test('OpenAI workspace credentials are scoped, stored only in gateway env, and revoked on removal', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-openai-home-')),bin=path.join(base,'bin');process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});process.env.PATH=bin+path.delimiter+(oldPath??'');
  for(const name of ['launchctl','systemctl'])await fs.writeFile(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o700});
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await fs.rm(base,{recursive:true,force:true})});
  const { root, dashboard, cookie, engram }=await signedIn(t);await engram.vault.createWorkspace('alpha');await engram.vault.createCollection('alpha','notes');
  const denied=await call(dashboard.port,'/api/connectors/openai/workspaces',{method:'POST',origin:true,body:{name:'alpha',workspace:'alpha'}});assert.equal(denied.status,401);
  const created=await call(dashboard.port,'/api/connectors/openai/workspaces',{method:'POST',cookie,csrf:true,origin:true,body:{name:'alpha',workspace:'alpha',collection:'notes'}});assert.equal(created.status,201);assert.doesNotMatch(created.body,/engram_[A-Za-z0-9_-]{30}/);
  const envFile=path.join(base,'.config/engram/keyed-gateway.env'),env=await fs.readFile(envFile,'utf8');assert.equal((await fs.stat(envFile)).mode&0o777,0o600);assert.match(env,/GATEWAY_WORKSPACES=/);assert.match(env,/ENGRAM_TOKEN_ALPHA=/);const token=env.split('\n').find(line=>line.startsWith('ENGRAM_TOKEN_ALPHA='))?.slice('ENGRAM_TOKEN_ALPHA='.length).replace(/^'|'$/g,'');assert.ok(token);const credential=JSON.parse(await fs.readFile(path.join(root,'.mdb/http-credentials.json'),'utf8'));const alphaCredential=credential.credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-alpha');assert.ok(alphaCredential);assert.deepEqual(alphaCredential.permissions,['workspace:alpha:collection:notes:read','workspace:alpha:collection:notes:write']);assert.equal(createHash('sha256').update(token).digest('hex'),alphaCredential.tokenHash);assert.ok(!JSON.stringify(credential).includes(token));
  const actor=await resolveHttpActor(root,'Bearer '+token);assert.ok(actor);const scoped=new Vault(root,actor);assert.equal(await scoped.canAccess({type:'workspace',workspaceId:'alpha',collectionId:'notes'},'read'),true);assert.equal(await scoped.canAccess({type:'workspace',workspaceId:'alpha',collectionId:'notes'},'write'),true);assert.equal(await scoped.canAccess({type:'workspace',workspaceId:'alpha'},'read'),false);assert.equal(await scoped.canAccess({type:'workspace',workspaceId:'alpha',collectionId:'other'},'read'),false);
  const writesOff=await call(dashboard.port,'/api/connectors/openai/writes',{method:'POST',cookie,csrf:true,origin:true,body:{enabled:false}});assert.equal(writesOff.status,200);const disabledCredential=JSON.parse(await fs.readFile(path.join(root,'.mdb/http-credentials.json'),'utf8')).credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-alpha');assert.ok(disabledCredential);assert.equal(disabledCredential.permissions.some((permission:string)=>permission.endsWith(':write')),false);
  const writesOn=await call(dashboard.port,'/api/connectors/openai/writes',{method:'POST',cookie,csrf:true,origin:true,body:{enabled:true}});assert.equal(writesOn.status,200);const enabledCredential=JSON.parse(await fs.readFile(path.join(root,'.mdb/http-credentials.json'),'utf8')).credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-alpha');assert.ok(enabledCredential);assert.equal(enabledCredential.permissions.some((permission:string)=>permission.endsWith(':write')),true);
  const listed=await call(dashboard.port,'/api/connectors/openai/status',{cookie,csrf:true});assert.doesNotMatch(listed.body,new RegExp(token));
  const rotated=await call(dashboard.port,'/api/connectors/openai/workspaces/alpha/rotate',{method:'POST',cookie,csrf:true,origin:true});assert.equal(rotated.status,200);assert.equal(await resolveHttpActor(root,'Bearer '+token,undefined,undefined,false),undefined);const rotatedEnv=await fs.readFile(envFile,'utf8'),rotatedToken=rotatedEnv.split('\n').find(line=>line.startsWith('ENGRAM_TOKEN_ALPHA='))?.slice('ENGRAM_TOKEN_ALPHA='.length).replace(/^'|'$/g,'');assert.ok(rotatedToken);assert.ok(await resolveHttpActor(root,'Bearer '+rotatedToken));
  const removed=await call(dashboard.port,'/api/connectors/openai/workspaces/alpha',{method:'DELETE',cookie,csrf:true,origin:true});assert.equal(removed.status,200);const remaining=JSON.parse(await fs.readFile(path.join(root,'.mdb/http-credentials.json'),'utf8')).credentials;assert.deepEqual(remaining.map((item:{actorId:string})=>item.actorId),['chatgpt-gateway']);assert.doesNotMatch(await fs.readFile(envFile,'utf8'),new RegExp(token));
});
test('ChatGPT gateway credential is created once, lists readable workspaces, and gates project writes in ACL and gateway settings', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-chatgpt-gateway-')),bin=path.join(base,'bin');process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});process.env.PATH=bin+path.delimiter+(oldPath??'');
  for(const name of ['launchctl','systemctl'])await fs.writeFile(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o700});
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await fs.rm(base,{recursive:true,force:true})});
  const {root,dashboard,cookie,engram}=await signedIn(t);await engram.vault.createWorkspace('alpha');await engram.vault.createWorkspace('beta');
  const configured=await call(dashboard.port,'/api/connectors/openai/config',{method:'POST',cookie,csrf:true,origin:true,body:{tunnelId:'private-tunnel',apiKey:'private-api-key'}});assert.equal(configured.status,200,configured.body);assert.doesNotMatch(configured.body,/engram_[A-Za-z0-9_-]{30}/);
  const settings=JSON.parse((await call(dashboard.port,'/api/connectors/openai/status',{cookie,csrf:true})).body).config;assert.equal(settings.allowAnyWorkspaceByName,true);assert.deepEqual(settings.reachableWorkspaces.map((item:{name:string})=>item.name),['wiki','alpha','beta','personal']);assert.equal(settings.reachableWorkspaces[0].allowWrites,true);assert.equal(settings.reservedNames.includes('wiki'),true);assert.equal(settings.workspaces.find((item:{name:string})=>item.name==='personal').isDefault,true);assert.equal(settings.workspaces.find((item:{name:string})=>item.name==='personal').allowWrites,true);
  const envFile=path.join(base,'.config/engram/keyed-gateway.env'),env=await fs.readFile(envFile,'utf8');assert.equal((await fs.stat(envFile)).mode&0o777,0o600);const tokenLine=env.split('\n').find(line=>line.startsWith('ENGRAM_TOKEN_CHATGPT_GATEWAY='));assert.ok(tokenLine);const token=tokenLine.slice(tokenLine.indexOf('=')+1).replace(/^'|'$/g,'');assert.match(token,/^engram_/);assert.doesNotMatch(configured.body+JSON.stringify(settings),new RegExp(token));assert.doesNotMatch((await call(dashboard.port,'/api/connectors/openai/status',{cookie,csrf:true})).body,new RegExp(token));
  const registryPath=path.join(root,'.mdb/http-credentials.json'),first=JSON.parse(await fs.readFile(registryPath,'utf8')).credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-gateway');assert.ok(first);assert.ok(first.permissions.includes('workspace:alpha:read'));assert.ok(first.permissions.includes('workspace:beta:read'));assert.ok(first.permissions.includes('workspace:personal:write'));assert.ok(first.permissions.includes('global:profile:read'));assert.ok(first.permissions.includes('global:profile:write'));assert.ok(first.permissions.includes('global:wiki:read'));assert.ok(first.permissions.includes('global:wiki:write'));assert.ok(first.permissions.includes('global:shared:read'));assert.equal(first.permissions.includes('workspace:alpha:write'),true);
  const resaved=await call(dashboard.port,'/api/connectors/openai/config',{method:'POST',cookie,csrf:true,origin:true,body:{tunnelId:'private-tunnel',apiKey:'private-api-key'}});assert.equal(resaved.status,200);const afterResave=JSON.parse(await fs.readFile(registryPath,'utf8')).credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-gateway');assert.equal(afterResave.id,first.id,'same settings do not mint or rotate a duplicate gateway credential');
  const disabledWorkspace=await call(dashboard.port,'/api/connectors/openai/workspaces/alpha/write',{method:'POST',cookie,csrf:true,origin:true,body:{allowWrites:false}});assert.equal(disabledWorkspace.status,200,disabledWorkspace.body);assert.doesNotMatch(disabledWorkspace.body,new RegExp(token));const changed=JSON.parse(await fs.readFile(registryPath,'utf8')).credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-gateway');assert.notEqual(changed.id,first.id);assert.equal(changed.permissions.includes('workspace:alpha:write'),false);assert.ok(changed.permissions.includes('workspace:beta:write'));const gatewayEnv=await fs.readFile(envFile,'utf8');assert.match(gatewayEnv,/GATEWAY_DYNAMIC_WRITABLE_WORKSPACES='\["beta","personal"\]'/);
  const newTokenLine=gatewayEnv.split('\n').find(line=>line.startsWith('ENGRAM_TOKEN_CHATGPT_GATEWAY='))!;const newToken=newTokenLine.slice(newTokenLine.indexOf('=')+1).replace(/^'|'$/g,'');const actor=await resolveHttpActor(root,'Bearer '+newToken,undefined,undefined,false);assert.ok(actor);assert.equal(await new Vault(root,actor).canAccess({type:'workspace',workspaceId:'beta'},'write'),true);
  const disabled=await call(dashboard.port,'/api/connectors/openai/by-name',{method:'POST',cookie,csrf:true,origin:true,body:{enabled:false}});assert.equal(disabled.status,200);assert.equal(JSON.parse(disabled.body).config.allowAnyWorkspaceByName,false);assert.match(await fs.readFile(envFile,'utf8'),/GATEWAY_ALLOW_ANY_WORKSPACE_BY_NAME='false'/);
  const writesOff=await call(dashboard.port,'/api/connectors/openai/writes',{method:'POST',cookie,csrf:true,origin:true,body:{enabled:false}});assert.equal(writesOff.status,200);assert.equal(JSON.parse(writesOff.body).config.chatGPTMayWrite,false);assert.match(await fs.readFile(envFile,'utf8'),/GATEWAY_WRITES_ENABLED='false'/);const disabledAll=JSON.parse(await fs.readFile(registryPath,'utf8')).credentials.find((item:{actorId:string})=>item.actorId==='chatgpt-gateway');assert.equal(disabledAll.permissions.some((permission:string)=>permission.endsWith(':write')),false);
});
test('service control requires session CSRF and password re-auth and uses fixed service-manager arguments', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,oldLog=process.env.FAKE_SERVICE_MANAGER_LOG,oldGatewayPort=process.env.ENGRAM_KEYED_GATEWAY_PORT,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-openai-home-')),binDir=path.join(base,'bin');process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(binDir,{recursive:true});process.env.PATH=binDir+path.delimiter+(oldPath??'');
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;if(oldLog===undefined)delete process.env.FAKE_SERVICE_MANAGER_LOG;else process.env.FAKE_SERVICE_MANAGER_LOG=oldLog;if(oldGatewayPort===undefined)delete process.env.ENGRAM_KEYED_GATEWAY_PORT;else process.env.ENGRAM_KEYED_GATEWAY_PORT=oldGatewayPort;await fs.rm(base,{recursive:true,force:true})});
  const commands=path.join(base,'commands');
  let gatewayHealthy=true;const health=createServer((_req,res)=>{res.statusCode=gatewayHealthy?200:503;res.setHeader('content-type','application/json');res.end('{"ok":true}')});await new Promise<void>(resolve=>health.listen(0,'127.0.0.1',resolve));const healthAddress=health.address();assert.ok(healthAddress&&typeof healthAddress==='object');process.env.ENGRAM_KEYED_GATEWAY_PORT=String(healthAddress.port);t.after(async()=>{await new Promise<void>(resolve=>health.close(()=>resolve()))});
  for (const name of ['launchctl','systemctl']) await fs.writeFile(path.join(binDir,name),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_SERVICE_MANAGER_LOG"\ncase "$*" in *print*|*show*) printf "state = running\\nActiveState=active\\nMainPID=4132\\n";; esac\nexit 0\n',{mode:0o700});
  process.env.FAKE_SERVICE_MANAGER_LOG=commands;
  const tunnel=path.join(base,'.config/engram/tunnel-client/tunnel-client');await fs.mkdir(path.dirname(tunnel),{recursive:true});await fs.writeFile(tunnel,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const { dashboard,cookie,engram }=await signedIn(t);const missing=await call(dashboard.port,'/api/connectors/openai/start',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{}});assert.equal(missing.status,400);assert.match(missing.body,/tunnel ID and API key/);assert.doesNotMatch(await fs.readFile(commands,'utf8').catch(()=>''),/bootstrap|kickstart|bootout/,'preflight may inspect service status but must not mutate launchd');assert.deepEqual((await call(dashboard.port,'/api/connectors/openai/status',{cookie,csrf:true})).body.includes('personal'),true);const saved=await call(dashboard.port,'/api/connectors/openai/config',{method:'POST',cookie,csrf:true,origin:true,body:{tunnelId:'tunnel-id-test',apiKey:'tunnel-key-test'}});assert.equal(saved.status,200);assert.equal(JSON.parse((await call(dashboard.port,'/api/connectors/openai/status',{cookie,csrf:true})).body).config.workspaces.length,1,'the default row alone satisfies the workspace prerequisite');assert.equal((await call(dashboard.port,'/api/connectors/openai/start',{method:'POST',cookie,origin:true,body:{}})).status,401);assert.equal((await call(dashboard.port,'/api/connectors/openai/start',{method:'POST',cookie,csrf:true,origin:true,reauth:'wrong password',body:{}})).status,401);
  const started=await call(dashboard.port,'/api/connectors/openai/start',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{}});assert.equal(started.status,200);const log=await fs.readFile(commands,'utf8');assert.match(log,/bootstrap gui\/\d+ .*dev\.engram\.keyed-gateway\.plist/);assert.match(log,/kickstart -k gui\/\d+\/dev\.engram\.tunnel-client/);assert.doesNotMatch(log,/correct horse battery staple|apiKey|token/i);
  const stopped=await call(dashboard.port,'/api/connectors/openai/stop',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{}});assert.equal(stopped.status,200);assert.match(await fs.readFile(commands,'utf8'),/bootout gui\/\d+\/dev\.engram\.keyed-gateway/);
  const launcher=path.join(base,'.config/engram/keyed-gateway-launcher.sh');assert.equal((await fs.stat(launcher)).mode&0o777,0o700);assert.match(await fs.readFile(launcher,'utf8'),/exec .*node.*keyed-gateway\.mjs/);gatewayHealthy=false;const beforeFailure=await fs.readFile(commands,'utf8'),failedRestart=await call(dashboard.port,'/api/connectors/openai/restart',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{}});assert.equal(failedRestart.status,400);assert.match(failedRestart.body,/did not become healthy/);const afterFailure=await fs.readFile(commands,'utf8'),newCalls=afterFailure.slice(beforeFailure.length);assert.match(newCalls,/bootout gui\/\d+\/dev\.engram\.keyed-gateway/);assert.doesNotMatch(newCalls,/kickstart -k gui\/\d+\/dev\.engram\.tunnel-client/);
});
test('tunnel-client discovery checks only executable files and validation is bounded', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-openai-home-'));process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;await fs.rm(base,{recursive:true,force:true})});
  assert.deepEqual(validateWorkspaceRow({name:'read-only',workspace:'alpha'}),{name:'read-only',workspace:'alpha',allowWrites:true});assert.equal((await discoverTunnelClient()).found,false);
  const bin=path.join(base,'.config/engram/tunnel-client/tunnel-client');await fs.mkdir(path.dirname(bin),{recursive:true});await fs.writeFile(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});assert.deepEqual(await discoverTunnelClient(),{found:true,path:bin});
});

test('tunnel state derivation distinguishes stopped, startup, ready, not-ready, and failure', () => {
  const cases: Array<[string, Parameters<typeof deriveTunnelState>[0], string]> = [
    ['not loaded', { loaded: false, running: false, ready: false, uptimeMs: null }, 'stopped'],
    ['loaded but not running', { loaded: true, running: false, ready: false, uptimeMs: 20_000 }, 'stopped'],
    ['starting within grace', { loaded: true, running: true, ready: false, uptimeMs: 1_000 }, 'starting'],
    ['ready during grace', { loaded: true, running: true, ready: true, uptimeMs: 1_000 }, 'connected'],
    ['ready after grace', { loaded: true, running: true, ready: true, uptimeMs: 20_000 }, 'connected'],
    ['not ready after grace', { loaded: true, running: true, ready: false, uptimeMs: 20_000 }, 'running-not-ready'],
    ['crash with a relevant error', { loaded: true, running: false, ready: false, uptimeMs: 20_000, failureReason: 'network unreachable' }, 'failing'],
    ['error after grace', { loaded: true, running: true, ready: false, uptimeMs: 20_000, failureReason: 'network unreachable' }, 'failing'],
  ];
  for (const [label, input, expected] of cases) assert.equal(deriveTunnelState(input), expected, label);
});

test('tunnel-client JSON log summary ignores OAuth discovery 404 and redacts actionable failures', () => {
  const summary = summarizeTunnelClientLog([
    '{"timestamp":"2026-11-09T18:14:00.000Z","level":"WARN","message":"OAuth discovery failed: empty body (status 404)"}',
    '{"timestamp":"2026-11-09T18:14:01.000Z","level":"INFO","message":"tunnel-client started"}',
    '{"timestamp":"2026-11-09T18:14:02.000Z","level":"INFO","message":"mcp session initialized"}',
    '{"timestamp":"2026-11-09T18:14:03.000Z","level":"ERROR","message":"API key rejected api_key=fixture-secret"}',
  ].join('\n'));
  assert.equal(summary.failureReason, 'Tunnel ID or API key was rejected; verify both values in tunnel settings.');
  assert.deepEqual(summary.recentLogLines, ['tunnel-client started', 'mcp session initialized', 'API key rejected [redacted]']);
  assert.doesNotMatch(JSON.stringify(summary), /OAuth discovery|fixture-secret/);
  for(const [message,guidance] of ([
    ['bad tunnel id','Tunnel ID or API key was rejected'],
    ['organization id mismatch','Organization ID mismatch'],
    ['network unreachable','cannot reach its network endpoint'],
  ] as Array<[string,string]>)) assert.match(summarizeTunnelClientLog(JSON.stringify({level:'ERROR',message})).failureReason!,new RegExp(guidance));
});

test('OpenAI status route probes only the configured loopback readyz and reports tunnel lifecycle states', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,oldGatewayPort=process.env.ENGRAM_KEYED_GATEWAY_PORT,oldFakeLog=process.env.FAKE_LAUNCHCTL_LOG,oldFakeState=process.env.FAKE_LAUNCHCTL_STATE,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-tunnel-status-')),bin=path.join(base,'bin'),commandLog=path.join(base,'launchctl.log'),managerState=path.join(base,'manager-state');
  process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});process.env.PATH=bin+path.delimiter+(oldPath??'');
  const managerScript=process.platform==='darwin'?'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_LOG"\ncat "$FAKE_LAUNCHCTL_STATE"\n':'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_LOG"\ncat "$FAKE_LAUNCHCTL_STATE"\n';
  for(const name of ['launchctl','systemctl'])await fs.writeFile(path.join(bin,name),managerScript,{mode:0o700});process.env.FAKE_LAUNCHCTL_LOG=commandLog;process.env.FAKE_LAUNCHCTL_STATE=managerState;
  let healthBody='ready',healthCode=200,healthRequests=0;
  const healthServer=createServer((_request,response)=>{healthRequests++;response.statusCode=healthCode;response.end(healthBody)}),gatewayServer=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end('{"ok":true}')});await new Promise<void>(resolve=>healthServer.listen(0,'127.0.0.1',resolve));await new Promise<void>(resolve=>gatewayServer.listen(0,'127.0.0.1',resolve));const healthPort=(healthServer.address() as import('node:net').AddressInfo).port;process.env.ENGRAM_KEYED_GATEWAY_PORT=String((gatewayServer.address() as import('node:net').AddressInfo).port);
  t.after(async()=>{await Promise.all([new Promise<void>(resolve=>healthServer.close(()=>resolve())),new Promise<void>(resolve=>gatewayServer.close(()=>resolve()))]);for(const [key,value] of [['HOME',oldHome],['XDG_CONFIG_HOME',oldXdg],['PATH',oldPath],['ENGRAM_KEYED_GATEWAY_PORT',oldGatewayPort],['FAKE_LAUNCHCTL_LOG',oldFakeLog],['FAKE_LAUNCHCTL_STATE',oldFakeState]] as Array<[string,string|undefined]>){if(value===undefined)delete process.env[key];else process.env[key]=value}await fs.rm(base,{recursive:true,force:true})});
  const {root,dashboard,cookie}=await signedIn(t);await saveOpenAIConfig(root,{tunnelId:'test-tunnel',apiKey:'unused-test-key'});
  const profile=path.join(base,'.config/engram/tunnel-client/engram-keyed.yaml');await fs.writeFile(profile,(await fs.readFile(profile,'utf8')).replace('127.0.0.1:'+TUNNEL_HEALTH_PORT,'127.0.0.1:'+healthPort));
  const logs=path.join(base,'Library/Logs/Engram');await fs.mkdir(logs,{recursive:true});await fs.writeFile(path.join(logs,'tunnel-client.log'),JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'tunnel-client started'})+'\n');
  await fs.writeFile(managerState,'state = running\npid = 57401\nlast exit code = 0\n');
  const route=async()=>JSON.parse((await call(dashboard.port,'/api/connectors/openai/status',{cookie,csrf:true})).body).status.tunnelClient;
  const connected=await route();assert.equal(connected.state,'connected');assert.equal(connected.healthUrl,'http://127.0.0.1:'+healthPort+'/readyz');
  const profileText=await fs.readFile(profile,'utf8'),requestsBeforeRejectedUrl=healthRequests;await fs.writeFile(profile,profileText.replace('127.0.0.1:'+healthPort,'0.0.0.0:'+healthPort));assert.equal((await route()).healthUrl,null);assert.equal(healthRequests,requestsBeforeRejectedUrl,'status must not probe a non-loopback profile address');
  await fs.writeFile(profile,profileText.replace('127.0.0.1:'+healthPort,'127.0.0.1:0'));await fs.writeFile(path.join(logs,'tunnel-client.log'),[JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'tunnel-client started'}),JSON.stringify({level:'INFO',message:'health_url: http://127.0.0.1:'+healthPort+'/healthz'})].join('\n')+'\n');const fallback=await route();assert.equal(fallback.state,'connected');assert.equal(fallback.healthUrl,'http://127.0.0.1:'+healthPort+'/readyz');assert.ok(fallback.recentLogLines.some((line:string)=>line.includes('[URL]')),'log URLs are redacted in the details list');
  healthBody='starting';assert.equal((await route()).state,'starting');
  await fs.writeFile(path.join(logs,'tunnel-client.log'),JSON.stringify({timestamp:new Date(Date.now()-20_000).toISOString(),level:'INFO',message:'tunnel-client started'})+'\n');healthCode=503;assert.equal((await route()).state,'running-not-ready');
  await fs.writeFile(managerState,'state = waiting\npid = 0\nlast exit code = 1\n');await fs.writeFile(path.join(logs,'tunnel-client.log'),JSON.stringify({timestamp:new Date().toISOString(),level:'ERROR',message:'network unreachable'})+'\n');const failed=await route();assert.equal(failed.state,'failing');assert.match(failed.failureReason,/network endpoint/);
  await fs.writeFile(managerState,'state = running\npid = 57402\nlast exit code = 0\n');healthCode=200;healthBody='ready';await fs.writeFile(profile,profileText);await fs.writeFile(path.join(logs,'tunnel-client.log'),JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'tunnel-client started'})+'\n');assert.equal((await route()).state,'connected');
  const before=await fs.readFile(commandLog,'utf8');assert.equal(await controlOpenAIServices(root,'start'),true);const after=await fs.readFile(commandLog,'utf8');assert.doesNotMatch(after.slice(before.length),/bootstrap|kickstart|bootout/,'Start on a healthy running pair must not restart either service');
});

test('gateway crash-loop status exposes only a sanitized last error line', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-gateway-status-')),bin=path.join(base,'bin');
  process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});process.env.PATH=bin+path.delimiter+(oldPath??'');
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await fs.rm(base,{recursive:true,force:true})});
  await fs.writeFile(path.join(bin,'launchctl'),'#!/bin/sh\nprintf "state = waiting\\nlast exit code = 1\\n"\nexit 0\n',{mode:0o700});
  const log=path.join(base,'Library/Logs/Engram/keyed-gateway.log');await fs.mkdir(path.dirname(log),{recursive:true});await fs.writeFile(log,'Error: no keys configured api_key=private-canary\n');
  const vault=await disposableVault();t.after(vault.cleanup);const status=await openAIStatus(vault.root);
  assert.match(status.gateway.failureReason!,/Gateway is failing: No workspace keys are configured: add at least one workspace row below, then start the gateway\./);assert.doesNotMatch(status.gateway.failureReason!,/private-canary/);assert.equal(status.keyedGateway.loaded,true);assert.equal(status.keyedGateway.running,false);assert.equal(status.keyedGateway.lastExitCode,1);
});

test('Claude local previews bind apply to exact config and claude.ai keys are private and one-time', async t => {
  const oldHome = process.env.HOME, oldXdg = process.env.XDG_CONFIG_HOME, oldPath = process.env.PATH, base = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-claude-home-')), bin = path.join(base, 'bin');
  process.env.HOME = base; process.env.XDG_CONFIG_HOME = path.join(base, '.config'); await fs.mkdir(bin, { recursive: true }); process.env.PATH = bin + path.delimiter + (oldPath ?? ''); await fs.writeFile(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 }); await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  t.after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; await fs.rm(base, { recursive: true, force: true }); });
  const { root, dashboard, cookie } = await signedIn(t), codeFile = path.join(base, '.claude.json');
  const noCsrf = await call(dashboard.port, '/api/connectors/claude/web', { method: 'POST', cookie, origin: true, body: { mode: 'fixed-header' } }); assert.equal(noCsrf.status, 401); assert.equal(await fs.stat(path.join(base, '.config/engram/claude-connector.env')).then(() => true, () => false), false);
  const local = await call(dashboard.port, '/api/connectors/claude/local', { cookie, csrf: true });
  assert.equal(local.status, 200); const localState = JSON.parse(local.body);
  assert.equal(path.isAbsolute(localState.node), true); assert.equal(path.isAbsolute(localState.mdbMcp), true); assert.equal(localState.claudeCode.state.engramPresent, false); assert.equal(localState.desktop.file !== null, process.platform === 'darwin' || process.platform === 'win32'); if (process.platform === 'linux') { assert.equal(desktopConfigTarget('linux').file, null); assert.match(desktopConfigTarget('linux').note ?? '', /unverified/); } assert.match(localState.command, /claude mcp add/); assert.match(localState.snippets.remote, /ENGRAM_MCP_TOKEN/);
  await fs.writeFile(codeFile, JSON.stringify({ existing: true, mcpServers: { other: { type: 'stdio' } } }), { mode: 0o600 });
  const preview = await call(dashboard.port, '/api/connectors/claude/local/preview', { method: 'POST', cookie, csrf: true, origin: true, body: { target: 'claude-code' } }); assert.equal(preview.status, 200);
  const shown = JSON.parse(preview.body); assert.equal(shown.file, codeFile); assert.ok(shown.backupPath); assert.match(shown.diff, /mcpServers/);
  const noReauth = await call(dashboard.port, '/api/connectors/claude/local/apply', { method: 'POST', cookie, csrf: true, origin: true, body: { previewId: shown.previewId, digest: shown.digest } }); assert.equal(noReauth.status, 401);
  const applied = await call(dashboard.port, '/api/connectors/claude/local/apply', { method: 'POST', cookie, csrf: true, origin: true, reauth: 'correct horse battery staple', body: { previewId: shown.previewId, digest: shown.digest } }); assert.equal(applied.status, 200); assert.equal(JSON.parse(applied.body).backupPath, shown.backupPath);
  assert.equal(JSON.parse(await fs.readFile(codeFile, 'utf8')).existing, true); assert.ok(JSON.parse(await fs.readFile(codeFile, 'utf8')).mcpServers.engram); assert.equal((await fs.stat(shown.backupPath)).isFile(), true);
  await fs.writeFile(codeFile, JSON.stringify({ mcpServers: { engram: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Engram-Workspace': 'alpha' } } } }));
  const presentCode = JSON.parse((await call(dashboard.port, '/api/connectors/claude/local', { cookie, csrf: true })).body); assert.equal(presentCode.claudeCode.state.engramPresent, true); assert.equal(presentCode.claudeCode.state.type, 'http'); assert.equal(presentCode.claudeCode.state.urlHost, 'mcp.example.test'); assert.equal(JSON.stringify(presentCode.claudeCode.state).includes('/mcp'), false);
  const stale = await call(dashboard.port, '/api/connectors/claude/local/preview', { method: 'POST', cookie, csrf: true, origin: true, body: { target: 'claude-code' } }); const stalePreview = JSON.parse(stale.body);
  await fs.writeFile(codeFile, '{}');
  const staleApply = await call(dashboard.port, '/api/connectors/claude/local/apply', { method: 'POST', cookie, csrf: true, origin: true, reauth: 'correct horse battery staple', body: { previewId: stalePreview.previewId, digest: stalePreview.digest } }); assert.equal(staleApply.status, 409); assert.match(staleApply.body, /changed after preview/);
  await fs.writeFile(codeFile, JSON.stringify({ mcpServers: { engram: { type: 'stdio', command: 'hand-written' } } }));
  const conflict = await call(dashboard.port, '/api/connectors/claude/local/preview', { method: 'POST', cookie, csrf: true, origin: true, body: { target: 'claude-code' } }); assert.equal(conflict.status, 409); assert.match(conflict.body, /conflicting hand-written/);
  const linuxDesktop = await call(dashboard.port, '/api/connectors/claude/local/preview', { method: 'POST', cookie, csrf: true, origin: true, body: { target: 'claude-desktop' } }); if (process.platform === 'linux') assert.equal(linuxDesktop.status, 409);
  if (localState.desktop.file) {
    const desktopFile = localState.desktop.file; await fs.mkdir(path.dirname(desktopFile), { recursive: true }); await fs.writeFile(desktopFile, JSON.stringify({ unrelated: 'keep' }), { mode: 0o640 });
    const desktopPreview = await call(dashboard.port, '/api/connectors/claude/local/preview', { method: 'POST', cookie, csrf: true, origin: true, body: { target: 'claude-desktop' } }); assert.equal(desktopPreview.status, 200); const desktopPlan = JSON.parse(desktopPreview.body); assert.equal(desktopPlan.file, desktopFile); assert.ok(desktopPlan.backupPath);
    const desktopApply = await call(dashboard.port, '/api/connectors/claude/local/apply', { method: 'POST', cookie, csrf: true, origin: true, reauth: 'correct horse battery staple', body: { previewId: desktopPlan.previewId, digest: desktopPlan.digest } }); assert.equal(desktopApply.status, 200); assert.equal((await fs.stat(desktopFile)).mode & 0o777, 0o640); assert.equal(JSON.parse(await fs.readFile(desktopFile, 'utf8')).unrelated, 'keep'); assert.ok(JSON.parse(await fs.readFile(desktopFile, 'utf8')).mcpServers.engram); assert.ok((await fs.readFile(desktopPlan.backupPath, 'utf8')).includes('unrelated'));
    await fs.writeFile(desktopFile, JSON.stringify({ mcpServers: { engram: { command: 'user-command' } } })); const desktopConflict = await call(dashboard.port, '/api/connectors/claude/local/preview', { method: 'POST', cookie, csrf: true, origin: true, body: { target: 'claude-desktop' } }); assert.equal(desktopConflict.status, 409); assert.match(desktopConflict.body, /conflicting hand-written/);
  }
  const invalidUrl = await call(dashboard.port, '/api/connectors/claude/web', { method: 'POST', cookie, csrf: true, origin: true, body: { url: 'https://user:pass@mcp.example.test/mcp?secret=x', mode: 'fixed-header' } }); assert.equal(invalidUrl.status, 400);
  const saved = await call(dashboard.port, '/api/connectors/claude/web', { method: 'POST', cookie, csrf: true, origin: true, body: { url: 'https://mcp.example.test/mcp', mode: 'fixed-header', headerName: 'x-api-key' } }); assert.equal(saved.status, 200, saved.body);
  const firstKey = JSON.parse(saved.body).oneTimeKey; assert.match(firstKey, /^[A-Za-z0-9_-]{40,}$/); assert.doesNotMatch(saved.body, /OAuth/);
  const secretFile = path.join(base, '.config/engram/claude-connector.env'); assert.equal((await fs.stat(secretFile)).mode & 0o777, 0o600); assert.match(await fs.readFile(secretFile, 'utf8'), new RegExp(firstKey));
  const claudeLauncher = path.join(base, '.config/engram/claude-keyed-gateway-launcher.sh'); assert.equal((await fs.stat(claudeLauncher)).mode & 0o777, 0o700); const launcherText = await fs.readFile(claudeLauncher, 'utf8'); assert.match(launcherText, /keyed-gateway\.env/); assert.match(launcherText, /claude-connector\.env/); assert.match(launcherText, /GATEWAY_PORT=3336/); assert.match(launcherText, /GATEWAY_INBOUND_HEADER='x-api-key'/); assert.doesNotMatch(launcherText, new RegExp(firstKey));
  const get = await call(dashboard.port, '/api/connectors/claude/web', { cookie, csrf: true }); assert.doesNotMatch(get.body, new RegExp(firstKey)); assert.equal(JSON.parse(get.body).config.keySet, true);
  const state = await call(dashboard.port, '/api/connectors', { cookie, csrf: true }); assert.doesNotMatch(state.body, new RegExp(firstKey)); assert.doesNotMatch(state.body, /oauthClientSecret|oauthClientId/);
  const deniedRotate = await call(dashboard.port, '/api/connectors/claude/web/rotate-key', { method: 'POST', cookie, csrf: true, origin: true, body: {} }); assert.equal(deniedRotate.status, 401);
  const deniedDelete = await call(dashboard.port, '/api/connectors/claude/web/key', { method: 'DELETE', cookie, csrf: true, origin: true, body: {} }); assert.equal(deniedDelete.status, 401);
  const rotated = await call(dashboard.port, '/api/connectors/claude/web/rotate-key', { method: 'POST', cookie, csrf: true, origin: true, reauth: 'correct horse battery staple', body: {} }); assert.equal(rotated.status, 200); const nextKey = JSON.parse(rotated.body).key; assert.notEqual(nextKey, firstKey); assert.doesNotMatch(rotated.body, new RegExp(firstKey));
  assert.match(await fs.readFile(secretFile, 'utf8'), new RegExp(nextKey));
  const logs = await fs.readFile(path.join(root, '.mdb/dashboard/audit.jsonl'), 'utf8').catch(() => ''); assert.doesNotMatch(logs, new RegExp(firstKey)); assert.doesNotMatch(logs, new RegExp(nextKey));
  const deleted = await call(dashboard.port, '/api/connectors/claude/web/key', { method: 'DELETE', cookie, csrf: true, origin: true, reauth: 'correct horse battery staple', body: {} }); assert.equal(deleted.status, 200); assert.equal((await fs.readFile(secretFile).catch(() => Buffer.alloc(0))).length, 0); await assert.rejects(() => fs.stat(claudeLauncher), { code: 'ENOENT' });
  assert.throws(() => validateConnectorTestUrl('http://mcp.example.test/mcp'), /HTTPS/);
});
test('connection URL policy rejects HTTP/private and cross-host redirects', async () => {
  assert.throws(() => validateConnectorTestUrl('http://memory.example.com'), /HTTPS/);
  assert.throws(() => validateConnectorTestUrl('https://127.0.0.1'), /Private and loopback/);
  assert.throws(() => validateConnectorTestUrl('https://192.168.1.2'), /Private and loopback/);
  assert.throws(() => validateConnectorTestUrl('https://memory.example.com?token=secret'), /HTTPS URL/);
  assert.throws(() => validateConnectorRedirect(new URL('https://memory.example.com/version'), 'https://attacker.example/collect'), /another host/);
  await assert.rejects(() => testConnectorConnection('https://localhost/version'), /Private and loopback/);
});

test('Anthropic tunnel config is validated, private, digest pinned, and certificates verify locally', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,oldOpenSslLog=process.env.FAKE_OPENSSL_LOG,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-anthropic-')),bin=path.join(base,'fake-bin');process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'docker'),'#!/bin/sh\ncase "$1" in --version) echo "Docker version 27.0.0";; info) echo 27;; compose) exit 0;; esac\n',{mode:0o700});await fs.writeFile(path.join(bin,'openssl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_OPENSSL_LOG"\nexit 1\n',{mode:0o700});process.env.PATH=bin+path.delimiter+(oldPath??'');process.env.FAKE_OPENSSL_LOG=path.join(base,'openssl.log');
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;if(oldOpenSslLog===undefined)delete process.env.FAKE_OPENSSL_LOG;else process.env.FAKE_OPENSSL_LOG=oldOpenSslLog;await fs.rm(base,{recursive:true,force:true})});
  const valid={tunnelId:'tnl_abcdefgh1234',tunnelDomain:'abcd1234.tunnel.anthropic.com',route:'memory',token:'sensitive-tunnel-token'};
  for(const bad of [{...valid,tunnelDomain:'bad host'},{...valid,upstream:'http://localhost:3336/path'},{...valid,upstream:'http://localhost:3336/'},{...valid,upstream:'http://localhost/no-port'},{...valid,upstream:'http://localhost:99999'},{...valid,route:'Bad_Route'},{...valid,listenPort:0},{...valid,token:"not-a-compose-token'"},{...valid,upstream:'file:///etc/passwd'}]) await assert.rejects(()=>saveAnthropicTunnel(base,bad));
  const saved=await saveAnthropicTunnel(base,valid);assert.equal(saved.tokenSet,true);assert.equal('token' in saved,false);
  const dir=anthropicTunnelDir(),env=await fs.readFile(path.join(dir,'anthropic-tunnel.env'),'utf8'),proxy=await fs.readFile(path.join(dir,'proxy.yaml'),'utf8'),compose=await fs.readFile(path.join(dir,'compose.yaml'),'utf8');
  const connectorStore=JSON.parse(await fs.readFile(path.join(base,'.mdb/dashboard/connectors.json'),'utf8'));assert.equal(connectorStore.connectors.anthropicTunnel.tunnelId,valid.tunnelId);assert.equal('token' in connectorStore.connectors.anthropicTunnel,false);await assert.rejects(()=>fs.stat(path.join(dir,'config.json')),{code:'ENOENT'});
  assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(dir,'anthropic-tunnel.env')).then(s=>s.mode&0o777)),0o600);assert.match(env,/ANTHROPIC_TUNNEL_TOKEN/);assert.doesNotMatch(proxy+compose, /sensitive-tunnel-token/);assert.match(proxy,/listen_addr: ":8080"/);assert.match(proxy,/routes:\n  memory: http:\/\/host\.docker\.internal:3336/);assert.match(compose,/mcp-proxy@sha256:d243d30642d39857a0579e465cb3b9bf3ae7c1141e83143bb6856777a31467a5/);assert.match(compose,/cloudflared@sha256:0e56c13c7058fcef9c4f0e7d83372f82330548dbf8f8b366f3d8b506526d93b2/);assert.match(compose,/network_mode: "service:mcp-proxy"/);assert.match(compose,/host-gateway/);
  await assert.rejects(()=>generateAnthropicCertificates(base),/openssl certificate operation failed/);const fakeArgs=await fs.readFile(process.env.FAKE_OPENSSL_LOG!,'utf8');assert.match(fakeArgs,/req -x509 -newkey rsa:3072 -nodes -days 3650 -subj \/CN=Engram Anthropic Tunnel CA/);assert.doesNotMatch(fakeArgs,/sensitive-tunnel-token/);await fs.unlink(path.join(bin,'openssl'));
  const result=await generateAnthropicCertificates(base);assert.match(result.caCertificate,/BEGIN CERTIFICATE/);assert.match(result.note,/upload only ca\.crt/i);assert.doesNotMatch(JSON.stringify(result),/PRIVATE KEY/);
  for(const name of ['ca.key','tls.key']) assert.equal((await fs.stat(path.join(dir,'data',name))).mode&0o777,0o600);
  const verified=spawnSync('openssl',['verify','-CAfile',path.join(dir,'data/ca.crt'),path.join(dir,'data/tls.crt')],{encoding:'utf8'});assert.equal(verified.status,0,verified.stderr);const san=spawnSync('openssl',['x509','-in',path.join(dir,'data/tls.crt'),'-noout','-text'],{encoding:'utf8'});assert.match(san.stdout,/\*\.abcd1234\.tunnel\.anthropic\.com/);
  await assert.rejects(()=>generateAnthropicCertificates(base),/already exist/);const status=await anthropicTunnelStatus(base);assert.equal(status.tokenSet,true);assert.match(status.notVerifiedLive,/Not verified by Engram/);assert.doesNotMatch(JSON.stringify(status),/sensitive-tunnel-token/);
});

test('Anthropic tunnel dashboard lifecycle requires CSRF, password re-auth, and typed image-pull confirmation', async t => {
  const oldHome=process.env.HOME,oldXdg=process.env.XDG_CONFIG_HOME,oldPath=process.env.PATH,base=await fs.mkdtemp(path.join(os.tmpdir(),'engram-anthropic-api-')),bin=path.join(base,'bin'),log=path.join(base,'docker.log');process.env.HOME=base;process.env.XDG_CONFIG_HOME=path.join(base,'.config');await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"\ncase "$1" in --version) echo "Docker version 27.0.0";; info) echo 27;; compose) if [ "$*" = "compose -p engram-anthropic-tunnel -f $HOME/.config/engram/anthropic-tunnel/compose.yaml ps --format json" ]; then echo "[]"; fi;; esac\n',{mode:0o700});await fs.writeFile(path.join(bin,'launchctl'),'#!/bin/sh\nexit 1\n',{mode:0o700});process.env.PATH=bin+path.delimiter+(oldPath??'');process.env.FAKE_DOCKER_LOG=log;
  t.after(async()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;delete process.env.FAKE_DOCKER_LOG;await fs.rm(base,{recursive:true,force:true})});
  const {root,dashboard,cookie}=await signedIn(t);await saveAnthropicTunnel(root,{tunnelId:'tnl_abcdefgh1234',tunnelDomain:'abcd1234.tunnel.anthropic.com',route:'memory',token:'lifecycle-secret'});
  assert.equal((await call(dashboard.port,'/api/connectors/anthropic-tunnel/up',{method:'POST',cookie,origin:true,body:{confirmation:'PULL AND START'}})).status,401);
  assert.equal((await call(dashboard.port,'/api/connectors/anthropic-tunnel/up',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{confirmation:'start'}})).status,400);
  const started=await call(dashboard.port,'/api/connectors/anthropic-tunnel/up',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{confirmation:'PULL AND START'}});assert.equal(started.status,200,started.body);
  const stopped=await call(dashboard.port,'/api/connectors/anthropic-tunnel/down',{method:'POST',cookie,csrf:true,origin:true,reauth:'correct horse battery staple',body:{}});assert.equal(stopped.status,200,stopped.body);
  const commands=await fs.readFile(log,'utf8');assert.match(commands,/compose -p engram-anthropic-tunnel -f .*compose\.yaml up -d/);assert.match(commands,/compose -p engram-anthropic-tunnel -f .*compose\.yaml down/);assert.doesNotMatch(commands,/lifecycle-secret/);assert.doesNotMatch(started.body,/lifecycle-secret/);
});

test('connector DNS rebinding uses one validated answer and pins that address', async () => {
  let calls = 0;
  const resolveHost = async () => { calls++; return calls === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
  const pinned = await resolveConnectorAddress(new URL('https://memory.example.com/version'), false, resolveHost);
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
  assert.equal(calls, 1, 'the connector must not perform a second DNS lookup after validation');
  await assert.rejects(() => resolveConnectorAddress(new URL('https://memory.example.com/version'), false, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /Private and loopback/);
});

test('connector connection pins the resolver address and refuses a local redirect to a private host', async t => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-connector-tls-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const certPath = path.join(fixtureDir, 'cert.pem'), keyPath = path.join(fixtureDir, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:memory.example.com', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' });
  if (generated.error && (generated.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('TLS redirect test requires openssl to generate its throwaway self-signed certificate');
    return;
  }
  assert.equal(generated.status, 0, `openssl certificate generation failed: ${generated.stderr}`);
  const cert = await fs.readFile(certPath);
  const key = await fs.readFile(keyPath);
  const server = createHttpsServer({ cert, key }, (_request, response) => { response.writeHead(302, { Location: 'https://127.0.0.1/private' }); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let resolutions = 0;
  const resolveHost = async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; };
  await assert.rejects(() => testConnectorConnection(`https://memory.example.com:${address.port}/version`, true, resolveHost, {}, { ca: cert, allowNonstandardPort: true }), /redirect to another host/);
  assert.equal(resolutions, 1, 'the TLS request uses the validated address without a second DNS lookup');
});

test('dashboard serves only fixed logo bytes with image types and immutable cache headers', async t => {
  const { dashboard } = await signedIn(t);
  for (const [route, asset] of Object.entries(logoAssets)) {
    const response = await fetch(`http://127.0.0.1:${dashboard.port}${route}`);
    assert.equal(response.headers.get('content-type'), 'image/png'); assert.match(response.headers.get('cache-control')!, /max-age=31536000/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.body);
  }
  assert.equal((await fetch(`http://127.0.0.1:${dashboard.port}/assets/not-real.png`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${dashboard.port}/assets/logo-64.png?x=1`)).status, 200);
  assert.equal(assets['/']!.body!.includes('apple-touch-icon'), true); assert.equal(assets['/']!.body!.includes('alt="Engram"'), true);
});
