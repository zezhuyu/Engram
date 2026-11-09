import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';

const MDB = resolve('bin/mdb.js');
type Temp = { dir: string; env: NodeJS.ProcessEnv };
async function temp(): Promise<Temp> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'engram-cli-contract-'));
  const home = path.join(dir, 'home'), xdg = path.join(dir, 'xdg');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(xdg, { recursive: true })]);
  return { dir, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), ENGRAM_DATA_DIR: path.join(dir, 'data'), ENGRAM_MODEL_CACHE: path.join(dir, 'models'), ENGRAM_AUTO_RECONNECT: '1' } };
}
function cli(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, [MDB, ...args, '--json'], { cwd: process.cwd(), encoding: 'utf8', env, timeout: 60_000 });
  let json: unknown; try { json = JSON.parse(result.stdout); } catch { /* preserve raw output for assertion */ }
  return { ...result, json };
}
function ok(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = cli(env, ...args); assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}\n${result.stdout}`); return result;
}
async function cleanup(s: Temp) { await rm(s.dir, { recursive: true, force: true }); }

test('documented mdb instructions positional actions work through bin/mdb.js', async t => {
  const s = await temp(); t.after(() => cleanup(s));
  const help = cli(s.env, 'help'); assert.equal(help.status, 0); assert.match(help.stdout, /instructions install\|refresh\|status\|remove --host/);
  const claude = path.join(s.dir, 'host', 'CLAUDE.md'), codex = path.join(s.dir, 'host', 'AGENTS.md');
  await mkdir(path.dirname(claude), { recursive: true }); await writeFile(claude, '# Keep this text\n'); await writeFile(codex, '# Codex text\n');
  const paths = ['--claude-instructions-path', claude, '--codex-instructions-path', codex];
  const invoke = (...args: string[]) => ok(s.env, 'instructions', ...args, '--host', 'both', ...paths);
  let result = invoke('status');
  assert.equal((result.json as Record<string, { status: string }> )['claude-code']!.status, 'absent');
  assert.equal((result.json as Record<string, { status: string }>).codex!.status, 'absent');
  result = invoke('install', '--dry-run');
  assert.equal((result.json as Record<string, { changed: boolean }> )['claude-code']!.changed, true);
  assert.equal(await readFile(claude, 'utf8'), '# Keep this text\n');
  result = invoke('install'); assert.equal((result.json as Record<string, { changed: boolean }> )['claude-code']!.changed, true);
  assert.match(await readFile(claude, 'utf8'), /# Keep this text/); assert.match(await readFile(claude, 'utf8'), /engram:user:start/);
  assert.ok((await readdir(path.dirname(claude))).some(name => name.includes('.bak') || name.includes('backup')), 'first managed edit creates a backup');
  result = invoke('status'); assert.equal((result.json as Record<string, { status: string }> )['claude-code']!.status, 'installed');
  result = invoke('install'); assert.equal((result.json as Record<string, { changed: boolean }> )['claude-code']!.changed, false);
  result = invoke('refresh'); assert.equal((result.json as Record<string, { changed: boolean }> )['claude-code']!.changed, false);
  result = invoke('remove'); assert.equal((result.json as Record<string, { changed: boolean }> )['claude-code']!.changed, true);
  assert.match(await readFile(claude, 'utf8'), /^# Keep this text\n/); assert.match(await readFile(codex, 'utf8'), /^# Codex text\n/);
  result = ok(s.env, 'setup', '--user', '--show', '--claude-instructions-path', claude, '--codex-instructions-path', codex);
  assert.equal((result.json as { instructions: Record<string, { status: string }> }).instructions['claude-code']?.status, 'absent');
});

test('new CLI families accept the documented positional forms through the real entry', async t => {
  const s = await temp(); t.after(() => cleanup(s));
  const root = path.join(s.dir, 'vault');
  const localEnv = { ...s.env }; delete localEnv.ENGRAM_DATA_DIR;
  assert.equal(ok(localEnv, 'init', '--root', root, '--no-sqlite').status, 0);
  const preview = ok(localEnv, 'embed', 'model', 'preview', '--root', root).json as { id: string; totalBytes: number };
  assert.ok(preview.id && preview.totalBytes > 0);
  assert.deepEqual(ok(localEnv, 'embed', 'model', 'status', '--root', root).json, { state: 'not_installed' });
  const download = cli(localEnv, 'embed', 'model', 'download', '--root', root);
  assert.notEqual(download.status, 0); assert.match(download.stderr + download.stdout, /rerun with --yes to download explicitly/);
  const embeddingTest = cli(localEnv, 'embed', 'model', 'test', '--root', root);
  assert.notEqual(embeddingTest.status, 0); assert.match(embeddingTest.stderr + embeddingTest.stdout, /Configure an embedding provider first/);
  const remove = cli(localEnv, 'embed', 'model', 'remove', '--yes', '--root', root);
  assert.equal(remove.status, 0, remove.stderr);

  const wiki = path.join(s.dir, 'wiki'); await mkdir(wiki); await writeFile(path.join(wiki, 'index.md'), '# Imported page\n\nA short page.\n');
  const imported = ok(localEnv, 'wiki', 'import', '--from', wiki, '--workspace', 'docs', '--dry-run', '--root', root).json as { files?: number; [key: string]: unknown };
  assert.ok(imported);
  const verified = ok(localEnv, 'wiki', 'import', 'verify', '--from', wiki, '--workspace', 'docs', '--root', root).json;
  assert.ok(verified);

  const binDir = path.join(s.dir, 'fake-bin'); await mkdir(binDir);
  const systemctl = path.join(binDir, 'systemctl'); await writeFile(systemctl, '#!/bin/sh\nif [ "$1" = "show" ]; then printf "LoadState=not-found\\nActiveState=inactive\\nMainPID=0\\n"; fi\nexit 0\n', { mode: 0o700 });
  await chmod(systemctl, 0o700); s.env.PATH = `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  const fakeCheck = spawnSync('systemctl', ['show'], { env: s.env, encoding: 'utf8' }); assert.equal(fakeCheck.status, 0, `fake systemctl not found via ${s.env.PATH}: ${fakeCheck.error?.message ?? ''}`);
  const client = ok(localEnv, 'service', 'dashboard-url', '--platform', 'linux', '--root', root).json as { url: string; noteAvailable: boolean };
  assert.match(client.url, /^http:\/\/127\.0\.0\.1:/); assert.equal(client.noteAvailable, false);
  const server = ok(localEnv, 'service', 'dashboard-url', '--role', 'server', '--platform', 'linux', '--root', root).json as { port: number };
  assert.equal(server.port, 4871);
  const serviceEnv = { ...localEnv, PATH: s.env.PATH };
  const serviceHome = path.join(s.dir, 'service'), tokenFile = path.join(s.dir, 'token'); await writeFile(tokenFile, 'test-token', { mode: 0o600 });
  const serviceArgs = ['--platform', 'linux', '--home', serviceHome, '--url', 'https://example.invalid/mcp', '--token-file', tokenFile, '--allow-root', '--root', root];
  assert.match(String((ok(serviceEnv, 'service', 'install', '--dry-run', ...serviceArgs).json)), /Engram outbox watcher/);
  assert.ok(ok(serviceEnv, 'service', 'status', ...serviceArgs).json);
  const notInstalled = cli(serviceEnv, 'service', 'start', ...serviceArgs); assert.notEqual(notInstalled.status, 0); assert.match(notInstalled.stdout + notInstalled.stderr, /service is not installed/);
  assert.equal((ok(serviceEnv, 'service', 'stop', ...serviceArgs).json as { installed: boolean }).installed, false);
  assert.equal((ok(serviceEnv, 'service', 'uninstall', ...serviceArgs).json as { removed: boolean }).removed, false);
  const template = ok(localEnv, 'credential', 'permissions-template', '--agent', '--workspace', 'docs,personal', '--root', root).json;
  assert.ok(template);
  assert.ok(ok(localEnv, 'model', 'show', '--root', root).json);
  assert.ok(ok(localEnv, 'model', 'set', '--provider', 'none', '--no-check', '--root', root).json);
  const modelTest = cli(localEnv, 'model', 'test', '--root', root);
  assert.notEqual(modelTest.status, 0); assert.match(modelTest.stdout + modelTest.stderr, /No model provider configured/);

  const setupPaths = ['--claude-instructions-path', path.join(s.dir, 'setup', 'CLAUDE.md'), '--codex-instructions-path', path.join(s.dir, 'setup', 'AGENTS.md')];
  assert.ok(ok(localEnv, 'setup', '--user', '--consent', '--hosts', 'claude-code,codex', '--mcp-url', 'http://127.0.0.1:4873/mcp', '--registration', 'reg_test', '--principal', 'actor_test', ...setupPaths).json);
  for (const args of [
    ['setup', '--user', '--show', ...setupPaths], ['setup', '--user', '--pause'], ['setup', '--user', '--resume'], ['setup', '--user', '--uninstall', ...setupPaths],
  ]) assert.equal(ok(localEnv, ...args).status, 0, args.join(' '));

  const configured = ok(localEnv, 'intelligence', 'schedule', 'configure', '--enable', '--timezone', 'UTC', '--time', '03:00', '--quiet-start', '22:00', '--quiet-end', '06:00', '--mode', 'fixed', '--auto-accept', 'none', '--include', 'docs', '--exclude', 'private', '--micro', 'on', '--micro-debounce-minutes', '15', '--micro-max-per-day', '4', '--root', root).json as { enabled: boolean; timezone: string; mode: string; micro: { enabled: boolean; debounceMinutes: number; maxPerDay: number; kinds: string[] } };
  assert.equal(configured.enabled, true); assert.equal(configured.timezone, 'UTC'); assert.equal(configured.mode, 'fixed');
  assert.deepEqual(configured.micro, { enabled: true, debounceMinutes: 15, maxPerDay: 4, kinds: ['user_insight', 'insight', 'wiki_page', 'source'] });
  assert.ok(ok(localEnv, 'intelligence', 'schedule', 'status', '--root', root).json);
  const launchd = ok(localEnv, 'intelligence', 'schedule', 'service', 'launchd', '--interval-s', '300', '--label', 'test-worker', '--log', path.join(s.dir, 'worker.log'), '--root', root).json as { content: string };
  assert.match(launchd.content, /test-worker/);
  const systemd = ok(localEnv, 'intelligence', 'schedule', 'service', 'systemd', '--interval-s', '300', '--root', root).json as { content: string };
  assert.match(systemd.content, /ExecStart=.*schedule worker/);
});
