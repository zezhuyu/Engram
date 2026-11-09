import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manageInstructions, renderUserInstructionBlock, USER_BLOCK_VERSION } from '../../packages/memory/global-instructions.js';

test('global blocks preserve user bytes, mode and line endings, back up once, and are idempotent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-instructions-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claude = path.join(dir, 'CLAUDE.md'), codex = path.join(dir, 'AGENTS.md');
  await fs.writeFile(claude, '# My rules\r\nkeep exactly\r\n', { mode: 0o640 });
  const paths = { 'claude-code': claude, codex };
  await manageInstructions('install', 'both', { paths });
  const installed = await fs.readFile(claude, 'utf8'); assert.ok(installed.startsWith('# My rules\r\nkeep exactly\r\n\r\n')); assert.match(installed, /<!-- engram:user:start -->\r\n/);
  assert.equal((await fs.stat(claude)).mode & 0o777, 0o640); assert.equal((await fs.stat(codex)).mode & 0o777, 0o644);
  const before = await fs.stat(claude); await manageInstructions('install', 'both', { paths }); assert.equal((await fs.stat(claude)).mtimeMs, before.mtimeMs);
  assert.equal((await fs.readdir(dir)).filter(name => name.includes('.engram-backup-')).length, 1);
  assert.deepEqual((await manageInstructions('status', 'both', { paths }))['codex'], { file: codex, status: 'installed', version: USER_BLOCK_VERSION });
  await manageInstructions('remove', 'both', { paths }); assert.match(await fs.readFile(claude, 'utf8'), /^# My rules\r\nkeep exactly\r\n/);
});

test('instruction dry-run, malformed markers, host overrides and secret bounds', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-instructions-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'AGENTS.md'); await fs.writeFile(file, 'prefix\n');
  assert.equal((await manageInstructions('install', 'codex', { paths: { codex: file }, dryRun: true }).then(v => (v.codex as { changed: boolean }).changed)), true); assert.equal(await fs.readFile(file, 'utf8'), 'prefix\n');
  await fs.writeFile(file, '<!-- engram:user:end -->\n'); const before = await fs.readFile(file, 'utf8');
  await assert.rejects(manageInstructions('install', 'codex', { paths: { codex: file } }), /malformed.*nothing was changed/); assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, '<!-- engram:user:start -->\na\n<!-- engram:user:end -->\n<!-- engram:user:start -->\nb\n<!-- engram:user:end -->\n'); const duplicate = await fs.readFile(file, 'utf8');
  await assert.rejects(manageInstructions('remove', 'codex', { paths: { codex: file } }), /malformed.*nothing was changed/); assert.equal(await fs.readFile(file, 'utf8'), duplicate);
  const claude = path.join(dir, 'claude-home'), codex = path.join(dir, 'codex-home');
  await manageInstructions('install', 'both', { env: { HOME: dir, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } });
  assert.ok(await fs.readFile(path.join(claude, 'CLAUDE.md'), 'utf8')); assert.ok(await fs.readFile(path.join(codex, 'AGENTS.md'), 'utf8'));
  const block = renderUserInstructionBlock(); assert.ok(block.length < 2400); assert.doesNotMatch(block, /https?:\/\/|Bearer [A-Za-z0-9_-]{12,}|token=|api[_-]?key/i);
});

test('stale instruction versions are reported and refresh updates only the managed block', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-instructions-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'CLAUDE.md'); await fs.writeFile(file, `keep\n\n<!-- engram:user:start -->\n<!-- ENGRAM managed-version=${USER_BLOCK_VERSION - 1} -->\nold\n<!-- engram:user:end -->\n`);
  assert.equal(((await manageInstructions('status', 'claude-code', { paths: { 'claude-code': file } }))['claude-code'] as { status: string }).status, 'stale');
  await manageInstructions('refresh', 'claude-code', { paths: { 'claude-code': file } });
  const after = await fs.readFile(file, 'utf8'); assert.ok(after.startsWith('keep\n\n')); assert.match(after, new RegExp(`managed-version=${USER_BLOCK_VERSION}`)); assert.doesNotMatch(after, /\nold\n/);
});

test('Node test runner refuses default instruction writes and removals, while explicit temp paths work', async t => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT');
  await assert.rejects(manageInstructions('install', 'claude-code'), /Refusing to install global Engram instructions.*real default path during a Node test run/);
  await assert.rejects(manageInstructions('remove', 'codex'), /Refusing to remove global Engram instructions.*real default path during a Node test run/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-instructions-safe-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claude = path.join(dir, 'CLAUDE.md'), codex = path.join(dir, 'AGENTS.md');
  await manageInstructions('install', 'both', { paths: { 'claude-code': claude, codex } });
  assert.match(await fs.readFile(claude, 'utf8'), /engram:user:start/);
  assert.match(await fs.readFile(codex, 'utf8'), /engram:user:start/);
  await manageInstructions('remove', 'both', { paths: { 'claude-code': claude, codex } });
});
