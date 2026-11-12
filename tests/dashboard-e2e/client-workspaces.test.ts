import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engram } from '../../packages/sdk/index.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { defaultBinding, writeBinding } from '../../packages/core/project-binding.js';
import { bindingFingerprint } from '../../packages/core/project-trust.js';
import { Cdp, browserExecutable, freePort, removeTree, terminate, waitFor } from './cdp.js';

const chrome = browserExecutable();
const skip = process.env.MDB_E2E_BROWSER !== '1' ? 'Set MDB_E2E_BROWSER=1 to opt in to the real-browser dashboard suite' : chrome ? false : 'Chrome not found';

test('client workspace browser renders the complete workspace union and fixed navigation', { skip, timeout: 120_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-client-workspaces-browser-'));
  const profile = path.join(root, 'chrome-profile');
  const names = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'ENGRAM_DATA_DIR', 'ENGRAM_TRUST_FILE', 'ENGRAM_REPLICA_DIR', 'ENGRAM_OUTBOX', 'ENGRAM_CACHE_DIR', 'MDB_DASHBOARD_AUTH_FILE'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_DATA_HOME: path.join(root, 'data'), ENGRAM_DATA_DIR: path.join(root, 'data'),
    ENGRAM_TRUST_FILE: path.join(root, 'trust', 'trusted-projects.json'), ENGRAM_REPLICA_DIR: path.join(root, 'data/.engram-runtime/replicas'),
    ENGRAM_OUTBOX: path.join(root, 'data/.engram-runtime/outbox'), ENGRAM_CACHE_DIR: path.join(root, 'data/.engram-runtime/cache'),
    MDB_DASHBOARD_AUTH_FILE: path.join(root, 'auth.json'), MDB_DASHBOARD_ALERT: 'false',
  });
  await fs.mkdir(process.env.HOME!, { recursive: true });
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined, browserControl: Cdp | undefined;
  let mcp: ReturnType<typeof createServer> | undefined;
  let dashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  const engram = new Engram(path.join(root, 'vault'));
  await engram.init({ sqlite: false });
  t.after(async () => {
    await cdp?.close().catch(() => undefined);
    await browserControl?.command('Browser.close').catch(() => undefined);
    await browserControl?.close().catch(() => undefined);
    await terminate(browser);
    await dashboard?.close().catch(() => undefined);
    if (mcp?.listening) await new Promise<void>(resolve => mcp!.close(() => resolve()));
    await engram.close().catch(() => undefined);
    await removeTree(root);
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });

  mcp = createServer((request, response) => {
    let body = ''; request.on('data', chunk => body += String(chunk)); request.on('end', () => {
      if (!body) { response.writeHead(404).end(); return; }
      const message = JSON.parse(body) as { id: number; method: string };
      response.setHeader('Content-Type', 'application/json');
      if (message.method === 'initialize') { response.setHeader('Mcp-Session-Id', 'browser-fixture'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } })); }
      else if (message.method === 'tools/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'mdb_workspace_list' }] } }));
      else response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify([{ id: 'server-only', name: 'Server Only' }]) }] } }));
    });
  });
  await new Promise<void>(resolve => mcp!.listen(0, '127.0.0.1', resolve));
  const mcpAddress = mcp.address(); assert.ok(mcpAddress && typeof mcpAddress !== 'string');
  const credential = path.join(root, 'client.token'); await fs.writeFile(credential, 'browser-fixture-token', { mode: 0o600 });
  const clientConfig = path.join(root, 'config/engram/client.env'); await fs.mkdir(path.dirname(clientConfig), { recursive: true });
  await fs.writeFile(clientConfig, `ENGRAM_MCP_URL="http://127.0.0.1:${mcpAddress.port}/mcp"\nENGRAM_TOKEN_FILE=${JSON.stringify(credential)}\n`);

  const projects = [
    { name: 'Bound folder One', id: 'bound-one' },
    { name: 'Bound folder Two', id: 'bound-two' },
  ];
  const trustEntries = [];
  for (const project of projects) {
    const directory = path.join(root, 'projects', project.name); await fs.mkdir(directory, { recursive: true });
    const binding = { ...defaultBinding({ workspaceId: project.id }), mode: 'remote' as const, serverUrl: `http://127.0.0.1:${mcpAddress.port}/mcp` };
    await writeBinding(directory, binding);
    trustEntries.push({ root: directory, fingerprint: bindingFingerprint(binding), workspaceId: project.id, mode: 'remote' });
  }
  await fs.mkdir(path.dirname(process.env.ENGRAM_TRUST_FILE!), { recursive: true });
  await fs.writeFile(process.env.ENGRAM_TRUST_FILE!, JSON.stringify({ schemaVersion: 1, entries: trustEntries }));
  const context = path.join(process.env.ENGRAM_CACHE_DIR!, 'context'); await fs.mkdir(context, { recursive: true });
  await fs.writeFile(path.join(context, createHash('sha256').update('browser-cache').digest('hex').slice(0, 24) + '.json'), JSON.stringify({ workspaceId: 'cache-only', serverUrl: 'http://127.0.0.1', fetchedAt: new Date(Date.now() - 90_000).toISOString(), text: 'private cache body' }));

  dashboard = await createDashboardServer({ engram, clientMode: true, host: '127.0.0.1', port: 0, idleMs: 60_000 });
  const origin = `http://127.0.0.1:${dashboard.port}`;
  const dashboardResponses: Array<{ path: string; status: number; durationMs: number }> = [];
  dashboard.server.on('request', (request, response) => {
    const startedAt = performance.now();
    response.once('finish', () => dashboardResponses.push({ path: new URL(request.url ?? '/', origin).pathname, status: response.statusCode, durationMs: Math.round(performance.now() - startedAt) }));
  });
  const password = 'workspace-browser-test-password';
  const browserPort = await freePort();
  const browserEnv = { ...process.env };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
    const value = previous.get(name);
    if (value === undefined) delete browserEnv[name]; else browserEnv[name] = value;
  }
  browser = spawn(chrome!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--no-pings', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--use-mock-keychain', `--user-data-dir=${profile}`, `--remote-debugging-port=${browserPort}`, '--remote-allow-origins=*', 'about:blank'], { env: browserEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let browserError = ''; browser.stderr?.on('data', chunk => browserError += String(chunk));
  await waitFor(async () => fetch(`http://127.0.0.1:${browserPort}/json/version`).then(response => response.ok), Boolean, `Chrome DevTools endpoint did not start (${chrome}): ${browserError}`, 30_000);
  const dashboardUrl = `${origin}/#t=${dashboard.token}`;
  const browserInfo = await fetch(`http://127.0.0.1:${browserPort}/json/version`).then(response => response.json()) as { webSocketDebuggerUrl: string };
  browserControl = await Cdp.connect(browserInfo.webSocketDebuggerUrl);
  const created = await browserControl.command('Target.createTarget', { url: dashboardUrl });
  const targetId = created.targetId as string;
  assert.ok(targetId, 'Chrome created a dashboard target');
  const targets = await waitFor(async () => fetch(`http://127.0.0.1:${browserPort}/json/list`).then(response => response.json()), value => Array.isArray(value) && value.some((item: any) => item.id === targetId && typeof item.webSocketDebuggerUrl === 'string' && item.url !== 'about:blank'), 'Chrome dashboard navigation did not start', 15_000);
  const target = targets.find((item: any) => item.id === targetId) as { webSocketDebuggerUrl: string; url: string };
  assert.ok(target.webSocketDebuggerUrl);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.command('Page.enable'); await cdp.command('Runtime.enable'); await cdp.command('Network.enable'); await cdp.command('Log.enable');
  const requests = new Map<string, { url: string; startedAt: number; status?: number }>();
  const workspaceTimings: Array<{ status?: number; durationMs: number }> = [];
  let eventCursor = 0;
  const collectDiagnostics = () => {
    for (const event of cdp!.events.slice(eventCursor)) {
      const params = event.params as Record<string, any> | undefined;
      if (event.method === 'Network.requestWillBeSent' && typeof params?.requestId === 'string' && typeof params?.request?.url === 'string' && typeof params?.timestamp === 'number') {
        requests.set(params.requestId, { url: params.request.url, startedAt: params.timestamp });
      } else if (event.method === 'Network.responseReceived' && typeof params?.requestId === 'string') {
        const request = requests.get(params.requestId);
        if (request && typeof params?.response?.status === 'number') request.status = params.response.status;
      } else if (event.method === 'Network.loadingFinished' && typeof params?.requestId === 'string') {
        const request = requests.get(params.requestId);
        if (request?.url.endsWith('/api/client/workspaces') && typeof params.timestamp === 'number') {
          workspaceTimings.push({ status: request.status, durationMs: Math.round((params.timestamp - request.startedAt) * 1000) });
        }
      }
    }
    eventCursor = cdp!.events.length;
  };
  const eventPoll = setInterval(collectDiagnostics, 25);
  t.after(() => clearInterval(eventPoll));
  try {
    await waitFor(() => cdp!.evaluate<string>('document.readyState'), value => value === 'complete', 'Client dashboard did not load', 15_000);
  } catch (error) {
    collectDiagnostics();
    const frameTree = JSON.stringify(await cdp.command('Page.getFrameTree').catch(() => ({}))).replace(/#t=[a-f0-9]+/g, '#t=[redacted]');
    const network = [...requests.values()].map(({ url, status }) => ({ url: url.replace(/#.*$/, ''), status }));
    const pageErrors = JSON.stringify(cdp.events.filter(event => ['Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed'].includes(event.method)).map(event => ({ method: event.method, params: event.params }))).replace(/#t=[a-f0-9]+/g, '#t=[redacted]');
    throw new Error(`${(error as Error).message}\nChrome stderr: ${browserError.slice(-2000)}\nFrame: ${frameTree}\nRequests: ${JSON.stringify(network)}\nDashboard responses: ${JSON.stringify(dashboardResponses)}\nPage errors: ${pageErrors}`);
  }
  try { await waitFor(() => cdp!.evaluate<string>('document.body.innerText'), value => value.includes('ENGRAM'), 'Client dashboard page shell did not load', 20_000); }
  catch (error) {
    collectDiagnostics();
    const page = (await cdp!.evaluate<string>('location.href+"\\n"+document.body.innerText').catch(() => 'unavailable')).replace(/#t=[a-f0-9]+/g, '#t=[redacted]');
    const network = [...requests.values()].map(({ url, status }) => ({ url: url.replace(/#.*$/, ''), status }));
    throw new Error(`${(error as Error).message}\nChrome stderr: ${browserError.slice(-2000)}\nPage: ${page}\nTarget: ${target.url.replace(/#t=[a-f0-9]+/g, '#t=[redacted]')}\nRequests: ${JSON.stringify(network)}\nDashboard responses: ${JSON.stringify(dashboardResponses)}\nOrigin: ${origin}`);
  }
  const firstPage = await cdp.evaluate<string>('document.body.innerText');
  assert.match(firstPage, /Set a password|Welcome back/, `Unexpected client dashboard page: ${firstPage}`);
  if (firstPage.includes('Set a password')) {
  await cdp.evaluate(`(()=>{document.querySelector('input[aria-label="New password"]').value=${JSON.stringify(password)};document.querySelector('input[aria-label="Confirm password"]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit()})()`);
  await waitFor(() => cdp!.evaluate<string>('document.body.innerText'), value => value.includes('Welcome back'), 'Client dashboard password setup did not complete');
  }
  await cdp.evaluate(`(()=>{const input=document.querySelector('input[aria-label="Password"]');input.value=${JSON.stringify(password)};document.querySelector('form').requestSubmit()})()`);
  await waitFor(() => cdp!.evaluate<string>('document.body.innerText'), value => value.includes('This device') && !value.includes('Welcome back'), 'Client dashboard login did not establish a session');
  const navigation = [
    ['this-device', 'This device'], ['server', 'Server'], ['workspaces', 'Workspaces'],
    ['cached-projects', 'Cached projects'], ['connections', 'Connections'], ['client-settings', 'Client settings'],
  ];
  const expectedLabels = navigation.map(([, label]) => label);
  for (const [id, heading] of navigation) {
    await cdp.evaluate(`location.hash=${JSON.stringify(`#${id}`)}`);
    await waitFor(() => cdp!.evaluate<string>('document.querySelector("#content h1")?.textContent||""'), value => value === heading, `Client ${heading} page did not render; current page: ` + await cdp.evaluate<string>('document.querySelector("#content")?.innerText||document.body.innerText'), 15_000);
    const labels: string[] = await cdp.evaluate<string[]>(`[...document.querySelectorAll('#nav a span:not(.nav-icon)')].map(x=>x.innerText)`);
    assert.deepEqual(labels, expectedLabels, `Fixed client navigation on ${heading}`);
  }
  await cdp.evaluate("location.hash='#workspaces'");
  await waitFor(() => cdp!.evaluate<string>('document.querySelector("#content h1")?.textContent||""'), value => value === 'Workspaces', 'Client Workspaces page did not render after navigation checks');
  const facts = await waitFor(() => cdp!.evaluate<{ labels: string[]; text: string }>(`(()=>({labels:[...document.querySelectorAll('#nav a span')].map(x=>x.innerText).filter(Boolean),text:document.querySelector('#content')?.innerText||''}))()`), value => value.text.includes('Server Only') && value.text.includes('Bound folder Two'), 'Workspace rows did not render; current page: ' + await cdp.evaluate<string>('document.querySelector("#content")?.innerText||document.body.innerText'));
  assert.deepEqual(facts.labels, ['This device', 'Server', 'Workspaces', 'Cached projects', 'Connections', 'Client settings']);
  for (const visible of ['Bound folder One', 'Bound folder Two', 'cache-only', 'Server Only']) assert.match(facts.text, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.doesNotMatch(facts.text, /private cache body|browser-fixture-token/);
  collectDiagnostics();
  assert.ok(workspaceTimings.length > 0, 'Browser recorded /api/client/workspaces response timing');
  assert.equal(workspaceTimings.at(-1)?.status, 200);
  assert.ok(workspaceTimings.every(item => item.durationMs < 3000), `Workspace API should complete promptly under the fixture: ${JSON.stringify(workspaceTimings)}`);
  process.stdout.write(`[client-workspaces-browser] nav=${JSON.stringify(facts.labels)}\n[client-workspaces-browser] visible=${facts.text.replace(/\s+/g, ' ').trim()}\n`);
  process.stdout.write(`[client-workspaces-browser] workspace-api=${JSON.stringify(workspaceTimings)}\n`);
});
