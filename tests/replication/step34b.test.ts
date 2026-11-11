import '../helpers/isolate-user-state.js';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { handleReplicaRoute } from '../../packages/mcp/replica-http.js';
import { initializeReplica, enrollWorkspace, openReplica } from '../../packages/replication/client.js';
import { DEFAULT_REPLICA_LIMITS } from '../../packages/replication/internals.js';
import { nextReplicaBackoffMs } from '../../packages/replication/daemon.js';
import { HttpReplicaTransport, ReplicaHttpError } from '../../packages/replication/sync.js';

async function originFixture(t: TestContext, root: string) {
  const owner = new Engram(path.join(root, 'origin'));
  await owner.vault.init();
  await owner.createWorkspace('project');
  await owner.vault.grant('project', 'replica-agent', ['read', 'write']);
  const credential = await createHttpCredential(owner.vault, 'replica-agent', ['workspace:project:read', 'workspace:project:write']);
  const actor = { actorId: 'replica-agent', permissions: ['workspace:project:read', 'workspace:project:write'], credentialBound: true };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const send = (_res: typeof res, status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${credential.token}`) { send(res, 401, { error: 'Unauthorized' }); return; }
    try { await handleReplicaRoute(path.join(root, 'origin'), owner.vault, actor, credential.id, req, res, url, async () => JSON.parse(body.toString('utf8')), send); }
    catch { if (!res.headersSent) send(res, 500, { error: 'internal' }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === 'object');
  return { owner, url: `http://127.0.0.1:${address.port}`, token: credential.token };
}

test('replica add enforces maxReplicaBytes unless --force is selected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-force-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { owner, url, token } = await originFixture(t, root);
  await owner.vault.put({ scope: { type: 'workspace', workspaceId: 'project' }, kind: 'note', title: 'large enough', body: 'x'.repeat(20_000) });
  const tokenFile = path.join(root, 'token'); await writeFile(tokenFile, token, { mode: 0o600 });
  const base = path.join(root, 'replicas'); await initializeReplica({ serverUrl: url, tokenFile, name: 'force-test', baseDir: base });
  const replica = await openReplica('force-test', base);
  await writeFile(path.join(replica.store.state, 'limits.json'), JSON.stringify({ ...DEFAULT_REPLICA_LIMITS, maxReplicaBytes: 1 }), { mode: 0o600 });
  await assert.rejects(enrollWorkspace('force-test', 'project', base), /REPLICA_TOO_LARGE.*--force/);
  assert.equal(replica.store.workspaceStatuses().some(row => row.workspaceId === 'project'), false, 'refused enrollment remains local and unregistered');
  const forced = await enrollWorkspace('force-test', 'project', base, true);
  assert.equal(forced.enrolled, true);
  assert.equal((await openReplica('force-test', base)).store.workspaceStatuses().some(row => row.workspaceId === 'project'), true);
});

test('daemon retry policy honors 429 and 503 Retry-After and resumes after bounded requests', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-retry-after-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { owner, url, token } = await originFixture(t, root);
  const tokenFile = path.join(root, 'token'); await writeFile(tokenFile, token, { mode: 0o600 });
  const base = path.join(root, 'replicas'); await initializeReplica({ serverUrl: url, tokenFile, name: 'retry-test', baseDir: base });
  const opened = await openReplica('retry-test', base);
  await owner.vault.put({ scope: { type: 'workspace', workspaceId: 'project' }, kind: 'note', title: 'retry target', body: 'base' });
  await fetch(url + '/replica/v1/enroll', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: opened.store.deviceId, workspaceId: 'project', label: 'retry-test' }) });
  await opened.store.enrollScope({ type: 'workspace', workspaceId: 'project' });
  await opened.store.vault.put({ scope: { type: 'workspace', workspaceId: 'project' }, kind: 'note', title: 'queued', body: 'durable' });
  const operation = opened.store.pendingBatch()[0]!;
  let requests = 0;
  const transport = new HttpReplicaTransport(url, tokenFile, async () => {
    requests++;
    if (requests === 1) return new Response('busy', { status: 429, headers: { 'Retry-After': '2' } });
    if (requests === 2) return new Response('busy', { status: 503, headers: { 'Retry-After': '3' } });
    return new Response(JSON.stringify({ results: [{ opId: operation.opId, status: 'accepted', code: 'COMMITTED' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  for (const [status, expected] of [[429, 2000], [503, 3000]] as const) {
    await assert.rejects(transport.push(opened.store.deviceId, [operation]), error => error instanceof ReplicaHttpError && error.status === status && error.retryAfterMs === expected);
  }
  const result = await transport.push(opened.store.deviceId, [operation]);
  assert.equal(result.results[0]?.status, 'accepted');
  assert.equal(requests, 3, 'one request per response; retries are scheduled by the daemon policy');
  assert.equal(nextReplicaBackoffMs(0, 2000, () => 0.5), 2000);
  assert.equal(nextReplicaBackoffMs(2000, 3000, () => 0.5), 3000);
  assert.equal(nextReplicaBackoffMs(0, 0, () => 0.5), 1500, 'ordinary failures retain exponential backoff with jitter');
});
