import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, symlinkSync, statSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProvider, detectAgents, detectOllama, findExecutable, cliChildEnvironment, cliArguments } from '../packages/models/cli.js';
import { deleteSecret, hasSecret, readSecret, writeSecret } from '../packages/core/secret-store.js';
import { isRemoteProvider, modelConsent } from '../packages/models/consent.js';
import type { ConverseRequest } from '../packages/core/types.js';

function temp(): string { return mkdtempSync(path.join(os.tmpdir(), 'engram-model-foundation-')); }
function shellScript(file: string, source: string): void { writeFileSync(file, `#!/bin/sh\n${source}\n`, { mode: 0o700 }); chmodSync(file, 0o700); }
function secretMatches(actual: string | undefined, expected: string): boolean { return createHash('sha256').update(actual ?? '').digest('hex') === createHash('sha256').update(expected).digest('hex'); }

test('resolver searches known home bins with a minimal PATH and detectAgents uses bounded version calls', async () => {
  const root = temp();
  try {
    const home = path.join(root, 'home'), local = path.join(home, '.local/bin'); mkdirSync(local, { recursive: true });
    shellScript(path.join(local, 'claude'), 'if [ "$1" = "--version" ]; then echo claude-test-1; else echo answer; fi');
    const bunBin = path.join(home, '.bun/bin'); mkdirSync(bunBin, { recursive: true });
    shellScript(path.join(bunBin, 'codex'), 'if [ "$1" = "--version" ]; then echo codex-test-2; else echo answer; fi');
    const env = { HOME: home, PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv;
    assert.equal(findExecutable('claude', env), path.join(local, 'claude'));
    assert.equal(findExecutable('codex', env), path.join(bunBin, 'codex'));
    const agents = await detectAgents(env, { timeoutMs: 1000 });
    assert.deepEqual(agents, [
      { id: 'claude-cli', found: true, path: path.join(local, 'claude'), version: 'claude-test-1' },
      { id: 'codex-cli', found: true, path: path.join(bunBin, 'codex'), version: 'codex-test-2' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI child env is allowlisted and override values go to the documented environment variables', () => {
  const source = { HOME: '/home/test', PATH: '/usr/bin:/bin', USER: 'owner', LANG: 'en_US.UTF-8', LC_ALL: 'C', XDG_CONFIG_HOME: '/cfg', SECRET_PARENT: 'must-not-pass', OPENAI_API_KEY: 'parent-key', ANTHROPIC_API_KEY: 'parent-key' } as NodeJS.ProcessEnv;
  const claude = cliChildEnvironment('/home/test/.local/bin/claude', source, { kind: 'claude', baseUrl: 'http://127.0.0.1:9090', apiKey: 'claude-secret' });
  assert.equal(claude.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9090'); assert.equal(secretMatches(claude.ANTHROPIC_API_KEY, 'claude-secret'), true);
  assert.equal(claude.OPENAI_API_KEY, undefined); assert.equal(claude.SECRET_PARENT, undefined); assert.match(claude.PATH!, /^\/home\/test\/\.local\/bin:/);
  const codex = cliChildEnvironment('/opt/homebrew/bin/codex', source, { kind: 'codex', baseUrl: 'http://127.0.0.1:9090/v1', apiKey: 'codex-secret' });
  assert.equal(codex.OPENAI_BASE_URL, undefined); assert.equal(secretMatches(codex.OPENAI_API_KEY, 'codex-secret'), true);
  assert.equal(codex.ANTHROPIC_API_KEY, undefined); assert.equal(codex.SECRET_PARENT, undefined);
});

test('CLI provider default omits model flags and classifies stderr without exposing credentials', async () => {
  assert.equal(cliArguments('codex', { cwd: '/tmp', outputFile: '/tmp/out' }).includes('-m'), false);
  assert.equal(cliArguments('claude', { cwd: '/tmp' }).includes('--model'), false);
  const root = temp();
  try {
    const executable = path.join(root, 'fake-claude');
    shellScript(executable, "echo 'model gpt-oss:latest not found; https://user:password@host.invalid/?api_key=fixture-secret' >&2; exit 1");
    const provider = new CliAgentProvider({ id: 'claude-cli', kind: 'claude', command: executable, model: 'gpt-oss:latest', locality: 'remote', timeoutMs: 3000, maxRetries: 0, maxInputTokens: 12000 });
    await assert.rejects(() => provider.converse({ system: 'system', turns: [{ role: 'user', content: 'hello' }] }), error => {
      assert.match((error as Error).message, /The model 'gpt-oss:latest' is not available for claude-cli/);
      assert.doesNotMatch((error as Error).message, /fixture-secret|password|host\.invalid/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Ollama detection requests only /api/tags with a two-second abort and bounds returned names', async () => {
  let requested = '', timeoutSignal: AbortSignal | undefined;
  const fakeFetch: typeof fetch = async (input, init) => { requested = String(input); timeoutSignal = init?.signal as AbortSignal; return new Response(JSON.stringify({ models: [{ name: 'llama3' }, { name: 'x'.repeat(500) }] }), { status: 200 }); };
  const result = await detectOllama('http://127.0.0.1:11434', fakeFetch);
  assert.equal(requested, 'http://127.0.0.1:11434/api/tags'); assert.equal(timeoutSignal?.aborted, false);
  assert.deepEqual(result.models, ['llama3', 'x'.repeat(200)]); assert.equal(result.reachable, true);
  let remoteCalled = false;
  const remoteFetch: typeof fetch = async () => { remoteCalled = true; return new Response(JSON.stringify({ models: [{ name: 'remote-model' }] }), { status: 200 }); };
  const refused = await detectOllama('http://example.test', remoteFetch);
  assert.deepEqual(refused, { reachable: false, models: [] });
  assert.equal(remoteCalled, false);
  const explicitlyAllowed = await detectOllama('http://example.test', remoteFetch, ['http://example.test']);
  assert.deepEqual(explicitlyAllowed, { reachable: true, models: ['remote-model'] });
});

test('secret store writes private files, trims trailing newlines, refuses unsafe entries, and never prints values', () => {
  const root = temp(), home = path.join(root, 'home'), env = { HOME: home } as NodeJS.ProcessEnv;
  try {
    writeSecret('openai-main', 'secret-canary\n\n', { env });
    const file = path.join(home, '.config/engram/secrets/openai-main');
    assert.equal(secretMatches(readSecret('openai-main', { env }), 'secret-canary'), true); assert.equal(hasSecret('openai-main', { env }), true);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700); assert.equal(statSync(file).mode & 0o777, 0o600);
    for (const name of ['../escape', '.bad', 'UPPER', 'x'.repeat(65)]) assert.throws(() => writeSecret(name, 'secret', { env }), /Invalid secret name/);
    const unsafe = path.join(home, '.config/engram/secrets/loose'); writeFileSync(unsafe, 'unsafe', { mode: 0o644 });
    assert.throws(() => readSecret('loose', { env }), /permissions are unsafe/);
    const target = path.join(root, 'target'); writeFileSync(target, 'secret', { mode: 0o600 }); const linkName = path.join(home, '.config/engram/secrets/link'); symlinkSync(target, linkName);
    assert.throws(() => readSecret('link', { env }), /permissions are unsafe/);
    const linkedConfig = path.join(root, 'linked-config'); symlinkSync(path.join(home, '.config'), linkedConfig);
    assert.throws(() => readSecret('openai-main', { env: { ...env, XDG_CONFIG_HOME: linkedConfig } }), /permissions are unsafe/);
    const serialized = JSON.stringify({ name: 'openai-main', set: hasSecret('openai-main', { env }) }); assert.equal(serialized.includes('secret-canary'), false);
    assert.equal(deleteSecret('openai-main', { env }), true); assert.equal(readSecret('openai-main', { env }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP model consent truth table treats vendor CLIs as remote and loopback endpoints as local', () => {
  assert.equal(isRemoteProvider({ provider: 'claude-cli', locality: 'local' }), true);
  assert.equal(isRemoteProvider({ provider: 'ollama', locality: 'local', baseUrl: 'https://models.example/v1' }), true);
  assert.equal(isRemoteProvider({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, 'remote'), true, 'a host-supplied remote provider must not inherit loopback config locality');
  assert.equal(isRemoteProvider({ provider: 'auto' }, 'local'), false, 'a host-supplied local provider is judged by its declared locality');
  assert.equal(modelConsent({ provider: 'openai', allowNetwork: true }, true).consentGiven, false);
  assert.equal(modelConsent({ provider: 'openai', allowNetwork: true, allowPrivateContentToRemote: true }, true).consentGiven, true);
  assert.equal(modelConsent({ provider: 'openai', allowNetwork: false }, false).consentGiven, false);
  assert.deepEqual(modelConsent({ provider: 'ollama', allowNetwork: false, baseUrl: 'http://127.0.0.1:11434' }, true), { remote: false, consentGiven: true });
  assert.equal(modelConsent({ provider: 'openai-compatible', allowNetwork: false, baseUrl: 'https://models.example/v1' }, true).consentGiven, false);
  assert.equal(modelConsent({ provider: 'openai-compatible', allowNetwork: true, allowPrivateContentToRemote: true, baseUrl: 'https://models.example/v1' }, true).consentGiven, true);
});

test('CLI provider runs an absolute executable with only mapped overrides and does not put secrets in argv', async () => {
  const root = temp(), home = path.join(root, 'home'); mkdirSync(home);
  try {
    const executable = path.join(root, 'fake-codex'), observed = path.join(home, 'observed.txt');
    shellScript(executable, 'printf "%s\\n" "$OPENAI_API_KEY" "$OPENAI_BASE_URL" "$PATH" "$@" > "$HOME/observed.txt"; echo reply');
    const provider = new CliAgentProvider({ id: 'codex-cli', kind: 'codex', command: executable, locality: 'remote', timeoutMs: 5000, maxRetries: 0, maxInputTokens: 12000, env: { HOME: home, PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'parent-secret', SECRET_PARENT: 'hidden' }, apiKey: 'mapped-secret', baseUrl: 'http://127.0.0.1:8765/v1' });
    const request: ConverseRequest = { system: 'System instructions', turns: [{ role: 'user', content: 'hello' }] };
    assert.equal(await provider.converse(request), 'reply');
    const captured = readFileSync(observed, 'utf8'), lines = captured.split('\n');
    assert.equal(secretMatches(lines[0], 'mapped-secret'), true); assert.equal(lines[1], '');
    assert.ok(lines[2]?.startsWith(path.dirname(executable) + path.delimiter)); assert.ok(lines.slice(3).some(line => line === '-c')); assert.ok(lines.slice(3).some(line => line.includes('openai_base_url=')));
    assert.equal(lines.slice(3).some(line => line === 'parent-secret' || line === 'hidden' || line === 'mapped-secret'), false);
    assert.ok(path.isAbsolute(executable));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
