import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { execute, isReadOnlyCommand } from '../../packages/cli/index.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { touchActivity } from '../../packages/adaptive/index.js';

/** Every read the CLI offers. Rebuildable derived caches under .mdb/indexes/ are the only thing a read may ever create or refresh, and only when the vault is writable. */
const READS = (root: string, id: string): string[][] => [
  ['grep', 'rare-token', '--root', root], ['search', 'alpha beta', '--mode', 'keyword', '--limit', '100', '--root', root], ['search', 'rare-token', '--mode', 'grep', '--limit', '5', '--root', root], ['grep', 'rare-[a-z]+', '--regex', '--root', root],
  ['get', id, '--root', root], ['history', id, '--root', root], ['context', '--task', 'alpha beta', '--scope', 'workspace:w', '--budget-tokens', '500', '--root', root], ['links', id, '--root', root], ['backlinks', id, '--root', root], ['related', id, '--depth', '1', '--root', root],
  ['query', '--json', JSON.stringify({ from: 'documents', search: { mode: 'keyword', text: 'alpha' }, pipe: [{ op: 'select', fields: ['id'] }] }), '--root', root], ['verify', '--root', root], ['doctor', '--root', root], ['capabilities', '--root', root], ['workspace', 'list', '--root', root], ['index', 'status', '--root', root]
];
async function snapshot(root: string, skip: (rel: string) => boolean = () => false): Promise<Map<string, string>> {
  const out = new Map<string, string>(); const walk = async (dir: string): Promise<void> => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, e.name), rel = path.relative(root, full); if (skip(rel)) continue; if (e.isDirectory()) { out.set(`${rel}/`, 'dir'); await walk(full); } else { const st = await fs.stat(full); out.set(rel, `${createHash('sha256').update(await fs.readFile(full)).digest('hex')}:${st.size}:${Math.floor(st.mtimeMs)}`); } } };
  await walk(root); return out;
}
const show = async (args: string[]): Promise<string> => JSON.stringify(await execute(args)) ?? 'null';
const diff = (a: Map<string, string>, b: Map<string, string>): string[] => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
async function populate(t: Parameters<typeof disposableVault>[0], sqlite: boolean) {
  const { root, vault } = await disposableVault(t, { sqlite }); await vault.createWorkspace('w', '', {}); const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push((await vault.put({ scope: { type: 'workspace', workspaceId: 'w' }, kind: 'note', title: `Doc ${i} alpha`, body: `# Doc ${i}\n\nalpha beta gamma ${i % 3 ? 'rare-token' : 'plain'} text`, tags: i % 2 ? ['x'] : [] })).id);
  await new SearchEngine(vault).rebuild(); await execute(['intelligence', 'schedule', 'configure', '--enable', '--root', root]); return { root, id: ids[0]! };
}

test('the classifier of read-only commands matches the commands that must not touch a vault', () => {
  for (const c of ['grep', 'search', 'get', 'context', 'query', 'verify', 'doctor', 'history', 'links', 'backlinks', 'related', 'capabilities']) assert.equal(isReadOnlyCommand(c, undefined), true, c);
  for (const [c, s] of [['put', undefined], ['patch', undefined], ['delete', undefined], ['restore', undefined], ['recover', undefined], ['query', 'save'], ['index', 'rebuild'], ['memory', 'record'], ['workspace', 'create']] as const) assert.equal(isReadOnlyCommand(c, s), false, `${c} ${s ?? ''}`);
});

for (const sqlite of [false, true]) {
  test(`read commands never modify a vault (${sqlite ? 'SQLite' : 'filesystem'} backend) and never write the activity marker, even with an enabled schedule`, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-state-')); process.env.ENGRAM_STATE_DIR = state; t.after(async () => { delete process.env.ENGRAM_STATE_DIR; await fs.rm(state, { recursive: true, force: true }); });
    const { root, id } = await populate(t, sqlite); const before = await snapshot(root);
    const first = []; for (const args of READS(root, id)) first.push(await show(args));
    const changed = diff(before, await snapshot(root)); const outside = changed.filter(p => !p.startsWith('.mdb/indexes') && !p.startsWith('.mdb/locks'));
    assert.deepEqual(outside, [], `a read changed files outside rebuildable index caches: ${outside.join(', ')}`); assert.deepEqual(await fs.readdir(state), [], 'no activity marker for reads');
    const warm = await snapshot(root); for (const args of READS(root, id)) await execute(args); const second = diff(warm, await snapshot(root)).filter(p => !p.startsWith('.mdb/locks') && !/\.sqlite-(shm|wal)$/.test(p)); /* SQLite maintains its own -shm/-wal sidecars next to a WAL-mode index even for readers */ assert.deepEqual(second, [], `with warm caches a second round changes nothing at all: ${second.join(', ')}`);
    await execute(['put', '--scope', 'workspace:w', '--kind', 'note', '--title', 'writer', '--body', 'a mutating command', '--root', root]); assert.ok((await fs.readdir(state)).length > 0, 'a mutating command on an enabled schedule does record activity, outside the vault');
    assert.ok(!(await fs.stat(path.join(root, '.mdb/adaptive/activity.json')).then(() => true, () => false)), 'never inside the vault');
    recordCase({ suite: 'security', name: `read-only-${sqlite ? 'sqlite' : 'files'}`, status: 'PASS', detail: { reads: first.length, cacheFilesTouched: changed.length } });
  });
  test(`reads work on a read-only filesystem copy (${sqlite ? 'SQLite' : 'filesystem'}): derived caches are skipped, results are identical`, async t => {
    const { root, id } = await populate(t, sqlite); const expected: string[] = []; for (const args of READS(root, id)) expected.push(await show(args));
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-ro-')); const target = path.join(copy, 'vault'); await fs.cp(root, target, { recursive: true });
    await fs.rm(path.join(target, '.mdb/indexes'), { recursive: true, force: true }); await fs.rm(path.join(target, '.mdb/locks'), { recursive: true, force: true }); // caches absent: a read must not need to rebuild them on disk
    const lock = async (dir: string, mode: number): Promise<void> => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) await lock(full, mode); else await fs.chmod(full, mode & 0o666); } await fs.chmod(dir, mode); };
    await lock(target, 0o555); t.after(async () => { await lock(target, 0o755).catch(() => undefined); await fs.chmod(target, 0o755).catch(() => undefined); const unlock = async (d: string): Promise<void> => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { await fs.chmod(f, 0o755); await unlock(f); } else await fs.chmod(f, 0o644); } }; await unlock(target).catch(() => undefined); await fs.rm(copy, { recursive: true, force: true }); });
    const before = await snapshot(target); const failures: string[] = []; const got: string[] = [];
    for (const args of READS(target, id)) { try { got.push(await show(args)); } catch (error) { failures.push(`${args[0]} ${args[1] ?? ''}: ${(error as Error).message}`); got.push('ERROR'); } }
    assert.deepEqual(failures, [], 'every read must succeed without write access'); assert.deepEqual(diff(before, await snapshot(target)), [], 'and must not change anything');
    const rooted = (x: string) => x.replace(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<root>').replace(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<root>');
    // Ranking may legitimately differ when an index is absent (BM25 vs lexical fallback), so ranked results are compared as sets of object ids; point reads compare byte for byte.
    const ids = (x: string) => [...new Set(x.match(/obj_[a-z0-9_]+/g) ?? [])].sort();
    READS(root, id).forEach((args, i) => { const name = args[0]!; if (['doctor', 'index', 'verify', 'capabilities', 'workspace'].includes(name)) return; if (['get', 'history'].includes(name)) assert.equal(rooted(got[i]!), rooted(expected[i]!), `read ${i} (${name}) returns the same result`); else assert.deepEqual(ids(got[i]!), ids(expected[i]!), `read ${i} (${name}) returns the same objects`); });
    recordCase({ suite: 'security', name: `read-only-filesystem-${sqlite ? 'sqlite' : 'files'}`, status: 'PASS' });
  });
}

test('touchActivity keeps its SDK contract (marker outside the vault, only for enabled schedules) and is a no-op otherwise', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-state-')); process.env.ENGRAM_STATE_DIR = state; t.after(async () => { delete process.env.ENGRAM_STATE_DIR; await fs.rm(state, { recursive: true, force: true }); });
  const { root } = await disposableVault(t); await touchActivity(root); assert.deepEqual(await fs.readdir(state), [], 'no schedule: nothing is written anywhere');
  await execute(['intelligence', 'schedule', 'configure', '--enable', '--root', root]); const before = await snapshot(root); await touchActivity(root); assert.equal((await fs.readdir(path.join(state, 'activity'))).length, 1); assert.deepEqual(diff(before, await snapshot(root)), [], 'the vault itself is untouched');
  recordCase({ suite: 'security', name: 'activity-marker-outside-vault', status: 'PASS' });
});
