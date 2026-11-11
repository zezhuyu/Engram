import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn, execFileSync } from 'node:child_process';
import { Engram } from '../packages/sdk/index.js';
import { createHttpCredential } from '../packages/mcp/credentials.js';
import { handleReplicaRoute } from '../packages/mcp/replica-http.js';
import { initializeReplica, openReplica } from '../packages/replication/client.js';
import { syncOnce } from '../packages/replication/sync.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'engram-replica-benchmark-'));
let requestBytes = 0, responseBytes = 0;
try {
  const owner = new Engram(path.join(root, 'origin')); await owner.vault.init(); await owner.createWorkspace('bench');
  await owner.vault.grant('bench', 'benchmark-agent', ['read', 'write']);
  const credential = await createHttpCredential(owner.vault, 'benchmark-agent', ['workspace:bench:read', 'workspace:bench:write']);
  const actor = { actorId: 'benchmark-agent', permissions: ['workspace:bench:read', 'workspace:bench:write'], credentialBound: true };
  const origin = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) { const bytes = Buffer.from(chunk); requestBytes += bytes.length; chunks.push(bytes); }
    const body = Buffer.concat(chunks), send = (_res: typeof res, status: number, value?: unknown, headers?: Record<string, string>) => {
      const output = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)); responseBytes += output.length;
      res.writeHead(status, { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers, ...(output.length ? { 'content-length': String(output.length) } : {}) }); res.end(output);
    };
    try { await handleReplicaRoute(path.join(root, 'origin'), owner.vault, actor, credential.id, req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), async () => JSON.parse(body.toString('utf8')), send); }
    catch { if (!res.headersSent) send(res, 500, { error: 'internal' }); }
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address(); if (!address || typeof address === 'string') throw new Error('benchmark HTTP server did not bind');
  const url = `http://127.0.0.1:${address.port}`, tokenFile = path.join(root, 'token'), replicaDir = path.join(root, 'replicas');
  await writeFile(tokenFile, credential.token, { mode: 0o600 });
  const scope = { type: 'workspace' as const, workspaceId: 'bench' };
  const progress = (message: string) => process.stderr.write(`[bench:replica] ${message}\n`);
  const payload = (n: number) => `note-${n.toString().padStart(4, '0')}\n${'synthetic benchmark data '.repeat(84).slice(0, 2000)}`;
  for (let i = 0; i < 2000; i++) { await owner.vault.put({ scope, kind: 'note', title: `Note ${i}`, body: payload(i) }); if ((i + 1) % 250 === 0) progress(`seeded ${i + 1}/2000 notes`); }
  const sourceFile = path.join(root, 'source.bin'), sourceBytes = Buffer.from(('0123456789abcdef'.repeat(131072)).slice(0, 2 * 1024 * 1024));
  for (let i = 0; i < 50; i++) { const unique = Buffer.from(sourceBytes); unique.writeUInt32BE(i, 0); await writeFile(sourceFile, unique); await owner.vault.ingest(sourceFile, scope, { title: `Synthetic source ${i}`, metadata: { benchmarkIndex: i } }); }
  progress('origin seeded; starting initial HTTP clone');
  const replica = await initializeReplica({ serverUrl: url, tokenFile, name: 'bench', baseDir: replicaDir });
  const client = await openReplica('bench', replicaDir);
  requestBytes = responseBytes = 0;
  const initialAt = performance.now();
  const enrollment = await fetch(url + '/replica/v1/enroll', { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, deviceId: client.store.deviceId, workspaceId: 'bench', label: 'benchmark' }) });
  if (!enrollment.ok) throw new Error(`enroll failed: ${enrollment.status}`); await client.store.enrollScope(scope);
  const initial = await syncOnce(client.store, client.transport); if (initial.errors.length) throw new Error(initial.errors.join('; '));
  const cloneMs = performance.now() - initialAt, cloneHttpBytes = requestBytes + responseBytes; progress(`initial clone finished in ${cloneMs.toFixed(0)} ms`);
  const editIds = (await owner.vault.listDocuments({ scopes: [scope] })).filter(doc => doc.kind === 'note').slice(0, 1000).map(doc => doc.id);
  const incremental = async (count: number) => { for (let i = 0; i < count; i++) { const id = editIds[i]!, current = await owner.vault.get(id); await owner.vault.patch({ objectId: id, expectedRevisionId: current.revisionId, body: `${current.body}\nedit-${i}` }); } requestBytes = responseBytes = 0; const at = performance.now(), result = await syncOnce(client.store, client.transport); if (result.errors.length) throw new Error(result.errors.join('; ')); return { ms: performance.now() - at, httpBytes: requestBytes + responseBytes, pulled: result.pulled }; };
  const after100 = await incremental(100); progress('100-edit incremental sync finished'); const after1000 = await incremental(900); progress('1,000-edit cumulative incremental sync finished');
  for (let i = 0; i < 500; i++) await client.store.vault.put({ scope, kind: 'note', title: `Client note ${i}`, body: payload(i + 2000) });
  requestBytes = responseBytes = 0; const pushAt = performance.now(), pushResult = await syncOnce(client.store, client.transport); if (pushResult.errors.length) throw new Error(pushResult.errors.join('; '));
  const push500 = { ms: performance.now() - pushAt, httpBytes: requestBytes + responseBytes, accepted: pushResult.accepted }; progress('500-note push finished');
  const conflictBases = [] as Array<{ id: string; revisionId: string }>;
  for (let i = 0; i < 50; i++) { const base = await owner.vault.put({ scope, kind: 'note', title: `Conflict ${i}`, body: 'base' }); conflictBases.push({ id: base.id, revisionId: base.revisionId }); }
  const conflictPull = await syncOnce(client.store, client.transport); if (conflictPull.errors.length) throw new Error(conflictPull.errors.join('; '));
  for (let i = 0; i < conflictBases.length; i++) { const base = conflictBases[i]!, local = await client.store.vault.get(base.id); await client.store.vault.patch({ objectId: base.id, expectedRevisionId: local.revisionId, body: 'replica branch' }); await owner.vault.patch({ objectId: base.id, expectedRevisionId: base.revisionId, body: 'origin branch' }); }
  requestBytes = responseBytes = 0; const conflictAt = performance.now(), conflictResult = await syncOnce(client.store, client.transport);
  const conflicts = { ms: performance.now() - conflictAt, httpBytes: requestBytes + responseBytes, count: conflictResult.conflicts, objects: conflictBases.length };
  progress('50-conflict sync finished; starting 60-second daemon idle measurement');
  let idle: { seconds: number; averageCpuPercent: number; peakRssBytes: number; daemonState: string; samples: number };
  const daemon = spawn(process.execPath, ['bin/mdb.js', 'replica', 'daemon', '--id', 'bench', '--interval-s', '120'], { cwd: process.cwd(), env: { ...process.env, ENGRAM_REPLICA_DIR: replicaDir, ENGRAM_STATE_DIR: path.join(root, 'state') }, stdio: 'ignore' });
  if (!daemon.pid) throw new Error('could not start benchmark daemon');
  try {
    const statusFile = path.join(client.store.state, 'status.json'); let readyState = '';
    for (let i = 0; i < 600; i++) { await new Promise(resolve => setTimeout(resolve, 100)); try { const state = JSON.parse(await (await import('node:fs/promises')).readFile(statusFile, 'utf8')) as { state: string; pid: number }; if (state.pid === daemon.pid && state.state !== 'syncing') { readyState = state.state; break; } } catch {} }
    if (!readyState) throw new Error('daemon did not reach a measurable idle state');
    const samples: Array<{ cpu: number; rss: number }> = [], idleAt = performance.now();
    for (let i = 0; i < 60; i++) { const row = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(daemon.pid)], { encoding: 'utf8' }).trim().split(/\s+/); if (row.length >= 2) samples.push({ cpu: Number(row[0]), rss: Number(row[1]) * 1024 }); await new Promise(resolve => setTimeout(resolve, 1000)); }
    const seconds = (performance.now() - idleAt) / 1000; daemon.kill('SIGTERM'); await waitForExit(daemon);
    idle = { seconds, averageCpuPercent: samples.reduce((sum, sample) => sum + sample.cpu, 0) / Math.max(1, samples.length), peakRssBytes: Math.max(0, ...samples.map(sample => sample.rss)), daemonState: readyState, samples: samples.length };
  } finally { if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await waitForExit(daemon); } }
  const result = { synthetic: true, workload: { notes: 2000, noteBytesApprox: 2000, sources: 50, sourceBytesEach: sourceBytes.length }, initialClone: { wallMs: cloneMs, httpBytes: cloneHttpBytes, clientServerProcessPeakRssBytes: process.resourceUsage().maxRSS, note: 'client and server share this benchmark process; separate RSS is unavailable' }, incrementalAfter100Edits: after100, incrementalAfter1000TotalEdits: after1000, push500LocalNotes: push500, conflicts50: conflicts, idleDaemon: idle, final: { clonePulled: initial.pulled, pending: client.store.status().pendingPush, verify: await client.store.verify() } };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
} finally { await rm(root, { recursive: true, force: true }); }

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', () => resolve()));
}
