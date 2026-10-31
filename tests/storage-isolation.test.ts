import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engram, OWNER } from '../packages/sdk/index.js';
import { toolsFor } from '../packages/mcp/index.js';
import { writeUserConfig, readUserConfig, userConfigPath } from '../packages/memory/user-config.js';
import { enqueueWrite, defaultOutboxDirectory } from '../packages/memory/outbox.js';
import { appendLog, LOG_FILE } from '../packages/memory/outbox.js';
import { queueRemoteCapture, defaultRemoteSpoolDirectory } from '../packages/memory/remote-spool.js';
import { createOwnedOperation, storageStatus } from '../packages/core/storage-lifecycle.js';
import { buildFsIndex } from '../packages/search-files/postings.js';
import { spawn, spawnSync } from 'node:child_process';
import { Vault } from '../packages/core/vault.js';
import { createHttpCredential } from '../packages/mcp/credentials.js';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../packages/storage-local/index.js';
import { createRegistration, drainSpool, enqueueEvent, eventFromHostPayload } from '../packages/memory/capture.js';
import { AdaptiveStore, touchActivity } from '../packages/adaptive/index.js';
import { contextStateFile } from '../packages/memory/context-hook.js';

const keys = ['ENGRAM_DATA_DIR', 'ENGRAM_USER_CONFIG', 'ENGRAM_STATE_DIR', 'ENGRAM_CACHE_DIR', 'ENGRAM_OUTBOX', 'ENGRAM_REMOTE_SPOOL', 'ENGRAM_TEMP_DIR', 'TMPDIR'] as const;

test('production-like default writes stay under ENGRAM_DATA_DIR with distinct TMPDIR and multiple MCP actors', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'engram-isolation-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'data'), systemTemp = path.join(parent, 'os-temp');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(systemTemp));
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ENGRAM_DATA_DIR = root; process.env.TMPDIR = systemTemp;
  for (const key of keys.slice(1, -1)) delete process.env[key];
  t.after(() => { for (const key of keys) { const value = old[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  const owner = new Engram(root, OWNER); await owner.init({ sqlite: true }); await owner.createWorkspace('storage-ws');
  const saved = await owner.put({ scope: { type: 'workspace', workspaceId: 'storage-ws' }, kind: 'note', title: 'Storage test', body: 'synthetic capture record' });
  await owner.search.query({ query: 'synthetic', mode: 'keyword' }); await owner.search.rebuild();
  assert.ok((await owner.vault.get(saved.id)).body.includes('synthetic'));

  const second = new Engram(root, { actorId: 'reader', permissions: ['workspace:storage-ws:read'] });
  const ownerTools = toolsFor(owner), readerTools = toolsFor(second);
  assert.ok(ownerTools.some(tool => tool.name.includes('search'))); assert.ok(readerTools.some(tool => tool.name.includes('search')));

  const config = { schemaVersion: 1 as const, serverUrl: 'https://example.invalid/mcp', tokenEnv: 'ENGRAM_TEST_TOKEN', workspaceId: 'storage-ws', registrationId: 'storage-test', principalId: 'reader', hosts: ['claude-code' as const], captureConsent: true as const, paused: false, excludeProjects: [] };
  await writeUserConfig(config); assert.deepEqual(await readUserConfig(), config);
  assert.ok(userConfigPath().startsWith(root));
  const queued = await enqueueWrite(defaultOutboxDirectory(), { url: config.serverUrl, workspaceId: config.workspaceId, tool: 'engram_note_upsert', arguments: { noteId: 'n1', title: 'queued', body: 'kept' } });
  assert.ok(queued.id); assert.ok(defaultOutboxDirectory().startsWith(root));
  await queueRemoteCapture({ url: config.serverUrl, registrationId: config.registrationId, payload: { event: 'test', prompt: 'synthetic only' } });
  assert.ok(defaultRemoteSpoolDirectory().startsWith(root));

  const registration = await createRegistration(owner.vault, { host: 'claude-code', principalId: 'capture-writer', workspaceId: 'storage-ws', consent: true });
  const captured = eventFromHostPayload(registration, { hook_event_name: 'UserPromptSubmit', session_id: 'storage-session', prompt: 'synthetic captured record' });
  assert.ok(captured);
  await enqueueEvent(root, { registrationId: registration.id, event: captured });
  assert.ok((await drainSpool(root)).ingested >= 1, 'the production capture drain commits the queued event');
  assert.ok((await readdir(path.join(root, '.mdb/capture/registrations'))).some(name => name.endsWith('.json')));

  await new AdaptiveStore(root).setConfig({ enabled: true });
  await touchActivity(root, new Date(), process.env);
  const activityFiles = await readdir(path.join(root, '.engram-runtime/state/activity'));
  assert.equal(activityFiles.length, 1, 'activity marker is a configured-root state write');

  const scratch = await createOwnedOperation('mock-model', { quotaKind: 'temporary' });
  assert.ok(scratch.directory.startsWith(path.join(root, '.engram-runtime/tmp/operations')));
  await scratch.cleanup();
  assert.deepEqual(await readdir(systemTemp), [], 'Engram default scratch did not escape to the distinct OS TMPDIR');
  const report = await storageStatus();
  const locations = (report as { locations: Record<string, string> }).locations;
  for (const [kind, location] of Object.entries(locations)) if (kind !== 'vault') assert.ok(path.resolve(location).startsWith(path.resolve(root) + path.sep), `${kind} escaped root: ${location}`);
  assert.equal(await stat(path.join(root, '.mdb/indexes')).then(() => true), true);
  assert.ok(contextStateFile().startsWith(path.join(root, '.engram-runtime/state')));
  await buildFsIndex(owner.vault);
  const indexMetadata = path.join(root, '.mdb/indexes/fs-trigram/meta.json'), beforeIndex = await readFile(indexMetadata, 'utf8');
  await assert.rejects(buildFsIndex(owner.vault, { env: { ENGRAM_STORAGE_INDEX_SCRATCH_QUOTA_BYTES: '1' } }), /index-scratch quota reached/);
  await assert.rejects(buildFsIndex(owner.vault, { fault: stage => { if (stage === 'index.before_part_write') { const error = new Error('injected ENOSPC') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; } } }), { code: 'ENOSPC' });
  assert.equal(await readFile(indexMetadata, 'utf8'), beforeIndex, 'failed scratch builds preserve the previous complete index');
  assert.deepEqual(await readdir(path.join(root, '.mdb/indexes/.engram-builds')).catch(() => []), [], 'failed builds clean only their unique scratch directory');
  assert.ok((await readFile(path.join(root, '.mdb/events/commits.jsonl'), 'utf8')).length > 0);
});

test('outbox diagnostic logs enforce a bounded two-file rotation under concurrent calls', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'engram-bounded-log-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ENGRAM_STORAGE_LOG_QUOTA_BYTES: '1024' };
  await Promise.all(Array.from({ length: 30 }, (_, index) => appendLog(directory, { event: `synthetic-${index}`, detail: 'x'.repeat(80) }, env)));
  const names = await readdir(directory), files = names.filter(name => name === LOG_FILE || name === `${LOG_FILE}.1`);
  const bytes = (await Promise.all(files.map(async name => (await stat(path.join(directory, name))).size))).reduce((sum, size) => sum + size, 0);
  assert.ok(files.length <= 2); assert.ok(bytes <= 1024, `diagnostic log cap exceeded: ${bytes}`);
});

test('ENOSPC before temporary replacement preserves the old file and leaves no partial artifact', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-temp-enospc-')); t.after(() => rm(root, { recursive: true, force: true }));
  await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(root, { recursive: true }).then(() => writeFile(path.join(root, 'record.md'), 'acknowledged old value')));
  const fault = (stage: string) => { if (stage === 'atomic.before_temp_create') { const error = new Error('injected ENOSPC') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; } };
  await assert.rejects(atomicWrite(root, 'record.md', 'unacknowledged new value', fault), { code: 'ENOSPC' });
  assert.equal(await readFile(path.join(root, 'record.md'), 'utf8'), 'acknowledged old value');
  assert.deepEqual((await readdir(root)).sort(), ['record.md']);
});

test('isolated HTTP MCP process starts under ENGRAM_DATA_DIR and enforces credential reads and writes', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'engram-mcp-storage-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'data'), tmp = path.join(parent, 'tmp'), home = path.join(parent, 'home');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(tmp), mkdir(home)]));
  const owner = new Vault(root); await owner.init(); await owner.createWorkspace('mcp-storage', '', { 'storage-reader': ['read', 'write'], 'storage-writer': ['read', 'write'] });
  const seed = await owner.put({ scope: { type: 'workspace', workspaceId: 'mcp-storage' }, kind: 'note', title: 'Authorized seed', body: 'synthetic MCP storage read' });
  const reader = await createHttpCredential(owner, 'storage-reader', ['workspace:mcp-storage:read']);
  const denied = await createHttpCredential(owner, 'storage-denied', ['global:wiki:read']);
  const executable = path.resolve('bin/mdb-mcp.js');
  const child = spawn(process.execPath, [executable], { cwd: process.cwd(), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(root, '.engram-runtime/config'), XDG_STATE_HOME: path.join(root, '.engram-runtime/state'), XDG_CACHE_HOME: path.join(root, '.engram-runtime/cache'), TMPDIR: tmp, ENGRAM_DATA_DIR: root, MDB_MCP_TRANSPORT: 'http', MDB_MCP_TOOLSET: 'remote-web', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); } });
  const deadline = Date.now() + 5000;
  while (!stderr.includes('MCP HTTP listening at') && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stderr, /MCP HTTP listening at http:\/\/127\.0\.0\.1:\d+\/mcp/);
  const url = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(stderr)![1]!;
  const call = async (token: string, id: number, name: string, arguments_: Record<string, unknown> = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }) });
    if (response.status !== 200) throw new Error(`MCP call returned ${response.status}: ${await response.text()}`);
    return await response.json() as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
  };
  const listing = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(listing.status, 200); assert.ok(JSON.stringify(await listing.json()).includes('engram_search'));
  const allowed = await call(reader.token, 2, 'engram_get', { objectId: seed.id });
  assert.match(JSON.stringify(allowed), /synthetic MCP storage read/);
  const forbidden = await call(denied.token, 3, 'engram_get', { objectId: seed.id });
  assert.equal(forbidden.result?.isError, true, 'a valid credential without workspace access is rejected');
  const created = await call(reader.token, 4, 'engram_create', { scope: { type: 'workspace', workspaceId: 'mcp-storage' }, kind: 'note', title: 'Denied write', body: 'must not write', source: 'storage-test', idempotencyKey: 'storage-denied-write' });
  assert.equal(created.result?.isError, true, 'read-only credentials cannot write');
  const writer = await createHttpCredential(owner, 'storage-writer', ['workspace:mcp-storage:write', 'workspace:mcp-storage:read']);
  const written = await call(writer.token, 5, 'engram_create', { scope: { type: 'workspace', workspaceId: 'mcp-storage' }, kind: 'note', title: 'Authorized write', body: 'journal-backed synthetic write', source: 'storage-test', idempotencyKey: 'storage-authorized-write' });
  assert.equal(written.result?.isError, undefined, JSON.stringify(written));
  assert.ok((await owner.events()).some(event => event.idempotencyKey === 'storage-authorized-write'));
  assert.ok((await readdir(tmp)).length === 0, 'the MCP process used no default OS-temp scratch');
  const stdio = spawnSync(process.execPath, [executable], { encoding: 'utf8', input: [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'storage-gate', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map(message => JSON.stringify(message)).join('\n') + '\n', env: { ...process.env, ENGRAM_DATA_DIR: root, TMPDIR: tmp, MDB_MCP_TRANSPORT: 'stdio', MDB_ACTOR_ID: 'stdio-storage-reader', MDB_PERMISSIONS: 'workspace:storage-ws:read' } });
  assert.equal(stdio.status, 0, stdio.stderr);
  assert.ok(stdio.stdout.includes('mdb_search'), 'stdio MCP starts and discovers the default toolset with the configured data root');
});

test('killed index rebuild leaves a marked orphan that is reported and survives a successful restart', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'engram-index-interrupt-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'data'), vault = new Vault(root); await vault.init();
  await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'Index seed', body: 'synthetic index content for a scratch shard' });
  await buildFsIndex(vault);
  const metadata = path.join(root, '.mdb/indexes/fs-trigram/meta.json'), oldIndex = await readFile(metadata, 'utf8');
  const vaultModule = pathToFileURL(path.resolve('dist/packages/core/vault.js')).href, indexModule = pathToFileURL(path.resolve('dist/packages/search-files/postings.js')).href;
  const script = `const {Vault}=await import(${JSON.stringify(vaultModule)});const {buildFsIndex}=await import(${JSON.stringify(indexModule)});await buildFsIndex(new Vault(${JSON.stringify(root)}),{fault:s=>{if(s==='index.before_part_write')process.kill(process.pid,'SIGKILL')}});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(await readFile(metadata, 'utf8'), oldIndex, 'the last complete index remains published');
  const interrupted = await storageStatus({ ENGRAM_DATA_DIR: root }) as { indexBuildScratch: { reports: Array<{ id: string; ownerAlive: boolean; bytes: number }>; complete: boolean } };
  assert.equal(interrupted.indexBuildScratch.complete, true); assert.equal(interrupted.indexBuildScratch.reports.length, 1);
  assert.equal(interrupted.indexBuildScratch.reports[0]?.ownerAlive, false); assert.ok((interrupted.indexBuildScratch.reports[0]?.bytes ?? 0) > 0);
  await buildFsIndex(vault);
  assert.equal(await readFile(metadata, 'utf8') === oldIndex, false, 'a fresh process can publish the rebuilt complete index');
  const after = await storageStatus({ ENGRAM_DATA_DIR: root }) as { indexBuildScratch: { reports: unknown[]; complete: boolean } };
  assert.equal(after.indexBuildScratch.complete, true); assert.equal(after.indexBuildScratch.reports.length, 1, 'the old orphan remains visible and is never silently deleted');
});
