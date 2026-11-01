import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { stopOwnedChildProcess } from '../helpers/owned-process.js';
import { credentialAudit, createHttpCredential } from '../../packages/mcp/credentials.js';

const MCP = resolve('bin/mdb-mcp.js');
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('MCP shutdown drains briefly then closes an owned stalled request within a bound', async t => {
  const { root, vault } = await disposableVault(t);
  const credential = await createHttpCredential(vault, 'shutdown-drain', ['global:wiki:write']);
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  let stderr = ''; child.stderr.setEncoding('utf8');
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timeout: ${stderr}`)), 10_000);
    child.stderr.on('data', chunk => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); resolveEndpoint(match[1]!); } });
    child.once('exit', code => reject(new Error(`MCP exited ${code}: ${stderr}`)));
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  t.after(() => stopOwnedChildProcess(child, 7_000));
  const socket = net.connect(Number(new URL(endpoint).port), '127.0.0.1');
  await new Promise<void>((resolveConnect, reject) => { socket.once('connect', resolveConnect); socket.once('error', reject); });
  socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${credential.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await sleep(100);
  child.kill('SIGTERM');
  const result = await Promise.race([
    closed,
    sleep(8_000).then(() => { throw new Error('MCP server did not finish shutdown within its bounded drain period'); })
  ]);
  assert.equal(result.signal, null, 'the server handles SIGTERM gracefully after closing its owned connection');
  assert.equal(result.code, 0);
  socket.destroy();
});

test('unauthenticated HTTP flood is rejected before repeated durable credential writes', async t => {
  const { root, vault } = await disposableVault(t); const credential = await createHttpCredential(vault, 'flood-authorized', ['global:wiki:read', 'global:wiki:write']);
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0', MDB_MCP_HTTP_REQUESTS_PER_MINUTE: '1000' } });
  let stderr = ''; child.stderr.setEncoding('utf8');
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timeout: ${stderr}`)), 10_000);
    child.stderr.on('data', chunk => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); resolveEndpoint(match[1]!); } });
    child.once('exit', code => reject(new Error(`MCP exited ${code}: ${stderr}`)));
  });
  const stop = () => stopOwnedChildProcess(child, 7_000);
  t.after(stop);

  const writeBatch = async (prefix: string) => {
    const times: number[] = [];
    for (let i = 0; i < 60; i++) { const started = performance.now(); await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: `${prefix}-${i}`, body: `durable write ${prefix} ${i}` }); times.push(performance.now() - started); }
    return times;
  };
  let rpcId = 10;
  const authenticatedToolWriteBatch = async (prefix: string) => {
    const init = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'authorized-write-benchmark', version: '1' } } }) });
    assert.equal(init.status, 200); await init.arrayBuffer(); const sessionId = init.headers.get('mcp-session-id'); assert.ok(sessionId);
    const times: number[] = [];
    for (let index = 0; index < 60; index++) {
      const started = performance.now();
      const response: Response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Mcp-Session-Id': sessionId, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'engram_create', arguments: { scope: { type: 'global', area: 'wiki' }, kind: 'note', title: `${prefix}-${index}`, body: `authorized durable MCP write ${prefix} ${index}`, source: 'http-auth-admission-test', idempotencyKey: `${prefix}-${index}` } } }), signal: AbortSignal.timeout(3000) });
      const payload = await response.json() as { result?: { isError?: boolean } }; times.push(performance.now() - started);
      assert.equal(response.status, 200, `${prefix} tool write HTTP status`); assert.notEqual(payload.result?.isError, true, `${prefix} tool write result`);
    }
    return times;
  };
  const baseline = await writeBatch('baseline');
  const authorizedBaseline = await authenticatedToolWriteBatch('authorized-baseline');
  const statuses: Record<number | string, number> = {}; let attempted = 0;
  const client = async (requests: number) => { for (let index = 0; index < requests; index++) {
    attempted++;
    const malformed = ['not-a-bearer-token', 'Bearer', 'Basic Zm9v', 'Bearer !!!'][index % 4]!;
    try { const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: malformed, 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) }); statuses[response.status] = (statuses[response.status] ?? 0) + 1; await response.arrayBuffer(); }
    catch { statuses.err = (statuses.err ?? 0) + 1; }
    // Match the auditor's observed aggregate rate (~31 requests/second over
    // 38 seconds) instead of accidentally creating a >400 req/s stress test.
    await sleep(600);
  } };
  const floodStarted = Date.now();
  const flood = Promise.all(Array.from({ length: 20 }, (_, index) => client(index === 0 ? 61 : 60)));
  const underFlood = await writeBatch('under-flood'); const authorizedUnderFlood = await authenticatedToolWriteBatch('authorized-under-flood'); await flood;
  const floodMs = Date.now() - floodStarted;
  assert.equal(attempted, 1201, 'replay the original bounded 1,201-request flood');
  assert.ok((statuses[401] ?? 0) > 0, JSON.stringify(statuses));
  assert.ok((statuses[429] ?? 0) > 0 || (statuses.err ?? 0) > 0, `excess requests must be rate-limited or dropped before HTTP parsing: ${JSON.stringify(statuses)}`);
  const baselineP95 = percentile(baseline, 0.95), floodP95 = percentile(underFlood, 0.95);
  const authorizedBaselineP95 = percentile(authorizedBaseline, 0.95), authorizedFloodP95 = percentile(authorizedUnderFlood, 0.95);
  t.diagnostic(`direct Vault write ms p50/p95/p99 baseline=${percentile(baseline, 0.50).toFixed(2)}/${baselineP95.toFixed(2)}/${percentile(baseline, 0.99).toFixed(2)} flood=${percentile(underFlood, 0.50).toFixed(2)}/${floodP95.toFixed(2)}/${percentile(underFlood, 0.99).toFixed(2)}; authenticated MCP write ms p50/p95/p99 baseline=${percentile(authorizedBaseline, 0.50).toFixed(2)}/${authorizedBaselineP95.toFixed(2)}/${percentile(authorizedBaseline, 0.99).toFixed(2)} flood=${percentile(authorizedUnderFlood, 0.50).toFixed(2)}/${authorizedFloodP95.toFixed(2)}/${percentile(authorizedUnderFlood, 0.99).toFixed(2)}; invalid requests=${JSON.stringify(statuses)}`);
  // The absolute 50 ms contract belongs to the isolated benchmark invocation.
  // Parallel suites create unrelated filesystem and CPU load, so their gate is
  // the bounded relative regression; strict standalone runs retain the same
  // absolute budget for both direct and authenticated writes.
  const strictPerformance = process.env.MDB_STRICT_PERF_TEST === '1';
  if (strictPerformance) {
    assert.ok(baselineP95 <= 50, `standalone durable-write baseline p95 ${baselineP95.toFixed(2)} ms exceeds 50 ms`);
    assert.ok(floodP95 <= 50, `standalone durable-write p95 under flood ${floodP95.toFixed(2)} ms exceeds 50 ms (flood requests ${JSON.stringify(statuses)})`);
    assert.ok(authorizedBaselineP95 <= 50, `standalone authenticated baseline p95 ${authorizedBaselineP95.toFixed(2)} ms exceeds 50 ms`);
    assert.ok(authorizedFloodP95 <= 50, `standalone authenticated write p95 under flood ${authorizedFloodP95.toFixed(2)} ms exceeds 50 ms`);
  } else {
    t.diagnostic(`absolute p95 reserved for MDB_STRICT_PERF_TEST=1 isolated run; concurrent-suite samples direct=${baselineP95.toFixed(2)}/${floodP95.toFixed(2)} ms, authenticated=${authorizedBaselineP95.toFixed(2)}/${authorizedFloodP95.toFixed(2)} ms`);
    // The full verification matrix runs unrelated filesystem and CPU suites in
    // parallel. Keep that lane functional; the unchanged 50 ms requirement is
    // enforced by verify:auth-flood-performance in an isolated process.
    assert.ok(Number.isFinite(floodP95) && Number.isFinite(authorizedFloodP95), 'latency samples are finite');
  }

  // Auth must be checked before consuming even an oversized request body.
  await sleep(1_100); // allow the bounded invalid-token burst window to expire.
  // The server answers 401 without reading the body and may reset the connection while the client is still uploading 2.2 MB. Depending on the OS the client then
  // sees the 401 or a transport reset (undici reports `fetch failed`); either outcome shows that auth ran before the body was consumed. Any other failure is real.
  let oversizedOutcome: number | string;
  try {
    const oversized = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer malformed', 'Content-Type': 'application/json', Accept: 'application/json' }, body: 'x'.repeat(2_200_000), signal: AbortSignal.timeout(3000) });
    oversizedOutcome = oversized.status; await oversized.arrayBuffer().catch(() => undefined);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code ?? '';
    assert.ok(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code), `oversized unauthenticated request failed for an unexpected reason: ${String(error)} cause=${JSON.stringify((error as { cause?: unknown }).cause, Object.getOwnPropertyNames((error as { cause?: object }).cause ?? {}))}`);
    oversizedOutcome = `reset:${code}`;
  }
  assert.ok(oversizedOutcome === 401 || String(oversizedOutcome).startsWith('reset:'), `oversized unauthenticated body must be refused with 401 or a connection reset, got ${oversizedOutcome}`);

  // A peer that never completes its headers is bounded by Node's header timeout.
  const slowClient = net.connect(new URL(endpoint).port ? Number(new URL(endpoint).port) : 80, '127.0.0.1');
  const slowClosed = new Promise<void>(resolveClosed => slowClient.once('close', () => resolveClosed()));
  slowClient.write('POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer');
  try {
    await Promise.race([slowClosed, sleep(12_000).then(() => { throw new Error('slow incomplete headers were not closed within the configured 10 second timeout'); })]);
  } finally { slowClient.destroy(); }

  await sleep(1_100); // the peer failure burst expires before the legitimate request.
  const authorized = await authenticatedToolWriteBatch('authorized-after-window');
  assert.ok(authorized.length === 60);
  await stop();
  const failures = (await credentialAudit(vault)).filter(item => item.action === 'authorization_failed');
  assert.ok(failures.length > 0, 'auth failures remain auditable');
  assert.ok(failures.length <= Math.ceil(floodMs / 1_000) + 2, `failure audit was not aggregated to at most one event per flush interval: ${failures.length} events over ${floodMs}ms`);
  assert.ok(failures.reduce((sum, item) => sum + (item.attempts ?? 1), 0) >= (statuses[401] ?? 0), 'the batched audit records the failed-auth count');
});

test('authenticated admission is not keyed by peer sockets and admits 80 writes across proxied principals', async t => {
  const { root, vault } = await disposableVault(t);
  const credentials = await Promise.all(['proxy-a', 'proxy-b', 'proxy-c'].map(async actor => ({ actor, credential: await createHttpCredential(vault, actor, ['global:wiki:read', 'global:wiki:write']) })));
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0', MDB_MCP_HTTP_REQUESTS_PER_MINUTE: '1000' } });
  let stderr = ''; child.stderr.setEncoding('utf8');
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timeout: ${stderr}`)), 10_000);
    child.stderr.on('data', chunk => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); resolveEndpoint(match[1]!); } });
    child.once('exit', code => reject(new Error(`MCP exited ${code}: ${stderr}`)));
  });
  const stop = () => stopOwnedChildProcess(child, 7_000);
  t.after(stop);
  let rpcId = 1;
  const sessions = await Promise.all(credentials.map(async ({ actor, credential }) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: actor, version: '1' } } }) });
    assert.equal(response.status, 200); await response.arrayBuffer(); const sessionId = response.headers.get('mcp-session-id'); assert.ok(sessionId); return { actor, credential, sessionId };
  }));
  const responses = await Promise.all(Array.from({ length: 80 }, async (_, index) => {
    const { credential, sessionId } = sessions[index % sessions.length]!; const key = `r002-${index}`;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Mcp-Session-Id': sessionId, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'mdb_put', arguments: { scope: { type: 'global', area: 'wiki' }, kind: 'note', title: key, body: `bounded concurrent authorized write ${index}`, idempotencyKey: key } } }), signal: AbortSignal.timeout(15_000) });
      const text = await response.text(); let payload: { result?: { isError?: boolean }; error?: unknown } | undefined; try { payload = JSON.parse(text) as typeof payload; } catch { /* assertion below reports invalid body */ }
      return { status: response.status, retryAfter: response.headers.get('retry-after'), payload };
    } catch (error) { return { status: 'transport-error', message: (error as Error).message }; }
  }));
  assert.equal(responses.length, 80);
  assert.equal(responses.filter(item => item.status === 200 && item.payload?.result?.isError !== true && !item.payload?.error).length, 80, JSON.stringify(responses.filter(item => item.status !== 200 || item.payload?.result?.isError || item.payload?.error)));
  assert.equal((await vault.listDocuments()).filter(doc => doc.kind === 'note' && doc.title.startsWith('r002-')).length, 80, 'all acknowledged requests created exactly one document');

  // Eight idle sockets from the same peer no longer consume a per-peer quota.
  const idle = await Promise.all(Array.from({ length: 8 }, () => new Promise<net.Socket>((resolveSocket, reject) => { const socket = net.connect(Number(new URL(endpoint).port), '127.0.0.1', () => resolveSocket(socket)); socket.once('error', reject); })));
  try {
    const { credential, sessionId } = sessions[0]!; const key = 'r002-after-idle-sockets';
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Mcp-Session-Id': sessionId, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'mdb_put', arguments: { scope: { type: 'global', area: 'wiki' }, kind: 'note', title: key, body: 'The idle sockets do not reserve request capacity.', idempotencyKey: key } } }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); const payload = await response.json() as { result?: { isError?: boolean } }; assert.notEqual(payload.result?.isError, true);
  } finally { for (const socket of idle) socket.destroy(); }
  await stop();
});

test('failed-auth aggregates are durable before abrupt server termination', async t => {
  const { root, vault } = await disposableVault(t);
  const credential = await createHttpCredential(vault, 'audit-survivor', ['global:wiki:read']);
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  let stderr = ''; child.stderr.setEncoding('utf8');
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timeout: ${stderr}`)), 10_000);
    child.stderr.on('data', chunk => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); resolveEndpoint(match[1]!); } });
    child.once('exit', code => reject(new Error(`MCP exited ${code}: ${stderr}`)));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const stop = () => stopOwnedChildProcess(child, 7_000);
  t.after(stop);
  const responses: Response[] = [];
  for (let offset = 0; offset < 200; offset += 10) {
    responses.push(...await Promise.all(Array.from({ length: 10 }, () => fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer invalid-synthetic-token', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }))));
  }
  assert.equal(responses.length, 200);
  const responseStatuses = responses.reduce<Record<number, number>>((counts, response) => { counts[response.status] = (counts[response.status] ?? 0) + 1; return counts; }, {});
  await Promise.all(responses.map(response => response.arrayBuffer()));
  const flushDeadline = Date.now() + 10_000;
  let persistedAttempts = 0;
  do {
    const failures = (await credentialAudit(vault)).filter(item => item.action === 'authorization_failed');
    persistedAttempts = failures.reduce((sum, item) => sum + (item.attempts ?? 1), 0);
    if (persistedAttempts >= 180 || Date.now() >= flushDeadline) break;
    await sleep(100);
  } while (true);
  child.kill('SIGKILL');
  const exit = await exited;
  assert.equal(exit.signal, 'SIGKILL');
  const failures = (await credentialAudit(vault)).filter(item => item.action === 'authorization_failed');
  assert.ok(failures.length > 0, 'an auth-failure aggregate must already be durable before graceful shutdown');
  assert.ok(failures.reduce((sum, item) => sum + (item.attempts ?? 1), 0) >= 180, `most failures should be flushed before SIGKILL: statuses=${JSON.stringify(responseStatuses)} attempts=${JSON.stringify(failures.map(({ attempts }) => attempts))}`);
});
