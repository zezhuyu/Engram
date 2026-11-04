import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Engram } from '../../packages/sdk/index.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { createDashboardCredential, listDashboardCredentials, resolveDashboardCredential, revokeDashboardCredential } from '../../packages/dashboard/credentials.js';
import { dashboardAuthFile } from '../../packages/dashboard/password.js';
import { disposableVault } from './helpers.js';

const location = (root: string) => ({ env: {}, homeDir: root, platform: 'linux' as NodeJS.Platform });
const api = (origin: string, route: string, cookie: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string,string> = {}) => fetch(origin + route, { method, headers: { Cookie: cookie, Origin: origin, 'X-Engram-Dashboard': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('dashboard credentials are hashed, expire, enforce view-only, and audit remote access without secrets', async t => {
  const v = await disposableVault(), old = process.env.MDB_DASHBOARD_REMOTE_ADMIN; process.env.MDB_DASHBOARD_REMOTE_ADMIN = 'true';
  const auth = location(v.root), remote = await createDashboardServer({ engram: v.engram, host: '127.0.0.1', idleMs: 60_000, authLocation: auth });
  t.after(async () => { await remote.close(); await v.cleanup(); if (old === undefined) delete process.env.MDB_DASHBOARD_REMOTE_ADMIN; else process.env.MDB_DASHBOARD_REMOTE_ADMIN = old; });
  const made = await createDashboardCredential(v.root, { label: 'readonly-ui', mode: 'view' });
  const listing = await listDashboardCredentials(v.root);
  assert.equal(listing.length, 1); assert.equal('tokenHash' in listing[0]!, false);
  const raw = JSON.parse(await fs.readFile(path.join(v.root, '.mdb/dashboard/credentials.json'), 'utf8'));
  assert.equal(raw.credentials[0].tokenHash.includes(made.token), false);
  assert.equal((await resolveDashboardCredential(v.root, made.token, '127.0.0.1'))?.mode, 'view');
  assert.ok((await listDashboardCredentials(v.root))[0]?.lastUsedAt);
  const status = await fetch(`http://127.0.0.1:${remote.port}/api/status`, { headers: { Authorization: `Bearer ${made.token}` } });
  assert.equal(status.status, 200);
  const write = await fetch(`http://127.0.0.1:${remote.port}/api/documents`, { method: 'POST', headers: { Authorization: `Bearer ${made.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(write.status, 403);
  const audit = await fs.readFile(path.join(v.root, '.mdb/dashboard/audit.jsonl'), 'utf8');
  assert.match(audit, /readonly-ui/); assert.match(audit, /sourceIp/); assert.doesNotMatch(audit, new RegExp(made.token));
  const expired = await createDashboardCredential(v.root, { label: 'expired', mode: 'admin', expiresAt: new Date(Date.now() - 1000).toISOString() }).catch(error => error);
  assert.ok(expired instanceof Error);
  const restricted = await createDashboardCredential(v.root, { label: 'restricted', mode: 'view', sourceIps: ['203.0.113.10'] });
  assert.equal(await resolveDashboardCredential(v.root, restricted.token, '127.0.0.1'), undefined, 'source IP allowlist blocks other peers');
  assert.equal(await revokeDashboardCredential(v.root, restricted.id), true);
  assert.equal(await resolveDashboardCredential(v.root, restricted.token, '203.0.113.10'), undefined, 'revoked credentials stop resolving');
});

test('client proxy keeps remote credentials server side and forwards dashboard reads and writes', async t => {
  const serverVault = await disposableVault(), clientVault = await disposableVault();
  const oldAdmin = process.env.MDB_DASHBOARD_REMOTE_ADMIN; process.env.MDB_DASHBOARD_REMOTE_ADMIN = 'true';
  const serverAuth = location(serverVault.root), clientAuth = location(clientVault.root);
  const remote = await createDashboardServer({ engram: serverVault.engram, host: '127.0.0.1', idleMs: 60_000, authLocation: serverAuth });
  const client = await createDashboardServer({ engram: clientVault.engram, host: '127.0.0.1', idleMs: 60_000, clientMode: true, authLocation: clientAuth });
  const secret = await createDashboardCredential(serverVault.root, { label: 'client', mode: 'admin' });
  const tokenFile = path.join(clientVault.root, 'server.token'); await fs.writeFile(tokenFile, secret.token, { mode: 0o600 });
  t.after(async () => { await client.close(); await remote.close(); await clientVault.cleanup(); await serverVault.cleanup(); if (oldAdmin === undefined) delete process.env.MDB_DASHBOARD_REMOTE_ADMIN; else process.env.MDB_DASHBOARD_REMOTE_ADMIN = oldAdmin; });

  const local = `http://127.0.0.1:${client.port}`, remoteOrigin = `http://127.0.0.1:${remote.port}`;
  const setup = await fetch(local + '/api/auth/setup', { method: 'POST', headers: { Origin: local, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: client.token, password: 'local-dashboard-phrase-93', confirm: 'local-dashboard-phrase-93' }) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  const login = await fetch(local + '/api/auth/login', { method: 'POST', headers: { Origin: local, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'local-dashboard-phrase-93' }) });
  const sessionCookie = login.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  assert.equal(login.status, 200);
  const add = await api(local, '/api/client/connections', sessionCookie, { name: 'Test server', url: remoteOrigin, credentialFile: tokenFile, mode: 'admin' });
  assert.equal(add.status, 201); const item = await add.json() as { id: string; credentialFile?: string };
  assert.equal(item.credentialFile, undefined, 'the credential path is not returned to the browser');
  const proxied = await fetch(local + '/api/status', { headers: { Cookie: sessionCookie, Origin: local, 'X-Engram-Dashboard': '1', 'X-Engram-Connection': item.id } });
  assert.equal(proxied.status, 200); assert.match(proxied.headers.get('set-cookie') ?? '', /engram_dash_session=/, 'only the local session cookie is returned');
  assert.doesNotMatch(await proxied.text(), new RegExp(secret.token));
  const forward = (route: string, method = 'GET', body?: unknown) => fetch(local + route, { method, headers: { Cookie: sessionCookie, Origin: local, 'X-Engram-Dashboard': '1', 'X-Engram-Connection': item.id, ...(['DELETE'].includes(method) || route === '/api/settings/apply' ? { 'X-Engram-Reauth-Password': 'local-dashboard-phrase-93' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const settings = await (await forward('/api/settings')).json() as any;
  const preview = await (await forward('/api/settings/preview', 'POST', { key: 'scheduler.enabled', value: !settings.settings['scheduler.enabled'], etag: settings.etag })).json() as any;
  assert.equal(preview.conflict, undefined);
  const noReauth = await fetch(local + '/api/settings/apply', { method: 'POST', headers: { Cookie: sessionCookie, Origin: local, 'X-Engram-Dashboard': '1', 'X-Engram-Connection': item.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'scheduler.enabled', value: !settings.settings['scheduler.enabled'], etag: settings.etag }) });
  assert.equal(noReauth.status, 401, 'server settings changes require fresh local password re-entry');
  const applied = await forward('/api/settings/apply', 'POST', { key: 'scheduler.enabled', value: !settings.settings['scheduler.enabled'], etag: settings.etag });
  assert.equal(applied.status, 200, await applied.clone().text());
  const created = await forward('/api/documents', 'POST', { scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'proxied dashboard write', body: 'remote canonical document' });
  assert.equal(created.status, 201); const document = (await created.json() as any).document;
  const removed = await forward('/api/documents/' + document.id, 'DELETE', { expectedRevisionId: document.revisionId });
  assert.equal(removed.status, 200);
  const tombstone = (await removed.json() as any).document;
  const restored = await forward('/api/documents/' + document.id + '/restore', 'POST', { revisionId: document.revisionId, expectedRevisionId: tombstone.revisionId });
  assert.equal(restored.status, 200);
  const jobs = await forward('/api/status/jobs'); assert.equal(jobs.status, 200);
  const clientData = await fs.readFile(path.join(clientVault.root, 'server.token'), 'utf8'); assert.equal(clientData, secret.token);
});

test('remote admin stays off by default and non-private plain HTTP is refused', async t => {
  const v = await disposableVault(), previous = process.env.MDB_DASHBOARD_REMOTE_ADMIN;
  t.after(async () => { await v.cleanup(); if (previous === undefined) delete process.env.MDB_DASHBOARD_REMOTE_ADMIN; else process.env.MDB_DASHBOARD_REMOTE_ADMIN = previous; });
  delete process.env.MDB_DASHBOARD_REMOTE_ADMIN;
  const local = await createDashboardServer({ engram: v.engram, host: '127.0.0.1', idleMs: 60_000 }); t.after(() => local.close());
  const made = await createDashboardCredential(v.root, { label: 'off', mode: 'admin' });
  const denied = await fetch(`http://127.0.0.1:${local.port}/api/status`, { headers: { Authorization: `Bearer ${made.token}` } }); assert.equal(denied.status, 401);
  process.env.MDB_DASHBOARD_REMOTE_ADMIN = 'true';
  await assert.rejects(() => createDashboardServer({ engram: v.engram, host: '0.0.0.0' }), /requires HTTPS or a private interface/);
});

test('two-process client dashboard proxies status, settings, document lifecycle, and jobs', async t => {
  const serverRoot = await mkdtemp('/tmp/mdb-step-o-server-'), clientRoot = await mkdtemp('/tmp/mdb-step-o-client-');
  const serverVault = new Engram(serverRoot), localVault = new Engram(clientRoot);
  await serverVault.init({ sqlite: false }); await localVault.init({ sqlite: false });
  const credential = await createDashboardCredential(serverRoot, { label: 'two-process', mode: 'admin' });
  await serverVault.close(); await localVault.close();
  const credentialFile = path.join(clientRoot, 'server.token'); await fs.writeFile(credentialFile, credential.token, { mode: 0o600 });
  const children: ChildProcess[] = [];
  const start = async (root: string, clientMode = false) => {
    const child = spawn(process.execPath, [path.resolve('bin/mdb.js'), 'dashboard', '--root', root, '--host', '127.0.0.1', '--port', '0', ...(clientMode ? ['--client'] : [])], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', MDB_DASHBOARD_REMOTE_ADMIN: 'true', MDB_DASHBOARD_AUTH_FILE: path.join(root, '.local-auth', 'auth.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); }); child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const began = Date.now(); let match: RegExpMatchArray | null = null;
    while (Date.now() - began < 15_000) { match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#t=[a-f0-9]{64}/); if (match) break; if (child.exitCode !== null) throw new Error(`Dashboard exited: ${stdout}\n${stderr}`); await new Promise(resolve => setTimeout(resolve, 30)); }
    if (!match) throw new Error(`Dashboard startup timed out: ${stdout}\n${stderr}`);
    return { child, url: match[0] };
  };
  const stop = async (child: ChildProcess) => { if (child.exitCode !== null) return; child.kill('SIGINT'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); };
  t.after(async () => { await Promise.all(children.map(stop)); await rm(serverRoot,{recursive:true,force:true}); await rm(clientRoot,{recursive:true,force:true}); });
  const server = await start(serverRoot), client = await start(clientRoot, true), local = new URL(client.url).origin, bootstrap = new URL(client.url).hash.slice(3), password = 'two-process-local-password-82';
  const setup = await fetch(local+'/api/auth/setup',{method:'POST',headers:{Origin:local,'Content-Type':'application/json'},body:JSON.stringify({token:bootstrap,password,confirm:password})}); assert.equal(setup.status,200);
  const login = await fetch(local+'/api/auth/login',{method:'POST',headers:{Origin:local,'Content-Type':'application/json'},body:JSON.stringify({password})}); assert.equal(login.status,200); const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const add = await fetch(local+'/api/client/connections',{method:'POST',headers:{Cookie:cookie,Origin:local,'X-Engram-Dashboard':'1','Content-Type':'application/json'},body:JSON.stringify({name:'Loopback server',url:new URL(server.url).origin,credentialFile,mode:'admin'})}); assert.equal(add.status,201); const connection=(await add.json() as {id:string}).id;
  const headers={Cookie:cookie,Origin:local,'X-Engram-Dashboard':'1','X-Engram-Connection':connection};
  const status=await fetch(local+'/api/status',{headers}); assert.equal(status.status,200);
  const settings=await (await fetch(local+'/api/settings',{headers})).json() as any;
  const apply=await fetch(local+'/api/settings/apply',{method:'POST',headers:{...headers,'X-Engram-Reauth-Password':password,'Content-Type':'application/json'},body:JSON.stringify({key:'scheduler.enabled',value:!settings.settings['scheduler.enabled'],etag:settings.etag})}); assert.equal(apply.status,200);
  const created=await fetch(local+'/api/documents',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({scope:{type:'global',area:'wiki'},kind:'wiki_page',title:'two process proxy',body:'server side content'})}); assert.equal(created.status,201); const doc=(await created.json() as any).document;
  const deleted=await fetch(local+`/api/documents/${doc.id}`,{method:'DELETE',headers:{...headers,'X-Engram-Reauth-Password':password,'Content-Type':'application/json'},body:JSON.stringify({expectedRevisionId:doc.revisionId})}); assert.equal(deleted.status,200); const tombstone=(await deleted.json() as any).document;
  const restored=await fetch(local+`/api/documents/${doc.id}/restore`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({revisionId:doc.revisionId,expectedRevisionId:tombstone.revisionId})}); assert.equal(restored.status,200);
  assert.equal((await fetch(local+'/api/status/jobs',{headers})).status,200);
  const browserText=await fetch(local+'/api/status',{headers}).then(response=>response.text()); assert.doesNotMatch(browserText,new RegExp(credential.token));
});
