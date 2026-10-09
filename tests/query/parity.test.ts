import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { disposableVault } from '../helpers/disposable-vault.js';
import { run as runCli, MCP_BIN } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';
import { QueryApi } from '../../packages/query/index.js';
import type { Scope } from '../../packages/core/types.js';

const app: Scope = { type: 'workspace', workspaceId: 'app' };
const sec: Scope = { type: 'workspace', workspaceId: 'secret' };
const wiki: Scope = { type: 'global', area: 'wiki' };

async function world(t: { after(fn: () => void | Promise<void>): void }) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('app', '', { agent: ['read'] }); await vault.createWorkspace('secret', '', {});
  const d: Record<string, string> = {};
  const put = async (k: string, scope: Scope, title: string, body: string, extra: { kind?: string; tags?: string[]; metadata?: Record<string, unknown> } = {}) => { d[k] = (await vault.put({ scope, kind: extra.kind ?? 'note', title, body, ...(extra.tags ? { tags: extra.tags } : {}), ...(extra.metadata ? { metadata: extra.metadata } : {}) })).id; };
  await put('a', app, 'Deploy runbook', 'run the pipeline\nasync steps are fine\nverify rollback', { tags: ['ops'] });
  await put('b', app, 'Alert tuning', 'tune thresholds\n[[Deploy runbook]]\nasync alerts', { tags: ['ops', 'alerts'] });
  await put('c', sec, 'Secret plan', 'SECRET-TOKEN async rocket\n[[Deploy runbook]]', { tags: ['ops'] });
  await put('w', wiki, 'Deploy glossary', 'deploy means release; see [[Alert tuning]]', { kind: 'wiki_page' });
  for (let i = 0; i < 4; i++) await put(`o${i}`, app, `event ${i}`, `observation ${i}`, { kind: 'observation', metadata: { sessionId: i < 2 ? 's1' : 's2', eventTime: `2026-04-0${i + 1}T08:00:00Z`, eventType: 'decision' } });
  return { root, vault, d };
}
const ASTS: Array<[string, Record<string, unknown>]> = [
  ['filter+sort+select', { from: 'documents', where: { and: [{ field: 'tags', op: 'contains', value: 'ops' }, { not: { field: 'workspace', op: 'eq', value: 'secret' } }] }, orderBy: [{ field: 'title' }], select: ['title', 'workspace'] }],
  ['keyword search', { from: 'documents', search: { mode: 'keyword', text: 'async' }, orderBy: [{ field: 'title' }], select: ['title'] }],
  ['exact search', { from: 'documents', search: { mode: 'exact', text: 'verify rollback' }, pipe: [{ op: 'select', fields: ['title', 'lineStart'] }] }],
  ['regex search', { from: 'documents', search: { mode: 'regex', text: 'async .*fine' }, pipe: [{ op: 'select', fields: ['title'] }] }],
  ['lines grep cut', { from: 'documents', where: { field: 'title', op: 'eq', value: 'Deploy runbook' }, pipe: [{ op: 'cat' }, { op: 'grep', pattern: 'async' }, { op: 'cut', chars: [[1, 10]] }, { op: 'select', fields: ['lineNumber', 'text'] }] }],
  ['sed', { from: 'documents', where: { field: 'title', op: 'eq', value: 'Alert tuning' }, pipe: [{ op: 'cat' }, { op: 'sed', script: 's/(tune)/\\1d/' }, { op: 'tail', n: 2 }, { op: 'select', fields: ['text'] }] }],
  ['group count', { from: 'documents', groupBy: ['workspace'], aggregate: { n: { op: 'count' } } }],
  ['distinct+count', { from: 'documents', pipe: [{ op: 'pluck', field: 'type' }, { op: 'distinct' }, { op: 'count' }] }],
  ['join', { from: 'observations', pipe: [{ op: 'select', fields: ['id', 'sessionId'] }, { op: 'join', kind: 'semi', right: { from: 'observations', where: { field: 'sessionId', op: 'eq', value: 's1' }, pipe: [{ op: 'select', fields: ['sessionId'] }] }, on: { left: 'sessionId', right: 'sessionId' } }, { op: 'sort', fields: [{ field: 'id' }] }, { op: 'count' }] }],
  ['union', { from: 'documents', where: { field: 'type', op: 'eq', value: 'wiki_page' }, pipe: [{ op: 'select', fields: ['title'] }, { op: 'union', right: { from: 'documents', where: { field: 'title', op: 'eq', value: 'Alert tuning' }, pipe: [{ op: 'select', fields: ['title'] }] } }, { op: 'sort', fields: [{ field: 'title' }] }] }],
  ['recent', { from: 'observations', pipe: [{ op: 'recent', n: 3 }, { op: 'select', fields: ['title', 'eventTime'] }] }],
  ['between', { from: 'observations', pipe: [{ op: 'between', from: '2026-04-02T00:00:00Z', to: '2026-04-04T00:00:00Z' }, { op: 'sort', fields: [{ field: 'eventTime' }] }, { op: 'select', fields: ['title'] }] }],
  ['timeline', { from: 'observations', pipe: [{ op: 'timeline', sessionId: 's2' }, { op: 'select', fields: ['title'] }] }],
  ['backlinks', { from: 'documents', where: { field: 'title', op: 'eq', value: 'Deploy runbook' }, pipe: [{ op: 'backlinks' }, { op: 'sort', fields: [{ field: 'title' }] }, { op: 'select', fields: ['title'] }] }],
  ['traverse', { from: 'documents', where: { field: 'title', op: 'eq', value: 'Deploy glossary' }, pipe: [{ op: 'traverse', maxDepth: 3, maxNodes: 20 }, { op: 'select', fields: ['title', 'depth'] }] }],
  ['edges', { from: 'edges', orderBy: [{ field: 'fromTitle' }, { field: 'toTitle' }], select: ['fromTitle', 'toTitle', 'type'] }]
];
const canonical = (rows: unknown[]) => JSON.stringify(rows);

function mcpCall(root: string, tool: string, args: unknown, actor?: { id: string; permissions: string }): { rows?: unknown[]; error?: { code?: string; message?: string }; raw: unknown } {
  const env = { ...process.env, ...(actor ? { MDB_ACTOR_ID: actor.id, MDB_PERMISSIONS: actor.permissions } : { MDB_ACTOR_ID: 'owner-host', MDB_PERMISSIONS: '*' }) };
  const child = spawnSync(process.execPath, [MCP_BIN, '--root', root], { input: [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }].map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', env, timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const reply = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
  if (reply.error) return { error: { message: reply.error.message }, raw: reply };
  const body = JSON.parse(reply.result!.content[0]!.text) as { rows?: unknown[]; error?: { code: string; message: string } };
  return reply.result!.isError ? { error: body.error, raw: body } : { rows: body.rows, raw: body };
}

test('every operator family returns the same rows through SDK, CLI and MCP', async t => {
  const w = await world(t); const sdk = new QueryApi(w.vault);
  for (const [name, ast] of ASTS) {
    const viaSdk = (await sdk.run({ version: 1, ...ast })).rows;
    const cli = await runCli(['query', '--json', JSON.stringify(ast), '--format', 'json', '--root', w.root]); assert.equal(cli.code, 0, `${name}: ${cli.stderr}`);
    const viaCli = (JSON.parse(cli.stdout) as { rows: unknown[] }).rows;
    const viaMcp = mcpCall(w.root, 'mdb_query', ast); assert.ok(viaMcp.rows, `${name}: ${JSON.stringify(viaMcp.raw).slice(0, 300)}`);
    assert.equal(canonical(viaCli), canonical(viaSdk), `${name}: CLI differs from SDK`);
    assert.equal(canonical(viaMcp.rows!), canonical(viaSdk), `${name}: MCP differs from SDK`);
    assert.ok(viaSdk.length > 0 || name === 'x', `${name}: the comparison is not vacuous`);
    recordCase({ suite: 'query-parity', name: `sdk-cli-mcp/${name}`, status: 'PASS' });
  }
});
test('ACL parity: MCP under a restricted host identity equals the SDK under the same identity', async t => {
  const w = await world(t);
  const agent = new QueryApi(new Vault(w.root, { actorId: 'agent', permissions: ['workspace:app:read', 'global:wiki:read'] }));
  for (const [name, ast] of ASTS) {
    const sdk = (await agent.run({ version: 1, ...ast })).rows; const mcp = mcpCall(w.root, 'mdb_query', ast, { id: 'agent', permissions: 'workspace:app:read,global:wiki:read' });
    assert.ok(mcp.rows, name); assert.equal(canonical(mcp.rows!), canonical(sdk), `${name} (agent)`);
    assert.ok(!JSON.stringify(mcp.rows).includes('Secret plan') && !JSON.stringify(mcp.rows).includes('SECRET-TOKEN'), name);
  }
  recordCase({ suite: 'query-parity', name: 'acl-sdk-vs-mcp', status: 'PASS' });
});
test('MCP: structured errors, forged principal and unknown keys are rejected, tightening-only budgets, explain and capabilities', async t => {
  const w = await world(t);
  const forged = mcpCall(w.root, 'mdb_query', { from: 'documents', principalId: 'owner' }, { id: 'agent', permissions: '' }); assert.ok(forged.error, 'invalid arguments are refused');
  const unknown = mcpCall(w.root, 'mdb_query', { from: 'documents', pipe: [{ op: 'head', n: 1, principalId: 'owner' }] }, { id: 'agent', permissions: '' }); assert.equal(unknown.error?.code, 'QUERY_INVALID');
  const semantic = mcpCall(w.root, 'mdb_query', { from: 'documents', search: { mode: 'semantic', text: 'deploy' } }); assert.equal(semantic.error?.code, 'CAPABILITY_UNAVAILABLE');
  const tight = mcpCall(w.root, 'mdb_query', { from: 'documents', options: { maxRows: 2 } }); assert.equal(tight.rows?.length, 2); assert.ok((tight.raw as { cursor?: string }).cursor);
  const loose = mcpCall(w.root, 'mdb_query', { from: 'documents', options: { maxRows: 100000 } }); assert.ok(loose.rows && loose.rows.length <= 10_000, 'options cannot exceed host budgets');
  const plan = mcpCall(w.root, 'mdb_query_explain', { from: 'documents', pipe: [{ op: 'cat' }] }); assert.ok((plan.raw as { stages: unknown[] }).stages.length > 0);
  const caps = mcpCall(w.root, 'mdb_query_capabilities', {}); assert.equal((caps.raw as { search: { semantic: { available: boolean } } }).search.semantic.available, false);
  const list = spawnSync(process.execPath, [MCP_BIN, '--root', w.root], { input: [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }].map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', env: { ...process.env, MDB_ACTOR_ID: 'o', MDB_PERMISSIONS: '*' } });
  const names = (JSON.parse(list.stdout.trim().split('\n').at(-1)!) as { result: { tools: Array<{ name: string }> } }).result.tools.map(x => x.name);
  for (const required of ['mdb_query', 'mdb_query_explain', 'mdb_query_capabilities', 'mdb_search', 'mdb_grep', 'mdb_memory_recent']) assert.ok(names.includes(required), `${required} still listed (existing names are preserved)`);
  recordCase({ suite: 'query-parity', name: 'mcp-surface', status: 'PASS' });
});
test('CLI: stream aliases compose through pipes and match the AST; formats; explain; saved queries; exit codes', async t => {
  const w = await world(t); const sdk = new QueryApi(w.vault);
  const id = w.d.a!;
  const cat = await runCli(['cat', id, '--root', w.root, '--format', 'ndjson']); assert.equal(cat.code, 0, cat.stderr);
  const lines = (await sdk.run({ version: 1, from: 'documents', where: { field: 'id', op: 'eq', value: id }, pipe: [{ op: 'cat' }] })).rows;
  assert.equal(cat.stdout.trim().split('\n').map(l => JSON.parse(l)).length, lines.length);
  const tail = await runCli(['tail', '-n', '2', '--format', 'text'], { input: cat.stdout }); assert.equal(tail.stdout, 'async steps are fine\nverify rollback\n'.split('\n').slice(0, 2).join('\n') + '\n');
  const head = await runCli(['head', '-n', '1', '--format', 'text'], { input: cat.stdout }); assert.equal(head.stdout, 'run the pipeline\n');
  const cut = await runCli(['cut', '-c', '1-3', '--format', 'text'], { input: cat.stdout }); assert.equal(cut.stdout, 'run\nasy\nver\n');
  const sed = await runCli(['sed', 's/async/ASYNC/', '--format', 'text'], { input: cat.stdout }); assert.match(sed.stdout, /ASYNC steps/);
  const sedN = await runCli(['sed', '-n', '2p', '--format', 'text'], { input: cat.stdout }); assert.equal(sedN.stdout, 'async steps are fine\n');
  const grepStdin = await runCli(['grep', 'rollback', '--stdin', '--format', 'text'], { input: cat.stdout }); assert.equal(grepStdin.stdout, 'verify rollback\n');
  const grepPath = await runCli(['grep', 'async', '--path', id, '-n', '--format', 'text', '--root', w.root]); assert.equal(grepPath.stdout, '2:async steps are fine\n');
  const plain = await runCli(['head', '-n', '1', '--format', 'text'], { input: 'plain one\nplain two\n' }); assert.equal(plain.stdout, 'plain one\n', 'plain text lines work as input');
  const upper = await runCli(['sort', '-r'], { input: cat.stdout }); assert.equal(JSON.parse(upper.stdout.split('\n')[0]!).text, 'verify rollback', 'sort works on NDJSON line rows and keeps their metadata');
  const count = await runCli(['count', '--format', 'jsonl'], { input: cat.stdout }); assert.equal(JSON.parse(count.stdout).count, 3);
  const table = await runCli(['query', '--json', JSON.stringify({ from: 'documents', where: { field: 'workspace', op: 'eq', value: 'app' }, orderBy: [{ field: 'title' }], limit: 2, select: ['title', 'type'] }), '--format', 'table', '--root', w.root]); assert.match(table.stdout, /^title\s+type\n-+\s+-+\n/);
  const explain = await runCli(['query', '--explain', '--json', JSON.stringify({ from: 'documents', pipe: [{ op: 'cat' }] }), '--root', w.root]); assert.equal(JSON.parse(explain.stdout).stages[0].op, 'cat');
  const file = await runCli(['query', '--file', '/nonexistent.json', '--root', w.root]); assert.notEqual(file.code, 0);
  const bad = await runCli(['query', '--json', '{"from":"documents","pipe":[{"op":"eval"}]}', '--root', w.root]); assert.notEqual(bad.code, 0); assert.match(bad.stderr, /QUERY_INVALID/);
  const sem = await runCli(['query', '--json', '{"from":"documents","search":{"mode":"semantic","text":"x"}}', '--root', w.root]); assert.notEqual(sem.code, 0); assert.match(sem.stderr, /CAPABILITY_UNAVAILABLE/);
  const save = await runCli(['query', 'save', 'cli saved', '--scope', 'workspace:app', '--root', w.root, '--json', JSON.stringify({ from: 'documents', where: { field: 'tags', op: 'contains', value: 'ops' }, select: ['title'], orderBy: [{ field: 'title' }] })]); assert.equal(save.code, 0, save.stderr);
  const saved = await runCli(['query', '--json', '{"from":"saved","saved":"cli saved"}', '--format', 'json', '--root', w.root]); assert.deepEqual((JSON.parse(saved.stdout) as { rows: unknown[] }).rows.length, 3);
  // existing commands are unchanged: grep without --path/--stdin is still the index search
  const search = await runCli(['grep', 'async', '--root', w.root, '--json']); assert.equal(search.code, 0); assert.ok(Array.isArray((JSON.parse(search.stdout) as { hits: unknown[] }).hits));
  recordCase({ suite: 'query-parity', name: 'cli-aliases', status: 'PASS' });
});
test('cursor paging through CLI: stderr carries the cursor, a second call continues', async t => {
  const w = await world(t);
  const q = { from: 'documents', orderBy: [{ field: 'id' }], select: ['id'] };
  const first = await runCli(['query', '--json', JSON.stringify(q), '--limit', '4', '--format', 'jsonl', '--root', w.root]); const cursor = (JSON.parse(first.stderr.trim().split('\n').at(-1)!) as { cursor: string }).cursor; assert.ok(cursor);
  const second = await runCli(['query', '--json', JSON.stringify(q), '--limit', '4', '--cursor', cursor, '--format', 'jsonl', '--root', w.root]);
  const a = first.stdout.trim().split('\n').map(l => JSON.parse(l).id), b = second.stdout.trim().split('\n').map(l => JSON.parse(l).id);
  assert.equal(new Set([...a, ...b]).size, 8, 'pages do not overlap'); assert.deepEqual([...a, ...b], [...a, ...b].slice().sort());
});
