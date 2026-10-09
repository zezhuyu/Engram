import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { faultPreamble, modules, runChild } from '../helpers/child.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { QueryApi } from '../../packages/query/index.js';
import type { Scope } from '../../packages/core/types.js';

const app: Scope = { type: 'workspace', workspaceId: 'app' };
const STAGES = ['journal.before_append', 'revision.after_dirsync', 'journal.after_append_before_fsync', 'journal.after_fsync', 'head.before_replace', 'view.before_replace'];
const rec = (name: string) => recordCase({ suite: 'query-recovery', name, status: 'PASS' });
const queryAll = async (vault: Vault) => (await new QueryApi(vault).run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'select', fields: ['documentId', 'text'] }] }, { maxRows: 100_000 })).rows as Array<{ documentId: string; text: string }>;

for (const stage of STAGES) {
  test(`kill at ${stage}: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree`, async t => {
    const { root, vault } = await disposableVault(t); await vault.createWorkspace('app', '', {});
    const acked: string[] = [];
    for (let i = 0; i < 3; i++) acked.push((await vault.put({ scope: app, kind: 'note', title: `base ${i}`, body: `base-${i} acknowledged` })).id);
    const child = await runChild(`${faultPreamble(root, { stage, mode: 'kill', after: 'commit.before_revision' })}
for (let i=0;i<5;i++){ const d=await vault.put({scope:{type:'workspace',workspaceId:'app'},kind:'note',title:'child '+i,body:'child-'+i+' maybe'}); console.log('ACK '+d.id); }`);
    assert.equal(child.signal, 'SIGKILL', `the fault at ${stage} fired`);
    for (const line of child.stdout.split('\n')) if (line.startsWith('ACK ')) acked.push(line.slice(4));
    const before = await new QueryApi(new Vault(root)).run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] }).then(r => r.rows, () => 'unavailable');
    await new Vault(root).recover();
    const after = new Vault(root); const api = new QueryApi(after);
    const ids = new Set(((await api.run({ version: 1, from: 'documents', pipe: [{ op: 'select', fields: ['id'] }] })).rows as Array<{ id: string }>).map(r => r.id));
    for (const id of acked) assert.ok(ids.has(id), `acknowledged commit ${id} is missing after recovery`);
    const lines = await queryAll(after); const byDoc = new Map<string, number>(); for (const l of lines) byDoc.set(l.documentId, (byDoc.get(l.documentId) ?? 0) + 1);
    assert.ok([...ids].every(id => byDoc.get(id) === 1), 'every visible document has a complete body (no partial revisions)');
    const search = await api.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'acknowledged' } }); assert.equal(search.rows.length, 3);
    assert.equal((await after.verify()).ok, true); void before;
    recordCase({ suite: 'query-recovery', name: `kill-${stage}`, status: 'PASS' });
  });
}
test('killing a process mid-query leaves the vault untouched and the next query correct', async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('app', '', {});
  for (let i = 0; i < 40; i++) await vault.put({ scope: app, kind: 'note', title: `d${i}`, body: `line ${i}\nsecond ${i}` });
  const journal = await fs.readFile(path.join(root, '.mdb/events/commits.jsonl'), 'utf8');
  const child = await runChild(`import {Vault} from ${JSON.stringify(modules.vault)};import {QueryApi} from ${JSON.stringify(new URL('../../packages/query/index.js', import.meta.url).href)};
const v=new Vault(${JSON.stringify(root)});const q=new QueryApi(v);setTimeout(()=>process.kill(process.pid,'SIGKILL'),60);
for(;;){ await q.run({version:1,from:'documents',pipe:[{op:'cat'},{op:'sort',fields:[{field:'text'}]}]}); }`);
  assert.equal(child.signal, 'SIGKILL');
  assert.equal(await fs.readFile(path.join(root, '.mdb/events/commits.jsonl'), 'utf8'), journal, 'queries write nothing');
  assert.equal((await queryAll(new Vault(root))).length, 80); assert.equal((await new Vault(root).verify()).ok, true);
  rec('kill-mid-query');
});
test('derived state damage: deleted, truncated or foreign manifest and SQLite files give correct answers, never silently incomplete ones', async t => {
  const { root, vault } = await disposableVault(t, { sqlite: true }); await vault.createWorkspace('app', '', {});
  for (let i = 0; i < 30; i++) await vault.put({ scope: app, kind: 'note', title: `d${i}`, body: `needle-${i % 3} haystack ${i}` });
  const expected = async () => ((await new QueryApi(new Vault(root)).run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'needle-1' }, orderBy: [{ field: 'title' }], pipe: [{ op: 'select', fields: ['title'] }] }, { maxRows: 1000 })).rows);
  await new SearchEngine(vault).rebuild(); const good = await expected(); assert.equal(good.length, 10);
  const indexes = path.join(root, '.mdb/indexes');
  for (const damage of ['delete', 'truncate', 'garbage'] as const) {
    for (const f of await fs.readdir(indexes)) { const p = path.join(indexes, f); if (damage === 'delete') await fs.rm(p, { force: true, recursive: true }); else if ((await fs.stat(p).catch(() => undefined))?.isFile()) await fs.writeFile(p, damage === 'truncate' ? (await fs.readFile(p)).subarray(0, 40) : 'not a database or manifest\n{"v":4,"sequence":999999,"count":0}\n'); }
    assert.deepEqual(await expected(), good, `after ${damage}`);
    await new SearchEngine(vault).rebuild();
  }
  const sqliteOff = async () => { const c = await vault.config(); c.sqlite.enabled = false; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(c)); };
  await sqliteOff(); assert.deepEqual(await expected(), good, 'the filesystem path needs no SQLite at all');
  rec('derived-damage');
});
test('writer processes racing with a querying process: no query ever misses an acknowledged commit that preceded it', async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('app', '', {});
  const writers = Array.from({ length: 3 }, (_, w) => runChild(`import {Vault} from ${JSON.stringify(modules.vault)};const v=new Vault(${JSON.stringify(root)});
for(let i=0;i<12;i++){const d=await v.put({scope:{type:'workspace',workspaceId:'app'},kind:'note',title:'w${w}-'+i,body:'racer-token ${w} '+i});console.log('ACK '+d.id);}`));
  const seen = new Set<string>(); const api = new QueryApi(new Vault(root)); let rounds = 0;
  const reader = (async () => { for (let i = 0; i < 12; i++) { const r = await api.run({ version: 1, from: 'documents', search: { mode: 'exact', text: 'racer-token' }, pipe: [{ op: 'select', fields: ['id'] }] }); for (const x of r.rows as Array<{ id: string }>) seen.add(x.id); rounds++; } })();
  const results = await Promise.all(writers); await reader;
  const acked = results.flatMap(r => r.stdout.split('\n').filter(l => l.startsWith('ACK ')).map(l => l.slice(4))); assert.equal(acked.length, 36, results.map(r => r.stderr).join());
  const final = new Set(((await api.run({ version: 1, from: 'documents', search: { mode: 'exact', text: 'racer-token' }, pipe: [{ op: 'select', fields: ['id'] }] })).rows as Array<{ id: string }>).map(r => r.id));
  for (const id of acked) assert.ok(final.has(id), `acknowledged commit ${id} invisible to a query started after the writers finished`);
  for (const id of seen) assert.ok(acked.includes(id), 'a query never returned something that was not acknowledged'); assert.ok(rounds === 12);
  rec('writers-vs-reader');
});
