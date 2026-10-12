import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../packages/core/vault.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { createRegistration } from '../../packages/memory/capture.js';
import { createProviderFromConfig } from '../../packages/models/factory.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { initializeProject } from '../../packages/project-init.js';
import { tempDir } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';

const enabled = process.env.MDB_REAL_REMOTE_HOST_TEST === '1';
const MCP = path.resolve('bin/mdb-mcp.js');
const MDB = path.resolve('bin/mdb.js');
type Server = { endpoint: string; port: number; stop(): Promise<void> };
function startServer(root: string, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: String(port), MDB_MCP_HTTP_ALLOWED_ORIGINS: 'https://agents.example' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`HTTP MCP did not start: ${stderr}`)); } }, 10_000);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (text: string) => {
      stderr += text; const match = /MCP HTTP listening at http:\/\/[^:]+:(\d+)\/mcp/.exec(stderr);
      if (match && !settled) { settled = true; clearTimeout(timer); const actualPort = Number(match[1]); resolve({ endpoint: `http://127.0.0.1:${actualPort}/mcp`, port: actualPort, stop: () => new Promise<void>(done => { if (child.exitCode !== null) return done(); child.once('exit', () => done()); child.kill('SIGTERM'); }) }); }
    });
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('exit', code => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`HTTP MCP exited ${code}: ${stderr}`)); } });
  });
}
function runHost(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 300_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); reject(new Error(`${command} host timed out`)); }, timeoutMs);
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function reorderAndDuplicate(spool: string): Promise<{ count: number; duplicatedEvent: string }> {
  const names = (await fs.readdir(spool)).filter(n => n.endsWith('.json')).sort();
  const envelopes = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(spool, name), 'utf8')) as { payload: Record<string, unknown> }));
  assert.ok(envelopes.some(e => e.payload.hook_event_name === 'SessionEnd'), 'real host session end was durably buffered during outage');
  assert.ok(envelopes.some(e => e.payload.hook_event_name === 'UserPromptSubmit'), 'real host prompt was durably buffered during outage');
  const user = envelopes.find(e => e.payload.hook_event_name === 'UserPromptSubmit')!;
  const ordered = [...envelopes].sort((a, b) => {
    const rank = (name: unknown) => name === 'SessionStart' ? 0 : name === 'PostToolUse' ? 1 : name === 'UserPromptSubmit' ? 2 : name === 'SessionEnd' ? 99 : 50;
    return rank(a.payload.hook_event_name) - rank(b.payload.hook_event_name);
  });
  const end = ordered.filter(e => e.payload.hook_event_name === 'SessionEnd'); const rest = ordered.filter(e => e.payload.hook_event_name !== 'SessionEnd');
  const copy = { ...user };
  const all = [...rest.slice(0, 3), copy, ...rest.slice(3), ...end];
  for (const name of names) await fs.rm(path.join(spool, name), { force: true });
  for (const [index, envelope] of all.entries()) await fs.writeFile(path.join(spool, `${String(index + 1).padStart(14, '0')}-captured-${index}.json`), JSON.stringify(envelope), { mode: 0o600 });
  return { count: all.length, duplicatedEvent: String(user.payload.prompt ?? '') };
}

test('real Claude Code and Codex remote capture recover after HTTP outage and server restart', { skip: enabled ? false : 'set MDB_REAL_REMOTE_HOST_TEST=1 with authenticated Claude Code/Codex CLIs', timeout: 900_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-remote-server-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = await tempDir(t, 'remote-shared-project');
  const local = await tempDir(t, 'remote-clients');
  const owner = new Vault(root); await owner.init({ sqlite: false }); await owner.createWorkspace(path.basename(projectDir));
  const workspaceId = path.basename(projectDir);
  const claudeCredential = await createHttpCredential(owner, 'claude-remote-live', [`workspace:${workspaceId}:read`, `workspace:${workspaceId}:write`]);
  const codexCredential = await createHttpCredential(owner, 'codex-remote-live', [`workspace:${workspaceId}:read`, `workspace:${workspaceId}:write`]);
  const claudeRegistration = await createRegistration(owner, { host: 'claude-code', principalId: 'claude-remote-live', workspaceId, consent: true });
  const codexRegistration = await createRegistration(owner, { host: 'codex', principalId: 'codex-remote-live', workspaceId, consent: true });
  const modelProviderName = process.env.MDB_TEST_PROVIDER ?? 'claude-cli';
  const modelName = process.env.MDB_TEST_MODEL;
  if (!/-cli$|^auto$/.test(modelProviderName) && !modelName) throw new Error('MDB_TEST_MODEL is required for API providers');
  const provider = createProviderFromConfig({ provider: modelProviderName, allowNetwork: process.env.MDB_TEST_ALLOW_NETWORK === '1', ...(modelName ? { modelName } : {}), ...(process.env.MDB_TEST_BASE_URL ? { baseUrl: process.env.MDB_TEST_BASE_URL } : {}), ...(process.env.MDB_TEST_API_KEY_ENV ? { apiKeyEnv: process.env.MDB_TEST_API_KEY_ENV } : {}), timeoutMs: 240_000, maxRetries: 1 });
  const config = await owner.config(); config.model.allowPrivateContentToRemote = true; config.model.critic = false; await fs.writeFile(path.join(root, 'mdb.yaml'), (await import('yaml')).default.stringify(config));
  let server = await startServer(root);
  t.after(async () => { await server.stop().catch(() => undefined); });

  const claudeSpool = path.join(local, 'claude-spool'); const codexSpool = path.join(local, 'codex-spool');
  const claudeSettings = path.join(local, 'claude-settings.json');
  await initializeProject(undefined, { projectDir, host: 'claude-code', settingsPath: claudeSettings, mcpUrl: server.endpoint, tokenEnv: 'ENGRAM_CLAUDE_TOKEN', principalId: 'claude-remote-live', registrationId: claudeRegistration.id, consent: true });
  await initializeProject(undefined, { projectDir, host: 'codex', settingsPath: path.join(projectDir, '.codex', 'hooks.json'), mcpUrl: server.endpoint, tokenEnv: 'ENGRAM_CODEX_TOKEN', principalId: 'codex-remote-live', registrationId: codexRegistration.id, consent: true });
  const authSource = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const auth = path.join(authSource, 'auth.json'); await fs.access(auth);
  const isolatedCodexHome = path.join(local, 'codex-home'); await fs.mkdir(isolatedCodexHome); await fs.copyFile(auth, path.join(isolatedCodexHome, 'auth.json')); await fs.chmod(path.join(isolatedCodexHome, 'auth.json'), 0o600);
  await fs.writeFile(path.join(isolatedCodexHome, 'config.toml'), `[features]\nhooks = true\n\n[projects.${JSON.stringify(projectDir)}]\ntrust_level = "trusted"\n`);

  const liveTask = async (host: 'claude' | 'codex', marker: string) => {
    const clientEnv: NodeJS.ProcessEnv = { ...process.env, ENGRAM_REMOTE_SPOOL: host === 'claude' ? claudeSpool : codexSpool, ...(host === 'claude' ? { ENGRAM_CLAUDE_TOKEN: claudeCredential.token } : { ENGRAM_CODEX_TOKEN: codexCredential.token, CODEX_HOME: isolatedCodexHome }) };
    const prompt = `Use the shell to run echo ${marker}. Do not write to Engram or any memory system. Reply exactly finished.`;
    const result = host === 'claude'
      ? await runHost('claude', ['-p', '--settings', claudeSettings, '--allowedTools', 'Bash', '--no-session-persistence', '--output-format', 'text', prompt], projectDir, clientEnv)
      : await runHost('codex', ['exec', '--cd', projectDir, '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only', '--json', prompt], projectDir, clientEnv);
    assert.equal(result.code, 0, `${host} native task failed: ${result.stderr.slice(-2000)}`); assert.match(result.stdout, /finished/i);
  };

  // A stopped server is a real HTTP outage. Both installed native agents must keep executing while their local bounded spools retain events.
  await server.stop();
  await Promise.all([liveTask('claude', 'claude-offline-capture-8147'), liveTask('codex', 'codex-offline-capture-9261')]);
  const claudeQueued = await fs.readdir(claudeSpool); const codexQueued = await fs.readdir(codexSpool);
  assert.ok(claudeQueued.filter(n => n.endsWith('.json')).length > 0 && claudeQueued.length <= 1000);
  assert.ok(codexQueued.filter(n => n.endsWith('.json')).length > 0 && codexQueued.length <= 1000);
  const claudeBuffer = await reorderAndDuplicate(claudeSpool); const codexBuffer = await reorderAndDuplicate(codexSpool);

  // Restart the same server and port. A later native lifecycle hook on each independent installation retries its own buffered stream.
  server = await startServer(root, server.port);
  await Promise.all([liveTask('claude', 'claude-reconnected-capture-1357'), liveTask('codex', 'codex-reconnected-capture-2468')]);
  for (const spool of [claudeSpool, codexSpool]) assert.equal((await fs.readdir(spool)).filter(n => n.endsWith('.json')).length, 0, 'all offline and reconnect events eventually delivered');

  const documents = await owner.listDocuments();
  for (const [actor, host, marker] of [['claude-remote-live', 'claude-code', 'claude-offline-capture-8147'], ['codex-remote-live', 'codex', 'codex-offline-capture-9261']] as const) {
    const matching = documents.filter(d => d.metadata.eventType === 'user.message' && d.createdBy === actor && d.metadata.host === host && d.body.includes(marker));
    assert.equal(matching.length, 1, `${actor} duplicate buffered prompt is idempotent and retains server actor attribution`);
  }
  const closed = documents.filter(d => d.kind === 'session' && d.metadata.lifecycle === 'closed'); assert.ok(closed.length >= 2, 'disconnected SessionEnd events close both remote sessions');
  const jobsBefore = await new IntelligenceEngine(owner).jobs(); assert.ok(jobsBefore.some(j => j.kind === 'memory' && j.input.instruction?.startsWith('HANDOFF:')), 'server queues handoff generation from delivered SessionEnd events');
  const intelligence = new IntelligenceEngine(owner, provider); const handoffJobs = await intelligence.run({ job: 'memory', limit: 10 });
  const handoffs = (await intelligence.proposals()).filter(p => p.input.kind === 'working_memory' && p.input.metadata?.handoff === true);
  assert.ok(handoffs.length > 0, `real model generated a staged, evidence-linked handoff after reconnect; jobs=${JSON.stringify(handoffJobs.map(j => ({ status: j.status, error: j.error })))} proposals=${JSON.stringify((await intelligence.proposals()).map(p => ({ kind: p.input.kind, status: p.status, title: p.input.title, flags: p.flags })))}`);
  recordCase({ suite: 'memory', name: 'remote-real-host-outage-restart-retry', status: 'PASS', detail: { agents: ['Claude Code', 'Codex'], serverTransport: 'HTTP MCP /capture', credentialsDistinct: claudeCredential.id !== codexCredential.id, outage: 'server terminated while both hosts executed tasks', restartPort: server.port, offlineBuffered: { claude: claudeBuffer.count, codex: codexBuffer.count }, duplicatedOutOfOrderEvents: true, eventualDrain: true, closedSessions: closed.length, stagedHandoffs: handoffs.length, duplicatedPrompt: 'each repeated captured payload committed once', codexStopRequired: false } });
  await server.stop();
});
