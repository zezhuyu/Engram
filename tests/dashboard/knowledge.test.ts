import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Engram } from '../../packages/sdk/index.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { assets } from '../../packages/dashboard/ui/view-model.js';
import { disposableVault } from './helpers.js';

async function call(port: number, token: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

test('dashboard knowledge CRUD preserves revisions, conflicts, tombstones, restore and idempotency', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const input = { scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'CRUD test', body: 'original inert text', idempotencyKey: 'create-key-1' };
  const created = await call(dashboard.port, dashboard.token, '/api/documents', 'POST', input);
  assert.equal(created.status, 201); const doc = created.body.document;
  const replay = await call(dashboard.port, dashboard.token, '/api/documents', 'POST', input);
  assert.equal(replay.body.document.id, doc.id); assert.equal(replay.body.document.revisionId, doc.revisionId);
  const edited = await call(dashboard.port, dashboard.token, `/api/documents/${doc.id}`, 'PATCH', { title: 'CRUD updated', body: 'changed', expectedRevisionId: doc.revisionId, idempotencyKey: 'patch-key-1' });
  assert.equal(edited.status, 200); const current = edited.body.document;
  const stale = await call(dashboard.port, dashboard.token, `/api/documents/${doc.id}`, 'PATCH', { title: 'stale overwrite', expectedRevisionId: doc.revisionId });
  assert.equal(stale.status, 409); assert.equal((await v.engram.get(doc.id)).title, 'CRUD updated');
  const history = await call(dashboard.port, dashboard.token, `/api/documents/${doc.id}/history`);
  assert.equal(history.body.length, 2);
  const removed = await call(dashboard.port, dashboard.token, `/api/documents/${doc.id}`, 'DELETE', { expectedRevisionId: current.revisionId, idempotencyKey: 'delete-key-1' });
  assert.equal(removed.status, 200); assert.equal(removed.body.tombstoned, true);
  assert.equal((await call(dashboard.port, dashboard.token, '/api/documents')).body.items.length, 0);
  assert.equal((await call(dashboard.port, dashboard.token, '/api/documents?includeDeleted=true')).body.items[0].status, 'deleted');
  const restored = await call(dashboard.port, dashboard.token, `/api/documents/${doc.id}/restore`, 'POST', { revisionId: doc.revisionId, expectedRevisionId: removed.body.document.revisionId, idempotencyKey: 'restore-key-1' });
  assert.equal(restored.status, 200); assert.equal(restored.body.document.body, 'original inert text'); assert.equal(restored.body.document.revisionNumber, 4);
  const audit = await fs.readFile(`${v.root}/.mdb/dashboard/audit.jsonl`, 'utf8');
  assert.equal(audit.includes('original inert text'), false); assert.match(audit, /knowledge\.create/);
});

test('dashboard revision preconditions reject missing, empty, and stale values without writing revisions', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const created = await call(dashboard.port, dashboard.token, '/api/documents', 'POST', { scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'Precondition test', body: 'original' });
  const doc = created.body.document;
  const cases = [
    { label: 'missing', expected: undefined, status: 400 },
    { label: 'empty', expected: '', status: 400 },
    { label: 'stale', expected: 'rev_stale_precondition', status: 409 },
  ];
  for (const operation of ['PATCH', 'DELETE', 'RESTORE'] as const) {
    for (const scenario of cases) {
      const historyLength = (await v.engram.history(doc.id)).length;
      const expected = scenario.expected === undefined ? {} : { expectedRevisionId: scenario.expected };
      const body = operation === 'PATCH' ? { ...expected, title: 'must not replace', body: 'must not replace' }
        : operation === 'RESTORE' ? { ...expected, revisionId: doc.revisionId }
          : expected;
      const path = operation === 'RESTORE' ? `/api/documents/${doc.id}/restore` : `/api/documents/${doc.id}`;
      const response = await call(dashboard.port, dashboard.token, path, operation === 'RESTORE' ? 'POST' : operation, body);
      assert.equal(response.status, scenario.status, `${operation} ${scenario.label}: ${JSON.stringify(response.body)}`);
      if (scenario.status === 400) assert.equal(response.body.error.code, 'INVALID_INPUT');
      assert.equal((await v.engram.history(doc.id)).length, historyLength, `${operation} ${scenario.label} must not add a revision`);
      const current = await v.engram.get(doc.id);
      assert.equal(current.body, 'original', `${operation} ${scenario.label} must preserve body`);
      assert.equal(current.status, 'active', `${operation} ${scenario.label} must preserve lifecycle`);
    }
  }
});

test('dashboard knowledge hides unauthorized documents and applies the document body limit', async t => {
  const owner = await disposableVault();
  t.after(async () => { await owner.cleanup(); });
  const secret = await owner.engram.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'ACL_SECRET_TITLE', body: 'ACL_SECRET_BODY' });
  const actorClient = new Engram(owner.root, { actorId: 'limited-reader', permissions: [] });
  const dashboard = await createDashboardServer({ engram: actorClient, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await actorClient.close(); });
  const list = await call(dashboard.port, dashboard.token, '/api/documents');
  assert.equal(JSON.stringify(list.body).includes(secret.title), false);
  assert.equal(JSON.stringify(list.body).includes(secret.uri), false);
  assert.equal((await call(dashboard.port, dashboard.token, `/api/documents/${secret.id}`)).status, 404);
  const tooLarge = await call(dashboard.port, dashboard.token, '/api/documents', 'POST', { scope: { type: 'global', area: 'wiki' }, kind: 'note', title: 'Oversized', body: 'x'.repeat(300_000) });
  assert.equal(tooLarge.status, 413);
});

test('dashboard knowledge writes require same-origin session requests and keep markdown inert under CSP', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  const page = await fetch(`http://127.0.0.1:${dashboard.port}/`);
  assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
  const unauthorized = await call(dashboard.port, dashboard.token, '/api/documents', 'POST', { scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>' }, { Origin: 'http://attacker.invalid' });
  assert.equal(unauthorized.status, 403);
  assert.equal((await v.engram.listDocuments()).length, 0);
  const malicious = { scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>' };
  const created = await call(dashboard.port, dashboard.token, '/api/documents', 'POST', malicious);
  const loaded = await call(dashboard.port, dashboard.token, `/api/documents/${created.body.document.id}`);
  assert.equal(loaded.body.document.title, malicious.title); assert.equal(loaded.body.document.body, malicious.body);
  assert.match(assets['/assets/app.js']!.body, /node\('pre','panel',d\.body\)/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /\.innerHTML\b|\.outerHTML\b/);
});

test('dashboard knowledge list cursor and metadata filters continue without snippets', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await v.cleanup(); });
  for (const [title, kind, tags] of [['alpha findme', 'note', ['blue']], ['beta findme', 'fact', ['blue']], ['gamma', 'note', ['green']]] as Array<[string, string, string[]]>) await v.engram.put({ scope: { type: 'global', area: 'wiki' }, kind, title, body: `body ${title}`, tags });
  const first = await call(dashboard.port, dashboard.token, '/api/documents?limit=1&q=findme&tag=blue');
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.items.length, 1); assert.ok(first.body.cursor); assert.equal('snippet' in first.body.items[0], false);
  const second = await call(dashboard.port, dashboard.token, `/api/documents?limit=1&q=findme&tag=blue&cursor=${encodeURIComponent(first.body.cursor)}`);
  assert.equal(second.status, 200, JSON.stringify(second.body)); assert.equal(second.body.items.length, 1); assert.notEqual(second.body.items[0].id, first.body.items[0].id);
  const kinds = await call(dashboard.port, dashboard.token, '/api/documents?kind=fact'); assert.equal(kinds.body.items.length, 1); assert.equal(kinds.body.items[0].kind, 'fact');
});
