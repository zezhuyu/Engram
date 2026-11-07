#!/usr/bin/env node
// Network probe only. This is never evidence of a ChatGPT/Claude.ai invocation. Session-aware variant of verify-hosted-mcp.mjs for servers that require initialize + mcp-session-id and mdb_* tool names (the original probe is pinned to 5 checks by tests/security/tls-verification.test.ts).
import https from 'node:https';
import { writeFile } from 'node:fs/promises';

const endpoint = new URL(process.env.ENGRAM_PROBE_URL ?? '');
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') throw new Error('Provide a credential-free HTTPS /mcp URL in ENGRAM_PROBE_URL');
const token = process.env.ENGRAM_PROBE_TOKEN;
if (!token || token.length < 32) throw new Error('ENGRAM_PROBE_TOKEN must contain a dedicated scoped credential');
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Insecure TLS overrides are refused');
const checks = []; let id = 0;
let session;
const call = (method, params, bearer) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });
  const request = https.request(endpoint, { method: 'POST', rejectUnauthorized: true, timeout: 10_000,
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(session && bearer === token ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}) } }, response => {
    const chunks = []; let size = 0;
    response.on('data', chunk => { size += chunk.length; if (size > 1_000_000) response.destroy(new Error('Response exceeds probe budget')); else chunks.push(chunk); });
    response.on('error', reject);
    response.on('end', () => { try { resolve({ status: response.statusCode, session: response.headers['mcp-session-id'], body: JSON.parse(Buffer.concat(chunks).toString()), tls: request.socket.authorized === true }); } catch { reject(new Error('Endpoint did not return bounded JSON')); } });
  });
  request.on('timeout', () => request.destroy(new Error('Probe timed out'))); request.on('error', reject); request.end(body);
});
const check = (name, pass) => { checks.push({ name, pass }); if (!pass) throw new Error(`Failed: ${name}`); };
try {
  const anonymous = await call('tools/list'); check('verified TLS; anonymous discovery rejected', anonymous.tls && anonymous.status === 401);
  check('invalid bearer rejected', (await call('tools/list', undefined, 'invalid-credential'.repeat(3))).status === 401);
  const opened = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'engram-probe', version: '1' } }, token);
  check('authenticated initialize opens a session', opened.status === 200 && !opened.body.error);
  session = opened.session;
  const listed = await call('tools/list', undefined, token);
  check('authenticated remote tool discovery', listed.status === 200 && Array.isArray(listed.body.result?.tools) && listed.body.result.tools.some(tool => tool.name === 'mdb_search'));
  const scope = JSON.parse(process.env.ENGRAM_PROBE_SCOPE ?? 'null');
  if (!scope) throw new Error('ENGRAM_PROBE_SCOPE must specify the disposable authorized scope');
  const capability = await call('tools/call', { name: 'mdb_capabilities', arguments: {} }, token);
  check('authenticated capabilities report', capability.status === 200 && !capability.body.error && !capability.body.result?.isError);
  const search = await call('tools/call', { name: 'mdb_search', arguments: { query: 'ENGRAM_HOSTED_CANARY', scopes: [scope], limit: 1 } }, token);
  check('authorized search', search.status === 200 && !search.body.error && !search.body.result?.isError);
  if (process.env.ENGRAM_PROBE_OBJECT_ID) {
    const get = await call('tools/call', { name: 'mdb_get', arguments: { objectId: process.env.ENGRAM_PROBE_OBJECT_ID } }, token);
    check('authorized retrieval', get.status === 200 && !get.body.error && !get.body.result?.isError);
  }
} catch (error) { process.exitCode = 1; console.error(error.message); }
const report = { at: new Date().toISOString(), endpoint: endpoint.toString(), kind: 'https-network-probe', status: process.exitCode ? 'FAIL' : 'PASS', checks,
  hostedChatGPT: 'NOT_RUN', hostedClaudeAI: 'NOT_RUN', writes: 'NOT_RUN', limitation: 'Network probe only; no hosted account invocation, write or revocation evidence. No response bodies or credentials are recorded.' };
if (process.env.ENGRAM_PROBE_REPORT) await writeFile(process.env.ENGRAM_PROBE_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
