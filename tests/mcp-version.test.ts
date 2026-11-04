import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { disposableVault } from './helpers/disposable-vault.js';
import { createHttpCredential } from '../packages/mcp/credentials.js';
import { ownChildProcess, stopOwnedChildProcess } from './helpers/owned-process.js';

test('HTTP GET /version is unauthenticated, admission checked and exposes only server package identity', async t => {
  const { root, vault } = await disposableVault(t); await createHttpCredential(vault, 'version-auth-check', ['global:shared:read']);
  const child = spawn(process.execPath, [resolve('bin/mdb-mcp.js'), '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0', MDB_MCP_HTTP_ALLOWED_ORIGINS: 'https://allowed.example' }, stdio: ['ignore', 'ignore', 'pipe'] });
  ownChildProcess(t, child); t.after(() => stopOwnedChildProcess(child));
  let stderr = '';
  const base = await new Promise<string>((resolveBase, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timeout: ${stderr}`)), 10_000);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string | Buffer) => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); resolveBase(match[1]!); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${stderr}`)); });
  });
  const response = await fetch(new URL('/version', base), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['name', 'version']); assert.deepEqual(body, { name: 'engram', version: '0.1.0' });
  assert.doesNotMatch(JSON.stringify(body), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((await fetch(new URL('/version', base), { method: 'POST' })).status, 405);
  assert.equal((await fetch(new URL('/version', base), { headers: { Origin: 'https://blocked.example' } })).status, 403, 'version requests use the configured origin admission policy');
});
