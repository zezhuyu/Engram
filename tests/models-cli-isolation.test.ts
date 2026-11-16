import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProvider, cliArguments, cliChildEnvironment } from '../packages/models/cli.js';
import { touchActivity } from '../packages/adaptive/activity.js';
import { execute } from '../packages/cli/index.js';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'engram-cli-isolation-'));

test('Codex provider runs with user config, hooks, and project instructions isolated while retaining auth home', async () => {
  const root = temp();
  try {
    const executable = path.join(root, 'codex');
    const record = path.join(root, 'invocation.json');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, marker: process.env.MDB_BACKGROUND_PIPELINE, hooks: process.env.CODEX_HOOKS, features: process.env.CODEX_FEATURES } }));
const output = args[args.indexOf('-o') + 1];
fs.writeFileSync(output, 'OK');
`);
    chmodSync(executable, 0o700);
    const provider = new CliAgentProvider({ id: 'codex-cli', kind: 'codex', command: executable, locality: 'remote', timeoutMs: 5000, maxRetries: 0, maxInputTokens: 12000, extraArgs: ['--enable', 'hooks', '-c', 'project_doc_max_bytes=8192'], env: { HOME: '/owner/home', CODEX_HOME: '/owner/.codex', CODEX_HOOKS: 'untrusted', CODEX_FEATURES: 'hooks=true', OPENAI_API_KEY: 'parent-secret' } });
    assert.equal(await provider.converse({ system: 'Reply with one word.', turns: [{ role: 'user', content: 'OK' }] }), 'OK');
    const call = JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; env: Record<string, string | undefined> };
    assert.ok(call.args.includes('--ignore-user-config'));
    assert.ok(call.args.lastIndexOf('--disable') > call.args.lastIndexOf('--enable'), 'the isolation setting wins over provider extra args');
    assert.deepEqual(call.args.slice(call.args.lastIndexOf('--disable'), call.args.lastIndexOf('--disable') + 2), ['--disable', 'hooks']);
    assert.deepEqual(call.args.slice(call.args.lastIndexOf('-c'), call.args.lastIndexOf('-c') + 2), ['-c', 'project_doc_max_bytes=0']);
    assert.equal(call.args.includes('Reply with one word.'), false, 'prompt stays on stdin');
    assert.equal(call.env.HOME, '/owner/home');
    assert.equal(call.env.CODEX_HOME, '/owner/.codex');
    assert.equal(call.env.marker, '1');
    assert.equal(call.env.hooks, undefined);
    assert.equal(call.env.features, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude arguments remain unchanged and do not receive the background marker', () => {
  assert.deepEqual(cliArguments('claude', { cwd: '/tmp', outputFile: '/tmp/out' }), ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '']);
  const env = cliChildEnvironment('/usr/local/bin/claude', { HOME: '/home/user' }, { kind: 'claude' });
  assert.equal(env.MDB_BACKGROUND_PIPELINE, undefined);
});

test('background model child activity touches are a no-op even when a schedule is enabled', async t => {
  const root = temp(), state = path.join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.mdb/adaptive'), { recursive: true });
  writeFileSync(path.join(root, '.mdb/adaptive/config.json'), JSON.stringify({ enabled: true }));
  const env = { HOME: root, ENGRAM_STATE_DIR: state, MDB_BACKGROUND_PIPELINE: '1' };
  await touchActivity(root, new Date(), env);
  assert.equal(requireActivityFile(state, root), false);
});

test('background model child capture hook entry point returns without consuming or storing a payload', async t => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.MDB_BACKGROUND_PIPELINE;
  process.env.MDB_BACKGROUND_PIPELINE = '1';
  try {
    assert.equal(await execute(['memory', 'capture', '--user', '--host', 'codex', '--root', root]), '');
  } finally {
    if (previous === undefined) delete process.env.MDB_BACKGROUND_PIPELINE;
    else process.env.MDB_BACKGROUND_PIPELINE = previous;
  }
});

function requireActivityFile(state: string, root: string): boolean {
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32);
  try { readFileSync(path.join(state, 'activity', `${hash}.json`)); return true; } catch { return false; }
}
