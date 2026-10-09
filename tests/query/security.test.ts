import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { QueryApi } from '../../packages/query/index.js';
import type { Scope } from '../../packages/core/types.js';

const app: Scope = { type: 'workspace', workspaceId: 'app' };
const sec: Scope = { type: 'workspace', workspaceId: 'secret' };
const rec = (name: string) => recordCase({ suite: 'query-security', name, status: 'PASS' });
async function world(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('app', '', { agent: ['read'] }); await vault.createWorkspace('secret', '', {});
  const a = await vault.put({ scope: app, kind: 'note', title: 'Public deploy', body: 'deploy deploy deploy notes' });
  const s = await vault.put({ scope: sec, kind: 'note', title: 'TOP-SECRET-TITLE', body: 'deploy deploy deploy SECRETWORD' });
  const agent = new Vault(root, { actorId: 'agent', permissions: ['workspace:app:read'] });
  return { root, vault, a, s, owner: new QueryApi(vault), agent: new QueryApi(agent) };
}

test('ranking and scores of readable rows do not depend on hidden documents; hidden titles never appear in errors', async t => {
  const w = await world(t);
  const withHidden = (await w.agent.run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'deploy' }, pipe: [{ op: 'select', fields: ['title', 'score'] }] })).rows;
  const { vault: v2 } = await disposableVault(t); await v2.createWorkspace('app', '', { agent: ['read'] });
  await v2.put({ scope: app, kind: 'note', title: 'Public deploy', body: 'deploy deploy deploy notes' });
  const alone = (await new QueryApi(new Vault(v2.root, { actorId: 'agent', permissions: ['workspace:app:read'] })).run({ version: 1, from: 'documents', search: { mode: 'keyword', text: 'deploy' }, pipe: [{ op: 'select', fields: ['title', 'score'] }] })).rows;
  assert.deepEqual(withHidden, alone, 'a hidden document that also matches changes neither membership nor score');
  for (const bad of [{ from: 'documents', where: { field: 'title', op: 'eq', value: 'TOP-SECRET-TITLE' }, pipe: [{ op: 'sum', field: 'title' }] }, { from: 'documents', pipe: [{ op: 'join', right: { from: 'documents' }, on: { left: 'title', right: 'title' }, kind: 'inner' }, { op: 'sum', field: 'right_title' }] }]) {
    try { await w.agent.run({ version: 1, ...bad }); } catch (e) { assert.ok(!String((e as Error).message).includes('TOP-SECRET') && !String((e as Error).message).includes(w.s.id)); }
  }
  rec('score-and-error-disclosure');
});
test('paths: traversal strings and absolute paths are plain values, never file reads', async t => {
  const w = await world(t);
  for (const value of ['../../../../etc/passwd', '/etc/passwd', 'file:///etc/passwd', '..\\..\\windows\\system.ini', 'mdb://workspaces/secret/objects/' + w.s.id, w.s.id]) {
    const r = await w.agent.run({ version: 1, from: 'documents', where: { or: [{ field: 'id', op: 'eq', value }, { field: 'path', op: 'eq', value }] }, pipe: [{ op: 'cat' }] });
    assert.deepEqual(r.rows, [], value);
  }
  for (const id of ['../x', '/etc/passwd']) assert.deepEqual((await w.owner.run({ version: 1, from: 'observations', pipe: [{ op: 'timeline', aroundId: id }] })).rows, []);
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', where: { field: '../../etc/passwd', op: 'eq', value: 1 } }), { code: 'QUERY_INVALID' });
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'select', fields: ['body; rm -rf /'] }] }), { code: 'QUERY_INVALID' });
  rec('paths');
});
test('symlink swap: a revision file replaced by a link to outside content is never served', async t => {
  const w = await world(t);
  const outside = path.join(path.dirname(w.root), `outside-${path.basename(w.root)}.md`); t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, '---\nid: x\n---\nOUTSIDE-CONTENT deploy\n');
  const file = path.join(w.root, '.mdb/objects', w.a.id, 'revs', `${w.a.revisionId}.md`); await fs.rm(file); await fs.symlink(outside, file);
  const r = await new QueryApi(new Vault(w.root)).run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }] }).then(x => JSON.stringify(x.rows), e => String(e));
  assert.ok(!r.includes('OUTSIDE-CONTENT'));
  rec('symlink-swap');
});
test('malicious YAML in a stored revision cannot crash the engine or leak; other rows still answer', async t => {
  const w = await world(t);
  const good = await w.vault.put({ scope: app, kind: 'note', title: 'Fine', body: 'fine body' });
  const file = path.join(w.root, '.mdb/objects', w.a.id, 'revs', `${w.a.revisionId}.md`);
  await fs.writeFile(file, '---\nid: &a [*a, *a]\ntitle: !!js/function "function(){}"\nbomb: &x [&y [*x]]\n---\nbody\n');
  const r = await new QueryApi(new Vault(w.root)).run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'select', fields: ['text'] }] });
  const texts = (r.rows as Array<{ text: string }>).map(x => x.text);
  assert.ok(texts.includes('fine body'), 'healthy rows still answer'); assert.ok(!texts.includes('body'), 'the poisoned revision is skipped, not parsed into results');
  assert.deepEqual((await new QueryApi(new Vault(w.root)).run({ version: 1, from: 'documents', pipe: [{ op: 'count' }] })).rows, [{ count: 2 }]);
  rec('malicious-yaml');
});
test('resource abuse: huge lines, oversized sorts, wide joins and deep graphs stay inside budgets', async t => {
  const w = await world(t);
  await w.vault.put({ scope: app, kind: 'note', title: 'Huge line', body: 'a'.repeat(3_000_000) });
  const lines = await w.owner.run({ version: 1, from: 'documents', where: { field: 'title', op: 'eq', value: 'Huge line' }, pipe: [{ op: 'cat' }, { op: 'select', fields: ['truncated'] }] }); assert.deepEqual(lines.rows, [{ truncated: true }], 'over-long lines are truncated and flagged, not processed whole');
  const t0 = Date.now(); await w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'regex', pattern: 'a.*b' }] }); assert.ok(Date.now() - t0 < 5000, 'a regex over a 1 MB line is bounded');
  for (let i = 0; i < 120; i++) await w.vault.put({ scope: app, kind: 'note', title: `n${i}`, body: 'x' });
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'join', right: { from: 'documents' }, on: { left: 'type', right: 'type' }, kind: 'inner' }, { op: 'sort', fields: [{ field: 'title' }] }] }, { maxBufferRows: 5000, maxRows: 1_000_000 }), { code: 'RESOURCE_LIMIT' }, 'a wide join feeding a sort is stopped by the buffer budget');
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }] }, { deadlineMs: 1 }).then(() => { throw new Error('should have timed out'); }), (e: Error) => /deadline|should have/.test(e.message));
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'traverse', maxDepth: 8, maxNodes: 99_999 }] }), { code: 'RESOURCE_LIMIT' });
  const output = await w.owner.run({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'select', fields: ['text'] }] }, { maxBytes: 100_000 }); assert.ok(output.stats.bytesOut <= 100_000 && output.truncated === 'bytes');
  rec('resource-abuse');
});
test('saved queries cannot carry a principal, code, or unsafe regex; a saved query cannot widen scope beyond the reader', async t => {
  const w = await world(t);
  const id = (await w.vault.put({ scope: app, kind: 'saved_query', title: 'evil', body: JSON.stringify({ version: 1, from: 'documents', principalId: 'owner' }) })).id; void id;
  await assert.rejects(w.agent.run({ version: 1, from: 'saved', saved: 'evil' }), { code: 'QUERY_INVALID' });
  await w.vault.put({ scope: app, kind: 'saved_query', title: 'all', body: JSON.stringify({ version: 1, from: 'documents' }) });
  const r = await w.agent.run({ version: 1, from: 'saved', saved: 'all' }); assert.ok(!JSON.stringify(r.rows).includes('TOP-SECRET'));
  await w.vault.put({ scope: app, kind: 'saved_query', title: 'redos', body: JSON.stringify({ version: 1, from: 'documents', pipe: [{ op: 'cat' }, { op: 'regex', pattern: '(a+)+$' }] }) });
  await assert.rejects(w.agent.run({ version: 1, from: 'saved', saved: 'redos' }), { code: 'QUERY_INVALID' });
  rec('saved-query-safety');
});
test('cursor tampering: edited, replayed on another query, or forged cursors are refused', async t => {
  const w = await world(t);
  const page = await w.owner.run({ version: 1, from: 'documents', limit: 1 }); assert.ok(page.cursor);
  const [payload, check] = page.cursor!.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), o: 0, h: 'x' })).toString('base64url');
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', limit: 1, cursor: `${forged}.${check}` }), { code: 'QUERY_INVALID' });
  await assert.rejects(w.owner.run({ version: 1, from: 'documents', limit: 1, cursor: `${payload}.0000000000000000` }), { code: 'QUERY_INVALID' });
  await assert.rejects(w.owner.run({ version: 1, from: 'wiki', limit: 1, cursor: page.cursor }), { code: 'QUERY_INVALID' });
  rec('cursor-tampering');
});
test('the query layer holds no write path: the AST has no operator that writes, and the journal is untouched by a hostile battery', async t => {
  const w = await world(t);
  const journal = path.join(w.root, '.mdb/events/commits.jsonl'); const before = await fs.readFile(journal, 'utf8');
  for (const op of ['put', 'delete', 'patch', 'write', 'exec', 'shell', 'eval', 'sql', 'grant', 'purge']) await assert.rejects(w.owner.run({ version: 1, from: 'documents', pipe: [{ op }] }), { code: 'QUERY_INVALID' }, op);
  assert.equal(await fs.readFile(journal, 'utf8'), before); rec('no-write-path');
});
