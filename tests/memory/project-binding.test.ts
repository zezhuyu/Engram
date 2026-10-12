import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MDBError } from '../../packages/core/types.js';
import { BINDING_FILE, defaultBinding, ensureGitignore, findBinding, parseBinding, readBinding, writeBinding } from '../../packages/core/project-binding.js';
import { recordCase } from '../helpers/report.js';

async function temp(t: { after(fn: () => void | Promise<void>): void }): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'engram-binding-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const rejects = (value: unknown) => assert.throws(() => parseBinding(value), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT', JSON.stringify(value).slice(0, 120));

test('a binding round-trips, is written atomically with owner-only permissions, and holds no secrets', async t => {
  const dir = await temp(t);
  const binding = defaultBinding({ workspaceId: 'engram-project', serverUrl: 'https://engram.example.com/mcp', hosts: ['claude-code', 'codex'], credentialRef: 'ENGRAM_MCP_TOKEN', captureConsent: true });
  await writeBinding(dir, binding);
  const file = path.join(dir, BINDING_FILE); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(await readBinding(dir), binding);
  const raw = await readFile(file, 'utf8'); assert.doesNotMatch(raw, /token":|Bearer|secret/i); assert.match(raw, /"credentialRef": "ENGRAM_MCP_TOKEN"/);
  await Promise.all(Array.from({ length: 8 }, (_, i) => writeBinding(dir, { ...binding, profileMaxTokens: 500 + i })));
  assert.ok((await readBinding(dir)).profileMaxTokens >= 500, 'concurrent writers leave one valid file');
  recordCase({ suite: 'memory', name: 'project-binding-roundtrip', status: 'PASS' });
});

test('the schema is strict: unknown keys, secrets, bad names, credentials in URLs and unsafe paths are refused', async () => {
  const ok = defaultBinding({ workspaceId: 'proj' });
  assert.doesNotThrow(() => parseBinding(ok));
  rejects({ ...ok, extra: 1 }); rejects({ ...ok, schemaVersion: 2 }); rejects({ ...ok, workspaceId: '../x' }); rejects({ ...ok, workspaceId: '' });
  rejects({ ...ok, credentialRef: 'sk-abcdefghijklmnop' }); rejects({ ...ok, credentialRef: 'lower_case' }); rejects({ ...ok, token: 'abc' });
  rejects({ ...ok, serverUrl: 'https://user:pass@engram.example.com/mcp' }); rejects({ ...ok, serverUrl: 'ftp://engram.example.com' }); rejects({ ...ok, serverUrl: 'https://e.example.com/mcp#frag' });
  rejects({ ...ok, hosts: ['vim'] }); rejects({ ...ok, notesInclude: ['/etc/*.md'] }); rejects({ ...ok, notesInclude: ['../outside/*.md'] }); rejects({ ...ok, notesInclude: ['notes/**/*.txt'] });
  rejects({ ...ok, profileMaxTokens: 50 }); rejects({ ...ok, profileMaxTokens: 100000 }); rejects({ ...ok, sessionContextMaxTokens: 0 }); rejects({ ...ok, fileSyncConsent: 'yes' });
  rejects({ ...ok, projectRoot: '/abs/path' }); rejects(null); rejects([]); rejects({ ...ok, notesInclude: ['notes/api_key=sk-abcdefghijklmnop.md'] });
});

test('fileSyncConsent is never implied by captureConsent and the default include list is narrow', () => {
  const b = defaultBinding({ workspaceId: 'proj', captureConsent: true });
  assert.equal(b.captureConsent, true); assert.equal(b.fileSyncConsent, false);
  assert.deepEqual(b.notesInclude, ['notes/**/*.md', '.engram/notes/**/*.md']);
  for (const excluded of ['**/.env*', '**/.git/**', '**/node_modules/**']) assert.ok(b.notesExclude.includes(excluded), excluded);
  assert.ok(!b.notesInclude.some(p => /README|AGENTS|CLAUDE/.test(p) || /^(\*\*\/)?\*\.md$/.test(p)));
});

test('the binding is found from a subdirectory, a symlinked or malformed file is refused', async t => {
  const dir = await temp(t); await writeBinding(dir, defaultBinding({ workspaceId: 'proj' }));
  const sub = path.join(dir, 'a', 'b'); await mkdir(sub, { recursive: true });
  const found = await findBinding(sub); assert.equal(found?.root, await (await import('node:fs/promises')).realpath(dir)); assert.equal(found?.binding.workspaceId, 'proj');
  assert.equal(await findBinding(await temp(t)), undefined, 'no binding means local mode, not an error');
  const outside = await temp(t); await writeFile(path.join(outside, 'x.json'), JSON.stringify(defaultBinding({ workspaceId: 'evil' })));
  const linked = await temp(t); await mkdir(path.join(linked, '.engram')); await symlink(path.join(outside, 'x.json'), path.join(linked, BINDING_FILE));
  await assert.rejects(readBinding(linked), (e: unknown) => e instanceof MDBError && /symlink/i.test(e.message));
  const broken = await temp(t); await mkdir(path.join(broken, '.engram')); await writeFile(path.join(broken, BINDING_FILE), '{not json');
  await assert.rejects(readBinding(broken), (e: unknown) => e instanceof MDBError && e.code === 'INVALID_INPUT');
});

test('.gitignore handling is idempotent, keeps other lines and CRLF endings, and never removes anything', async t => {
  const dir = await temp(t); const file = path.join(dir, '.gitignore');
  assert.equal(await ensureGitignore(dir), true); assert.equal(await readFile(file, 'utf8'), '.engram/\n');
  assert.equal(await ensureGitignore(dir), false, 'second run changes nothing'); assert.equal((await readFile(file, 'utf8')).match(/\.engram\//g)!.length, 1);
  await writeFile(file, 'node_modules/\r\ndist/\r\n'); assert.equal(await ensureGitignore(dir), true);
  assert.equal(await readFile(file, 'utf8'), 'node_modules/\r\ndist/\r\n.engram/\r\n');
  await writeFile(file, 'build\n.engram\n'); assert.equal(await ensureGitignore(dir), false, 'an existing .engram entry without slash counts');
});

test('CLI switches added for project setup never capture a flag that other commands use with a value', async () => {
  const { execute } = await import('../../packages/cli/index.js');
  const { Engram } = await import('../../packages/sdk/index.js');
  const base = await mkdtemp(path.join(tmpdir(), 'engram-switches-')); const root = path.join(base, 'vault');
  try {
    await new Engram(root).init({ sqlite: false });
    await execute(['profile', 'correct', '--key', 'editor', '--claim', 'The user uses Neovim.', '--category', 'preference', '--root', root]);
    await execute(['profile', 'correct', '--key', 'editor', '--claim', 'The user switched to Helix.', '--category', 'preference', '--reason', 'changed', '--root', root]);
    const superseded = await execute(['insight', 'search', '--status', 'superseded', '--root', root]) as { insights: unknown[] };
    assert.equal(superseded.insights.length, 1, '--status still takes a value on insight search');
  } finally { await rm(base, { recursive: true, force: true }); }
});
