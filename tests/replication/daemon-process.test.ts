import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeReplica, openReplica } from '../../packages/replication/client.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const spawnMdb = (args: string[], env: NodeJS.ProcessEnv) => spawn(process.execPath, [path.join(repo, 'bin/mdb.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const waitForDaemonReady = async (child: ChildProcess, statusFile: string, getOutput: () => string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: unknown;
  while (Date.now() < deadline) {
    assert.equal(alive(child), true, `daemon exited before readiness: ${getOutput()}`);
    try {
      const status = JSON.parse(await readFile(statusFile, 'utf8')) as { pid?: number; state?: string };
      lastStatus = status;
      if (status.pid === child.pid && ['offline', 'syncing', 'synced', 'refused', 'epoch-changed', 'paused', 'conflict'].includes(status.state ?? '')) return status;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await wait(25);
  }
  assert.fail(`daemon did not become ready within ${timeoutMs}ms (last status: ${JSON.stringify(lastStatus)}): ${getOutput()}`);
};

test('real daemon survives offline polling, writes atomic status, recovers a killed lock, and stops on SIGTERM', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-daemon-process-'));
  const replicaDir = path.join(root, 'replicas');
  const home = path.join(root, 'home');
  const token = path.join(root, 'token');
  await writeFile(token, 'process-test-token', { mode: 0o600 });
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, ENGRAM_REPLICA_DIR: process.env.ENGRAM_REPLICA_DIR };
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), ENGRAM_REPLICA_DIR: replicaDir };
  let daemon: ChildProcess | undefined;
  t.after(async () => {
    if (daemon && alive(daemon)) { const done = exited(daemon); daemon.kill('SIGKILL'); await done; }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  await initializeReplica({ serverUrl: 'http://127.0.0.1:9', tokenFile: token, name: 'process-daemon', baseDir: replicaDir });
  const args = ['replica', 'daemon', '--id', 'process-daemon', '--interval-s', '1', '--debounce-ms', '50'];
  const child = spawnMdb(args, env);
  daemon = child;
  let output = '';
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { output += chunk; });
  const statusFile = path.join(replicaDir, 'process-daemon', '.replica', 'status.json');
  const samples: number[] = [];
  await waitForDaemonReady(child, statusFile, () => output);
  for (let i = 0; i < 10; i++) {
    assert.equal(alive(child), true, `daemon exited early: ${output}`);
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      const raw = await readFile(statusFile, 'utf8');
      const status = JSON.parse(raw) as { state: string; backoffMs: number; pid: number };
      assert.equal(status.pid, child.pid);
      assert.ok(status.state === 'offline' || status.state === 'syncing');
      samples.push(status.backoffMs);
      await wait(25);
    }
  }
  assert.ok(Math.max(...samples) >= 2000, `offline backoff should grow in status.json; observed ${samples.join(',')}`);

  const killedExit = exited(child);
  child.kill('SIGKILL');
  const killed = await killedExit;
  assert.equal(killed.signal, 'SIGKILL');
  const restarted = spawnMdb(args, env);
  daemon = restarted;
  output = '';
  restarted.stderr.setEncoding('utf8'); restarted.stderr.on('data', chunk => { output += chunk; });
  await waitForDaemonReady(restarted, statusFile, () => output);
  const stopped = exited(restarted);
  restarted.kill('SIGTERM');
  const result = await Promise.race([stopped, wait(15_000).then(() => 'timeout' as const)]);
  if (result === 'timeout') assert.fail('SIGTERM shutdown exceeded fifteen seconds under load');
  assert.equal(result.code, 0, output);
  const finalStatus = JSON.parse(await readFile(statusFile, 'utf8')) as { pid: number; state: string };
  assert.equal(finalStatus.pid, 0);
  await assert.rejects(readFile(path.join(path.dirname(statusFile), 'daemon.lock'), 'utf8'), { code: 'ENOENT' });
});

test('real daemon stays idle after credential revocation without retrying continuously', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-daemon-refused-'));
  const replicaDir = path.join(root, 'replicas'), token = path.join(root, 'token');
  await writeFile(token, 'revoked-process-token', { mode: 0o600 });
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":"revoked"}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert(address && typeof address === 'object');
  await initializeReplica({ serverUrl: `http://127.0.0.1:${address.port}`, tokenFile: token, name: 'process-refused', baseDir: replicaDir });
  const env = { ...process.env, ENGRAM_REPLICA_DIR: replicaDir, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
  const child = spawnMdb(['replica', 'daemon', '--id', 'process-refused', '--interval-s', '1'], env);
  t.after(async () => { if (alive(child)) { child.kill('SIGKILL'); await exited(child); } });
  const statusFile = path.join(replicaDir, 'process-refused', '.replica', 'status.json');
  const deadline = Date.now() + 5000;
  let status: { state: string; pid: number } | undefined;
  while (Date.now() < deadline) {
    try { status = JSON.parse(await readFile(statusFile, 'utf8')) as { state: string; pid: number }; if (status.state === 'refused') break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await wait(25);
  }
  assert.equal(status?.state, 'refused');
  await wait(250);
  const refusedRequestCount = requests;
  await wait(3000);
  assert.equal(alive(child), true);
  assert.equal(requests, refusedRequestCount, 'a refused credential should not create a retry storm');
  const stopped = exited(child);
  child.kill('SIGTERM');
  const result = await Promise.race([stopped, wait(15_000).then(() => 'timeout' as const)]);
  if (result === 'timeout') assert.fail('refused daemon did not stop on SIGTERM');
  assert.equal(result.code, 0);
});

test('SIGTERM aborts an in-flight hung replica request within three seconds and preserves the queue', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-daemon-hung-'));
  const replicaDir = path.join(root, 'replicas'), token = path.join(root, 'token');
  await writeFile(token, 'hung-server-token', { mode: 0o600 });
  const server = createServer(() => { /* accept the request and deliberately never respond */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const env = { ...process.env, ENGRAM_REPLICA_DIR: replicaDir, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
  const replica = await initializeReplica({ serverUrl: `http://127.0.0.1:${address.port}`, tokenFile: token, name: 'hung-process', baseDir: replicaDir });
  const { store } = await openReplica(replica.replicaId, replicaDir); await store.enrollScope({ type: 'workspace', workspaceId: 'proj' });
  await store.vault.put({ scope: { type: 'workspace', workspaceId: 'proj' }, kind: 'note', title: 'Queued before shutdown', body: 'must remain queued' });
  const child = spawnMdb(['replica', 'daemon', '--id', replica.replicaId, '--interval-s', '1'], env);
  let output = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { output += chunk; });
  t.after(async () => { if (alive(child)) { child.kill('SIGKILL'); await exited(child); } server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const statusFile = path.join(replicaDir, replica.replicaId, '.replica', 'status.json'), deadline = Date.now() + 5000;
  while (Date.now() < deadline) { try { const status = JSON.parse(await readFile(statusFile, 'utf8')) as { state: string }; if (status.state === 'syncing') break; } catch {} await wait(20); }
  const load = spawn(process.execPath, ['-e', 'const end=Date.now()+5000;while(Date.now()<end){}'], { stdio: 'ignore' });
  const started = Date.now(), stopped = exited(child); child.kill('SIGTERM');
  const result = await Promise.race([stopped, wait(3000).then(() => 'timeout' as const)]);
  load.kill('SIGKILL');
  if (result === 'timeout') assert.fail('hung fetch blocked SIGTERM'); assert.equal(result.code, 0, output); assert.ok(Date.now() - started < 3000);
  const reopened = await openReplica(replica.replicaId, replicaDir); assert.equal(reopened.store.status().pendingPush, 1, 'aborted fetch must not discard or corrupt queued operations');
});

test('replica stdio MCP process remains alive while idle', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-mcp-process-'));
  const home = path.join(root, 'home'), replicaDir = path.join(root, 'replicas'), token = path.join(root, 'token');
  await writeFile(token, 'stdio-test-token', { mode: 0o600 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), ENGRAM_REPLICA_DIR: replicaDir };
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await initializeReplica({ serverUrl: 'http://127.0.0.1:9', tokenFile: token, name: 'process-mcp', baseDir: replicaDir });
  const { store } = await openReplica('process-mcp', replicaDir);
  await store.enrollScope({ type: 'workspace', workspaceId: 'proj' });
  const child = spawn(process.execPath, [path.join(repo, 'bin/mdb-mcp.js'), '--replica', 'process-mcp', '--workspace', 'proj'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (alive(child)) child.kill('SIGTERM'); });
  let stdout = '';
  child.stdout!.setEncoding('utf8');
  const initialized = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`replica stdio MCP did not answer initialize: ${stdout}`)), 5000);
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        try { if (JSON.parse(line).id === 1) { clearTimeout(timeout); resolve(); return; } } catch { /* wait for a complete JSON-RPC line */ }
      }
    });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`replica stdio MCP exited before initialize (${code ?? signal}): ${stdout}`)); });
  });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'daemon-process-test', version: '1' } } })}\n`);
  await initialized;
  await wait(10_000);
  assert.equal(alive(child), true, 'replica stdio MCP server exited while idle');
  child.kill('SIGTERM');
  await exited(child);
});

test('outbox-watch CLI process remains alive while its queue is idle', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-outbox-watch-process-'));
  const token = path.join(root, 'token'), outbox = path.join(root, 'outbox');
  await writeFile(token, 'outbox-watch-process-token', { mode: 0o600 });
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), ENGRAM_OUTBOX: outbox };
  const child = spawnMdb(['outbox', 'watch', '--url', 'http://127.0.0.1:9', '--token-file', token, '--outbox', outbox, '--interval-sec', '1'], env);
  t.after(async () => { if (alive(child)) { child.kill('SIGKILL'); await exited(child); } await rm(root, { recursive: true, force: true }); });
  let output = '';
  child.stderr!.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`outbox watcher did not report startup: ${output}`)), 5000);
    child.stderr!.on('data', (chunk: string) => { output += chunk; if (output.includes('"event":"start"')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`outbox watcher exited before startup (${code ?? signal}): ${output}`)); });
  });
  await wait(10_000);
  assert.equal(alive(child), true, 'outbox watcher exited while its queue was idle');
  const stopped = exited(child);
  child.kill('SIGTERM');
  const result = await Promise.race([stopped, wait(15_000).then(() => 'timeout' as const)]);
  if (result === 'timeout') assert.fail('outbox watcher did not stop on SIGTERM');
  assert.equal(result.code, 0);
});
