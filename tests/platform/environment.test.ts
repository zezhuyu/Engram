import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDisposable } from '../helpers/disposable-vault.js';
import { verifyInvariants } from '../helpers/invariants.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';

const wiki = { type: 'global' as const, area: 'wiki' as const };
async function vaultAt(t: { after(fn: () => void | Promise<void>): void }, ...segments: string[]) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-plat-')); const root = path.join(base, ...segments);
  t.after(async () => { assertDisposable(base); await fs.chmod(root, 0o700).catch(() => undefined); await fs.rm(base, { recursive: true, force: true }); });
  const vault = new Vault(root); await vault.init(); return { base, root, vault };
}

test('vault under a path with spaces, Unicode, emoji and punctuation works end to end (write, search, backup, restore)', async t => {
  const { root, vault } = await vaultAt(t, 'my vault ünïcödé 知识库 🚀 (test) & more');
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'Path test', body: 'unique-path-token' });
  assert.equal((await new SearchEngine(vault).query({ query: 'unique-path-token', mode: 'grep' })).hits[0]!.objectId, doc.id);
  const dest = path.join(path.dirname(root), 'backup 🚀'); t.after(() => fs.rm(dest, { recursive: true, force: true }));
  await vault.backup(dest); const restored = await Vault.restoreBackup(dest, path.join(path.dirname(root), 'restored 知识'));
  assert.equal((await restored.get(doc.id)).body, 'unique-path-token'); assert.deepEqual((await verifyInvariants(restored)).issues, []);
  recordCase({ suite: 'platform', name: 'unicode-and-space-paths', status: 'PASS' });
});

test('maximum-length identifiers produce valid long paths', async t => {
  const { vault } = await vaultAt(t, 'v');
  const ws = 'w'.repeat(128), col = 'c'.repeat(128);
  await vault.createWorkspace(ws, ''); await vault.createCollection(ws, col, '');
  const doc = await vault.put({ scope: { type: 'workspace', workspaceId: ws, collectionId: col }, kind: 'note', title: 'long', body: 'long path body' });
  assert.equal((await vault.get(doc.id)).body, 'long path body'); assert.deepEqual((await verifyInvariants(vault)).issues, []);
  await assert.rejects(vault.createWorkspace('x'.repeat(129), ''), { code: 'INVALID_INPUT' });
  recordCase({ suite: 'platform', name: 'long-identifiers', status: 'PASS', detail: { pathLength: doc.path.length } });
});

test('mixed-case identifiers that would collide on case-insensitive filesystems are rejected', async t => {
  const { vault } = await vaultAt(t, 'v');
  await vault.createWorkspace('Case', ''); await assert.rejects(vault.createWorkspace('case', ''), { code: 'INVALID_INPUT' }); await assert.rejects(vault.createWorkspace('CASE', ''), { code: 'INVALID_INPUT' });
  await vault.createCollection('Case', 'Col', ''); await assert.rejects(vault.createCollection('Case', 'col', ''), { code: 'INVALID_INPUT' });
  recordCase({ suite: 'platform', name: 'case-collisions', status: 'PASS' });
});

test('invalid UTF-8, NUL and control bytes: originals keep exact bytes; text paths never crash the parser', async t => {
  const { root, vault } = await vaultAt(t, 'v');
  const bytes = Buffer.concat([Buffer.from('# bad\n'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x1b]), Buffer.from('\nend\n')]);
  const file = path.join(root, '..', 'bad.md'); await fs.writeFile(file, bytes);
  const source = await vault.ingest(file, wiki);
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, String(source.metadata.originalPath)))).digest('hex'), createHash('sha256').update(bytes).digest('hex'), 'original bytes identical');
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  const weird = await vault.put({ scope: wiki, kind: 'note', title: 'ctl \u0007  ', body: 'a\u0000b\r\nc‮d 🚀' });
  assert.equal((await vault.get(weird.id)).body, 'a\u0000b\r\nc‮d 🚀'); assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'platform', name: 'invalid-bytes', status: 'PASS' });
});

test('read-only vault: writes fail cleanly with no committed state, reads keep working', { skip: process.getuid?.() === 0 ? 'root ignores permission bits' : false }, async t => {
  const { root, vault } = await vaultAt(t, 'v');
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'ro', body: 'readable' }); const before = (await vault.events()).length;
  const lock = path.join(root, '.mdb/locks'); await fs.chmod(lock, 0o500);
  await assert.rejects(vault.put({ scope: wiki, kind: 'note', title: 'denied', body: 'x' }), (e: NodeJS.ErrnoException) => ['EACCES', 'EPERM', 'EROFS'].includes(e.code ?? ''));
  await fs.chmod(lock, 0o700);
  assert.equal((await vault.get(doc.id)).body, 'readable'); assert.equal((await vault.events()).length, before);
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'platform', name: 'read-only-locks-dir', status: 'PASS' });
});

test('permission denied on the current-view directory after the commit point: commit stays durable and recover() repairs the view', { skip: process.getuid?.() === 0 ? 'root ignores permission bits' : false }, async t => {
  const { root, vault } = await vaultAt(t, 'v');
  const first = await vault.put({ scope: wiki, kind: 'note', title: 'view', body: 'v1' });
  const viewDir = path.join(root, path.dirname(first.path)); await fs.chmod(viewDir, 0o500);
  const denied = await vault.patch({ objectId: first.id, expectedRevisionId: first.revisionId, body: 'v2' }).catch(e => e as NodeJS.ErrnoException);
  await fs.chmod(viewDir, 0o700);
  assert.ok(denied instanceof Error && ['EACCES', 'EPERM'].includes((denied as NodeJS.ErrnoException).code ?? ''), 'caller is told the operation failed');
  assert.equal((await new Vault(root).get(first.id)).body, 'v2', 'but the commit is durable and readable');
  const repaired = await vault.recover(); assert.equal(repaired.repaired, 1);
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'platform', name: 'permission-denied-view-dir', status: 'PASS' });
});
