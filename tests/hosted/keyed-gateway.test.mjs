import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { await new Promise(resolve => server.close(resolve)); }

test('keyed gateway exposes health only and applies the explicit workspace scope', async t => {
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
  const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.deepEqual(listed.result.tools[0].inputSchema.required, ['query']);
  const missing = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x' } } }); assert.equal(missing.result.content[0].text, 'Workspace not found.');
  const unknown = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x', workspace: 'other' } } }); assert.equal(unknown.result.content[0].text, 'Workspace not found.');
  const read = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x', workspace: 'alpha' } } }); assert.equal(read.result.content[0].text, 'fixture result');
  const write = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'engram_create', arguments: { workspace: 'alpha' } } }); assert.match(write.result.content[0].text, /read-only/);
});

test('ChatGPT defaults to personal, resolves readable names, and rejects scope overrides', async t => {
  const forwarded = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body); forwarded.push({ method: message.method, auth: req.headers.authorization, params: message.params });
    const result = message.method === 'tools/list' ? { tools: [
      { name: 'engram_search', description: 'Search', inputSchema: { properties: { query: { type: 'string' }, scopes: { type: 'array' }, collectionId: { type: 'string' } }, required: ['query'] } },
      { name: 'engram_create', description: 'Create', inputSchema: { properties: { title: { type: 'string' }, scope: { type: 'object' } }, required: ['title'] } },
      { name: 'engram_get', description: 'Get', inputSchema: { properties: { objectId: { type: 'string' } }, required: ['objectId'] } },
      { name: 'engram_patch', description: 'Patch', inputSchema: { properties: { objectId: { type: 'string' }, expectedRevisionId: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['objectId', 'expectedRevisionId', 'idempotencyKey'] } },
      { name: 'engram_chat_record', description: 'Record chat', inputSchema: { properties: { conversationId: { type: 'string' } }, required: [] } },
      { name: 'engram_chat_recent', description: 'Recent chats', inputSchema: { properties: { limit: { type: 'number' } }, required: [] } },
      { name: 'engram_chat_find', description: 'Find chats', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'engram_preference_record', description: 'Record preference', inputSchema: { properties: { claim: { type: 'string' } }, required: ['claim'] } }
    ] } : { content: [{ type: 'text', text: message.params?.arguments?.objectId ? JSON.stringify({ workspace_id: message.params.arguments.objectId === 'beta-object' ? 'beta' : 'alpha' }) : 'fixture result' }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'dynamic-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const reserved = createServer(), gatewayPort = await listen(reserved); await close(reserved);
  const tokens = { chat: 'engram_chat_gateway_secret_never_logged_012345', project: 'engram_project_secret_never_logged_012345', alpha: 'engram_explicit_alpha_secret_never_logged_012345', beta: 'engram_explicit_beta_secret_never_logged_012345' }; let logs = '';
  const gateway = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/hosted/keyed-gateway.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    ...process.env, GATEWAY_PORT: String(gatewayPort), ENGRAM_UPSTREAM: `http://127.0.0.1:${upstreamPort}/mcp`,
    GATEWAY_WORKSPACES: JSON.stringify([{ name: 'personal', tokenEnv: 'CHAT_TOKEN', scope: { type: 'workspace', workspaceId: 'personal' }, allowWrites: true }, { name: 'alpha', tokenEnv: 'ALPHA_TOKEN', scope: { type: 'workspace', workspaceId: 'alpha' }, allowWrites: false }, { name: 'beta', tokenEnv: 'BETA_TOKEN', scope: { type: 'workspace', workspaceId: 'beta', collectionId: 'notes' }, allowWrites: true }]),
    GATEWAY_DYNAMIC_WORKSPACES: JSON.stringify(['alpha', 'beta', 'gamma', 'personal']), GATEWAY_DYNAMIC_TOKEN_ENV: 'PROJECT_TOKEN', GATEWAY_DYNAMIC_WRITABLE_WORKSPACES: JSON.stringify(['personal', 'alpha', 'gamma']),
    CHAT_TOKEN: tokens.chat, PROJECT_TOKEN: tokens.project, ALPHA_TOKEN: tokens.alpha, BETA_TOKEN: tokens.beta
  } });
  gateway.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => { gateway.kill('SIGTERM'); await once(gateway, 'exit').catch(() => undefined); for (const token of Object.values(tokens)) assert.doesNotMatch(logs, new RegExp(token)); });
  let base;
  for (let attempt = 0; attempt < 40; attempt++) { try { const probe = await fetch(`http://127.0.0.1:${gatewayPort}/health`); if (probe.ok) { base = `http://127.0.0.1:${gatewayPort}`; break; } } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  assert.ok(base);
  const call = async (id, name, args) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) }).then(response => response.json());
  const listed = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(response => response.json());
  const searchSchema = listed.result.tools.find(tool => tool.name === 'engram_search');
  assert.deepEqual(searchSchema.inputSchema.properties.workspace.enum, ['personal', 'alpha', 'beta', 'gamma', 'profile', 'user-insight', 'wiki']);
  assert.match(searchSchema.description, /shared memory in personal: conversations are in chat and stated or accepted preferences are in preferences/);
  const chatRecordSchema = listed.result.tools.find(tool => tool.name === 'engram_chat_record');
  assert.match(chatRecordSchema.description, /Start a new conversation unless the user explicitly asks to continue a specific one/);
  assert.ok(!searchSchema.inputSchema.required.includes('workspace'));
  assert.equal((await call(2, 'engram_search', { query: 'general' })).result.content[0].text, 'fixture result');
  assert.equal(forwarded.at(-1).auth, `Bearer ${tokens.chat}`);
  assert.deepEqual(forwarded.at(-1).params.arguments.scopes, [{ type: 'workspace', workspaceId: 'personal' }]);
  assert.equal((await call(3, 'engram_search', { query: 'project', workspace: 'gamma' })).result.content[0].text, 'fixture result');
  assert.equal(forwarded.at(-1).auth, `Bearer ${tokens.project}`);
  assert.deepEqual(forwarded.at(-1).params.arguments.scopes, [{ type: 'workspace', workspaceId: 'gamma' }]);
  assert.equal((await call(4, 'engram_create', { title: 'narrowed explicit row', workspace: 'alpha' })).result.content[0].text, 'This workspace is read-only through the gateway.');
  assert.equal((await call(5, 'engram_create', { title: 'explicit write', workspace: 'beta' })).result.content[0].text, 'fixture result');
  assert.equal(forwarded.at(-1).auth, `Bearer ${tokens.beta}`);
  assert.deepEqual(forwarded.at(-1).params.arguments.scope, { type: 'workspace', workspaceId: 'beta', collectionId: 'notes' });
  assert.equal((await call(10, 'engram_create', { title: 'enabled dynamic write', workspace: 'gamma' })).result.content[0].text, 'fixture result');
  assert.equal(forwarded.at(-1).auth, `Bearer ${tokens.project}`);
  assert.deepEqual(forwarded.at(-1).params.arguments.scope, { type: 'workspace', workspaceId: 'gamma' });
  assert.equal((await call(14, 'engram_search', { query: 'wiki page', workspace: 'wiki' })).result.content[0].text, 'fixture result');
  assert.equal(forwarded.at(-1).auth, `Bearer ${tokens.project}`);
  assert.deepEqual(forwarded.at(-1).params.arguments.scopes, [{ type: 'global', area: 'wiki' }]);
  assert.equal((await call(15, 'engram_create', { title: 'global page', body: 'page', workspace: 'wiki' })).result.content[0].text, 'fixture result');
  assert.deepEqual(forwarded.at(-1).params.arguments.scope, { type: 'global', area: 'wiki' });
  const unknown = await call(6, 'engram_search', { query: 'x', workspace: 'inaccessible' });
  const traversal = await call(7, 'engram_search', { query: 'x', workspace: '../alpha' });
  const collection = await call(8, 'engram_search', { query: 'x', workspace: 'alpha', collectionId: 'private' });
  const scope = await call(9, 'engram_search', { query: 'x', workspace: 'alpha', scopes: [{ type: 'global', area: 'wiki' }] });
  assert.equal(unknown.result.content[0].text, 'Workspace not found.'); assert.equal(traversal.result.content[0].text, unknown.result.content[0].text);
  assert.equal(collection.result.content[0].text, unknown.result.content[0].text); assert.equal(scope.result.content[0].text, unknown.result.content[0].text);
  const sameWorkspaceObject = await call(11, 'engram_get', { workspace: 'alpha', objectId: 'alpha-object' });
  assert.equal(sameWorkspaceObject.result.isError, undefined);
  const otherWorkspaceObject = await call(12, 'engram_get', { workspace: 'alpha', objectId: 'beta-object' });
  assert.equal(otherWorkspaceObject.result.content[0].text, 'Workspace not found.');
  const crossWorkspacePatch = await call(13, 'engram_patch', { workspace: 'gamma', objectId: 'beta-object', expectedRevisionId: 'r1', idempotencyKey: 'patch-1' });
  assert.equal(crossWorkspacePatch.result.content[0].text, 'Workspace not found.');
});

test('connector-wide write disable blocks every exposed write tool before upstream dispatch', async t => {
  const forwarded = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body); forwarded.push(message);
    const result = message.method === 'tools/list' ? { tools: ['engram_create', 'engram_patch', 'engram_chat_record', 'engram_preference_record'].map(name => ({ name, description: name, inputSchema: { properties: { workspace: { type: 'string' } }, required: [] } })) } : { content: [{ type: 'text', text: 'unexpected upstream write' }] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const reserved = createServer(), gatewayPort = await listen(reserved); await close(reserved);
  const token = 'engram_disabled_write_fixture_token_never_logged';
  const gateway = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/hosted/keyed-gateway.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    ...process.env, GATEWAY_PORT: String(gatewayPort), ENGRAM_UPSTREAM: `http://127.0.0.1:${upstreamPort}/mcp`,
    GATEWAY_WORKSPACES: JSON.stringify([{ name: 'personal', tokenEnv: 'CHAT_TOKEN', scope: { type: 'workspace', workspaceId: 'personal' }, allowWrites: true }]),
    GATEWAY_DYNAMIC_TOKEN_ENV: 'PROJECT_TOKEN', PROJECT_TOKEN: 'engram_disabled_global_wiki_token_never_logged', CHAT_TOKEN: token, GATEWAY_WRITES_ENABLED: 'false'
  } });
  t.after(async () => { gateway.kill('SIGTERM'); await once(gateway, 'exit').catch(() => undefined); });
  let base;
  for (let attempt = 0; attempt < 40; attempt++) { try { const probe = await fetch(`http://127.0.0.1:${gatewayPort}/health`); if (probe.ok) { base = `http://127.0.0.1:${gatewayPort}`; break; } } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  assert.ok(base);
  const call = async (id, name, args) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) }).then(response => response.json());
  const create = await call(1, 'engram_create', { workspace: 'personal' });
  const chat = await call(2, 'engram_chat_record', { workspace: 'personal' });
  const preference = await call(3, 'engram_preference_record', { workspace: 'personal' });
  const wikiWrite = await call(4, 'engram_create', { workspace: 'wiki', title: 'blocked wiki page' });
  assert.match(create.result.content[0].text, /writes are disabled/);
  assert.match(chat.result.content[0].text, /writes are disabled/);
  assert.match(preference.result.content[0].text, /writes are disabled/);
  assert.match(wikiWrite.result.content[0].text, /writes are disabled|read-only/);
  assert.equal(forwarded.filter(message => message.method === 'tools/call').length, 0);
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
  const listedResponse = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'auth-fixture-session'), listed = await listedResponse.json(); assert.equal(listedResponse.headers.get('content-type'), 'application/json'); assert.deepEqual(listed.result.tools[0].inputSchema.required, ['query']);
  const calledResponse = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'x', workspace: 'alpha' } } }, 'auth-fixture-session'), called = await calledResponse.json(); assert.equal(called.result.content[0].text, 'fixture result');
  assert.ok(upstreamMethods.some(item => item.method === 'notifications/initialized')); assert.ok(upstreamMethods.some(item => item.method === 'tools/call' && item.session === 'auth-fixture-session' && item.auth === `Bearer ${token}`));
});

test('keyed gateway refuses non-loopback bind unless inbound auth is configured', async () => {
  const script = fileURLToPath(new URL('../../scripts/hosted/keyed-gateway.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GATEWAY_BIND: '0.0.0.0', GATEWAY_WORKSPACES: JSON.stringify([{ name: 'alpha', tokenEnv: 'ENGRAM_TOKEN_ALPHA', scope: { type: 'workspace', workspaceId: 'alpha' } }]), ENGRAM_TOKEN_ALPHA: 'engram_fixture_gateway_token_never_logged' } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); }); const [code] = await once(child, 'exit'); assert.notEqual(code, 0); assert.match(stderr, /Non-loopback GATEWAY_BIND requires/);
});
