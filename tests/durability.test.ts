import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Vault } from '../packages/core/vault.js';
import { SearchEngine } from '../packages/search-files/index.js';
import type { ObjectStore } from '../packages/core/types.js';

function child(code: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', b => { stdout += b; }); process.stderr.on('data', b => { stderr += b; });
    process.on('error', reject); process.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('actual process death recovers committed journal and removes dead writer lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-process-crash-'));
  try {
    const vault = new Vault(root); await vault.init();
    const uri = new URL('../packages/core/vault.js', import.meta.url).href;
    const result = await child(`import {Vault} from ${JSON.stringify(uri)}; const v=new Vault(${JSON.stringify(root)},undefined,{fault(stage){if(stage==='after_journal')process.exit(77)}});await v.put({scope:{type:'global',area:'wiki'},kind:'note',title:'Committed before abrupt death',body:'Durable data'});`);
    assert.equal(result.code, 77, result.stderr);
    const recovered = await vault.recover(); assert.equal(recovered.committed, 1); assert.equal(recovered.repaired, 1);
    assert.equal((await vault.listDocuments())[0]!.body, 'Durable data'); assert.equal((await vault.verify()).ok, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('independent processes serialize writes and optimistic conflict does not erase inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-process-race-'));
  try {
    const vault = new Vault(root); await vault.init(); const doc = await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'Race', body: 'base' });
    const uri = new URL('../packages/core/vault.js', import.meta.url).href;
    const run = (body: string) => child(`import {Vault} from ${JSON.stringify(uri)};try{const d=await new Vault(${JSON.stringify(root)}).patch({objectId:${JSON.stringify(doc.id)},expectedRevisionId:${JSON.stringify(doc.revisionId)},body:${JSON.stringify(body)}});console.log(d.body)}catch(e){console.log(e.code);process.exitCode=2}`);
    const results = await Promise.all([run('first authored input'), run('second authored input')]);
    assert.deepEqual(results.map(r => r.code).sort(), [0, 2]); assert.ok(results.some(r => r.stdout.includes('CONFLICT'))); assert.equal((await vault.history(doc.id)).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('filesystem retrieval survives index removal and does not require rg or sqlite', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-pure-files-'));
  try {
    const vault = new Vault(root); await vault.init({ sqlite: false });
    const scope = { type: 'global' as const, area: 'wiki' as const };
    const doc = await vault.put({ scope, kind: 'note', title: 'Unicode', body: '# Topic\n\n知识庫 café retrieval', tags: ['research'] });
    await fs.rm(path.join(root, '.mdb/indexes'), { recursive: true, force: true });
    const search = new SearchEngine(vault); assert.equal((await search.query({ query: '知识庫', mode: 'grep' })).hits[0]!.objectId, doc.id);
    await search.rebuild(); assert.equal((await search.query({ query: 'café', tags: ['research'] })).hits.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('future object-store contract supports immutable writes and CAS without rename', async () => {
  const data = new Map<string, Uint8Array>();
  const remote: ObjectStore = {
    async read(key) { const bytes = data.get(key); if (!bytes) throw new Error('missing'); return bytes; },
    async stat(key) { return data.has(key) ? { size: data.get(key)!.length } : null; },
    async *list(prefix) { for (const [key, value] of data) if (key.startsWith(prefix)) yield { key, size: value.length }; },
    async putImmutable(key, bytes) { if (data.has(key) && !Buffer.from(data.get(key)!).equals(Buffer.from(bytes))) throw new Error('immutable'); data.set(key, bytes.slice()); },
    async compareAndSwapPointer(key, expected, value) { if ((data.has(key) ? Buffer.from(data.get(key)!).toString() : null) !== expected) return false; data.set(key, Buffer.from(value)); return true; },
    async removeForAuthorizedPurge(key) { data.delete(key); }
  };
  await remote.putImmutable('revs/one.md', Buffer.from('# One'));
  await assert.rejects(remote.putImmutable('revs/one.md', Buffer.from('# Changed')));
  assert.equal(await remote.compareAndSwapPointer('heads/one', null, 'revs/one.md'), true);
  assert.equal(await remote.compareAndSwapPointer('heads/one', null, 'bad'), false);
  assert.equal(Buffer.from(await remote.read('revs/one.md')).toString(), '# One');
});
