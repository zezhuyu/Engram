import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Engram } from '../packages/sdk/index.js';
import { hostActor } from '../packages/mcp/index.js';
import { createHttpCredential, revokeHttpCredential } from '../packages/mcp/credentials.js';
import { createRegistration } from '../packages/memory/capture.js';
import { drainRemoteCaptureSpool, queueRemoteCapture } from '../packages/memory/remote-spool.js';

const CLI = resolve('bin/mdb.js'), MCP = resolve('bin/mdb-mcp.js');
function cli(root: string, ...args: string[]): unknown {
  const child = spawnSync(process.execPath, [CLI, ...args, '--root', root, '--json'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
interface Reply { id?: number; result?: { isError?: boolean; content?: { text: string }[]; [key: string]: unknown }; error?: { code: number; message: string } }
function mcp(root: string, calls: unknown[], actor = 'agent-a', permissions = ''): Reply[] {
  const child = spawnSync(process.execPath, [MCP, '--root', root], {
    input: [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tests', version: '1' } } }, ...calls].map(item => JSON.stringify(item)).join('\n') + '\n',
    encoding: 'utf8', env: { ...process.env, MDB_MCP_TRANSPORT: 'stdio', MDB_ACTOR_ID: actor, MDB_PERMISSIONS: permissions }, timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim().split('\n').map(line => JSON.parse(line) as Reply);
}
function call(id: number, name: string, args: unknown) { return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }; }
function result(reply: Reply): unknown { return JSON.parse(reply.result!.content![0]!.text); }
async function spawnHttpMcp(root: string, t: { after(fn: () => void | Promise<void>): void }, options: { token?: string; actor?: string; permissions?: string; toolset?: string } = {}) {
  const token = options.token ?? 'http-test-token-that-is-at-least-32-bytes-long';
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_TOKEN: token, MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0', MDB_ACTOR_ID: options.actor ?? 'http-agent', MDB_PERMISSIONS: options.permissions ?? '*', MDB_MCP_HTTP_ALLOWED_ORIGINS: 'https://agents.example', ...(options.toolset ? { MDB_MCP_TOOLSET: options.toolset } : {}) } });
  let stderr = '', resolveReady!: (url: string) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolveUrl, reject) => { resolveReady = resolveUrl; rejectReady = reject; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk; const match = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(stderr); if (match) resolveReady(match[1]!); });
  child.once('error', rejectReady); child.once('exit', code => { if (code !== null && code !== 0) rejectReady(new Error(`HTTP MCP exited ${code}: ${stderr}`)); });
  const endpoint = await ready;
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolveExit => child.once('exit', () => resolveExit())); } });
  return { endpoint, token };
}
const httpPost = (endpoint: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}) => fetch(endpoint, {
  method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('spawned CLI supports Markdown CRUD, conflicts, history, restore and sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-cli-'));
  try {
    cli(root, 'init', '--no-sqlite');
    cli(root, 'workspace', 'create', 'research');
    cli(root, 'collection', 'create', 'task', '--workspace', 'research');
    const document = cli(root, 'put', '--scope', 'workspace:research:task', '--kind', 'note', '--title', 'Retrieval', '--body', 'Immutable first note') as { id: string; revisionId: string };
    const revised = cli(root, 'patch', document.id, '--revision', document.revisionId, '--body', 'Revised note') as { revisionId: string };
    const conflict = spawnSync(process.execPath, [CLI, '--root', root, 'patch', document.id, '--revision', document.revisionId, '--body', 'lost update', '--json'], { encoding: 'utf8' });
    assert.equal(conflict.status, 1); assert.equal(JSON.parse(conflict.stderr).error.code, 'CONFLICT');
    assert.equal((cli(root, 'history', document.id) as unknown[]).length, 2);
    const diff = cli(root, 'diff', document.id, document.revisionId, revised.revisionId) as { diff: string };
    assert.match(diff.diff, /first note/);
    cli(root, 'restore', document.id, document.revisionId, '--revision', revised.revisionId);
    const hits = cli(root, 'grep', 'Immutable', '--scope', 'workspace:research') as { hits: unknown[] };
    assert.equal(hits.hits.length, 1);
    const session = cli(root, 'session', 'start', '--workspace', 'research') as { id: string };
    cli(root, 'session', 'observe', '--session', session.id, '--body', 'Explicit selected observation');
    cli(root, 'session', 'end', '--session', session.id);
    const context = cli(root, 'context', '--task', 'observation', '--scope', 'workspace:research', '--budget-tokens', '100') as { estimatedTokens: number };
    assert.ok(context.estimatedTokens <= 100);
    assert.ok((cli(root, 'skills', 'list') as unknown[]).length >= 12);
    const help = spawnSync(process.execPath, [CLI, '--root', root, 'help'], { encoding: 'utf8' });
    assert.equal(help.status, 0); assert.match(help.stdout, /session start/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spawned MCP honors host actor, scope ACL, schemas and stable permission errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-mcp-'));
  try {
    const owner = new Engram(root); await owner.init({ sqlite: false });
    await owner.createWorkspace('a'); await owner.createWorkspace('b');
    await owner.grant('a', 'agent-a', ['read', 'write']);
    const secret = await owner.put({ scope: { type: 'workspace', workspaceId: 'b' }, kind: 'note', title: 'Secret', body: 'classified mango' });
    const publicDoc = await owner.put({ scope: { type: 'workspace', workspaceId: 'a' }, kind: 'note', title: 'Visible', body: 'visible mango' });
    const replies = mcp(root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      call(2, 'mdb_search', { query: 'mango' }),
      call(3, 'mdb_get', { objectId: secret.id }),
      call(4, 'mdb_get', { objectId: publicDoc.id, actor: { actorId: 'owner', permissions: ['*'] } }),
      call(5, 'mdb_put', { scope: { type: 'workspace', workspaceId: 'b' }, kind: 'note', title: 'Attack', body: 'forbidden' }),
      call(6, 'mdb_put', { scope: { type: 'workspace', workspaceId: 'a' }, kind: 'note', title: 'Authored', body: 'safe commit' }),
      call(7, 'mdb_search', { query: 'safe' }),
    ]);
    assert.equal(replies[0]!.result!.protocolVersion, '2025-03-26');
    assert.ok((replies[1]!.result!.tools as unknown[]).length >= 18);
    assert.equal((result(replies[2]!) as { hits: unknown[] }).hits.length, 1);
    assert.equal(replies[3]!.result!.isError, true);
    assert.equal((result(replies[3]!) as { error: { code: string } }).error.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(replies[4]!.error!.code, -32602);
    assert.equal(replies[5]!.result!.isError, true);
    assert.equal((result(replies[6]!) as { createdBy: string }).createdBy, 'agent-a');
    assert.equal((result(replies[7]!) as { hits: unknown[] }).hits.length, 1);
    assert.doesNotMatch(JSON.stringify(replies), /classified mango/);
    const anonymous = mcp(root, [call(1, 'mdb_get', { objectId: publicDoc.id })], '', '*');
    assert.equal(anonymous[1]!.result!.isError, true);
    assert.deepEqual(hostActor({ MDB_PERMISSIONS: '*' }), { actorId: 'mcp-anonymous', permissions: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP HTTP transport is opt-in, authenticated, origin-checked, and serves the same tool API as stdio', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-mcp-http-'));
  try {
    const owner = new Engram(root); await owner.init({ sqlite: false }); await owner.createWorkspace('shared');
    const { endpoint, token } = await spawnHttpMcp(root, t);
    assert.equal((await fetch(endpoint, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } })).status, 405);
    assert.equal((await httpPost(endpoint, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize' })).status, 401);
    assert.equal((await httpPost(endpoint, token, { jsonrpc: '2.0', id: 1, method: 'initialize' }, { Origin: 'https://untrusted.example' })).status, 403);
    const initialized = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'remote-agent', version: '1' } } }, { Origin: 'https://agents.example' });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get('content-type')?.split(';')[0], 'application/json');
    const sessionId = initialized.headers.get('mcp-session-id'); assert.ok(sessionId);
    assert.equal((await httpPost(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 400, 'session is required after initialize');
    const listed = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': sessionId! });
    assert.equal(listed.status, 200);
    const listReply = await listed.json() as { result: { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    assert.ok(listReply.result.tools.some(tool => tool.name === 'mdb_memory_search'));
    assert.ok(listReply.result.tools.some(tool => tool.name === 'mdb_workspace_create'));
    const insightTool = listReply.result.tools.find(tool => tool.name === 'mdb_insight_search');
    assert.ok(insightTool?.inputSchema?.properties?.scopeLabel, 'remote initialization can query project-scoped preferences');
    assert.ok(listReply.result.tools.some(tool => tool.name === 'mdb_skill_run'));
    const called = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mdb_workspace_list', arguments: {} } }, { 'Mcp-Session-Id': sessionId! });
    const callReply = await called.json() as { result: { structuredContent: { result: Array<{ id: string }> } } };
    assert.equal(callReply.result.structuredContent.result[0]!.id, 'shared');
    assert.equal((await fetch(endpoint.replace('/mcp', '/wrong'), { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await httpPost(endpoint, token, { jsonrpc: '2.0', id: 4, method: 'ping' }, { 'Mcp-Session-Id': sessionId! })).status, 200);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote-web MCP exposes bounded authorized tools and idempotent versioned create/patch operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-web-mcp-'));
  try {
    const owner = new Engram(root); await owner.init({ sqlite: false }); await owner.createWorkspace('remote');
    const credential = await createHttpCredential(owner.vault, 'web-connector', ['workspace:remote:read', 'workspace:remote:write']);
    await owner.vault.grant('remote', 'web-connector', ['read', 'write']);
    const { endpoint, token } = await spawnHttpMcp(root, t, { token: credential.token, actor: 'legacy-unused', permissions: '', toolset: 'remote-web' });
    const initialized = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'web-client', version: '1' } } });
    assert.equal(initialized.status, 200); assert.equal(initialized.headers.get('mcp-protocol-version'), '2025-03-26');
    const session = initialized.headers.get('mcp-session-id')!;
    const request = (id: number, name: string, args: unknown) => httpPost(endpoint, token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' });
    const listed = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' });
    const tools = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['engram_capabilities', 'engram_chat_get', 'engram_chat_list', 'engram_chat_project_link', 'engram_chat_project_remap', 'engram_chat_project_resolve', 'engram_chat_project_unlink', 'engram_chat_projects', 'engram_chat_search', 'engram_context', 'engram_create', 'engram_get', 'engram_get_many', 'engram_handoff_status', 'engram_handoff_write', 'engram_history', 'engram_note_upsert', 'engram_patch', 'engram_project_projection', 'engram_propose_insight', 'engram_recent', 'engram_search', 'engram_session_context', 'engram_task_upsert', 'engram_timeline', 'engram_workspace_ensure'].sort());
    const capability = await request(3, 'engram_capabilities', { scope: { type: 'workspace', workspaceId: 'remote' } });
    assert.deepEqual((JSON.parse((await capability.json() as Reply).result!.content![0]!.text) as { authorization: unknown }).authorization, { read: true, write: true });
    const denied = await request(4, 'engram_create', { scope: { type: 'workspace', workspaceId: 'secret' }, kind: 'note', title: 'Hidden', body: 'no leak', source: 'ChatGPT', idempotencyKey: 'denied-write' });
    const deniedJson = await denied.json() as Reply; assert.equal(deniedJson.result?.isError, true); assert.match(deniedJson.result!.content![0]!.text, /NOT_FOUND_OR_FORBIDDEN/); assert.doesNotMatch(JSON.stringify(deniedJson), /secret/);
    const createArgs = { scope: { type: 'workspace', workspaceId: 'remote' }, kind: 'decision', title: 'Remote decision', body: 'Use a narrow connector', source: 'Claude Web', idempotencyKey: 'create-1' };
    const createdReply = await request(5, 'engram_create', createArgs); const created = JSON.parse((await createdReply.json() as Reply).result!.content![0]!.text) as { id: string; revisionId: string };
    const otherActor = new Engram(root, { actorId: 'other-web-connector', permissions: [] });
    await owner.vault.grant('remote', 'other-web-connector', ['read', 'write']);
    await assert.rejects(() => otherActor.vault.put({ scope: { type: 'workspace', workspaceId: 'remote' }, kind: 'decision', title: 'Remote decision', body: 'Use a narrow connector', metadata: { authoredSource: 'Claude Web', capture: 'explicit' }, idempotencyKey: 'create-1' }), /Idempotency key was already used/);
    const replayReply = await request(6, 'engram_create', createArgs); const replay = JSON.parse((await replayReply.json() as Reply).result!.content![0]!.text) as { id: string; revisionId: string };
    assert.equal(replay.id, created.id); assert.equal(replay.revisionId, created.revisionId); assert.equal((await owner.vault.history(created.id)).length, 1);
    const patchArgs = { objectId: created.id, expectedRevisionId: created.revisionId, body: 'Use the shared remote connector', idempotencyKey: 'patch-1' };
    const firstPatchReply = await request(7, 'engram_patch', patchArgs); const firstPatch = JSON.parse((await firstPatchReply.json() as Reply).result!.content![0]!.text) as { revisionId: string };
    const repeatedPatchReply = await request(8, 'engram_patch', patchArgs); const repeatedPatch = JSON.parse((await repeatedPatchReply.json() as Reply).result!.content![0]!.text) as { revisionId: string };
    assert.equal(repeatedPatch.revisionId, firstPatch.revisionId); assert.equal((await owner.vault.history(created.id)).length, 2);
    const conflictingReplay = await request(9, 'engram_patch', { ...patchArgs, body: 'Different payload' });
    assert.match((await conflictingReplay.json() as Reply).result!.content![0]!.text, /CONFLICT/);
    const stale = await request(10, 'engram_patch', { ...patchArgs, idempotencyKey: 'patch-2', body: 'Stale update' });
    assert.match((await stale.json() as Reply).result!.content![0]!.text, /CONFLICT/);
    const search = await request(11, 'engram_search', { query: 'shared remote connector', scopes: [{ type: 'workspace', workspaceId: 'remote' }] });
    assert.match((await search.json() as Reply).result!.content![0]!.text, /Use the shared remote connector/);
    const typedWrite = await request(12, 'engram_note_upsert', { scope: { type: 'workspace', workspaceId: 'remote' }, noteId: 'packaged-client', title: 'Client note', body: 'written through the typed client contract' });
    assert.match((await typedWrite.json() as Reply).result!.content![0]!.text, /COMMITTED/);
    const deniedTypedWrite = await request(13, 'engram_note_upsert', { scope: { type: 'workspace', workspaceId: 'secret' }, noteId: 'denied', title: 'Denied', body: 'must not commit' });
    assert.equal((await deniedTypedWrite.json() as Reply).result?.isError, true);
    assert.equal(await owner.vault.byIdempotencyKey('note:denied', { type: 'workspace', workspaceId: 'remote' }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote-web MCP supports stateless server discovery and authorized tool calls for the current ChatGPT tunnel flow', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-web-discover-'));
  try {
    const owner = new Engram(root); await owner.init({ sqlite: false });
    const { endpoint, token } = await spawnHttpMcp(root, t, { toolset: 'remote-web' });
    const discovered = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    assert.equal(discovered.status, 200); assert.equal(discovered.headers.get('mcp-protocol-version'), '2026-07-28');
    const discovery = (await discovered.json() as Reply).result as { resultType: string; supportedVersions: string[]; cacheScope: string };
    assert.equal(discovery.resultType, 'complete'); assert.ok(discovery.supportedVersions.includes('2026-07-28')); assert.equal(discovery.cacheScope, 'private');
    const listed = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'MCP-Protocol-Version': '2026-07-28' });
    assert.equal(listed.status, 200); assert.equal(listed.headers.get('mcp-session-id'), null);
    const tools = ((await listed.json() as Reply).result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some(tool => tool.name === 'engram_search'));
    const called = await httpPost(endpoint, token, call(3, 'engram_capabilities', {}), { 'MCP-Protocol-Version': '2026-07-28' });
    assert.equal(called.status, 200); assert.equal((await called.json() as Reply).result?.isError, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two scoped remote agents passively deliver lifecycle observations to one authorized memory store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-two-agents-'));
  try {
    const owner = new Engram(root); await owner.init({ sqlite: false }); await owner.createWorkspace('shared'); await owner.createWorkspace('private');
    await owner.put({ scope: { type: 'workspace', workspaceId: 'private' }, kind: 'note', title: 'Private', body: 'only-private-zebra' });
    const a = await createHttpCredential(owner.vault, 'claude-agent', ['workspace:shared:read', 'workspace:shared:write']);
    const b = await createHttpCredential(owner.vault, 'codex-agent', ['workspace:shared:read', 'workspace:shared:write']);
    const wrongScope = await createHttpCredential(owner.vault, 'claude-agent-narrow', ['workspace:private:write']);
    const registrationA = await createRegistration(owner.vault, { host: 'claude-code', principalId: 'claude-agent', workspaceId: 'shared', consent: true });
    const registrationB = await createRegistration(owner.vault, { host: 'codex', principalId: 'codex-agent', workspaceId: 'shared', consent: true });
    const narrowRegistration = await createRegistration(owner.vault, { host: 'claude-code', principalId: 'claude-agent-narrow', workspaceId: 'shared', consent: true });
    const { endpoint, token: legacy } = await spawnHttpMcp(root, t);
    const initClient = async (token: string) => {
      const response = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'independent-host', version: '1' } } });
      assert.equal(response.status, 200); return response.headers.get('mcp-session-id')!;
    };
    const sessions = await Promise.all([initClient(a.token), initClient(b.token), initClient(wrongScope.token)]);
    const events = [
      { token: a.token, registrationId: registrationA.id, session: 'claude-session-1', prompt: 'I prefer small focused code changes. claude-only-observation' },
      { token: b.token, registrationId: registrationB.id, session: 'codex-session-1', prompt: 'I always want tests and detailed results before completion. codex-only-observation' }
    ];
    for (const item of events) {
      const accepted = await httpPost(endpoint.replace('/mcp', '/capture'), item.token, { registrationId: item.registrationId, payload: { hook_event_name: 'UserPromptSubmit', session_id: item.session, prompt_id: item.session, prompt: item.prompt, cwd: '/workspace/project' } });
      assert.equal(accepted.status, 202); assert.equal((await accepted.json() as { accepted: boolean }).accepted, true);
    }
    // Both clients can read the same workspace history, without either calling an explicit memory write tool.
    for (const [index, token] of [a.token, b.token].entries()) {
      let body = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        const response = await httpPost(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mdb_memory_recent', arguments: { scope: 'workspace', workspaceId: 'shared', detail: 'full', limit: 20, tokenBudget: 1000 } } }, { 'Mcp-Session-Id': sessions[index]! });
        assert.equal(response.status, 200); body = JSON.stringify(await response.json());
        if (body.includes('claude-only-observation') && body.includes('codex-only-observation')) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      assert.match(body, /claude-only-observation/); assert.match(body, /codex-only-observation/); assert.doesNotMatch(body, /only-private-zebra/);
      const page = JSON.parse((JSON.parse(body).result.content[0].text)) as { estimatedTokens: number };
      assert.ok(page.estimatedTokens <= 1000, 'remote recall stays inside its requested token budget');
    }
    const contextResponse = await httpPost(endpoint, a.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mdb_context', arguments: { query: 'only-observation', scopes: [{ type: 'workspace', workspaceId: 'shared' }], budgetTokens: 500 } } }, { 'Mcp-Session-Id': sessions[0]! });
    const contextReply = JSON.stringify(await contextResponse.json()); assert.doesNotMatch(contextReply, /only-private-zebra/);
    const context = JSON.parse(JSON.parse(contextReply).result.content[0].text) as { estimatedTokens: number; text: string };
    assert.ok(context.estimatedTokens <= 500); assert.match(context.text, /claude-only-observation/);
    assert.equal((await httpPost(endpoint.replace('/mcp', '/capture'), a.token, { registrationId: registrationB.id, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'forged', prompt: 'forged identity' } })).status, 404);
    assert.equal((await httpPost(endpoint.replace('/mcp', '/capture'), wrongScope.token, { registrationId: narrowRegistration.id, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'wrong-scope', prompt: 'scope escalation' } })).status, 404);
    const narrowRead = await httpPost(endpoint, wrongScope.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mdb_memory_recent', arguments: { scope: 'workspace', workspaceId: 'shared', detail: 'full' } } }, { 'Mcp-Session-Id': sessions[2]! });
    assert.doesNotMatch(JSON.stringify(await narrowRead.json()), /claude-only-observation|codex-only-observation/);
    assert.equal(await revokeHttpCredential(owner.vault, b.id), true);
    assert.equal((await httpPost(endpoint, b.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mdb_workspace_list', arguments: {} } }, { 'Mcp-Session-Id': sessions[1]! })).status, 401);
    assert.equal((await httpPost(endpoint, legacy, { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).status, 200);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP transport selection rejects ambiguous modes and HTTP refuses a missing bearer secret', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-mcp-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await new Engram(root).init({ sqlite: false });
  for (const env of [{ MDB_MCP_TRANSPORT: 'both' }, { MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_TOKEN: '' }]) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, MDB_ROOT: root }; delete childEnv.ENGRAM_DATA_DIR;
    const child = spawnSync(process.execPath, [MCP], { encoding: 'utf8', env: childEnv });
    assert.equal(child.status, 1);
    assert.match(child.stderr, env.MDB_MCP_TRANSPORT === 'http' ? /requires .*credential|MDB_MCP_HTTP_TOKEN/ : /must be exactly/);
  }
});

test('lifecycle adapter captures only explicit allowlisted events and redacts supplied text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-lifecycle-'));
  try {
    const { LifecycleAdapter } = await import('../packages/sdk/index.js');
    const client = new Engram(root); await client.init({ sqlite: false }); await client.createWorkspace('events');
    const disabled = new LifecycleAdapter(client, { type: 'workspace', workspaceId: 'events' }, { enabled: false, allowedEvents: ['session_start'], allowedSources: ['manual'] });
    assert.deepEqual(await disabled.capture('session_start', 'manual'), { captured: false, reason: 'Capture not enabled for this event/source' });
    const adapter = new LifecycleAdapter(client, { type: 'workspace', workspaceId: 'events' }, { enabled: true, allowedEvents: ['session_start', 'user_message', 'session_end'], allowedSources: ['manual'] });
    assert.deepEqual(await adapter.capture('user_message', 'manual', 'premature'), { captured: false, reason: 'No explicit active session' });
    await adapter.capture('session_start', 'manual');
    assert.deepEqual(await adapter.capture('tool_outcome', 'manual', 'disallowed'), { captured: false, reason: 'Capture not enabled for this event/source' });
    await adapter.capture('user_message', 'manual', 'Bearer abcdefg token=secretvalue');
    await adapter.capture('session_end', 'manual');
    const observations = (await client.listDocuments()).filter(doc => doc.kind === 'observation');
    assert.equal(observations.length, 1); assert.doesNotMatch(observations[0]!.body, /abcdefg|secretvalue/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote lifecycle hook adapters install against one shared server and can be removed cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdb-remote-hooks-'));
  try {
    const settingsPath = join(root, 'host', 'settings.json');
    const { createAdapter } = await import('../packages/memory/adapters.js');
    const adapter = createAdapter('claude-code', { root, settingsPath });
    const installed = await adapter.install({ consent: true, principalId: 'remote-agent', workspaceId: 'shared', mcpUrl: 'https://memory.example/mcp', tokenEnv: 'ENGRAM_REMOTE_TOKEN', registrationId: 'reg_remote123' });
    assert.equal(installed.changed, true);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const command = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.command;
    assert.match(command, /--remote-url "https:\/\/memory\.example\/mcp"/); assert.match(command, /--token-env "ENGRAM_REMOTE_TOKEN"/);
    assert.deepEqual(await readdir(root), ['host'], 'remote installation creates no local vault or registration state');
    assert.deepEqual((await adapter.status()).capture.includes('user.message'), true);
    assert.ok((await adapter.uninstall()).removed > 0);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote capture spool redacts before persistence and retries delivery without storing credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mdb-remote-spool-')); let attempts = 0, received = '';
  const server = createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { attempts++; received = Buffer.concat(chunks).toString(); response.writeHead(attempts === 1 ? 503 : 202).end(); }); });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { await new Promise<void>(resolveClose => server.close(() => resolveClose())); await rm(directory, { recursive: true, force: true }); });
  const token = 'remote-bearer-token-that-must-not-be-stored';
  const first = await queueRemoteCapture({ url: `http://127.0.0.1:${address.port}/mcp`, registrationId: 'reg_remote', token, directory, payload: { hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'remember token=super-secret-value', transcript_path: '/private/transcript.jsonl' } });
  assert.deepEqual(first, { delivered: 0, queued: 1, rejected: 0 });
  const stored = await readFile(join(directory, (await readdir(directory))[0]!), 'utf8');
  assert.doesNotMatch(stored, /super-secret-value|remote-bearer-token|transcript\.jsonl/);
  assert.equal((await drainRemoteCaptureSpool({ token, directory })).queued, 0);
  assert.equal(attempts, 2); assert.match(received, /\[REDACTED\]/);
});

test('remote capture quarantines permanently rejected entries and continues with later events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mdb-remote-reject-')); const received: string[] = [];
  const server = createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { received.push(Buffer.concat(chunks).toString()); response.writeHead(received.length === 1 ? 400 : 202).end(); }); });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen)); const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { await new Promise<void>(resolveClose => server.close(() => resolveClose())); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${address.port}/capture`, token = 'remote-bearer-token-that-must-not-be-stored';
  const first = await queueRemoteCapture({ url, registrationId: 'reg', token, directory, payload: { hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'rejected event' } });
  assert.deepEqual(first, { delivered: 0, queued: 0, rejected: 1 });
  const rejected = await readdir(join(directory, 'rejected')); assert.equal(rejected.filter(name => name.endsWith('.json') && !name.endsWith('.reason.json')).length, 1);
  const second = await queueRemoteCapture({ url, registrationId: 'reg', token, directory, payload: { hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'following event' } });
  assert.deepEqual(second, { delivered: 1, queued: 0, rejected: 0 });
  assert.equal(received.length, 2); assert.match(received[1]!, /following event/);
  const delayedPayload = (JSON.parse(received[1]!) as { payload: { _engramCapturedAt?: string } }).payload;
  assert.ok(Number.isFinite(Date.parse(delayedPayload._engramCapturedAt ?? '')));
});
