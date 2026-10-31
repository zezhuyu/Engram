import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { ownChildProcess, stopOwnedChildProcess } from '../helpers/owned-process.js';

for (const sqliteEnabled of [false, true]) test(`HTTP server maintains the ${sqliteEnabled ? 'SQLite' : 'filesystem'} search index independently of the credential-bound searcher`, { timeout: 120_000 }, async t => {
  const { root, vault } = await disposableVault(t, { sqlite: sqliteEnabled });
  await vault.createWorkspace('auto-index');
  const scope = { type: 'workspace' as const, workspaceId: 'auto-index' };
  for (let i = 0; i < 220; i++) await vault.put({ scope, kind: 'note', title: `indexed ${i}`, body: `ordinary document ${i}${i === 219 ? ' server-auto-index-marker' : ''}` });
  await vault.grant('auto-index', 'search-agent', ['read']);
  const credential = await createHttpCredential(vault, 'search-agent', ['workspace:auto-index:read']);
  const child = spawn(process.execPath, [path.resolve('bin/mdb-mcp.js'), '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  ownChildProcess(t, child);
  let stderr = ''; child.stderr.setEncoding('utf8');
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timeout after 60s: ${stderr}`)), 60_000);
    child.stderr.on('data', chunk => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); resolveEndpoint(match[1]!); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${stderr}`)); });
  });
  const stop = async () => stopOwnedChildProcess(child);
  const call = async (id: number, method: string, params: unknown, session?: string) => fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(30_000),
  });
  const initialize = await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'search-agent', version: '1' } });
  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get('mcp-session-id'); assert.ok(sessionId);
  const indexPath = sqliteEnabled
    ? path.join(root, '.mdb/indexes/workspace-auto-index.sqlite')
    : path.join(root, '.mdb/indexes/fs-trigram/meta.json');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await fs.stat(indexPath).then(() => true, () => false))) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  assert.ok(await fs.stat(indexPath).then(() => true, () => false), 'trusted server maintenance should publish the derived index without an owner search request');
  const response = await call(2, 'tools/call', { name: 'mdb_search', arguments: { query: 'server-auto-index-marker', mode: 'keyword', limit: 10 } }, sessionId);
  assert.equal(response.status, 200);
  const payload = await response.json() as { result?: { structuredContent?: { result?: { hits?: Array<{ title: string }>; backend?: string } }; content?: Array<{ text?: string }> } };
  assert.match(payload.result?.content?.map(item => item.text ?? '').join('\n') ?? '', /server-auto-index-marker/);
  assert.equal(payload.result?.structuredContent?.result?.hits?.length, 1);
  if (sqliteEnabled) assert.equal(payload.result?.structuredContent?.result?.backend, 'sqlite', 'credential-bound query uses the independently maintained SQLite index');
  await stop();
});
