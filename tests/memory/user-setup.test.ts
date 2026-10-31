import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { MDBError } from '../../packages/core/types.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { createRegistration } from '../../packages/memory/capture.js';
import { defaultRemoteSpoolDirectory, drainRemoteCaptureSpool } from '../../packages/memory/remote-spool.js';
import { captureForUser, insideProject, setUserPaused, setupUser, uninstallUser, userStatus } from '../../packages/memory/user-setup.js';
import { defaultBinding, writeBinding } from '../../packages/core/project-binding.js';
import { trustProject } from '../../packages/core/project-trust.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { ownChildProcess } from '../helpers/owned-process.js';
import { recordCase } from '../helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js');
async function temp(t: Cleanup, prefix: string): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), prefix)); t.after(() => rm(d, { recursive: true, force: true })); return d; }
/** Redirects every user-level file into a temp dir; the real home is never touched. */
async function sandbox(t: Cleanup) {
  const base = await temp(t, 'engram-user-'), dataRoot = path.join(base, 'data'); const saved = { data: process.env.ENGRAM_DATA_DIR, cfg: process.env.ENGRAM_USER_CONFIG, spool: process.env.ENGRAM_REMOTE_SPOOL, tok: process.env.ENGRAM_USER_TOKEN };
  process.env.ENGRAM_DATA_DIR = dataRoot; delete process.env.ENGRAM_USER_CONFIG; delete process.env.ENGRAM_REMOTE_SPOOL;
  t.after(() => { for (const [k, v] of [['ENGRAM_DATA_DIR', saved.data], ['ENGRAM_USER_CONFIG', saved.cfg], ['ENGRAM_REMOTE_SPOOL', saved.spool], ['ENGRAM_USER_TOKEN', saved.tok]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  return { base, dataRoot, paths: { claudeJsonPath: path.join(base, 'claude.json'), codexConfigPath: path.join(base, 'codex', 'config.toml'), settingsPaths: { 'claude-code': path.join(base, 'claude-settings.json'), codex: path.join(base, 'codex-hooks.json') } } };
}
async function server(t: Cleanup) {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('personal');
  const credential = await createHttpCredential(owner.vault, 'me', ['workspace:personal:read', 'workspace:personal:write']); await owner.vault.grant('personal', 'me', ['read', 'write']);
  const registration = await createRegistration(owner.vault, { host: 'claude-code', principalId: 'me', workspaceId: 'personal', consent: true });
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, ENGRAM_DATA_DIR: root, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  ownChildProcess(t, child);
  let stderr = ''; const url = await new Promise<string>((res, rej) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => { if (settled) return; settled = true; clearTimeout(startupTimeout); error ? rej(error) : res(value!); };
    const startupTimeout = setTimeout(() => finish(new Error(`MCP HTTP startup exceeded 30 seconds: ${stderr.slice(-4000)}`)), 30_000);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (c: string) => { stderr += c; const m = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(stderr); if (m) finish(undefined, m[1]!); });
    child.once('error', error => finish(error)); child.once('exit', code => finish(new Error(`exited ${code}: ${stderr}`)));
  });
  return { owner, url, token: credential.token, registrationId: registration.id };
}
const payload = (cwd: string, prompt: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-user-1', cwd, prompt_id: `p-${prompt}`, prompt, ...extra });
const settle = async (owner: Engram, want: number) => { for (let i = 0; i < 40; i++) { if ((await owner.listDocuments()).filter(d => d.kind === 'observation').length >= want) return; await new Promise(r => setTimeout(r, 150)); } };

test('setup --user needs explicit consent, a permitted server URL, and records no secret', async t => {
  const { paths } = await sandbox(t);
  const base = { hosts: ['claude-code' as const], mcpUrl: 'https://engram.example.com/mcp', tokenEnv: 'ENGRAM_USER_TOKEN', registrationId: 'reg_u1', principalId: 'me', ...paths };
  await assert.rejects(setupUser({ ...base }), (e: unknown) => e instanceof MDBError && /explicit consent/.test(e.message));
  await assert.rejects(setupUser({ ...base, consent: true, mcpUrl: 'http://203.0.113.9:3333/mcp' }), (e: unknown) => e instanceof MDBError);
  assert.deepEqual(await userStatus(), { configured: false });
  await assert.rejects(readFile(paths.settingsPaths['claude-code']), 'nothing was written before consent');
});

test('setup --user installs hooks and MCP for both hosts without touching other settings, is idempotent, and uninstalls cleanly', async t => {
  const { base, dataRoot, paths } = await sandbox(t);
  await writeFile(paths.claudeJsonPath, JSON.stringify({ numStartups: 7, projects: { '/x': { allowedTools: [] } }, mcpServers: { other: { type: 'http', url: 'https://other.example/mcp' } } }));
  await writeFile(paths.settingsPaths['claude-code'], JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  await mkdir(path.dirname(paths.codexConfigPath), { recursive: true }); await writeFile(paths.codexConfigPath, '[features]\nhooks = true\n');
  const options = { hosts: ['claude-code' as const, 'codex' as const], mcpUrl: 'https://engram.example.com/mcp', tokenEnv: 'ENGRAM_USER_TOKEN', registrationId: 'reg_u1', principalId: 'me', exclude: ['secret-client'], consent: true, ...paths };
  const first = await setupUser(options); assert.equal(first.workspaceId, 'personal');
  assert.ok(first.configPath.startsWith(dataRoot + path.sep), 'Engram config stays under the configured data root');
  for (const hostPath of [paths.claudeJsonPath, paths.codexConfigPath, ...Object.values(paths.settingsPaths)]) assert.equal(path.relative(dataRoot, hostPath).startsWith('..'), true, 'host settings are an explicitly selected external integration destination');
  const configText = await readFile(first.configPath, 'utf8'); assert.equal((await stat(first.configPath)).mode & 0o777, 0o600); assert.doesNotMatch(configText, /token":|Bearer|secret":/i); assert.deepEqual(JSON.parse(configText).excludeProjects, ['secret-client']);
  const claude = JSON.parse(await readFile(paths.claudeJsonPath, 'utf8')); assert.equal(claude.numStartups, 7); assert.ok(claude.mcpServers.other, 'unrelated MCP server kept'); assert.equal(claude.mcpServers.engram.headers['X-Engram-Workspace'], 'personal');
  assert.match(await readFile(paths.codexConfigPath, 'utf8'), /\[features\]\nhooks = true/); assert.match(await readFile(paths.codexConfigPath, 'utf8'), /"X-Engram-Workspace" = "personal"/);
  const settings = JSON.parse(await readFile(paths.settingsPaths['claude-code'], 'utf8')); assert.deepEqual(settings.permissions.allow, ['Read']);
  const commands = (name: string) => (settings.hooks[name] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
  assert.ok(commands('UserPromptSubmit').includes('echo mine')); assert.ok(commands('UserPromptSubmit').some(c => / memory capture --user --host claude-code /.test(c) && !c.includes('--registration') && !/Bearer|token=/i.test(c)));
  assert.ok(((settings.hooks.SessionStart ?? []) as Array<{ hooks: Array<{ command: string }> }>).some(e => / memory context --host claude-code --user /.test(e.hooks[0]!.command)), 'the user-level SessionStart context hook is installed');
  const settingsBytes = await readFile(paths.settingsPaths['claude-code'], 'utf8'); const claudeBytes = await readFile(paths.claudeJsonPath, 'utf8'); const tomlBytes = await readFile(paths.codexConfigPath, 'utf8');
  await setupUser(options); assert.equal(await readFile(paths.settingsPaths['claude-code'], 'utf8'), settingsBytes); assert.equal(await readFile(paths.claudeJsonPath, 'utf8'), claudeBytes); assert.equal(await readFile(paths.codexConfigPath, 'utf8'), tomlBytes, 'a second run changes nothing');
  assert.equal((await userStatus()).configured, true);
  const removed = await uninstallUser(paths); assert.ok(removed.hooksRemoved >= 2); assert.deepEqual(removed.mcpRemoved.sort(), ['claude-code', 'codex']); assert.equal(removed.configRemoved, true);
  const after = JSON.parse(await readFile(paths.settingsPaths['claude-code'], 'utf8'));
  assert.doesNotMatch(JSON.stringify(after), /engram-mdb/, 'no Engram hook of any kind remains'); assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'echo mine' }] }], 'only our entries were removed');
  assert.ok(JSON.parse(await readFile(paths.claudeJsonPath, 'utf8')).mcpServers.other); assert.doesNotMatch(await readFile(paths.codexConfigPath, 'utf8'), /engram/); assert.equal((await userStatus()).configured, false);
  void base; recordCase({ suite: 'memory', name: 'user-setup-install-uninstall', status: 'PASS' });
});

test('a conflicting hand-written engram MCP entry is never overwritten', async t => {
  const { paths } = await sandbox(t);
  await writeFile(paths.claudeJsonPath, JSON.stringify({ mcpServers: { engram: { type: 'http', url: 'https://mine.example/mcp' } } }));
  await assert.rejects(setupUser({ hosts: ['claude-code'], mcpUrl: 'https://engram.example.com/mcp', tokenEnv: 'ENGRAM_USER_TOKEN', registrationId: 'reg_u1', principalId: 'me', consent: true, ...paths }), /different mcpServers\.engram/);
  assert.equal(JSON.parse(await readFile(paths.claudeJsonPath, 'utf8')).mcpServers.engram.url, 'https://mine.example/mcp');
});

test('every conversation reaches the user workspace with its project, whether or not the project was initialized; bound, excluded and paused cases are honored', async t => {
  const { base, dataRoot, paths } = await sandbox(t); const srv = await server(t);
  process.env.ENGRAM_USER_TOKEN = srv.token;
  await setupUser({ hosts: ['claude-code'], mcpUrl: srv.url, tokenEnv: 'ENGRAM_USER_TOKEN', registrationId: srv.registrationId, principalId: 'me', exclude: ['/private-client'], consent: true, ...paths });
  const plain = path.join(base, 'projects', 'never-initialized'); await mkdir(plain, { recursive: true });
  const bound = path.join(base, 'projects', 'bound-project'); await mkdir(bound, { recursive: true }); const boundBinding = defaultBinding({ workspaceId: 'bound-project', serverUrl: srv.url, hosts: ['claude-code'], credentialRef: 'ENGRAM_USER_TOKEN', captureConsent: true }); await writeBinding(bound, boundBinding); await trustProject(bound, boundBinding);
  const boundSub = path.join(bound, 'src'); await mkdir(boundSub);
  const excluded = path.join(base, 'projects', 'private-client'); await mkdir(excluded, { recursive: true });
  assert.equal(await captureForUser('claude-code', payload(plain, 'I prefer concise commit messages')), 'queued');
  assert.equal(await captureForUser('claude-code', payload(bound, 'handled by the project hook')), 'deferred:project-capture');
  assert.equal(await captureForUser('claude-code', payload(boundSub, 'subdirectory of a bound project')), 'deferred:project-capture');
  assert.equal(await captureForUser('claude-code', payload(excluded, 'client confidential')), 'ignored:excluded');
  assert.equal(await captureForUser('claude-code', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'no cwd' })), 'ignored:no-cwd');
  assert.equal(await captureForUser('claude-code', 'not json'), 'ignored:bad-payload'); assert.equal(await captureForUser('codex', payload(plain, 'wrong host')), 'ignored:not-configured');
  await drainRemoteCaptureSpool({ token: srv.token }); await settle(srv.owner, 1);
  const spool = defaultRemoteSpoolDirectory(); assert.ok(spool.startsWith(dataRoot + path.sep), 'the actual remote-capture queue uses the configured root');
  assert.equal((await readdir(spool)).filter(name => name.endsWith('.json')).length, 0, 'the delivered queue entry is removed from the confined spool');
  const observations = (await srv.owner.listDocuments()).filter(d => d.kind === 'observation');
  assert.equal(observations.length, 1, 'only the uninitialized project was recorded here'); const o = observations[0]!;
  assert.equal((o.scope as { workspaceId: string }).workspaceId, 'personal'); assert.match(o.body, /concise commit messages/); assert.equal(o.metadata.project, 'never-initialized'); assert.match(String(o.metadata.cwdHash), /^[0-9a-f]{12}$/); assert.equal(o.metadata.evidenceClass, 'user_authored');
  await setUserPaused(true); assert.equal(await captureForUser('claude-code', payload(plain, 'while paused')), 'ignored:paused');
  await setUserPaused(false); assert.equal(await captureForUser('claude-code', payload(plain, 'after resume')), 'queued');
  recordCase({ suite: 'memory', name: 'user-level-capture-routing', status: 'PASS' });
});

test('a project hook only records sessions inside its own project; symlinks and bad payloads record nothing', async t => {
  const base = await temp(t, 'engram-scope-'); const a = path.join(base, 'a'), b = path.join(base, 'b'); await mkdir(path.join(a, 'deep'), { recursive: true }); await mkdir(b);
  await symlink(b, path.join(a, 'link-to-b'));
  assert.equal(await insideProject(JSON.stringify({ cwd: a }), a), true); assert.equal(await insideProject(JSON.stringify({ cwd: path.join(a, 'deep') }), a), true);
  assert.equal(await insideProject(JSON.stringify({ cwd: b }), a), false, 'another project');
  assert.equal(await insideProject(JSON.stringify({ cwd: path.join(a, 'link-to-b') }), a), false, 'a symlink out of the project is outside');
  assert.equal(await insideProject(JSON.stringify({ cwd: `${a}-sibling` }), a), false); assert.equal(await insideProject(JSON.stringify({}), a), false); assert.equal(await insideProject('nope', a), false); assert.equal(await insideProject(JSON.stringify({ cwd: '/does/not/exist' }), a), false);
});
