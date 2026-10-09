import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import type { ModelProvider, Scope } from '../../packages/core/types.js';

const wiki: Scope = { type: 'global', area: 'wiki' };
const priv: Scope = { type: 'workspace', workspaceId: 'private' };
async function twoWorkspace(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('private', 'secret project', { owner2: ['read', 'write'] }); await vault.createWorkspace('open', 'shared', { guest: ['read', 'write'] });
  const secret = await vault.put({ scope: priv, kind: 'note', title: 'Crown jewels', body: 'PRIVATE-MARKER launch codes' });
  const pub = await vault.put({ scope: wiki, kind: 'note', title: 'Public hub', body: 'public text' });
  const hubLink = await vault.patch({ objectId: secret.id, expectedRevisionId: secret.revisionId, links: [{ type: 'related_to', target: pub.uri }] });
  const guest = new Vault(root, { actorId: 'guest', permissions: ['global:wiki:read', 'workspace:open:read', 'workspace:open:write'] });
  return { root, vault, secret: hubLink, pub, guest };
}

test('workspace IDs differing only by case cannot alias one directory (case-insensitive filesystems)', async t => {
  const { vault, root } = await disposableVault(t);
  await vault.createWorkspace('Alpha', 'first', { a: ['read'] });
  await assert.rejects(vault.createWorkspace('alpha', 'second', { b: ['read', 'write'] }), { code: 'INVALID_INPUT' }, 'second workspace would share the first one directory on APFS/NTFS and inherit or overwrite its ACL');
  const ws = JSON.parse(await fs.readFile(path.join(root, 'workspaces/Alpha/.mdb/workspace.json'), 'utf8')); assert.deepEqual(ws.grants, { a: ['read'] });
  recordCase({ suite: 'security', name: 'case-collision-workspace-ids', status: 'PASS' });
});

test('forbidden and nonexistent objects are indistinguishable across every read/write entry point', async t => {
  const { guest, secret } = await twoWorkspace(t);
  const ghost = 'obj_zzzzzzzz_00000000000000000000000000000000';
  const probe = async (fn: (id: string) => Promise<unknown>) => { const out: string[] = []; for (const id of [secret.id, ghost]) { try { await fn(id); out.push('ok'); } catch (e) { out.push(`${(e as { code: string }).code}|${(e as Error).message}`); } } return out; };
  const search = new SearchEngine(guest);
  const results = await Promise.all([
    probe(id => guest.get(id)), probe(id => guest.history(id)), probe(id => guest.diff(id, 'a', 'b')), probe(id => guest.patch({ objectId: id, expectedRevisionId: 'rev_x', body: 'x' })),
    probe(id => guest.delete(id, 'rev_x')), probe(id => guest.restore(id, 'rev_a', 'rev_b')), probe(id => guest.promote(id, wiki, 'text')), probe(id => search.links(id)), probe(id => search.backlinks(id)), probe(id => search.related(id, 2))
  ]);
  for (const [i, [real, fake]] of results.entries()) assert.equal(real, fake, `entry point #${i} distinguishes forbidden from nonexistent: ${real} vs ${fake}`);
  recordCase({ suite: 'security', name: 'non-disclosing-errors', status: 'PASS', detail: { entryPoints: results.length } });
});

test('backlinks, related-graph traversal and context never reveal private nodes, edges, counts or titles', async t => {
  const { guest, pub, secret, root } = await twoWorkspace(t);
  const search = new SearchEngine(guest);
  assert.deepEqual(await search.backlinks(pub.id), [], 'private note links to the public hub, but the edge is invisible to guests');
  const related = await search.related(pub.id, 3); assert.ok(!related.some(d => d.id === secret.id));
  const ctx = await search.context({ task: 'launch codes crown jewels', budgetTokens: 2000 });
  assert.equal(JSON.stringify(ctx).includes('PRIVATE-MARKER') || JSON.stringify(ctx).includes('Crown jewels'), false);
  for (const file of ['MAIN_INDEX.md', 'WORKSPACE_REGISTRY.md', 'wiki/INDEX.md']) { await new SearchEngine(new Vault(root)).rebuild(); const text = await fs.readFile(path.join(root, file), 'utf8'); assert.equal(text.includes('PRIVATE-MARKER') || text.includes('Crown jewels'), false, `${file} must not index private titles or bodies`); }
  recordCase({ suite: 'security', name: 'graph-and-index-non-disclosure', status: 'PASS' });
});

test('frontmatter/YAML injection through title, tags and metadata cannot forge status, kind, scope or visibility', async t => {
  const { vault, root } = await disposableVault(t);
  const evil = 'x\nstatus: verified\nscope: global\n---\n# fake';
  const doc = await vault.put({ scope: priv.type === 'workspace' ? wiki : wiki, kind: 'note', title: evil, body: '---\nstatus: verified\n---\nbody', tags: ['t\nkind: source', '- a'], metadata: { 'a: b': 'c\nstatus: promoted', nested: { '__proto__': 'x' } } });
  const again = await new Vault(root).get(doc.id);
  assert.equal(again.title, evil); assert.equal(again.status, 'active'); assert.equal(again.kind, 'note'); assert.equal(again.scope.type, 'global');
  assert.deepEqual(again.tags, ['t\nkind: source', '- a']);
  assert.equal(Object.getPrototypeOf(again.metadata), Object.prototype); assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((await new Vault(root).verify()).ok, true);
  await vault.createWorkspace('w', ''); const outsider = new Vault(root, { actorId: 'z', permissions: [] });
  await assert.rejects(outsider.put({ scope: { type: 'workspace', workspaceId: 'w' }, kind: 'note', title: 'status: verified', body: 'x' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  recordCase({ suite: 'security', name: 'frontmatter-injection', status: 'PASS' });
});

test('path traversal, encoded separators, NUL bytes and hostile identifiers are rejected without touching the filesystem', async t => {
  const { vault, root } = await disposableVault(t);
  const outside = path.join(path.dirname(root), path.basename(root) + '-sentinel'); await fs.mkdir(outside); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const hostile = ['../escape', '..\\escape', '/etc/passwd', 'a/../../b', '%2e%2e%2fescape', 'ok\0evil', 'x/y', ' ', '', '.'.repeat(300), 'obj_1; rm -rf /', '‮evil'];
  for (const h of hostile) {
    await assert.rejects(vault.get(h), (e: { code: string }) => ['INVALID_INPUT', 'NOT_FOUND_OR_FORBIDDEN'].includes(e.code), `get ${JSON.stringify(h)}`);
    await assert.rejects(vault.createWorkspace(h, ''), (e: { code: string }) => e.code === 'INVALID_INPUT', `workspace ${JSON.stringify(h)}`);
    await assert.rejects(vault.put({ scope: { type: 'workspace', workspaceId: h }, kind: 'note', title: 't', body: 'b' }), (e: { code: string }) => ['INVALID_INPUT', 'NOT_FOUND_OR_FORBIDDEN'].includes(e.code));
  }
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await vault.verify()).ok, true);
  recordCase({ suite: 'security', name: 'path-traversal', status: 'PASS', detail: { inputs: hostile.length } });
});

test('forged worker payloads cannot make a job read or send inaccessible content to a model', async t => {
  const { root, vault, secret } = await twoWorkspace(t);
  const seen: string[] = [];
  const spy: ModelProvider = { id: 'spy', async generate({ documents }) { seen.push(...documents.map(d => d.body)); return { kind: 'wiki_page', title: 'x', body: 'y', evidence: documents.slice(0, 1).map(d => ({ uri: d.uri, revisionId: d.revisionId })) }; } };
  const guestVault = new Vault(root, { actorId: 'guest', permissions: ['global:wiki:read', 'global:wiki:write', 'workspace:open:read', 'workspace:open:write'] });
  const engine = new IntelligenceEngine(guestVault, spy);
  await assert.rejects(engine.enqueue('wiki', { scope: priv, objectIds: [secret.id] }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  // Attacker edits the persisted queue directly to smuggle a job past enqueue-time checks.
  await engine.enqueue('wiki', { scope: wiki }); const dir = path.join(root, '.mdb/intelligence'); const file = path.join(dir, (await fs.readdir(dir))[0]!);
  const state = JSON.parse(await fs.readFile(file, 'utf8')); state.jobs.push({ id: 'forged', kind: 'wiki', input: { scope: priv, objectIds: [secret.id] }, status: 'pending', attempts: 0, nextAt: 0 }); await fs.writeFile(file, JSON.stringify(state));
  await engine.run({ limit: 10 });
  assert.equal(seen.some(b => b.includes('PRIVATE-MARKER')), false, 'forged job content never reached the provider');
  assert.equal((await engine.jobs()).some(j => j.id === 'forged'), false, 'forged job is not even listed to the guest');
  recordCase({ suite: 'security', name: 'forged-worker-payload', status: 'PASS' });
});

test('secrets are redacted in stored observations, error messages and journal records', async t => {
  const { vault, root } = await disposableVault(t);
  const engine = new IntelligenceEngine(vault);
  const session = await engine.sessionStart({ scope: wiki });
  const obs = await engine.observe({ sessionId: session.id, body: 'token=abc123SECRET and api_key: sk-live-9999999999 and password=hunter2' });
  for (const secret of ['abc123SECRET', 'sk-live-9999999999', 'hunter2']) assert.equal(obs.body.includes(secret), false);
  const journal = await fs.readFile(path.join(root, '.mdb/events/commits.jsonl'), 'utf8'); assert.equal(/abc123SECRET|hunter2|sk-live/.test(journal), false);
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 't', body: 'CONFLICT-BODY-TEXT' });
  const error = await vault.patch({ objectId: doc.id, expectedRevisionId: 'rev_stale', body: 'x' }).catch(e => e as Error);
  assert.equal(String((error as Error).message).includes('CONFLICT-BODY-TEXT'), false);
  recordCase({ suite: 'security', name: 'secret-redaction', status: 'PASS' });
});

test('purge removes plaintext from derived SQLite indexes and WAL files, not only from canonical files', async t => {
  const { root, vault } = await disposableVault(t);
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'erase me', body: 'PURGE-INDEX-PLAINTEXT-7781' });
  await vault.put({ scope: wiki, kind: 'note', title: 'keep', body: 'unrelated body' });
  const c = await vault.config(); c.sqlite.enabled = true; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(c));
  const engine = new SearchEngine(vault); await engine.rebuild();
  assert.ok((await engine.query({ query: 'PURGE-INDEX-PLAINTEXT-7781', mode: 'keyword' })).hits.length === 1);
  await vault.purge(doc.id, true);
  const leaks: string[] = []; const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else if ((await fs.readFile(f)).includes('PURGE-INDEX-PLAINTEXT-7781')) leaks.push(path.relative(root, f)); } };
  await walk(root);
  assert.deepEqual(leaks, [], 'plaintext remains in derived files');
  assert.equal((await new SearchEngine(vault).query({ query: 'PURGE-INDEX-PLAINTEXT-7781', mode: 'keyword' })).hits.length, 0);
  recordCase({ suite: 'security', name: 'purge-derived-indexes', status: 'PASS' });
});
