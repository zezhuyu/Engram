import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { await new Promise(resolve => server.close(resolve)); }

test('keyed gateway exposes health only and requires a named read-only workspace', async t => {
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body), method = message.method;
    const result = method === 'tools/list' ? { tools: [{ name: 'engram_search', description: 'Search', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] } }] }
      : method === 'tools/call' ? { content: [{ type: 'text', text: 'fixture result' }] } : {};
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }); res.end(JSON.stringify(message.id === undefined ? {} : { jsonrpc: '2.0', id: message.id, result }));
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const reserved = createServer(), gatewayPort = await listen(reserved); await close(reserved);
  const token = 'engram_fixture_gateway_token_never_logged'; let logs = '';
  const gateway = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/hosted/keyed-gateway.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GATEWAY_PORT: String(gatewayPort), ENGRAM_UPSTREAM: `http://127.0.0.1:${upstreamPort}/mcp`, GATEWAY_WORKSPACES: JSON.stringify([{ name: 'alpha', tokenEnv: 'ENGRAM_TOKEN_ALPHA', scope: { type: 'workspace', workspaceId: 'alpha' }, allowWrites: false }]), ENGRAM_TOKEN_ALPHA: token } });
  gateway.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => { gateway.kill('SIGTERM'); await once(gateway, 'exit').catch(() => undefined); assert.doesNotMatch(logs, new RegExp(token)); });
  let health;
  for (let attempt = 0; attempt < 40; attempt++) { try { health = await fetch(`http://127.0.0.1:${gatewayPort}/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  assert.equal(health?.status, 200); assert.deepEqual(await health.json(), { ok: true, workspaces: 1 });
  const call = async message => fetch(`http://127.0.0.1:${gatewayPort}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) }).then(response => response.json());
  const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.deepEqual(listed.result.tools[0].inputSchema.required, ['workspace', 'query']);
  const missing = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x' } } }); assert.match(missing.result.content[0].text, /workspace is required/);
  const unknown = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x', workspace: 'other' } } }); assert.equal(unknown.result.content[0].text, 'Workspace not found.');
  const read = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x', workspace: 'alpha', scope: { type: 'global', area: 'wiki' } } } }); assert.equal(read.result.content[0].text, 'fixture result');
  const write = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'engram_create', arguments: { workspace: 'alpha' } } }); assert.match(write.result.content[0].text, /read-only/);
});

test('keyed gateway inbound auth is uniform and Streamable HTTP lifecycle passes through safely', async t => {
  const upstreamMethods = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body); upstreamMethods.push({ method: message.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization });
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'engram_search', description: 'Search', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] } }] }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'fixture result' }] } : {};
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'auth-fixture-session' }); res.end(message.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const reserved = createServer(), gatewayPort = await listen(reserved); await close(reserved);
  const key = 'claude-fixed-header-key-never-log-0123456789', token = 'engram_fixture_gateway_token_never_logged', methods = fileURLToPath(new URL('../../scripts/hosted/keyed-gateway.mjs', import.meta.url)); let logs = '';
  const gateway = spawn(process.execPath, [methods], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GATEWAY_PORT: String(gatewayPort), ENGRAM_UPSTREAM: `http://127.0.0.1:${upstreamPort}/mcp`, GATEWAY_WORKSPACES: JSON.stringify([{ name: 'alpha', tokenEnv: 'ENGRAM_TOKEN_ALPHA', scope: { type: 'workspace', workspaceId: 'alpha' }, allowWrites: false }]), ENGRAM_TOKEN_ALPHA: token, GATEWAY_INBOUND_HEADER: 'x-api-key', GATEWAY_INBOUND_KEY_ENV: 'INBOUND_KEY', INBOUND_KEY: key } });
  gateway.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => { gateway.kill('SIGTERM'); await once(gateway, 'exit').catch(() => undefined); assert.doesNotMatch(logs, new RegExp(key)); assert.doesNotMatch(logs, new RegExp(token)); });
  let base;
  for (let attempt = 0; attempt < 40; attempt++) { try { const probe = await fetch(`http://127.0.0.1:${gatewayPort}/health`); if (probe.ok) { base = `http://127.0.0.1:${gatewayPort}`; break; } } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  assert.ok(base);
  const unauthorized = await Promise.all([undefined, 'wrong-key', 'x'.repeat(Buffer.byteLength(key) + 1)].map(value => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(value ? { 'x-api-key': value } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })));
  const replies = await Promise.all(unauthorized.map(async response => ({ status: response.status, body: await response.text() })));
  assert.deepEqual(replies, replies.map(() => replies[0])); assert.equal(replies[0].status, 401); assert.equal(replies[0].body, '{"error":"Unauthorized"}');
  const get = await fetch(`${base}/mcp`); assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  const health = await fetch(`${base}/health`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, workspaces: 1 });
  const post = async (message, session) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(message) });
  const initialize = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
  assert.equal(initialize.status, 200); assert.equal(initialize.headers.get('content-type'), 'application/json'); assert.equal(initialize.headers.get('mcp-session-id'), 'auth-fixture-session'); assert.equal((await initialize.json()).result.serverInfo.name, 'fixture');
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'auth-fixture-session'); assert.equal(initialized.status, 202); assert.equal(await initialized.text(), '');
  const listedResponse = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'auth-fixture-session'), listed = await listedResponse.json(); assert.equal(listedResponse.headers.get('content-type'), 'application/json'); assert.deepEqual(listed.result.tools[0].inputSchema.required, ['workspace', 'query']);
  const calledResponse = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x', workspace: 'alpha' } } }, 'auth-fixture-session'), called = await calledResponse.json(); assert.equal(called.result.content[0].text, 'fixture result');
  assert.ok(upstreamMethods.some(item => item.method === 'notifications/initialized')); assert.ok(upstreamMethods.some(item => item.method === 'tools/call' && item.session === 'auth-fixture-session' && item.auth === `Bearer ${token}`));
});

test('keyed gateway refuses non-loopback bind unless inbound auth is configured', async () => {
  const script = fileURLToPath(new URL('../../scripts/hosted/keyed-gateway.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GATEWAY_BIND: '0.0.0.0', GATEWAY_WORKSPACES: JSON.stringify([{ name: 'alpha', tokenEnv: 'ENGRAM_TOKEN_ALPHA', scope: { type: 'workspace', workspaceId: 'alpha' } }]), ENGRAM_TOKEN_ALPHA: 'engram_fixture_gateway_token_never_logged' } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); }); const [code] = await once(child, 'exit'); assert.notEqual(code, 0); assert.match(stderr, /Non-loopback GATEWAY_BIND requires/);
});
