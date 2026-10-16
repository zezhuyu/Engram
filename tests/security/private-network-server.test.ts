import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { isTailnetHost } from '../../packages/core/private-network.js';

const MCP = resolve('bin/mdb-mcp.js');
const TOKEN = 'private-network-test-token-at-least-32-bytes';
const lanAddress = Object.values(os.networkInterfaces()).flat().find(n => n && n.family === 'IPv4' && !n.internal && !isTailnetHost(n.address))?.address;
const freePort = (): Promise<number> => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const baseEnv = (root: string, extra: Record<string, string>) => ({ ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_TOKEN: TOKEN, MDB_ACTOR_ID: 'net-test', MDB_PERMISSIONS: '*', ...extra });
const initialize = (url: string) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '1' } } }), signal: AbortSignal.timeout(5000) });

test('a malformed request target receives 400 and does not terminate the MCP HTTP process', async t => {
  const { root } = await disposableVault(t); const port = await freePort();
  const child = spawn(process.execPath, [MCP, '--root', root], { env: baseEnv(root, { MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port) }) });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(r => child.once('exit', () => r())); } });
  let stderr = ''; child.stderr.setEncoding('utf8');
  await new Promise<void>((res, rej) => { child.stderr.on('data', (c: string) => { stderr += c; if (/MCP HTTP listening/.test(stderr)) res(); }); child.once('exit', code => rej(new Error(`exited ${code}: ${stderr}`))); });
  const malformed = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    let response = ''; socket.setEncoding('utf8'); socket.on('data', chunk => response += chunk); socket.on('end', () => resolve(response)); socket.on('error', reject); setTimeout(() => socket.destroy(new Error('malformed request timed out')), 3000).unref();
  });
  assert.match(malformed, /^HTTP\/1\.1 400\b/);
  assert.equal(child.exitCode, null, 'server remains available after malformed input');
  const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
  assert.equal(denied.status, 401);
});

test('without the opt-in a non-loopback plain-HTTP bind is refused, even on a tailnet address or 0.0.0.0', async t => {
  const { root } = await disposableVault(t);
  for (const host of ['0.0.0.0', '100.77.249.102']) {
    const child = spawnSync(process.execPath, [MCP, '--root', root], { encoding: 'utf8', env: baseEnv(root, { MDB_MCP_HTTP_HOST: host, MDB_MCP_HTTP_PORT: '0', MDB_MCP_HTTP_ALLOWED_HOSTS: 'x.example:1' }), timeout: 20_000 });
    assert.equal(child.status, 1, host); assert.match(child.stderr, /requires MDB_MCP_HTTP_ALLOWED_HOSTS and an HTTPS MDB_MCP_PUBLIC_URL/);
  }
});

test('with the opt-in a LAN or public bind address is still refused', async t => {
  const { root } = await disposableVault(t);
  for (const host of [lanAddress, '203.0.113.9'].filter((h): h is string => !!h)) {
    const child = spawnSync(process.execPath, [MCP, '--root', root], { encoding: 'utf8', env: baseEnv(root, { MDB_TRANSPORT_TRUST: 'tailscale', MDB_MCP_HTTP_HOST: host, MDB_MCP_HTTP_PORT: '0', MDB_MCP_HTTP_ALLOWED_HOSTS: 'x.example:1' }), timeout: 20_000 });
    assert.equal(child.status, 1, host); assert.match(child.stderr, /requires MDB_MCP_HTTP_ALLOWED_HOSTS and an HTTPS MDB_MCP_PUBLIC_URL/);
  }
});

test('opt-in 0.0.0.0 bind serves loopback peers and drops LAN peers before authentication', async t => {
  const { root } = await disposableVault(t); const port = await freePort();
  const child = spawn(process.execPath, [MCP, '--root', root], { env: baseEnv(root, { MDB_TRANSPORT_TRUST: 'tailscale', MDB_MCP_HTTP_HOST: '0.0.0.0', MDB_MCP_HTTP_PORT: String(port), MDB_MCP_HTTP_ALLOWED_HOSTS: [`127.0.0.1:${port}`, ...(lanAddress ? [`${lanAddress}:${port}`] : [])].join(',') }) });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(r => child.once('exit', () => r())); } });
  let stderr = ''; child.stderr.setEncoding('utf8');
  await new Promise<void>((res, rej) => { child.stderr.on('data', (c: string) => { stderr += c; if (/MCP HTTP listening/.test(stderr)) res(); }); child.once('exit', code => rej(new Error(`exited ${code}: ${stderr}`))); });
  const ok = await initialize(`http://127.0.0.1:${port}/mcp`); assert.equal(ok.status, 200);
  if (!lanAddress) { t.diagnostic('no LAN interface on this machine: the peer-refusal half is not exercised'); return; }
  await assert.rejects(initialize(`http://${lanAddress}:${port}/mcp`), 'a peer that is neither loopback nor tailnet must be dropped, with a valid token');
});
