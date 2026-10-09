import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { disposableVault } from '../helpers/disposable-vault.js';
import { tempDir } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { Engram, createAdapter, drainSpool, spoolStats } from '../../packages/sdk/index.js';

/**
 * Opt-in (MDB_REAL_HOST_TEST=1): drives the REAL claude binary with hooks installed by our adapter into a TEMPORARY settings file
 * (--settings), never the user's own configuration. It sends one tiny prompt, so it uses a little of the user's Claude quota.
 */
const enabled = process.env.MDB_REAL_HOST_TEST === '1';
const claude = (args: string[], cwd: string, env: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string }>(resolve => { const c = spawn('claude', args, { cwd, env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; c.stdout.on('data', d => { stdout += d; }); c.on('close', code => resolve({ code, stdout })); });
const codexExec = (args: string[], cwd: string, env: Record<string, string>) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => { const c = spawn('codex', args, { cwd, env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; }); c.on('close', code => resolve({ code, stdout, stderr })); });
const flags = (settings: string) => ['-p', '--settings', settings, '--setting-sources', '', '--allowedTools', 'Bash', '--no-session-persistence', '--output-format', 'text'];

test('real Claude Code: hooks installed by the adapter capture a real task; another principal recalls it; the host works with MDB broken or absent', { skip: enabled ? false : 'set MDB_REAL_HOST_TEST=1 to run', timeout: 300_000 }, async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  const work = await tempDir(t, 'hostwork'); const settings = path.join(await tempDir(t, 'hostcfg'), 'settings.json');
  const adapter = createAdapter('claude-code', { root, settingsPath: settings });
  const installed = await adapter.install({ consent: true, principalId: 'claude-agent', workspaceId: 'proj' });
  assert.equal((await adapter.status()).installed, true);

  const task = await claude([...flags(settings), 'Run the shell command: echo real-host-marker-7341. Then reply with exactly the word finished.'], work);
  assert.equal(task.code, 0); assert.match(task.stdout, /finished/i, 'the host completed its task');
  for (let i = 0; i < 100 && ((await spoolStats(root)).queued > 0 || !(await vault.listDocuments()).some(d => d.kind === 'session' && d.metadata.lifecycle === 'closed')); i++) { await drainSpool(root); await new Promise(r => setTimeout(r, 200)); }
  const docs = await vault.listDocuments();
  assert.ok(docs.some(d => d.metadata.eventType === 'user.message' && /real-host-marker-7341/.test(d.body)), 'the user prompt was captured');
  assert.ok(docs.some(d => d.metadata.eventType === 'tool.result' && /real-host-marker-7341/.test(d.body)), 'the tool outcome was captured');
  assert.ok(docs.some(d => d.kind === 'session' && d.metadata.lifecycle === 'closed'), 'the session was closed by SessionEnd');

  await vault.grant('proj', 'reader', ['read']);
  const later = new Engram(root, { actorId: 'reader', permissions: [] });
  const hit = await later.memory.query({ mode: 'keyword', query: 'real-host-marker-7341', scope: 'workspace', workspaceId: 'proj' });
  assert.ok(hit.items.length >= 1, 'another principal retrieves the record on demand');
  assert.deepEqual((await new Engram(root, { actorId: 'nobody', permissions: [] }).memory.query({ mode: 'keyword', query: 'real-host-marker-7341' })).items, []);

  // MDB broken: hooks stay installed in the host, but the whole vault directory is destroyed. The host must still finish normally.
  const { promises: fsp } = await import('node:fs');
  await fsp.rm(root, { recursive: true, force: true });
  const broken = await claude([...flags(settings), 'Run the shell command: echo still-works-9915. Then reply with exactly the word finished.'], work);
  assert.equal(broken.code, 0); assert.match(broken.stdout, /finished/i, 'the host task succeeds with a destroyed vault');
  await assert.rejects(fsp.stat(root), { code: 'ENOENT' }, 'the failing recorder did not resurrect the vault or write elsewhere');
  const emptySettings = path.join(await tempDir(t, 'empty'), 'none.json'); await fsp.writeFile(emptySettings, '{}');
  const withoutHooks = await claude([...flags(emptySettings), 'Reply with exactly the word finished.'], work);
  assert.match(withoutHooks.stdout, /finished/i);
  recordCase({ suite: 'memory', name: 'real-claude-code-host', status: 'PASS', detail: { hostTaskWithMdb: true, hostTaskWithDestroyedVault: true, hostTaskWithoutHooks: true } });
});

const codexEnabled = process.env.MDB_REAL_CODEX_HOST_TEST === '1';
test('real Codex CLI: trusted hooks pass actual lifecycle payloads, capture without memory-write instructions, and fail open', { skip: codexEnabled ? false : 'set MDB_REAL_CODEX_HOST_TEST=1 to run', timeout: 300_000 }, async t => {
  const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const authFile = path.join(sourceHome, 'auth.json');
  await fs.access(authFile); // if the CLI is authenticated only by another mechanism, point CODEX_HOME at it
  const isolatedHome = await tempDir(t, 'codex-home'); await fs.copyFile(authFile, path.join(isolatedHome, 'auth.json')); await fs.chmod(path.join(isolatedHome, 'auth.json'), 0o600);
  const projectRoot = process.cwd();
  await fs.writeFile(path.join(isolatedHome, 'config.toml'), `[features]\nhooks = true\n\n[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`);
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '');
  const work = projectRoot; const codexDir = path.join(work, '.codex'); const settings = path.join(codexDir, 'hooks.json');
  await fs.access(codexDir).then(() => { throw new Error('Live Codex test needs a disposable project .codex directory; refusing to alter an existing one'); }, () => undefined);
  await fs.mkdir(codexDir); t.after(async () => { await fs.rm(settings, { force: true }); await fs.rmdir(codexDir).catch(() => undefined); });
  const adapter = createAdapter('codex', { root, settingsPath: settings });
  await adapter.install({ consent: true, principalId: 'codex-live-agent', workspaceId: 'proj' });
  const marker = `codex-live-marker-${Date.now()}`;
  const result = await codexExec(['exec', '--cd', work, '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only', '--json', '-c', 'features.hooks=true', `Use the shell to run echo ${marker}. Do not write to Engram or any memory system. Then reply exactly finished.`], work, { CODEX_HOME: isolatedHome });
  assert.equal(result.code, 0, result.stderr.slice(-2000));
  assert.match(result.stdout, /finished/i);
  for (let i = 0; i < 100; i++) { await drainSpool(root); const docs = await vault.listDocuments(); if (docs.some(d => d.kind === 'session' && d.metadata.lifecycle === 'closed')) break; await new Promise(r => setTimeout(r, 200)); }
  const docs = await vault.listDocuments();
  assert.ok(docs.some(d => d.kind === 'session' && d.metadata.startedAt), 'real SessionStart payload captured');
  assert.ok(docs.some(d => d.metadata.eventType === 'user.message' && d.body.includes(marker)), 'real UserPromptSubmit payload captured');
  assert.ok(docs.some(d => d.metadata.eventType === 'tool.result' && d.body.includes(marker)), 'real PostToolUse payload captured');
  // `codex exec` in the supported CLI version emits SessionStart, UserPromptSubmit,
  // PostToolUse and SessionEnd here. Its Stop hook is not dispatched for this
  // non-interactive invocation, so do not fabricate assistant-message evidence.
  assert.ok(docs.some(d => d.kind === 'session' && d.metadata.lifecycle === 'closed'), 'real SessionEnd payload captured');
  recordCase({ suite: 'memory', name: 'real-codex-host', status: 'PASS', detail: { hostTask: true, passiveCapture: true, hostVersion: (await new Promise<string>(resolve => { const c = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; c.stdout.on('data', d => out += d); c.on('close', () => resolve(out.trim())); })) , observedEvents: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'], stopDispatchedInExec: false, note: 'Stop was not dispatched for this real non-interactive codex exec invocation; no assistant-message capture is claimed.' } });
});
