import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { MAX_SYNC_FILE_BYTES, evaluatePath, globToRegExp, localSink, pathsFromHookPayload, reconcile, remoteSink, syncFile, syncReport, type SyncContext } from '../../packages/memory/file-sync.js';
import { defaultBinding, writeBinding, type ProjectBinding } from '../../packages/core/project-binding.js';
import { trustProject } from '../../packages/core/project-trust.js';
import { initializeProject } from '../../packages/project-init.js';
import { projectDoctor } from '../../packages/memory/project-doctor.js';
import { createAdapter } from '../../packages/memory/adapters.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js'); const MDB = resolve('bin/mdb.js');
async function temp(t: Cleanup, prefix: string): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), prefix)); t.after(() => rm(d, { recursive: true, force: true })); return d; }

async function startServer(root: string, port = 0) {
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port) } });
  let stderr = ''; const url = await new Promise<string>((res, rej) => { child.stderr.setEncoding('utf8'); child.stderr.on('data', (c: string) => { stderr += c; const m = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(stderr); if (m) res(m[1]!); }); child.once('exit', code => rej(new Error(`exited ${code}: ${stderr}`))); });
  return { child, url };
}
async function liveServer(t: Cleanup) {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj');
  const credential = await createHttpCredential(owner.vault, 'agent-1', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-1', ['read', 'write']);
  const state = { current: await startServer(root) }; const port = Number(new URL(state.current.url).port);
  const stop = async () => { if (state.current.child.exitCode === null) { state.current.child.kill('SIGTERM'); await new Promise<void>(r => state.current.child.once('exit', () => r())); } };
  t.after(stop);
  process.env.ENGRAM_SYNC_TOKEN = credential.token; t.after(() => { delete process.env.ENGRAM_SYNC_TOKEN; });
  return { root, owner, token: credential.token, get url() { return state.current.url; }, stop, restart: async () => { await stop(); state.current = await startServer(root, port); } };
}
async function project(t: Cleanup, server: { url: string }, overrides: Partial<ProjectBinding> = {}) {
  const dir = await temp(t, 'engram-sync-'); await mkdir(path.join(dir, 'notes'), { recursive: true });
  const binding: ProjectBinding = { ...defaultBinding({ workspaceId: 'proj', serverUrl: server.url, hosts: ['claude-code'], credentialRef: 'ENGRAM_SYNC_TOKEN', captureConsent: false }), fileSyncConsent: true, ...overrides };
  await writeBinding(dir, binding); await trustProject(dir, binding); const ctx: SyncContext = { projectDir: dir, binding, sink: remoteSink(binding, process.env, 1500) }; return { dir, binding, ctx };
}
const notesOnServer = async (owner: Engram) => (await owner.listDocuments()).filter(d => d.kind === 'note');

test('an approved note is uploaded in full, exactly once; repeated write events and unchanged saves add nothing', async t => {
  const server = await liveServer(t); const { dir, ctx } = await project(t, server);
  const body = `# Plan\n\n${Array.from({ length: 300 }, (_, i) => `Step ${i}: carefully described, well beyond an 800 character excerpt.`).join('\n')}\n`; assert.ok(body.length > 5000);
  await writeFile(path.join(dir, 'notes', 'plan.md'), body);
  const first = await syncFile(ctx, 'notes/plan.md'); assert.equal(first.status, 'COMMITTED', JSON.stringify(first));
  const docs = await notesOnServer(server.owner); assert.equal(docs.length, 1); assert.equal(docs[0]!.body, body, 'the whole file, byte for byte'); assert.equal(docs[0]!.metadata.sourcePath, 'notes/plan.md'); assert.equal(docs[0]!.metadata.contentSource, 'file-sync'); assert.equal(docs[0]!.title, 'Plan');
  for (let i = 0; i < 5; i++) assert.equal((await syncFile(ctx, path.join(dir, 'notes', 'plan.md'))).status, 'SKIPPED', 'a repeated write event for identical content is dropped');
  await writeFile(path.join(dir, 'notes', 'plan.md'), `${body}One more step.\n`); const second = await syncFile(ctx, 'notes/plan.md'); assert.equal(second.status, 'COMMITTED');
  const after = await notesOnServer(server.owner); assert.equal(after.length, 1, 'still one object'); assert.equal(after[0]!.revisionNumber, 2); assert.notEqual(second.revisionId, first.revisionId);
  recordCase({ suite: 'memory', name: 'file-sync-full-content-dedupe', status: 'PASS' });
});

test('only approved Markdown is ever read: everything else is refused, links cannot escape, and nothing refused reaches the server', async t => {
  const server = await liveServer(t); const { dir, ctx } = await project(t, server);
  const outside = await temp(t, 'engram-sync-outside-'); await writeFile(path.join(outside, 'secret.md'), '# not mine');
  await mkdir(path.join(dir, 'src')); await mkdir(path.join(dir, 'docs')); await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  const files: Record<string, string> = { 'README.md': '# r', 'AGENTS.md': '# a', 'CLAUDE.md': '# c', 'src/app.ts': 'export {}', 'notes/data.txt': 'txt', '.env': 'A=1', 'notes/.env.md': '# env', 'docs/guide.md': '# not approved', 'node_modules/x/readme.md': '# dep', 'notes/big.md': 'x'.repeat(MAX_SYNC_FILE_BYTES + 1) };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content); await writeFile(path.join(dir, 'notes', 'binary.md'), Buffer.from([0x23, 0x20, 0, 1, 2]));
  await symlink(path.join(outside, 'secret.md'), path.join(dir, 'notes', 'link.md')); await symlink(outside, path.join(dir, 'notes', 'linkdir'));
  const refused = [...Object.keys(files), 'notes/binary.md', 'notes/link.md', 'notes/linkdir/secret.md', '../outside.md', path.join(outside, 'secret.md'), 'notes/../README.md', 'notes/missing.md'];
  for (const candidate of refused) { const outcome = await syncFile(ctx, candidate); assert.equal(outcome.status, 'SKIPPED', `${candidate}: ${JSON.stringify(outcome)}`); }
  assert.equal((await notesOnServer(server.owner)).length, 0, 'zero committed records');
  const noConsent = await syncFile({ ...ctx, binding: { ...ctx.binding, fileSyncConsent: false } }, 'notes/data.txt'); assert.equal(noConsent.status, 'DISABLED');
  assert.deepEqual((await reconcile({ ...ctx, binding: { ...ctx.binding, fileSyncConsent: false } })).outcomes.map(o => o.status), ['DISABLED']);
  assert.equal((await evaluatePath(dir, ctx.binding, 'notes/link.md')).ok, false); assert.equal(globToRegExp('**/.env*').test('a/b/.env.local'), true); assert.equal(globToRegExp('notes/**/*.md').test('notes/a/b/c.md'), true); assert.equal(globToRegExp('notes/**/*.md').test('notes2/a.md'), false);
});

test('a file with a secret is quarantined on this machine and never uploaded; saving a clean version syncs it', async t => {
  const server = await liveServer(t); const { dir, ctx } = await project(t, server);
  await writeFile(path.join(dir, 'notes', 'creds.md'), '# Deploy\napi_key=sk-abcdefghijklmnop1234\n');
  const outcome = await syncFile(ctx, 'notes/creds.md'); assert.equal(outcome.status, 'QUARANTINED'); assert.equal((await notesOnServer(server.owner)).length, 0);
  assert.deepEqual((await syncReport(dir, ctx.binding)).quarantined, ['notes/creds.md']);
  assert.equal((await syncFile(ctx, 'notes/creds.md')).status, 'QUARANTINED', 'still quarantined while the secret is there');
  await writeFile(path.join(dir, 'notes', 'creds.md'), '# Deploy\nUse the vault; no secrets here.\n'); assert.equal((await syncFile(ctx, 'notes/creds.md')).status, 'COMMITTED');
  assert.equal((await syncReport(dir, ctx.binding)).quarantined.length, 0); assert.doesNotMatch(JSON.stringify(await notesOnServer(server.owner)), /sk-abcdefghijklmnop/);
});

test('a note written while offline is queued durably, survives SIGKILL, a restart and the server restarting, and commits exactly once', async t => {
  const server = await liveServer(t); const { dir, binding, ctx } = await project(t, server);
  await writeFile(path.join(dir, 'notes', 'offline.md'), '# Written offline\nContent that must arrive once.\n');
  await server.stop();
  // a client process queues the write and is killed abruptly right after
  const script = `import { syncFile, remoteSink } from ${JSON.stringify(path.resolve('dist/packages/memory/file-sync.js'))}; import { readBinding } from ${JSON.stringify(path.resolve('dist/packages/core/project-binding.js'))}; const dir = ${JSON.stringify(dir)}; const binding = await readBinding(dir); const r = await syncFile({ projectDir: dir, binding, sink: remoteSink(binding, process.env, 500) }, 'notes/offline.md'); console.log(JSON.stringify(r)); process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, ENGRAM_SYNC_TOKEN: server.token } });
  assert.equal(child.signal, 'SIGKILL'); assert.equal(JSON.parse(child.stdout.trim().split('\n').pop()!).status, 'QUEUED_OFFLINE', 'honest status: not on the server yet');
  assert.equal((await readdir(path.join(dir, '.engram', 'sync-queue'))).length, 1, 'a durable queue entry exists after the kill'); assert.equal((await syncReport(dir, binding)).queued, 1);
  await server.restart();
  const live: SyncContext = { projectDir: dir, binding: { ...binding, serverUrl: server.url }, sink: remoteSink({ ...binding, serverUrl: server.url }, process.env, 1500) };
  const drained = await reconcile(live); assert.deepEqual(drained.outcomes.filter(o => o.path === 'notes/offline.md').map(o => o.status), ['COMMITTED']);
  const docs = await notesOnServer(server.owner); assert.equal(docs.length, 1); assert.equal(docs[0]!.revisionNumber, 1, 'exactly one revision');
  assert.equal((await syncReport(dir, binding)).queued, 0); assert.equal((await reconcile(live)).outcomes.filter(o => o.status === 'COMMITTED').length, 0, 'nothing further to send');
  // the acknowledgement was lost: client state is gone, the server already has the note
  await rm(path.join(dir, '.engram', 'sync-state.json')); const again = await syncFile(live, 'notes/offline.md'); assert.equal(again.status, 'COMMITTED'); assert.equal(again.unchanged, true, 'the server recognized identical content');
  assert.equal((await notesOnServer(server.owner))[0]!.revisionNumber, 1); void ctx;
  recordCase({ suite: 'memory', name: 'file-sync-offline-sigkill-restart-exactly-once', status: 'PASS' });
});

test('concurrent edits never overwrite: the stale writer gets a conflict and its version is kept as its own note', async t => {
  const server = await liveServer(t); const a = await project(t, server); const b = await project(t, server);
  await writeFile(path.join(a.dir, 'notes', 'shared.md'), '# Shared\nversion from A\n');
  assert.equal((await syncFile(a.ctx, 'notes/shared.md')).status, 'COMMITTED');
  await writeFile(path.join(b.dir, 'notes', 'shared.md'), '# Shared\nsomething else entirely from B\n');
  const firstSync = await syncFile(b.ctx, 'notes/shared.md'); assert.equal(firstSync.status, 'CONFLICT', 'B never synced this path: it may not overwrite A');
  let notes = await notesOnServer(server.owner); assert.equal(notes.find(n => n.metadata.stableId === 'file:notes/shared.md')!.body, '# Shared\nversion from A\n'); assert.equal(notes.filter(n => n.tags.includes('conflict')).length, 1);
  assert.equal(await readFile(path.join(b.dir, 'notes', 'shared.md'), 'utf8'), '# Shared\nsomething else entirely from B\n', 'the local file is untouched');
  // B adopts A's text, then A moves on and B edits from a stale base
  await writeFile(path.join(b.dir, 'notes', 'shared.md'), '# Shared\nversion from A\n'); await rm(path.join(b.dir, '.engram', 'sync-state.json')); assert.equal((await syncFile(b.ctx, 'notes/shared.md')).status, 'COMMITTED');
  await writeFile(path.join(a.dir, 'notes', 'shared.md'), '# Shared\nversion 2 from A\n'); assert.equal((await syncFile(a.ctx, 'notes/shared.md')).status, 'COMMITTED');
  await writeFile(path.join(b.dir, 'notes', 'shared.md'), '# Shared\nB edit on a stale base\n'); const stale = await syncFile(b.ctx, 'notes/shared.md'); assert.equal(stale.status, 'CONFLICT'); assert.match(stale.detail ?? '', /nothing was overwritten/);
  notes = await notesOnServer(server.owner); assert.equal(notes.find(n => n.metadata.stableId === 'file:notes/shared.md')!.body, '# Shared\nversion 2 from A\n', 'A\'s latest is intact');
  const conflicts = notes.filter(n => n.tags.includes('conflict')); assert.equal(conflicts.length, 2); assert.ok(conflicts.some(c => c.body.includes('B edit on a stale base')), 'B\'s version is preserved');
  assert.equal((await syncFile(b.ctx, 'notes/shared.md')).status, 'CONFLICT', 'no retry storm'); assert.equal((await notesOnServer(server.owner)).filter(n => n.tags.includes('conflict')).length, 2);
  assert.equal((await syncReport(b.dir, b.binding)).conflicts.length, 1);
  recordCase({ suite: 'memory', name: 'file-sync-conflicts-never-overwrite', status: 'PASS' });
});

test('deleting a file records a tombstone revision and keeps history; a rename is a tombstone plus a new note', async t => {
  const server = await liveServer(t); const { dir, ctx } = await project(t, server);
  await writeFile(path.join(dir, 'notes', 'old.md'), '# Old name\nSome durable text.\n'); await syncFile(ctx, 'notes/old.md');
  await rm(path.join(dir, 'notes', 'old.md')); const gone = await syncFile(ctx, 'notes/old.md'); assert.equal(gone.status, 'TOMBSTONED', JSON.stringify(gone));
  const history = await server.owner.vault.history((await server.owner.listDocuments({ includeHistory: true })).find(d => d.metadata.stableId === 'file:notes/old.md')!.id); assert.equal(history.length, 2, 'both revisions are kept'); assert.equal(history.at(-1)!.status, 'tombstone');
  await writeFile(path.join(dir, 'notes', 'renamed-from.md'), '# Moving\nSame text.\n'); await syncFile(ctx, 'notes/renamed-from.md');
  await rm(path.join(dir, 'notes', 'renamed-from.md')); await writeFile(path.join(dir, 'notes', 'renamed-to.md'), '# Moving\nSame text.\n');
  const result = await reconcile(ctx); const by = Object.fromEntries(result.outcomes.map(o => [o.path, o.status])); assert.equal(by['notes/renamed-to.md'], 'COMMITTED'); assert.equal(by['notes/renamed-from.md'], 'TOMBSTONED');
  assert.equal((await syncReport(dir, ctx.binding)).committed, 1);
});

test('the hook syncs only the files a tool call touched, ignores everything else, and a full reconcile works with no file named', async t => {
  const server = await liveServer(t); const { dir } = await project(t, server);
  assert.deepEqual(pathsFromHookPayload(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/p/notes/a.md', content: 'x' } })), ['/p/notes/a.md']);
  assert.deepEqual(pathsFromHookPayload(JSON.stringify({ tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Add File: notes/b.md\n+hi\n*** Update File: src/x.ts\n*** End Patch' } })), ['notes/b.md', 'src/x.ts']);
  assert.equal(pathsFromHookPayload(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })), undefined); assert.equal(pathsFromHookPayload('nope'), undefined);
  await writeFile(path.join(dir, 'notes', 'hook.md'), '# Via hook\nbody\n'); await writeFile(path.join(dir, 'README.md'), '# readme');
  const run = (payload: unknown) => spawnSync(process.execPath, [MDB, 'notes', 'sync', '--hook', '--project-root', dir], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ENGRAM_SYNC_TOKEN: server.token } });
  const readme = run({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'README.md') } }); assert.equal(readme.status, 0); assert.equal(readme.stdout, '', 'a hook prints nothing'); assert.equal((await notesOnServer(server.owner)).length, 0);
  const elsewhere = run({ hook_event_name: 'PostToolUse', cwd: await temp(t, 'engram-sync-else-'), tool_name: 'Write', tool_input: { file_path: path.join(dir, 'notes', 'hook.md') } }); assert.equal(elsewhere.status, 0); assert.equal((await notesOnServer(server.owner)).length, 0, 'a session outside the project does not sync it');
  const touched = run({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'notes', 'hook.md') } }); assert.equal(touched.status, 0); assert.equal((await notesOnServer(server.owner)).length, 1);
  await writeFile(path.join(dir, 'notes', 'other.md'), '# Other\n'); const end = run({ hook_event_name: 'SessionEnd', cwd: dir, reason: 'other' }); assert.equal(end.status, 0); assert.equal((await notesOnServer(server.owner)).length, 2, 'SessionEnd reconciles everything approved');
  const bad = spawnSync(process.execPath, [MDB, 'notes', 'sync', '--hook', '--project-root', await temp(t, 'engram-sync-unbound-')], { input: '{}', encoding: 'utf8' }); assert.equal(bad.status, 0, 'a hook never fails the host'); assert.equal(bad.stdout, '');
});

test('local mode syncs into the local vault, and init records consent separately and installs the sync hooks only then', async t => {
  const { root } = await disposableVault(t); const client = new Engram(root); const base = await temp(t, 'engram-sync-local-'); const dir = path.join(base, 'proj'); await mkdir(path.join(dir, 'notes'), { recursive: true });
  const noConsent = await initializeProject(client, { projectDir: dir, hosts: ['claude-code'], consent: true });
  assert.equal(noConsent.binding.fileSyncConsent, false, '--consent alone never enables file sync'); assert.equal(noConsent.readiness.fileSync.status, 'DISABLED'); assert.equal(noConsent.fileSyncScope, undefined);
  assert.equal((await createAdapter('claude-code', { root, settingsPath: path.join(dir, '.claude', 'settings.local.json') }).status()).fileSync, false);
  const consented = await initializeProject(client, { projectDir: dir, hosts: ['claude-code'], fileSyncConsent: true });
  assert.equal(consented.binding.fileSyncConsent, true); assert.deepEqual(consented.fileSyncScope!.include, ['notes/**/*.md', '.engram/notes/**/*.md']); assert.ok(consented.fileSyncScope!.exclude.includes('**/.env*'));
  assert.equal((await createAdapter('claude-code', { root, settingsPath: path.join(dir, '.claude', 'settings.local.json') }).status()).fileSync, true);
  const settings = await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8'); assert.match(settings, /notes sync --hook/); assert.match(settings, /Write\|Edit\|MultiEdit\|apply_patch/);
  await initializeProject(client, { projectDir: dir, hosts: ['claude-code'], fileSyncConsent: true }); assert.equal((await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).match(/notes sync --hook/g)!.length, 2, 'one PostToolUse and one SessionEnd entry after a rerun');
  assert.match(await readFile(path.join(dir, '.gitignore'), 'utf8'), /\.claude\/settings\.local\.json/);
  await writeFile(path.join(dir, 'notes', 'local.md'), '# Local note\nstored in the local vault\n');
  const ctx: SyncContext = { projectDir: dir, binding: consented.binding, sink: localSink(client, 'proj') }; assert.equal((await syncFile(ctx, 'notes/local.md')).status, 'COMMITTED');
  assert.equal((await client.listDocuments()).filter(d => d.kind === 'note').length, 1);
  const doctor = await projectDoctor(dir, { probeRemote: false, settingsPaths: { 'claude-code': path.join(dir, '.claude', 'settings.local.json') } }); assert.equal(doctor.features.fileSync.status, 'PASS', JSON.stringify(doctor.features.fileSync));
  await writeFile(path.join(dir, 'notes', 'secret.md'), 'token=abcd1234efgh5678'); await syncFile(ctx, 'notes/secret.md');
  assert.equal((await projectDoctor(dir, { probeRemote: false })).features.fileSync.status, 'INCOMPLETE'); assert.match((await projectDoctor(dir, { probeRemote: false })).features.fileSync.detail, /1 quarantined/);
});
