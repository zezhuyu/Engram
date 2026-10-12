import test from 'node:test';
import assert from 'node:assert/strict';
import { isTailnetHost, remoteUrlAllowed, tailnetTrusted } from '../../packages/core/private-network.js';

const on = { MDB_TRANSPORT_TRUST: 'tailscale' } as NodeJS.ProcessEnv;
const off = {} as NodeJS.ProcessEnv;

test('tailnet host recognition is limited to 100.64.0.0/10, the tailnet IPv6 prefix and *.ts.net', () => {
  for (const host of ['100.64.0.1', '100.77.249.102', '100.127.255.254', 'fd7a:115c:a1e0::1', '[fd7a:115c:a1e0:ab12::7]', 'studio.tail1234.ts.net']) assert.equal(isTailnetHost(host), true, host);
  for (const host of ['100.63.255.255', '100.128.0.1', '10.0.0.1', '192.168.1.5', '0.0.0.0', '8.8.8.8', 'example.com', 'ts.net', 'evil-ts.net', 'a.ts.net.evil.com', 'fd7b::1', '']) assert.equal(isTailnetHost(host), false, host);
});

test('plain HTTP to a tailnet host is refused unless the operator opted in', () => {
  const url = new URL('http://100.77.249.102:3333/mcp');
  assert.equal(remoteUrlAllowed(url, off), false);
  assert.equal(remoteUrlAllowed(url, { MDB_TRANSPORT_TRUST: 'yes' } as NodeJS.ProcessEnv), false);
  assert.equal(tailnetTrusted(on), true);
  assert.equal(remoteUrlAllowed(url, on), true);
});

test('the opt-in never allows plain HTTP to LAN or public hosts, and other schemes stay refused', () => {
  for (const u of ['http://192.168.1.5:3333/mcp', 'http://example.com/mcp', 'http://10.0.0.2/mcp', 'http://0.0.0.0:3333/mcp', 'ftp://100.77.249.102/mcp']) assert.equal(remoteUrlAllowed(new URL(u), on), false, u);
});

test('HTTPS and loopback behave as before, with or without the opt-in', () => {
  for (const env of [off, on]) {
    assert.equal(remoteUrlAllowed(new URL('https://memory.example.org/mcp'), env), true);
    assert.equal(remoteUrlAllowed(new URL('http://localhost:3333/mcp'), env), true);
    assert.equal(remoteUrlAllowed(new URL('http://127.0.0.1:3333/mcp'), env), true);
    assert.equal(remoteUrlAllowed(new URL('http://[::1]:3333/mcp'), env), true);
  }
});

test('opt-in bind accepts all interfaces or a tailnet IP only, and only with the opt-in', async () => {
  const { bindAllowedWithoutTls } = await import('../../packages/core/private-network.js');
  for (const host of ['0.0.0.0', '::', '100.77.249.102']) { assert.equal(bindAllowedWithoutTls(host, on), true, host); assert.equal(bindAllowedWithoutTls(host, off), false, host); }
  for (const host of ['192.168.1.5', '203.0.113.9', 'example.com']) assert.equal(bindAllowedWithoutTls(host, on), false, host);
});

test('per-connection filter serves only loopback and tailnet peers (LAN and public peers are refused even on a 0.0.0.0 bind)', async () => {
  const { peerAllowed } = await import('../../packages/core/private-network.js');
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.83.107.85', '::ffff:100.83.107.85', 'fd7a:115c:a1e0::5']) assert.equal(peerAllowed(peer), true, peer);
  for (const peer of ['192.168.1.20', '10.0.2.152', '203.0.113.9', '::ffff:192.168.1.20', undefined, '']) assert.equal(peerAllowed(peer), false, String(peer));
});
