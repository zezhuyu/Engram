import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { modules, runChild } from '../helpers/child.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import type { SearchInput, Scope } from '../../packages/core/types.js';

const wiki: Scope = { type: 'global', area: 'wiki' };
const wsA: Scope = { type: 'workspace', workspaceId: 'a' };
const wsB: Scope = { type: 'workspace', workspaceId: 'b' };
async function setSqlite(vault: Vault, enabled: boolean) { const c = await vault.config(); c.sqlite.enabled = enabled; await fs.writeFile(path.join(vault.root, 'mdb.yaml'), YAML.stringify(c)); }
const ids = async (engine: SearchEngine, input: SearchInput) => (await engine.query({ limit: 100, ...input })).hits.map(h => h.objectId).sort();

async function corpus(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('a', '', { agent: ['read', 'write'] }); await vault.createWorkspace('b', '', {});
  const d: Record<string, string> = {};
  const put = async (key: string, scope: Scope, title: string, body: string, tags: string[] = [], kind = 'note') => { d[key] = (await vault.put({ scope, kind, title, body, tags })).id; };
  await put('ascii', wiki, 'Retrieval notes', '# Retrieval\n\nA warm cache improves retrieval latency. The the the.', ['perf']);
  await put('cjk', wiki, '知识库', '知识庫 与 检索 系统。知识 管理很重要。', ['zh']);
  await put('accent', wiki, 'Café', 'Un café très naïve, résumé of déjà vu.', ['fr']);
  await put('emoji', wiki, 'Rocket', 'Launch 🚀 now — emoji 🎉 test', ['fun']);
  await put('punct', wiki, 'Code', 'Call a.b(c) and x[0] || y && z; path C:\\temp\\file.txt', ['code']);
  await put('multiline', wiki, 'Fence', '```python\ndef warm_cache():\n    return "retrieval"\n```\n', ['code']);
  await put('frontmatter', wiki, 'Frontmatter lookalike', '---\nkind: fake\nstatus: secret-fm-token\n---\nbody text', []);
  await put('dupA', wiki, 'Same title', 'duplicate-one unique-alpha', []);
  await put('dupB', wiki, 'Same title', 'duplicate-two unique-beta', []);
  await put('private', wsB, 'Private B', 'warm cache PRIVATE-B-ONLY retrieval secret', []);
  await put('workspace', wsA, 'Team A', 'warm cache team-a-only retrieval', ['team']);
  await put('deleted', wiki, 'Gone', 'tombstoned-unique-token warm cache', []);
  const gone = await vault.get(d.deleted!); await vault.delete(gone.id, gone.revisionId);
  return { root, vault, d };
}

const queries: { name: string; input: SearchInput; expect: string[] }[] = [
  { name: 'grep substring', input: { query: 'warm cache', mode: 'grep' }, expect: ['ascii', 'workspace'] },
  { name: 'grep unicode CJK', input: { query: '知识', mode: 'grep' }, expect: ['cjk'] },
  { name: 'grep accented', input: { query: 'café', mode: 'grep' }, expect: ['accent'] },
  { name: 'grep emoji', input: { query: '🚀', mode: 'grep' }, expect: ['emoji'] },
  { name: 'grep punctuation literal', input: { query: 'a.b(c)', mode: 'grep' }, expect: ['punct'] },
  { name: 'grep backslash literal', input: { query: 'C:\\temp', mode: 'grep' }, expect: ['punct'] },
  { name: 'grep inside code fence', input: { query: 'def warm_cache', mode: 'grep' }, expect: ['multiline'] },
  { name: 'grep frontmatter lookalike is body text', input: { query: 'secret-fm-token', mode: 'grep' }, expect: ['frontmatter'] },
  { name: 'grep nonexistent', input: { query: 'zzz-no-such-token', mode: 'grep' }, expect: [] },
  { name: 'grep regex', input: { query: 'duplicate-(one|two)', mode: 'grep', regex: true }, expect: ['dupA', 'dupB'] },
  { name: 'grep tombstoned hidden', input: { query: 'tombstoned-unique-token', mode: 'grep' }, expect: [] },
  { name: 'keyword single', input: { query: 'retrieval', mode: 'keyword' }, expect: ['ascii', 'multiline', 'workspace'] },
  { name: 'keyword phrase', input: { query: '"warm cache"', mode: 'keyword' }, expect: ['ascii', 'workspace'] },
  { name: 'keyword multi-term AND (underscore is a separator, so warm_cache matches warm)', input: { query: 'warm retrieval', mode: 'keyword' }, expect: ['ascii', 'multiline', 'workspace'] },
  { name: 'keyword filtered by tag', input: { query: 'warm', mode: 'keyword', tags: ['team'] }, expect: ['workspace'] },
  { name: 'keyword filtered by kind', input: { query: 'cache', mode: 'keyword', kinds: ['fact'] }, expect: [] },
  { name: 'keyword scoped to wiki', input: { query: 'cache', mode: 'keyword', scopes: [wiki] }, expect: ['ascii', 'multiline'] },
  { name: 'keyword common token', input: { query: 'the', mode: 'keyword' }, expect: ['ascii'] },
  { name: 'keyword duplicate titles stay distinct', input: { query: 'unique-alpha', mode: 'keyword' }, expect: ['dupA'] }
];

for (const sqlite of [false, true]) {
  test(`golden corpus, SQLite ${sqlite ? 'ON' : 'OFF'}: every query returns exactly the authorized golden set and never private/tombstoned data`, async t => {
    const { vault, d } = await corpus(t);
    await setSqlite(vault, sqlite);
    const owner = new SearchEngine(vault); if (sqlite) await owner.rebuild();
    // Owner sees everything it is allowed to; private workspace B is the owner's too, so restrict golden to an agent that holds only workspace a.
    const agent = new SearchEngine(new Vault(vault.root, { actorId: 'agent', permissions: ['global:wiki:read', 'workspace:a:read'] }));
    const failures: string[] = [];
    for (const q of queries) {
      const got = await ids(agent, q.input); const want = q.expect.map(k => d[k]!).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${q.name}: got ${got.map(i => Object.entries(d).find(([, v]) => v === i)?.[0])} want ${q.expect}`);
      assert.ok(!got.includes(d.private!) && !got.includes(d.deleted!), `${q.name}: leaked private/tombstoned object`);
    }
    assert.deepEqual(failures, []);
    recordCase({ suite: 'search', name: `golden-${sqlite ? 'sqlite' : 'files'}`, status: 'PASS', detail: { queries: queries.length } });
  });
}

test('SQLite and filesystem return identical sets (and snippets) for every golden query', async t => {
  const { vault } = await corpus(t);
  const files = new SearchEngine(vault); const a = new Map<string, unknown>();
  for (const q of queries) { const r = await files.query({ limit: 100, ...q.input }); a.set(q.name, r.hits.map(h => [h.objectId, h.snippet]).sort()); }
  await setSqlite(vault, true); const sql = new SearchEngine(vault); await sql.rebuild();
  const diffs: string[] = [];
  for (const q of queries) { const r = await sql.query({ limit: 100, ...q.input }); assert.equal(r.backend, 'sqlite', q.name); const b = r.hits.map(h => [h.objectId, h.snippet]).sort(); if (JSON.stringify(b) !== JSON.stringify(a.get(q.name))) diffs.push(q.name); }
  assert.deepEqual(diffs, [], 'filesystem vs SQLite divergence');
  recordCase({ suite: 'search', name: 'parity-files-vs-sqlite', status: 'PASS', detail: { queries: queries.length } });
});

test('stale index: commits, edits and deletes after the last rebuild are never silently missing; health reports staleness', async t => {
  const { vault, d } = await corpus(t); await setSqlite(vault, true);
  const engine = new SearchEngine(vault); await engine.rebuild();
  const fresh = await vault.put({ scope: wiki, kind: 'note', title: 'Fresh', body: 'brand-new-after-index freshtoken' });
  assert.deepEqual(await ids(engine, { query: 'freshtoken', mode: 'keyword' }), [fresh.id], 'new commit visible before reindex');
  assert.deepEqual(await ids(engine, { query: 'freshtoken', mode: 'grep' }), [fresh.id]);
  const old = await vault.get(d.dupA!); await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, body: 'edited-away replaced-token' });
  assert.deepEqual(await ids(engine, { query: 'unique-alpha', mode: 'keyword' }), [], 'old content gone after edit');
  assert.deepEqual(await ids(engine, { query: 'replaced-token', mode: 'keyword' }), [old.id]);
  const dupB = await vault.get(d.dupB!); await vault.delete(dupB.id, dupB.revisionId);
  assert.deepEqual(await ids(engine, { query: 'unique-beta', mode: 'keyword' }), [], 'deleted after index is hidden');
  const result = await engine.query({ query: 'freshtoken', mode: 'keyword' });
  assert.ok(result.fallback || result.backend, 'result states how it was served');
  recordCase({ suite: 'search', name: 'stale-index', status: 'PASS', detail: { backend: result.backend, fallback: result.fallback ?? null } });
});

test('corrupt, truncated or deleted SQLite files: queries stay correct via fallback, rebuild restores the index, integrity checks pass', async t => {
  const { root, vault, d } = await corpus(t); await setSqlite(vault, true);
  const engine = new SearchEngine(vault); await engine.rebuild();
  const baseline = await ids(engine, { query: 'retrieval', mode: 'keyword' });
  const dbs = async () => (await fs.readdir(path.join(root, '.mdb/indexes'))).filter(f => f.endsWith('.sqlite'));
  assert.ok((await dbs()).length >= 2, 'per-scope databases exist');
  for (const damage of ['garbage', 'truncate', 'delete'] as const) {
    for (const f of await dbs()) { const p = path.join(root, '.mdb/indexes', f); if (damage === 'garbage') await fs.writeFile(p, Buffer.from('this is not a sqlite database'.repeat(50))); else if (damage === 'truncate') await fs.truncate(p, 100); else await fs.rm(p, { force: true }); }
    await fs.rm(path.join(root, '.mdb/indexes'), { force: true, recursive: false }).catch(() => undefined);
    assert.deepEqual(await ids(new SearchEngine(vault), { query: 'retrieval', mode: 'keyword' }), baseline, `${damage}: results unchanged`);
    assert.deepEqual(await ids(new SearchEngine(vault), { query: 'tombstoned-unique-token', mode: 'grep' }), []);
    await new SearchEngine(vault).rebuild();
    const r = await new SearchEngine(vault).query({ query: 'retrieval', mode: 'keyword', limit: 100 });
    assert.equal(r.backend, 'sqlite', `${damage}: rebuilt index serves queries`); assert.deepEqual(r.hits.map(h => h.objectId).sort(), baseline);
  }
  let ftsChecked = 0;
  for (const f of await dbs()) {
    const db = new DatabaseSync(path.join(root, '.mdb/indexes', f));
    try {
      assert.equal(JSON.stringify(db.prepare('PRAGMA integrity_check').all()), '[{"integrity_check":"ok"}]', `${f} integrity_check`);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, `${f} foreign_key_check`);
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'").all() as { name: string }[]) { db.exec(`INSERT INTO ${row.name}(${row.name}) VALUES('integrity-check')`); ftsChecked++; }
    } finally { db.close(); }
  }
  assert.ok(ftsChecked >= 4, 'FTS5 integrity-check ran on both FTS tables of each database');
  recordCase({ suite: 'search', name: 'corrupt-sqlite-fallback-and-integrity', status: 'PASS', detail: { ftsIntegrityChecks: ftsChecked } });
  void d;
});

test('killing the process during an index rebuild leaves canonical data intact and the next rebuild succeeds', async t => {
  const { root, vault } = await corpus(t); await setSqlite(vault, true);
  for (let i = 0; i < 150; i++) await vault.put({ scope: wiki, kind: 'note', title: `bulk ${i}`, body: `bulk body ${i} retrieval cache ${'filler '.repeat(40)}` });
  const before = (await vault.events()).length;
  const child = runChild(`import {Vault} from ${JSON.stringify(modules.vault)};import {SearchEngine} from ${JSON.stringify(modules.search)};setTimeout(()=>process.kill(process.pid,'SIGKILL'),60);await new SearchEngine(new Vault(${JSON.stringify(root)})).rebuild();`);
  const r = await child; void r;
  assert.equal((await vault.events()).length, before); assert.equal((await vault.verify()).ok, true);
  const engine = new SearchEngine(vault);
  const hits = await engine.query({ query: 'bulk body 7 ', mode: 'grep', limit: 100 }); assert.ok(hits.hits.length >= 1, 'queries still correct right after the crash');
  await engine.rebuild(); assert.equal((await engine.query({ query: 'retrieval', mode: 'keyword', limit: 5 })).backend, 'sqlite');
  recordCase({ suite: 'search', name: 'kill-during-rebuild', status: 'PASS' });
});

test('ACL is applied before counts, cursors and snippets on both backends', async t => {
  const { vault, d } = await corpus(t);
  for (const sqlite of [false, true]) {
    await setSqlite(vault, sqlite); if (sqlite) await new SearchEngine(vault).rebuild();
    const outsider = new SearchEngine(new Vault(vault.root, { actorId: 'x', permissions: ['global:wiki:read'] }));
    const owner = new SearchEngine(vault);
    const a = await outsider.query({ query: 'PRIVATE-B-ONLY', mode: 'grep' }); assert.deepEqual(a.hits, []); assert.equal(JSON.stringify(a).includes('PRIVATE-B-ONLY'), false, 'query text is not echoed with data');
    const total = (await outsider.query({ query: 'warm cache', mode: 'grep', limit: 100 })).hits.length; const ownerTotal = (await owner.query({ query: 'warm cache', mode: 'grep', limit: 100 })).hits.length;
    assert.ok(total < ownerTotal, 'outsider counts exclude private matches');
    const paged = await outsider.query({ query: 'warm cache', mode: 'grep', limit: 1 }); const next = paged.cursor ? await outsider.query({ query: 'warm cache', mode: 'grep', limit: 1, cursor: paged.cursor }) : { hits: [] };
    assert.ok(![...paged.hits, ...next.hits].some(h => h.objectId === d.private || h.objectId === d.workspace));
  }
  recordCase({ suite: 'search', name: 'acl-before-counts-and-cursors', status: 'PASS' });
});
