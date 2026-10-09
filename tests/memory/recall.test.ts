import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { disposableVault } from '../helpers/disposable-vault.js';
import { MCP_BIN, run } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { Engram, parseWhen } from '../../packages/sdk/index.js';
import { spawnSync } from 'node:child_process';

type T = { after(fn: () => void | Promise<void>): void };
const scope = { type: 'workspace' as const, workspaceId: 'proj' };
/** A session of timestamped records, written through the normal commit path with explicit event times. */
async function seeded(t: T) {
  const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', '', { reader: ['read'] }); await vault.createWorkspace('other', '');
  const session = await vault.put({ scope, kind: 'session', title: 'S1', body: '', metadata: { lifecycle: 'closed', eventTime: '2026-10-07T10:00:00.000Z', hostSessionId: 'host-1' } });
  const ids: string[] = []; const times = ['2026-10-07T10:00:01.000Z', '2026-10-07T10:00:02.000Z', '2026-10-07T10:00:02.000Z', '2026-10-07T10:05:00.000Z', '2026-10-08T09:00:00.000Z'];
  for (const [i, at] of times.entries()) {
    const d = await vault.put({ scope, kind: 'observation', title: `obs ${i}`, body: `record ${i} about the ${i % 2 ? 'cache invalidation' : 'deployment pipeline'} ENOENT-${i}`, evidence: [{ uri: session.uri, revisionId: session.revisionId }], metadata: { sessionId: session.id, hostSessionId: 'host-1', eventTime: at, eventType: i === 0 ? 'user.message' : 'tool.result', speaker: i === 0 ? 'user' : 'tool' } });
    ids.push(d.id);
  }
  await vault.put({ scope: { type: 'workspace', workspaceId: 'other' }, kind: 'observation', title: 'other workspace', body: 'cache invalidation elsewhere', metadata: { eventTime: '2026-10-09T00:00:00.000Z' } });
  return { root, vault, session, ids, times, client: new Engram(root) };
}

test('recent: newest first by event time with id tie-break, exact cursor paging, scope isolation and an upper time bound', async t => {
  const { client, ids, times } = await seeded(t);
  const all = await client.memory.recent({ scope: 'workspace', workspaceId: 'proj', limit: 100 });
  const sorted = [...times.keys()].map(i => ({ id: ids[i]!, at: times[i]! })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  assert.deepEqual(all.items.filter(i => i.kind === 'observation').map(i => i.id), sorted.map(x => x.id), 'order is event time desc, then id desc');
  const seen: string[] = []; let cursor: string | undefined;
  do { const page = await client.memory.recent({ scope: 'workspace', workspaceId: 'proj', limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...page.items.map(i => i.id)); cursor = page.cursor; } while (cursor);
  assert.deepEqual(seen, all.items.map(i => i.id), 'paging visits every record exactly once, in order');
  assert.equal(all.items.some(i => i.title === 'other workspace'), false, 'other workspace never leaks into a workspace-scoped query');
  const bounded = await client.memory.recent({ scope: 'workspace', workspaceId: 'proj', to: '2026-10-07T10:01:00Z', limit: 100 });
  assert.ok(bounded.items.every(i => i.at <= '2026-10-07T10:01:00.000Z'), 'nothing after the upper bound');
  assert.equal(all.items[0]!.revisionId.startsWith('rev_'), true);
  await assert.rejects(client.memory.recent({ cursor: 'garbage' }), { code: 'INVALID_INPUT' }); await assert.rejects(client.memory.recent({ limit: 0 }), { code: 'INVALID_INPUT' });
  recordCase({ suite: 'memory', name: 'recent-ordering-and-paging', status: 'PASS' });
});

test('time_range and timeline: timezone semantics, ascending order, evidence references preserved', async t => {
  const { client, ids, times, session } = await seeded(t);
  assert.equal(parseWhen('2026-10-07T06:00:00-04:00', 'x'), '2026-10-07T10:00:00.000Z', 'offsets are converted, not ignored');
  assert.equal(parseWhen('2026-10-07', 'x'), '2026-10-07T00:00:00.000Z'); assert.equal(parseWhen('2026-10-07', 'x', true), '2026-10-07T23:59:59.999Z', 'a date as upper bound covers the whole UTC day');
  assert.throws(() => parseWhen('2026-10-07T10:00:00', 'from'), { code: 'INVALID_INPUT' }, 'a time without an offset is rejected rather than guessed'); assert.throws(() => parseWhen('yesterday', 'from'), { code: 'INVALID_INPUT' });
  const range = await client.memory.timeRange({ scope: 'workspace', workspaceId: 'proj', from: '2026-10-07T06:00:01-04:00', to: '2026-10-07T10:02:00Z', types: ['observation'], limit: 50 });
  assert.deepEqual(range.items.map(i => i.id), [ids[0], ...[ids[1]!, ids[2]!].sort()], 'inclusive range in the stated offset, oldest first'); assert.ok(range.items.every((i, n, a) => n === 0 || a[n - 1]!.at <= i.at));
  const days = await client.memory.timeRange({ scope: 'workspace', workspaceId: 'proj', from: '2026-10-08', to: '2026-10-08', types: ['observation'] }); assert.deepEqual(days.items.map(i => i.id), [ids[4]]);
  const timeline = await client.memory.timeline({ sessionId: 'host-1', detail: 'full' });
  assert.equal(timeline.items[0]!.kind, 'session'); assert.deepEqual(timeline.items.slice(1).map(i => i.at), [...times].sort(), 'chronological, raw records');
  assert.ok(timeline.items.slice(1).every(i => i.body!.includes('record')), 'bodies are the stored source text, not summaries');
  const stored = await new Vault(timeline.items[1]!.uri.includes('workspaces') ? (client.vault.root) : client.vault.root).get(timeline.items[1]!.id); assert.equal(stored.evidence[0]!.uri, session.uri, 'evidence reference to the session is intact');
  const around = await client.memory.timeline({ aroundId: ids[2]!, window: 1 }); assert.equal(around.items.length, 3); assert.ok(around.items.some(i => i.id === ids[2]));
  await assert.rejects(client.memory.timeRange({}), { code: 'INVALID_INPUT' }); await assert.rejects(client.memory.timeline({}), { code: 'INVALID_INPUT' });
  recordCase({ suite: 'memory', name: 'time-range-and-timeline', status: 'PASS' });
});

test('progressive disclosure: index -> snippet -> timeline -> full fetch keep one identity, and token budgets are enforced with continuation', async t => {
  const { client, ids } = await seeded(t);
  const index = await client.memory.query({ mode: 'keyword', query: 'cache invalidation', scope: 'workspace', workspaceId: 'proj', detail: 'index' });
  assert.ok(index.items.length >= 2); assert.ok(index.items.every(i => i.snippet === undefined && i.body === undefined), 'index detail carries no content');
  const snippets = await client.memory.query({ mode: 'keyword', query: 'cache invalidation', scope: 'workspace', workspaceId: 'proj', detail: 'snippet' });
  assert.deepEqual(snippets.items.map(i => i.id), index.items.map(i => i.id)); assert.ok(snippets.items.every(i => i.snippet!.length > 0 && i.snippet!.length <= 240));
  const neighbours = await client.memory.timeline({ aroundId: index.items[0]!.id, window: 2 }); assert.ok(neighbours.items.some(i => i.id === index.items[0]!.id));
  const full = await client.memory.get(index.items.map(i => i.id));
  assert.deepEqual(full.items.map(i => [i.id, i.revisionId]), index.items.map(i => [i.id, i.revisionId]), 'the same objects and revisions at every level'); assert.ok(full.items.every(i => i.body!.includes('record')));
  const impossible = await client.memory.recent({ scope: 'workspace', workspaceId: 'proj', detail: 'full', tokenBudget: 20 }); assert.deepEqual(impossible.items, []); assert.match(impossible.note ?? '', /smaller than a single record/);
  const tiny = await client.memory.recent({ scope: 'workspace', workspaceId: 'proj', detail: 'full', tokenBudget: 280, limit: 100 });
  assert.equal(tiny.truncated, true); assert.ok(tiny.estimatedTokens <= 280, `${tiny.estimatedTokens} tokens`); assert.ok(tiny.cursor, 'a continuation cursor is returned'); assert.ok(tiny.items.length >= 1);
  const rest = await client.memory.recent({ scope: 'workspace', workspaceId: 'proj', detail: 'full', tokenBudget: 280, limit: 100, cursor: tiny.cursor! }); assert.ok(rest.items.length >= 1); assert.equal(rest.items.some(i => tiny.items.some(j => j.id === i.id)), false, 'continuation never repeats');
  const budgeted = await client.memory.get(ids, { tokenBudget: 300 }); assert.equal(budgeted.truncated, true); assert.ok(budgeted.estimatedTokens <= 300);
  await assert.rejects(client.memory.get([]), { code: 'INVALID_INPUT' }); await assert.rejects(client.memory.get(Array.from({ length: 51 }, (_, i) => `x${i}`)), { code: 'INVALID_INPUT' });
  const missing = await client.memory.get([ids[0]!, 'obj_nope_000000000000000000000000000000']); assert.equal(missing.unavailable.length, 1);
  recordCase({ suite: 'memory', name: 'progressive-disclosure-and-budgets', status: 'PASS' });
});

test('modes: grep, regex, keyword, links and auto work without a model; semantic and hybrid are explicitly unavailable; identity cannot be asserted', async t => {
  const { client, ids } = await seeded(t);
  const base = { scope: 'workspace' as const, workspaceId: 'proj' };
  assert.deepEqual((await client.memory.query({ ...base, mode: 'grep', query: 'ENOENT-3' })).items.map(i => i.id), [ids[3]]);
  assert.deepEqual((await client.memory.query({ ...base, mode: 'regex', query: 'ENOENT-[24]' })).items.map(i => i.id).sort(), [ids[2]!, ids[4]!].sort());
  assert.ok((await client.memory.query({ ...base, mode: 'keyword', query: 'deployment pipeline' })).items.length >= 2);
  assert.deepEqual((await client.memory.query({ ...base, mode: 'auto', query: 'ENOENT-1' })).items.map(i => i.id), [ids[1]]); assert.equal((await client.memory.query({ ...base, mode: 'auto' })).mode, 'recent');
  assert.deepEqual((await client.memory.query({ ...base, mode: 'grep', query: 'ENOENT', types: ['user.message'] })).items.map(i => i.id), [ids[0]], 'types filter by event type');
  assert.equal((await client.memory.query({ ...base, mode: 'grep', query: 'ENOENT', from: '2026-10-08', to: '2026-10-08' })).items.length, 1, 'time bounds apply to event time');
  for (const mode of ['semantic', 'hybrid'] as const) await assert.rejects(client.memory.query({ ...base, mode, query: 'similar failures' }), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(client.memory.query({ ...base, mode: 'recent', principalId: 'someone-else' }), { code: 'NOT_FOUND_OR_FORBIDDEN' }); await assert.rejects(client.memory.query({ ...base, mode: 'keyword' }), { code: 'INVALID_INPUT' });
  const caps = await client.capabilities() as { recall: { modes: { semantic: { available: boolean } } }; search: { vector: { available: boolean } } };
  assert.equal(caps.recall.modes.semantic.available, false); assert.equal(caps.search.vector.available, false);
  recordCase({ suite: 'memory', name: 'recall-modes', status: 'PASS' });
});

test('authorization: readers see only granted scopes, grants and revocations apply immediately, MCP rejects asserted identities', async t => {
  const { root, vault } = await seeded(t);
  const reader = new Engram(root, { actorId: 'reader', permissions: [] }); const stranger = new Engram(root, { actorId: 'stranger', permissions: [] });
  assert.ok((await reader.memory.recent({})).items.length >= 6, 'granted workspace is readable'); assert.equal((await reader.memory.recent({})).items.some(i => i.title === 'other workspace'), false);
  assert.deepEqual((await stranger.memory.recent({})).items, []); assert.deepEqual((await stranger.memory.timeline({ sessionId: 'host-1' })).items, []);
  assert.deepEqual((await stranger.memory.get((await reader.memory.recent({})).items.map(i => i.id))).items, [], 'ids obtained elsewhere do not open anything');
  await vault.revoke('proj', 'reader'); assert.deepEqual((await reader.memory.recent({})).items, [], 'revocation is immediate');
  const rpc = (name: string, args: unknown) => spawnSync(process.execPath, [MCP_BIN, '--root', root], { input: [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }].map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', env: { ...process.env, MDB_ACTOR_ID: 'mcp-agent', MDB_PERMISSIONS: 'workspace:proj:read' } });
  const ok = JSON.parse(rpc('mdb_memory_recent', { scope: 'workspace', workspaceId: 'proj', limit: 3 }).stdout.trim().split('\n')[1]!); assert.equal(ok.result.isError, undefined); assert.equal(JSON.parse(ok.result.content[0].text).items.length, 3);
  const forged = JSON.parse(rpc('mdb_memory_recent', { principalId: 'owner', permissions: ['*'] }).stdout.trim().split('\n')[1]!); assert.ok(forged.error || forged.result?.isError, 'asserting an identity through tool arguments is refused by the schema');
  const tools = JSON.parse(rpc('mdb_capabilities', {}).stdout.trim().split('\n')[1]!); assert.match(JSON.parse(tools.result.content[0].text).nativeMemory, /host harness keeps its own context/);
  recordCase({ suite: 'memory', name: 'recall-authorization', status: 'PASS' });
});

test('SQLite and filesystem recall agree, new commits are visible before any reindex, and a damaged index only degrades', async t => {
  const { root, vault, client, ids } = await seeded(t);
  const query = { mode: 'keyword' as const, query: 'cache invalidation', scope: 'workspace' as const, workspaceId: 'proj' };
  const files = (await client.memory.query(query)).items.map(i => i.id).sort();
  const c = await vault.config(); c.sqlite.enabled = true; await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(c));
  const sql = new Engram(root); await sql.search.rebuild();
  const viaSql = await sql.memory.query(query); assert.equal(viaSql.backend, 'sqlite'); assert.deepEqual(viaSql.items.map(i => i.id).sort(), files);
  const late = await vault.put({ scope, kind: 'observation', title: 'late', body: 'cache invalidation again', metadata: { eventTime: '2026-10-10T00:00:00.000Z', eventType: 'tool.result', speaker: 'tool' } });
  assert.ok((await sql.memory.query(query)).items.some(i => i.id === late.id), 'a commit newer than the index is found');
  assert.equal((await sql.memory.recent({ scope: 'workspace', workspaceId: 'proj' })).items[0]!.id, late.id, 'and is the newest');
  await fs.writeFile(path.join(root, '.mdb/indexes/workspace-proj.sqlite'), 'garbage'.repeat(200));
  const degraded = await new Engram(root).memory.query(query); assert.ok(degraded.items.some(i => i.id === late.id) && degraded.items.some(i => i.id === ids[1]), 'complete results despite a corrupt index'); assert.match(degraded.fallback ?? '', /canonical files/);
  recordCase({ suite: 'memory', name: 'recall-sqlite-parity', status: 'PASS' });
});

test('CLI: mdb memory recent/search/timeline/get and capabilities work end to end as JSON', async t => {
  const { root, ids } = await seeded(t);
  const j = async (...args: string[]) => { const r = await run([...args, '--root', root, '--json']); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
  assert.equal((await j('memory', 'recent', '--workspace', 'proj', '--scope', 'workspace', '--limit', '3')).items.length, 3);
  assert.deepEqual((await j('memory', 'search', 'ENOENT-3', '--mode', 'grep', '--scope', 'workspace', '--workspace', 'proj')).items.map((i: { id: string }) => i.id), [ids[3]]);
  assert.equal((await j('memory', 'timeline', '--session', 'host-1')).items.length, 6);
  assert.equal((await j('memory', 'get', '--ids', ids.slice(0, 2).join(','))).items.length, 2);
  assert.equal((await j('memory', 'range', '--from', '2026-10-08', '--to', '2026-10-08', '--types', 'observation')).items.length, 1);
  assert.equal((await j('capabilities')).recall.requiresModel, false);
  const bad = await run(['memory', 'search', 'x', '--mode', 'semantic', '--root', root, '--json']); assert.equal(bad.code, 1); assert.equal(JSON.parse(bad.stderr).error.code, 'CAPABILITY_UNAVAILABLE');
  recordCase({ suite: 'memory', name: 'cli-recall', status: 'PASS' });
});
