import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { stopOwnedChildProcess } from '../helpers/owned-process.js';
import { serverBasePath, serverRouteUrl } from '../../packages/core/server-url.js';

const MCP = resolve('bin/mdb-mcp.js');
const TOKEN = 'gateway-base-path-test-token-at-least-32-bytes';
const freePort = (): Promise<number> => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

test('client route URLs keep a gateway prefix and still work for unprefixed servers', () => {
  assert.equal(serverBasePath('https://h.ts.net/engram/mcp'), '/engram');
  assert.equal(serverBasePath('https://h.ts.net/engram/'), '/engram');
  assert.equal(serverBasePath('https://h.ts.net/mcp'), '');
  assert.equal(serverBasePath('https://h.ts.net'), '');
  assert.equal(serverRouteUrl('https://h.ts.net/engram/mcp', '/replica/v1/hello').toString(), 'https://h.ts.net/engram/replica/v1/hello');
  assert.equal(serverRouteUrl('https://h.ts.net/engram', '/replica/v1/blobs/abc?scope=w&deviceId=d').toString(), 'https://h.ts.net/engram/replica/v1/blobs/abc?scope=w&deviceId=d');
  assert.equal(serverRouteUrl('https://h.ts.net/mcp', '/client/heartbeat').toString(), 'https://h.ts.net/client/heartbeat');
  assert.equal(serverRouteUrl('https://h.ts.net', '/version').toString(), 'https://h.ts.net/version');
});

test('the server answers under its public path prefix and without it', async t => {
  const { root } = await disposableVault(t); const port = await freePort();
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_TOKEN: TOKEN, MDB_ACTOR_ID: 'gw-test', MDB_PERMISSIONS: '*', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port), MDB_MCP_PUBLIC_URL: 'https://gw.example/engram/mcp' } });
  t.after(() => stopOwnedChildProcess(child));
  let stderr = ''; child.stderr.setEncoding('utf8');
  await new Promise<void>((res, rej) => { const timer = setTimeout(() => rej(new Error(`MCP startup timeout: ${stderr}`)), 10_000); child.stderr.on('data', (c: string) => { stderr += c; if (/MCP HTTP listening/.test(stderr)) { clearTimeout(timer); res(); } }); });
  const init = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }), signal: AbortSignal.timeout(5000) });
  assert.equal((await init('/engram/mcp')).status, 200, 'prefixed');
  assert.equal((await init('/mcp')).status, 200, 'prefix stripped by the gateway');
  assert.equal((await init('/other/mcp')).status, 404, 'a different prefix is not accepted');
  assert.equal((await fetch(`http://127.0.0.1:${port}/engram/version`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test('a replica config may carry a gateway prefix and rejects other non-canonical server URLs', async t => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { readReplicaConfig, replicaServerUrl } = await import('../../packages/replication/client.js');
  assert.equal(replicaServerUrl('https://h.ts.net/engram/mcp'), 'https://h.ts.net/engram');
  assert.equal(replicaServerUrl('https://h.ts.net/mcp'), 'https://h.ts.net');
  const base = await mkdtemp(join(tmpdir(), 'replica-cfg-')); t.after(() => rm(base, { recursive: true, force: true }));
  const write = async (serverUrl: string) => { await mkdir(join(base, 'r1', '.replica'), { recursive: true }); await writeFile(join(base, 'r1', '.replica', 'config.json'), JSON.stringify({ version: 1, replicaId: 'r1', serverUrl, tokenFile: '/tmp/t', createdAt: 'x' }), { mode: 0o600 }); };
  await write('https://h.ts.net/engram'); assert.equal((await readReplicaConfig('r1', base)).serverUrl, 'https://h.ts.net/engram');
  await write('https://h.ts.net'); assert.equal((await readReplicaConfig('r1', base)).serverUrl, 'https://h.ts.net');
  await write('https://h.ts.net/engram/mcp'); await assert.rejects(readReplicaConfig('r1', base), /invalid/);
  await write('https://h.ts.net/engram?x=1'); await assert.rejects(readReplicaConfig('r1', base), /invalid/);
});
