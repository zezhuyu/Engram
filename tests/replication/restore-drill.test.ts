import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { Vault } from '../../packages/core/vault.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { handleReplicaRoute } from '../../packages/mcp/replica-http.js';
import { initializeReplica, openReplica, resyncWorkspace } from '../../packages/replication/client.js';
import { syncOnce } from '../../packages/replication/sync.js';

test('two replicas retain and explicitly republish revisions after a real older-backup restore', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-restore-drill-'));
  const priorState = process.env.ENGRAM_STATE_DIR, priorReplicaDir = process.env.ENGRAM_REPLICA_DIR;
  process.env.ENGRAM_STATE_DIR = path.join(root, 'state'); process.env.ENGRAM_REPLICA_DIR = path.join(root, 'replicas');
  t.after(async () => { if (priorState === undefined) delete process.env.ENGRAM_STATE_DIR; else process.env.ENGRAM_STATE_DIR = priorState; if (priorReplicaDir === undefined) delete process.env.ENGRAM_REPLICA_DIR; else process.env.ENGRAM_REPLICA_DIR = priorReplicaDir; await rm(root, { recursive: true, force: true }); });
  const originPath = path.join(root, 'origin'), backupPath = path.join(root, 'older-backup');
  const initial = new Engram(originPath); await initial.vault.init(); await initial.createWorkspace('restore');
  await initial.vault.grant('restore', 'restore-agent', ['read', 'write']);
  const scope = { type: 'workspace' as const, workspaceId: 'restore' }, actor = { actorId: 'restore-agent', permissions: ['workspace:restore:read', 'workspace:restore:write'], credentialBound: true };
  const base = await initial.vault.put({ scope, kind: 'note', title: 'survivor', body: 'in older backup' });
  const credential = await createHttpCredential(initial.vault, 'restore-agent', ['workspace:restore:read', 'workspace:restore:write']);
  let originVault = initial.vault;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const data = Buffer.concat(chunks);
    const send = (_res: typeof res, status: number, value?: unknown, headers?: Record<string, string>) => { const output = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)); res.writeHead(status, { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }); res.end(output); };
    if (req.headers.authorization !== `Bearer ${credential.token}`) { send(res, 401, { error: 'Unauthorized' }); return; }
    try { await handleReplicaRoute(originPath, originVault, actor, credential.id, req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), async () => JSON.parse(data.toString('utf8')), send); } catch { if (!res.headersSent) send(res, 500, { error: 'internal' }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === 'object'); const url = `http://127.0.0.1:${address.port}`, tokenFile = path.join(root, 'token'); await writeFile(tokenFile, credential.token, { mode: 0o600 });
  for (const id of ['replica-a', 'replica-b']) {
    await initializeReplica({ serverUrl: url, tokenFile, name: id, baseDir: process.env.ENGRAM_REPLICA_DIR! }); const { store } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!);
    const response = await fetch(url + '/replica/v1/enroll', { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: store.deviceId, workspaceId: 'restore', label: id }) }); assert.equal(response.status, 200); await store.enrollScope(scope); const sync = await syncOnce(store, (await openReplica(id, process.env.ENGRAM_REPLICA_DIR!)).transport); assert.deepEqual(sync.errors, []);
  }
  await initial.vault.backup(backupPath);
  const serverRevision = await originVault.patch({ objectId: base.id, expectedRevisionId: base.revisionId, body: 'server revision absent from old backup' });
  const opIds: string[] = [];
  for (const [index, id] of ['replica-a', 'replica-b'].entries()) { const { store } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!); assert.deepEqual((await syncOnce(store, (await openReplica(id, process.env.ENGRAM_REPLICA_DIR!)).transport)).errors, []); const current = await store.vault.get(base.id); const local = await store.vault.patch({ objectId: base.id, expectedRevisionId: current.revisionId, body: `local pending ${index}` }); opIds.push(store.pendingBatch().find(op => op.revisionId === local.revisionId)!.opId); }
  assert.equal((await originVault.events()).some(event => event.revisionId === serverRevision.revisionId), true);

  await rm(originPath, { recursive: true, force: true });
  const restoreOutput = execFileSync(process.execPath, ['bin/mdb.js', 'backup', 'restore', backupPath, originPath], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.match(restoreOutput, /"replicasMustResync":\s*true/, 'the supported restore command bumps the server epoch automatically');
  originVault = new Vault(originPath); assert.equal((await originVault.get(base.id)).revisionId, base.revisionId);
  const survivors: Array<{ replica: string; serverHead: string; pendingCandidate: string; rejected: string }> = [];
  for (const [index, id] of ['replica-a', 'replica-b'].entries()) {
    let { store, transport } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!);
    assert.equal(store.status().pendingPush, 1, 'each replica retains its queued commit across restore');
    const epochReport = await syncOnce(store, transport); assert.equal(epochReport.epochChanged, true, 'the changed server epoch is reported before pushing');
    store = (await openReplica(id, process.env.ENGRAM_REPLICA_DIR!)).store;
    assert.equal(store.status().pendingPush, 1, 'epoch-change detection does not drop the queued operation');
    await resyncWorkspace(id, 'restore', process.env.ENGRAM_REPLICA_DIR!);
    ({ store, transport } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!));
    assert.equal(store.status().state, 'ready');
    assert.equal((await store.vault.get(base.id)).body, `local pending ${index}`, 'local revision bytes remain readable');
    const rejected = await syncOnce(store, transport); assert.ok(rejected.rejected === 1 || rejected.conflicts === 1, 'orphan must be rejected or surfaced as an explicit conflict');
    const opId = opIds[index]!;
    const resultRows = (await (await import('node:fs/promises')).readFile(path.join(store.state, 'results.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { opId: string; result: { code?: string } });
    assert.ok(resultRows.find(row => row.opId === opId)?.result.code === 'PARENT_MISSING' || store.conflicts.some(conflict => conflict.objectId === base.id && conflict.candidateRevisionIds.includes(store.conflicts.find(candidate => candidate.objectId === base.id)?.localRevisionId ?? '')), 'orphan is retained as a rejection or conflict candidate');
    const localEvent = (await store.vault.events()).findLast(event => event.objectId === base.id)!;
    survivors.push({ replica: id, serverHead: base.revisionId, pendingCandidate: localEvent.revisionId, rejected: opId });
    const rawQueue = await (await import('node:fs/promises')).readFile(path.join(store.state, 'pending.jsonl'), 'utf8').catch(() => '');
    assert.ok(rawQueue.includes(opId) || resultRows.some(row => row.opId === opId), `orphan operation record missing: ${opId}; queue=${rawQueue}; results=${JSON.stringify(resultRows)}; conflicts=${JSON.stringify(store.conflicts)}`);
    const republished = JSON.parse(execFileSync(process.execPath, ['bin/mdb.js', 'replica', 'republish', opId, '--id', id, '--reviewed'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' })) as { republishedFrom: string[] };
    assert.equal(republished.republishedFrom.includes(localEvent.revisionId), true);
  }
  for (const id of ['replica-a', 'replica-b']) { const { store, transport } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!); assert.equal((await syncOnce(store, transport)).errors.length, 0); }
  const finalOrigin = new Vault(originPath), republishedIds = (await finalOrigin.listDocuments({ scopes: [scope] })).filter(doc => doc.metadata.republishedFromOpId).map(doc => doc.id);
  for (const id of ['replica-a', 'replica-b']) { const { store, transport } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!); assert.equal((await syncOnce(store, transport)).errors.length, 0); }
  const originDocs = await finalOrigin.listDocuments({ scopes: [scope] });
  assert.equal(originDocs.filter(doc => doc.metadata.republishedFromOpId).length, 2, 'each explicitly reviewed orphan chain becomes a fresh origin object');
  assert.equal((await finalOrigin.get(base.id)).revisionId, base.revisionId, 'restored origin keeps the older base head');
  assert.equal((await finalOrigin.events()).some(event => event.objectId === base.id && event.revisionId === serverRevision.revisionId), false, 'the post-backup server revision is absent at the restored origin');
  for (const id of ['replica-a', 'replica-b']) { const { store } = await openReplica(id, process.env.ENGRAM_REPLICA_DIR!); assert.equal((await store.vault.get(base.id)).body.startsWith('local pending '), true); const events = await store.vault.events(); assert.ok(events.some(event => event.objectId === base.id && event.revisionId === serverRevision.revisionId), 'the replica retains the pre-restore server revision'); for (const objectId of new Set(republishedIds)) assert.ok(events.some(event => event.objectId === objectId), `republished object ${objectId} reaches both replicas`); assert.equal(store.status().pendingPush, 0); assert.equal((await store.verify()).ok, true); }
  assert.equal((await finalOrigin.verify()).ok, true);
  process.stdout.write(`restore-drill survivors ${JSON.stringify({ origin: { restoredHead: base.revisionId, postBackupRevisionRemovedByRestore: serverRevision.revisionId, republishedObjects: republishedIds }, replicas: survivors })}\n`);
});
