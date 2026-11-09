#!/usr/bin/env node
// Named-workspace MCP gateway for a no-authentication transport (for example an OpenAI Secure MCP Tunnel profile without OAuth), modelled on Agent Slack's
// `workspace_key` bridge. The transport carries no identity; access to the tunnel itself is controlled by the OpenAI organization/workspace it is associated with.
// Every tool call must name the memory space it needs (`workspace`). The name is NOT a secret: it only selects one entry of a server-side registry. Each entry holds one
// Engram credential (from the environment), the fixed scope forced onto the call, and whether writes are allowed. An unknown name is refused; the chat never supplies
// a credential or a scope, and the Engram credential never leaves this process. Engram's own authentication and vault ACLs are unchanged and still apply.
//
//   GATEWAY_WORKSPACES=/path/workspaces.json  GATEWAY_PORT=3335  ENGRAM_UPSTREAM=http://127.0.0.1:3333/mcp  node scripts/hosted/keyed-gateway.mjs
//   workspaces.json: [{ "name": "project-a", "tokenEnv": "ENGRAM_TOKEN_PROJECT_A", "scope": { "type": "workspace", "workspaceId": "project-a", "collectionId": "shared" }, "allowWrites": false }]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.GATEWAY_PORT ?? 3335), bind = process.env.GATEWAY_BIND ?? '127.0.0.1', inboundHeader = process.env.GATEWAY_INBOUND_HEADER?.toLowerCase(), inboundKeyEnv = process.env.GATEWAY_INBOUND_KEY_ENV, inboundKey = inboundKeyEnv ? process.env[inboundKeyEnv] : undefined, upstream = process.env.ENGRAM_UPSTREAM ?? 'http://127.0.0.1:3333/mcp';
const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(bind);
if (!isLoopback && (!inboundHeader || !/^[a-z0-9-]{1,64}$/.test(inboundHeader) || !inboundKeyEnv || !/^[A-Z_][A-Z0-9_]*$/.test(inboundKeyEnv) || !inboundKey || inboundKey.length < 32)) throw new Error('Non-loopback GATEWAY_BIND requires GATEWAY_INBOUND_HEADER and a configured GATEWAY_INBOUND_KEY_ENV secret (at least 32 characters)');
if ((inboundHeader || inboundKeyEnv) && (!inboundHeader || !/^[a-z0-9-]{1,64}$/.test(inboundHeader) || !inboundKeyEnv || !/^[A-Z_][A-Z0-9_]*$/.test(inboundKeyEnv) || !inboundKey || inboundKey.length < 32)) throw new Error('Inbound gateway authentication requires a valid header and a configured key of at least 32 characters');
const upstreamUrl = new URL(upstream); if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(upstreamUrl.hostname)) throw new Error('ENGRAM_UPSTREAM must be loopback');
const workspaceConfig = process.env.GATEWAY_WORKSPACES ?? '';
const entries = JSON.parse(workspaceConfig.startsWith('[') ? workspaceConfig : readFileSync(workspaceConfig, 'utf8')).map(e => {
  const token = process.env[e.tokenEnv ?? '']; if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(e.name) || !token || token.length < 32) throw new Error(`invalid workspace entry ${e.name}`);
  const scope = e.scope; if (!(scope?.type === 'workspace' && /^[A-Za-z0-9._-]{1,100}$/.test(scope.workspaceId ?? ''))) throw new Error(`a workspace scope is required for ${e.name}`);
  return { name: e.name, token, tokenEnv: e.tokenEnv, scope, allowWrites: e.allowWrites === true, window: [] };
});
if (!entries.length) throw new Error('no keys configured');
const WRITE_TOOLS = new Set(['engram_create', 'engram_patch']);
const ALLOWED = new Set((process.env.GATEWAY_TOOLS ?? 'engram_capabilities,engram_search,engram_get,engram_create,engram_patch').split(','));
const MAX_BODY = 64 * 1024, PER_MINUTE = Number(process.env.GATEWAY_PER_MINUTE ?? 60);
const byName = new Map(entries.map(e => [e.name, e]));
const lookup = name => byName.get(String(name ?? '').trim());
const log = (...a) => console.error(new Date().toISOString(), ...a);

async function up(entry, method, params, id = 1, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${entry.token}` };
  const response = await fetch(upstream, { method: 'POST', headers: { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(30_000) });
  return { status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', sessionId: response.headers.get('mcp-session-id'), text: await response.text() };
}
let toolCache;
const SCOPE_FIELDS = ['scope', 'scopes'];
const withWorkspace = tool => ({ ...tool, description: `${tool.description ?? ''} Requires the workspace name of the memory space.`.trim(), inputSchema: { ...tool.inputSchema, properties: { workspace: { type: 'string', description: `Name of the memory space to use. Available: ${entries.map(e => e.name).join(', ')}.`, enum: entries.map(e => e.name) }, ...Object.fromEntries(Object.entries(tool.inputSchema?.properties ?? {}).filter(([k]) => !SCOPE_FIELDS.includes(k))) }, required: ['workspace', ...(tool.inputSchema?.required ?? []).filter(k => !SCOPE_FIELDS.includes(k))] } });
const forceScope = (entry, name, args) => { if (!entry.scope) return args; const out = { ...args }; delete out.scope; delete out.scopes; if (name === 'engram_search') out.scopes = [entry.scope]; else if (name === 'engram_create' || name === 'engram_capabilities') out.scope = entry.scope; return out; };
// A read-only entry must not tell the chat that writes are possible: Engram reports the credential's own access, the gateway narrows it.
const readOnlyCapabilities = result => {
  const narrow = o => { if (o && typeof o === 'object' && o.authorization && typeof o.authorization === 'object') o.authorization = { ...o.authorization, write: false, ...('promote' in o.authorization ? { promote: false } : {}) }; return o; };
  try { const text = result.content?.[0]?.text; if (typeof text === 'string') result.content[0].text = JSON.stringify(narrow(JSON.parse(text))); } catch { /* leave the text as returned */ }
  narrow(result.structuredContent); narrow(result.structuredContent?.result);
  return result;
};
const sessions = new Map();
async function upstreamSession(entry, clientSession) {
  let mapped = sessions.get(clientSession); if (!mapped) { mapped = new Map(); sessions.set(clientSession, mapped); }
  if (!mapped.has(entry.tokenEnv)) {
    const init = await up(entry, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'keyed-gateway', version: '1' } }, 1);
    if (init.status < 200 || init.status >= 300) throw new Error(`upstream initialize ${init.status}`);
    const backendSession = init.sessionId ?? '';
    await up(entry, 'notifications/initialized', undefined, undefined, backendSession || undefined);
    mapped.set(entry.tokenEnv, backendSession);
  }
  return mapped.get(entry.tokenEnv) || undefined;
}
async function tools(sessionId) { if (!toolCache) { const backendSession = sessionId ? await upstreamSession(entries[0], sessionId) : undefined; const r = await up(entries[0], 'tools/list', undefined, 1, backendSession); const parsed = JSON.parse(r.text); toolCache = (parsed.result?.tools ?? []).filter(t => ALLOWED.has(t.name)).map(withWorkspace); } return toolCache; }

async function handle(msg, remote, sessionId) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result }), error = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'engram-keyed-gateway', version: '1' } });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: await tools(sessionId) });
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {}; const { workspace, ...rest } = args;
    if (typeof workspace !== 'string' || !workspace.trim()) { log('DENY no-workspace', name); return reply({ isError: true, content: [{ type: 'text', text: `workspace is required: name the memory space (${entries.map(e => e.name).join(', ')}).` }] }); }
    const entry = lookup(workspace); if (!entry) { log('DENY unknown-workspace', name, workspace.slice(0, 40)); return reply({ isError: true, content: [{ type: 'text', text: 'Workspace not found.' }] }); }
    if (WRITE_TOOLS.has(name) && !entry.allowWrites) { log('DENY write', entry.name, name); return reply({ isError: true, content: [{ type: 'text', text: 'This workspace is read-only through the gateway.' }] }); }
    if (!ALLOWED.has(name)) { log('DENY tool', entry.name, name); return reply({ isError: true, content: [{ type: 'text', text: 'This tool is not available through the gateway.' }] }); }
    const now = Date.now(); entry.window = entry.window.filter(t => now - t < 60_000); if (entry.window.length >= PER_MINUTE) { log('LIMIT', entry.name); return reply({ isError: true, content: [{ type: 'text', text: 'rate limit reached, retry shortly.' }] }); } entry.window.push(now);
    const backendSession = sessionId ? await upstreamSession(entry, sessionId) : undefined;
    const response = await up(entry, 'tools/call', { name, arguments: forceScope(entry, name, rest) }, msg.id, backendSession); const res = JSON.parse(response.text); log('CALL', entry.name, name, res.error ? 'error' : res.result?.isError ? 'denied-by-engram' : 'ok');
    if (name === 'engram_capabilities' && !entry.allowWrites && res.result && !res.result.isError) res.result = readOnlyCapabilities(res.result);
    return { ...res, id: msg.id };
  }
  return error(-32601, 'method not found');
}
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, workspaces: entries.length })); return; }
  if (req.method === 'GET' && req.url === '/mcp') { res.writeHead(405, { allow: 'POST' }).end(); return; }
  // This transport advertises no OAuth: discovery probes (GET /.well-known/...) get a plain 404, not 405.
  if (req.method === 'GET' && req.url.startsWith('/.well-known/')) { res.writeHead(404).end(); return; }
  if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(req.method === 'POST' ? 404 : 405).end(); return; }
  if (inboundHeader && !constantHeaderMatch(req.headers[inboundHeader], inboundKey)) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' })); return; }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415, { 'content-type': 'application/json' }).end(); return; }
  const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
  let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400).end(); return; }
  if (!msg || typeof msg.method !== 'string') { res.writeHead(400).end(); return; }
  if (msg.method === 'notifications/initialized' || msg.id === undefined) { if (msg.method === 'notifications/initialized') { try { await up(entries[0], msg.method, msg.params, undefined, typeof req.headers['mcp-session-id'] === 'string' ? await upstreamSession(entries[0], req.headers['mcp-session-id']) : undefined); } catch { /* notification has no response body */ } } res.writeHead(202).end(); return; }
  try {
    if (msg.method === 'initialize' || msg.method === 'ping') {
      const result = await up(entries[0], msg.method, msg.params, msg.id);
      if (result.sessionId) { sessions.set(result.sessionId, new Map([[entries[0].tokenEnv, result.sessionId]])); }
      res.writeHead(result.status, { 'content-type': result.contentType, ...(result.sessionId ? { 'mcp-session-id': result.sessionId } : {}) }).end(result.text); return;
    }
    if (msg.method === 'tools/list') { const out = await handle(msg, req.socket.remoteAddress, typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined); res.writeHead(200, { 'content-type': 'application/json', ...(req.headers['mcp-session-id'] ? { 'mcp-session-id': req.headers['mcp-session-id'] } : {}) }).end(JSON.stringify(out)); return; }
    if (msg.method === 'tools/call') {
      const workspace = msg.params?.arguments?.workspace, entry = lookup(workspace);
      if (!entry) { const out = await handle(msg, req.socket.remoteAddress); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out)); return; }
      const out = await handle(msg, req.socket.remoteAddress, typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined);
      res.writeHead(200, { 'content-type': 'application/json', ...(req.headers['mcp-session-id'] ? { 'mcp-session-id': req.headers['mcp-session-id'] } : {}) }).end(JSON.stringify(out)); return;
    }
    const entry = entries[0], clientSession = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    const result = await up(entry, msg.method, msg.params, msg.id, clientSession ? await upstreamSession(entry, clientSession) : undefined);
    res.writeHead(result.status, { 'content-type': result.contentType, ...(result.sessionId ? { 'mcp-session-id': result.sessionId } : {}) }).end(result.text);
  } catch (e) { log('ERR', String(e.message).slice(0, 120)); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'gateway upstream failure' } })); }
}).listen(port, bind, () => { if (!isLoopback) console.warn('WARNING: keyed gateway is bound beyond loopback; inbound header authentication is required'); log(`keyed gateway on ${bind}:${port} -> ${upstream} with ${entries.length} key(s): ${entries.map(e => e.name).join(', ')}`); });

function constantHeaderMatch(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(value), expectedBytes = Buffer.from(expected);
  const sameLength = actualBytes.length === expectedBytes.length;
  const comparison = timingSafeEqual(actualBytes.length === expectedBytes.length ? actualBytes : Buffer.alloc(expectedBytes.length), expectedBytes);
  return sameLength && comparison;
}
