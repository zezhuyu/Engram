import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault, sleep } from '../helpers/disposable-vault.js';
import { faultPreamble, runChild } from '../helpers/child.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';

const wiki = { type: 'global' as const, area: 'wiki' as const };
const put = (v: Vault, title: string, body: string) => v.put({ scope: wiki, kind: 'note', title, body });
const read = (root: string, key: string) => fs.readFile(path.join(root, key), 'utf8');
const quarantined = async (root: string) => (await fs.readdir(path.join(root, '.mdb/quarantine')).catch(() => [])).length;
const revisionText = (root: string, d: { id: string; revisionId: string }) => read(root, `.mdb/objects/${d.id}/revs/${d.revisionId}.md`);
const headKey = (d: { id: string }) => `.mdb/heads/${d.id}.json`;

test('an acknowledged commit is immediately visible to logical readers even if both projections are lost', async t => {
  const { root, vault } = await disposableVault(t); const d = await put(vault, 'visible', 'findable-immediately body');
  await fs.rm(path.join(root, d.path)); await fs.rm(path.join(root, headKey(d)));
  const reader = new Vault(root); assert.equal((await reader.get(d.id)).body, 'findable-immediately body'); assert.equal((await reader.verify()).ok, true);
  assert.deepEqual((await new SearchEngine(reader).query({ query: 'findable-immediately', mode: 'grep' })).hits.map(h => h.objectId), [d.id]);
  recordCase({ suite: 'acid', name: 'projection-read-your-write', status: 'PASS' });
});

test('stale, empty, torn and missing projections left by a power loss are repaired by the next owner commit, without quarantining anything', async t => {
  const { root, vault } = await disposableVault(t);
  const a = await put(vault, 'empty', 'a body that will be zero-length'), b = await put(vault, 'torn', 'a body that will be cut in half '.repeat(20)), c = await put(vault, 'nohead', 'head file will go missing');
  const old = await put(vault, 'stale', 'first revision'); const next = await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, body: 'second revision' });
  await fs.writeFile(path.join(root, a.path), ''); const bytes = await revisionText(root, b); await fs.writeFile(path.join(root, b.path), bytes.slice(0, Math.floor(bytes.length / 2)));
  await fs.rm(path.join(root, headKey(c))); await fs.writeFile(path.join(root, old.path), await revisionText(root, old)); // previous revision bytes: a lost rename
  const restarted = new Vault(root); await put(restarted, 'trigger', 'first owner commit after the crash');
  assert.equal(await read(root, a.path), await revisionText(root, a)); assert.equal(await read(root, b.path), bytes); assert.equal(await read(root, old.path), await revisionText(root, next));
  assert.equal(JSON.parse(await read(root, headKey(c))).revisionId, c.revisionId); assert.equal(await quarantined(root), 0, 'crash artifacts are never treated as external edits');
  recordCase({ suite: 'acid', name: 'projection-tail-repair', status: 'PASS' });
});

test('a deliberate external edit is never overwritten by automatic tail repair, is imported by reconcile(), and recover() quarantines a diverging view', async t => {
  const { root, vault } = await disposableVault(t); const d = await put(vault, 'edited', 'original body'); const text = await read(root, d.path);
  await fs.writeFile(path.join(root, d.path), text.replace('original body', 'edited by a person'));
  await put(new Vault(root), 'another commit', 'tail repair runs here'); assert.match(await read(root, d.path), /edited by a person/, 'tail repair left the edit alone');
  const imported = await new Vault(root).reconcile(); assert.equal(imported.imported, 1); assert.equal((await new Vault(root).get(d.id)).body.trim(), 'edited by a person');
  const e = await put(vault, 'second', 'body two'); await fs.writeFile(path.join(root, e.path), 'completely different content'); const rec = await new Vault(root).recover(); assert.equal(rec.repaired >= 1, true);
  assert.equal(await read(root, e.path), await revisionText(root, e)); assert.equal(await quarantined(root), 1, 'recover() preserves the diverging file in quarantine');
  recordCase({ suite: 'acid', name: 'projection-external-edit-preserved', status: 'PASS' });
});

test('flushProjections makes pending head and view writes durable; a flush failure never undoes or fails an acknowledged commit and is retried', async t => {
  const { root } = await disposableVault(t); let failing = true;
  const vault = new Vault(root, undefined, { fault: stage => { if (failing && stage === 'projection.flush.file') { const e = new Error('injected EIO') as NodeJS.ErrnoException; e.code = 'EIO'; throw e; } } });
  const d = await put(vault, 'flush', 'flush me'); assert.equal((await vault.events()).length, 1, 'acknowledged before any flush');
  await assert.rejects(() => vault.flushProjections(), { code: 'EIO' }); assert.equal((await new Vault(root).get(d.id)).body, 'flush me');
  failing = false; const done = await vault.flushProjections(); assert.equal(done.files, 2, 'the retained pending keys are flushed on the next attempt'); assert.equal((await vault.flushProjections()).files, 0, 'nothing left pending');
  recordCase({ suite: 'acid', name: 'projection-flush-failure', status: 'PASS' });
});

test('the background timer flushes pending projections by itself', async t => {
  const { vault } = await disposableVault(t); await put(vault, 'timer', 'flushed by the timer'); const pending = () => (vault as unknown as { pendingProjections: Map<string, number> }).pendingProjections.size;
  assert.ok(pending() >= 2); for (let i = 0; i < 40 && pending(); i++) await sleep(50); assert.equal(pending(), 0);
  recordCase({ suite: 'acid', name: 'projection-timer-flush', status: 'PASS' });
});

test('SIGKILL right after the journal fsync leaves no projections; restart sees the commit and repairs on its own, and recover() is idempotent', async t => {
  const { root, vault } = await disposableVault(t); const base = await put(vault, 'base', 'acknowledged baseline');
  const child = await runChild(`${faultPreamble(root, { stage: 'journal.after_fsync', mode: 'kill' })}\nawait vault.put({scope:{type:'global',area:'wiki'},kind:'note',title:'in-flight',body:'durable but unacknowledged'});`); assert.equal(child.signal, 'SIGKILL');
  const restarted = new Vault(root); const docs = await restarted.listDocuments(); assert.ok(docs.some(d => d.title === 'in-flight'), 'the durable commit is visible to logical readers before any repair');
  await put(restarted, 'next', 'first owner commit'); const inflight = docs.find(d => d.title === 'in-flight')!; assert.equal(await read(root, inflight.path), await revisionText(root, inflight), 'tail repair created the missing view');
  const r1 = await restarted.recover(), r2 = await restarted.recover(); assert.equal(r2.repaired, 0); assert.ok(r1.committed === r2.committed); assert.equal((await restarted.verify()).ok, true); void base;
  recordCase({ suite: 'acid', name: 'projection-kill-after-journal', status: 'PASS' });
});

test('healthy recovery verifies durable heads without rewriting and fsyncing each head', async t => {
  const { root, vault } = await disposableVault(t);
  await put(vault, 'stable', 'already committed and projected');
  await vault.flushProjections();
  let headWrites = 0;
  const recovering = new Vault(root, undefined, { fault: stage => { if (stage === 'recover.before_head_write') headWrites++; } });
  const result = await recovering.recover();
  assert.equal(result.repaired, 0);
  assert.equal(headWrites, 0, 'a healthy projection is verified, not needlessly rewritten');
  recordCase({ suite: 'acid', name: 'recovery-avoids-unnecessary-head-fsync', status: 'PASS' });
});

test('purging an object with pending projections never makes a later flush fail; a non-owner commit does not repair other people\'s projections', async t => {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('w', '', { agent: ['read', 'write'] });
  const d = await vault.put({ scope: { type: 'workspace', workspaceId: 'w' }, kind: 'note', title: 'purge me', body: 'pending then purged' }); const events = await vault.events(); void events;
  await fs.rm(path.join(root, d.path)); await fs.rm(path.join(root, headKey(d))); await vault.flushProjections(); // missing files are skipped
  const agent = new Vault(root, { actorId: 'agent', permissions: ['workspace:w:read', 'workspace:w:write'] });
  const e = await vault.put({ scope: { type: 'workspace', workspaceId: 'w' }, kind: 'note', title: 'torn', body: 'cut short '.repeat(30) }); const full = await revisionText(root, e); await fs.writeFile(path.join(root, e.path), full.slice(0, 20));
  await agent.put({ scope: { type: 'workspace', workspaceId: 'w' }, kind: 'note', title: 'by agent', body: 'agent commit' }); assert.equal((await read(root, e.path)).length, 20, 'non-owner commits leave repair to the owner');
  await vault.recover(); assert.equal(await read(root, e.path), full);
  recordCase({ suite: 'acid', name: 'projection-purge-and-non-owner', status: 'PASS' });
});
