import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { resolveHttpActor } from '../../packages/mcp/credentials.js';
import { disposableVault } from './helpers.js';

const repo = path.resolve('.');
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function privateEnv(text: string): Map<string, string> {
  return new Map(text.split(/\r?\n/).flatMap(line => {
    const match = /^([A-Z][A-Z0-9_]*)='(.*)'$/.exec(line);
    return match ? [[match[1]!, match[2]!.replaceAll("'\\''", "'")]] : [];
  }));
}
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), 5000))]);
  if (timedOut && child.exitCode === null) { child.kill('SIGKILL'); await exited; }
}

test('disposable OpenAI gateway smoke reaches real Engram MCP and revoked workspace credentials stop working', async t => {
  const oldHome = process.env.HOME, oldXdg = process.env.XDG_CONFIG_HOME, oldPath = process.env.PATH, oldGatewayPort = process.env.ENGRAM_KEYED_GATEWAY_PORT, oldManagerLog = process.env.SERVICE_MANAGER_LOG, oldManagerRunning = process.env.SERVICE_MANAGER_RUNNING;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-openai-smoke-')), bin = path.join(base, 'bin');
  process.env.HOME = base; process.env.XDG_CONFIG_HOME = path.join(base, '.config'); await fs.mkdir(bin, { recursive: true }); process.env.PATH = bin + path.delimiter + (oldPath ?? '');
  const managerLog = path.join(base, 'service-manager.log'), runningMarker = path.join(base, 'gateway-running'); process.env.SERVICE_MANAGER_LOG = managerLog; process.env.SERVICE_MANAGER_RUNNING = runningMarker;
  for (const manager of ['launchctl', 'systemctl']) await fs.writeFile(path.join(bin, manager), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_MANAGER_LOG"\nif [ "$1" = print ]; then if [ -f "$SERVICE_MANAGER_RUNNING" ]; then printf "state = running\\npid = 123\\n"; exit 0; else exit 1; fi; fi\nexit 0\n', { mode: 0o700 });
  const fakeTunnel = path.join(base, '.config/engram/tunnel-client/tunnel-client');
  await fs.mkdir(path.dirname(fakeTunnel), { recursive: true }); await fs.writeFile(fakeTunnel, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
  const vault = await disposableVault(); let dashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  let mcp: ChildProcess | undefined, gateway: ChildProcess | undefined;
  t.after(async () => {
    await stop(gateway); await stop(mcp); await dashboard?.close(); await vault.cleanup();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldGatewayPort === undefined) delete process.env.ENGRAM_KEYED_GATEWAY_PORT; else process.env.ENGRAM_KEYED_GATEWAY_PORT = oldGatewayPort;
    if (oldManagerLog === undefined) delete process.env.SERVICE_MANAGER_LOG; else process.env.SERVICE_MANAGER_LOG = oldManagerLog;
    if (oldManagerRunning === undefined) delete process.env.SERVICE_MANAGER_RUNNING; else process.env.SERVICE_MANAGER_RUNNING = oldManagerRunning;
    await fs.rm(base, { recursive: true, force: true });
  });
  await vault.engram.vault.createWorkspace('alpha'); await vault.engram.vault.createWorkspace('beta'); await vault.engram.vault.createWorkspace('gamma');
  dashboard = await createDashboardServer({ engram: vault.engram, idleMs: 60_000 });
  const request = async (route: string, options: { method?: string; cookie?: string; body?: unknown; csrf?: boolean; reauth?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.method && options.method !== 'GET') headers.Origin = `http://127.0.0.1:${dashboard!.port}`;
    if (options.csrf) headers['X-Engram-Dashboard'] = '1';
    if (options.reauth) headers['X-Engram-Reauth-Password'] = options.reauth;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${dashboard!.port}${route}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  assert.equal((await request('/api/auth/setup', { method: 'POST', csrf: true, body: { token: dashboard.token, password: 'smoke passphrase 2026', confirm: 'smoke passphrase 2026' } })).status, 200);
  const login = await request('/api/auth/login', { method: 'POST', csrf: true, body: { password: 'smoke passphrase 2026' } }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const emptyStart = await request('/api/connectors/openai/start', { method: 'POST', cookie, csrf: true, reauth: 'smoke passphrase 2026', body: {} });
  assert.equal(emptyStart.status, 400); assert.match(emptyStart.body, /tunnel ID and API key/i);
  assert.equal(JSON.parse((await request('/api/connectors/openai/status', { cookie, csrf: true })).body).config.workspaces[0].name, 'personal', 'first Start provisions the default chat workspace row');
  assert.doesNotMatch(await fs.readFile(managerLog, 'utf8').catch(() => ''), /bootstrap|kickstart/, 'preflight does not bootstrap services');
  for (const row of [{ name: 'alpha', workspace: 'alpha', allowWrites: false }, { name: 'beta', workspace: 'beta', allowWrites: true }]) {
    const created = await request('/api/connectors/openai/workspaces', { method: 'POST', cookie, csrf: true, body: row }); assert.equal(created.status, 201);
  }
  const config = await request('/api/connectors/openai/config', { method: 'POST', cookie, csrf: true, reauth: 'smoke passphrase 2026', body: { tunnelId: 'smoke-tunnel', apiKey: 'smoke-runtime-key' } }); assert.equal(config.status, 200, config.body);
  const gatewayPort = await freePort(); process.env.ENGRAM_KEYED_GATEWAY_PORT = String(gatewayPort);
  const healthStub = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }); healthStub.listen(gatewayPort, '127.0.0.1'); await once(healthStub, 'listening');
  t.after(async () => { if (healthStub.listening) await new Promise<void>(resolve => healthStub.close(() => resolve())); });
  const started = await request('/api/connectors/openai/start', { method: 'POST', cookie, csrf: true, reauth: 'smoke passphrase 2026', body: {} }); assert.equal(started.status, 200, started.body);
  await new Promise<void>(resolve => healthStub.close(() => resolve()));
  const env = privateEnv(await fs.readFile(path.join(base, '.config/engram/keyed-gateway.env'), 'utf8'));
  const mcpPort = await freePort();
  mcp = spawn(process.execPath, [path.join(repo, 'bin/mdb-mcp.js'), '--root', vault.root], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_TOOLSET: 'remote-web', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(mcpPort) } });
  let mcpLogs = ''; mcp.stderr?.on('data', chunk => { mcpLogs += String(chunk).slice(-2000); });
  const alphaToken = env.get('ENGRAM_TOKEN_ALPHA'); assert.ok(alphaToken);
  let mcpReady = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${alphaToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }), signal: AbortSignal.timeout(500) });
      if (response.ok) { mcpReady = true; break; }
    } catch { /* MCP child is starting */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(mcpReady, true, `MCP did not start: ${mcpLogs}`);
  const gatewayEnv: NodeJS.ProcessEnv = { ...process.env, GATEWAY_PORT: String(gatewayPort), ENGRAM_UPSTREAM: `http://127.0.0.1:${mcpPort}/mcp`, GATEWAY_WORKSPACES: env.get('GATEWAY_WORKSPACES') };
  for (const [key, value] of env) if (key.startsWith('ENGRAM_TOKEN_') || key.startsWith('GATEWAY_DYNAMIC_') || key === 'GATEWAY_ALLOW_ANY_WORKSPACE_BY_NAME' || key === 'GATEWAY_WRITES_ENABLED') gatewayEnv[key] = value;
  gateway = spawn(process.execPath, [path.join(repo, 'scripts/hosted/keyed-gateway.mjs')], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'], env: gatewayEnv });
  await fs.writeFile(runningMarker, 'running');
  let gatewayLogs = ''; gateway.stderr?.on('data', chunk => { gatewayLogs += String(chunk).slice(-2000); });
  const endpoint = `http://127.0.0.1:${gatewayPort}/mcp`;
  let health: Response | undefined;
  for (let i = 0; i < 100; i++) { try { health = await fetch(`http://127.0.0.1:${gatewayPort}/health`); if (health.ok) break; } catch { /* child is starting */ } await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.equal(health?.status, 200, `gateway did not start; MCP output: ${mcpLogs}`); assert.deepEqual(await health!.json(), { ok: true, workspaces: 3 });
  const running = await request('/api/connectors/openai/status', { cookie, csrf: true });
  assert.equal(running.status, 200); const runningStatus = JSON.parse(running.body).status;
  assert.equal(runningStatus.gateway.healthy, true); assert.equal(runningStatus.keyedGateway.running, true, 'the real gateway process is healthy while the isolated service-manager fake reports its job running');
  const call = async (id: number, name: string, args: Record<string, unknown>) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(10_000) }).then(response => response.json() as Promise<Record<string, any>>).catch(error => { throw new Error(`gateway call failed: ${String(error)}; gateway=${gatewayLogs}; mcp=${mcpLogs}`); });
  const read = await call(1, 'engram_search', { workspace: 'alpha', query: 'smoke' }); assert.equal(read.error, undefined, JSON.stringify({ read, gatewayLogs, mcpLogs })); assert.notEqual(read.result?.isError, true);
  const deniedWrite = await call(2, 'engram_create', { workspace: 'alpha', kind: 'note', title: 'should be refused', body: 'should not be stored', source: 'smoke test', idempotencyKey: 'alpha-denied' }); assert.match(deniedWrite.result.content[0].text, /read-only/);
  const unknown = await call(3, 'engram_search', { workspace: 'missing', query: 'smoke' }); assert.equal(unknown.result.content[0].text, 'Workspace not found.');
  const defaultRead = await call(4, 'engram_search', { query: 'personal memory' }); assert.equal(defaultRead.error, undefined); assert.notEqual(defaultRead.result?.isError, true, JSON.stringify(defaultRead));
  const dynamicRead = await call(5, 'engram_search', { workspace: 'gamma', query: 'project memory' }); assert.equal(dynamicRead.error, undefined); assert.notEqual(dynamicRead.result?.isError, true, JSON.stringify(dynamicRead));
  const dynamicWrite = await call(6, 'engram_create', { workspace: 'gamma', kind: 'note', title: 'dynamic write works', body: 'the default write policy permits this workspace', source: 'smoke test', idempotencyKey: 'gamma-allowed' }); assert.equal(dynamicWrite.error, undefined, JSON.stringify(dynamicWrite)); assert.notEqual(dynamicWrite.result?.isError, true, JSON.stringify(dynamicWrite));
  await stop(gateway); gateway = undefined;
  const removed = await request('/api/connectors/openai/workspaces/alpha', { method: 'DELETE', cookie, csrf: true }); assert.equal(removed.status, 200);
  const removedBeta = await request('/api/connectors/openai/workspaces/beta', { method: 'DELETE', cookie, csrf: true }); assert.equal(removedBeta.status, 200);
  const removedPersonal = await request('/api/connectors/openai/workspaces/personal', { method: 'DELETE', cookie, csrf: true }); assert.equal(removedPersonal.status, 200);
  const actionsBeforeRefusal = await fs.readFile(managerLog, 'utf8');
  const noRowsAgain = await request('/api/connectors/openai/start', { method: 'POST', cookie, csrf: true, reauth: 'smoke passphrase 2026', body: {} });
  assert.equal(noRowsAgain.status, 400); assert.match(noRowsAgain.body, /needs workspace rows/i);
  assert.doesNotMatch((await fs.readFile(managerLog, 'utf8')).slice(actionsBeforeRefusal.length), /bootstrap|kickstart|bootout/, 'removing the final workspace row may inspect status but cannot mutate service-manager state');
  const credentials = JSON.parse(await fs.readFile(path.join(vault.root, '.mdb/http-credentials.json'), 'utf8')) as { credentials: Array<{ actorId: string }> };
  assert.equal(credentials.credentials.some(credential => credential.actorId === 'chatgpt-alpha'), false);
  assert.equal(await resolveHttpActor(vault.root, `Bearer ${alphaToken}`, undefined, undefined, false), undefined);
  await stop(mcp); mcp = undefined;
  assert.doesNotMatch(gatewayLogs, /engram_[A-Za-z0-9_-]{30}/); assert.doesNotMatch(mcpLogs, /engram_[A-Za-z0-9_-]{30}/);
});
