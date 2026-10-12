import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

const MCP = resolve('bin/mdb-mcp.js');
type Cleanup = { after(fn: () => void | Promise<void>): void };
interface Reply { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { code: number; message: string } }

async function setup(t: Cleanup) {
  const { root } = await disposableVault(t); const owner = new Engram(root);
  await owner.createWorkspace('proj-a'); await owner.createWorkspace('proj-b');
  const a = await createHttpCredential(owner.vault, 'agent-a', ['workspace:proj-a:read', 'workspace:proj-a:write']); await owner.vault.grant('proj-a', 'agent-a', ['read', 'write']);
  const b = await createHttpCredential(owner.vault, 'agent-b', ['workspace:proj-b:read', 'workspace:proj-b:write']); await owner.vault.grant('proj-b', 'agent-b', ['read', 'write']);
  const both = await createHttpCredential(owner.vault, 'agent-ab', ['workspace:proj-a:read', 'workspace:proj-a:write', 'workspace:proj-b:read', 'workspace:proj-b:write']); await owner.vault.grant('proj-a', 'agent-ab', ['read', 'write']); await owner.vault.grant('proj-b', 'agent-ab', ['read', 'write']);
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  let stderr = ''; const endpoint = await new Promise<string>((res, rej) => { child.stderr.setEncoding('utf8'); child.stderr.on('data', (c: string) => { stderr += c; const m = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(stderr); if (m) res(m[1]!); }); child.once('exit', code => rej(new Error(`exited ${code}: ${stderr}`))); });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(r => child.once('exit', () => r())); } });
  return { root, owner, endpoint, tokens: { a: a.token, b: b.token, both: both.token } };
}
const post = (endpoint: string, token: string, body: unknown, headers: Record<string, string> = {}) => fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } };
async function open(endpoint: string, token: string, workspace?: string) {
  const res = await post(endpoint, token, INIT, workspace ? { 'X-Engram-Workspace': workspace } : {});
  if (res.status !== 200) return { status: res.status, call: undefined as never, list: undefined as never };
  const session = res.headers.get('mcp-session-id')!; let id = 10;
  const rpc = async (method: string, params?: unknown): Promise<Reply> => (await (await post(endpoint, token, { jsonrpc: '2.0', id: id++, method, params }, { 'Mcp-Session-Id': session })).json()) as Reply;
  const call = async (name: string, args: unknown) => { const r = await rpc('tools/call', { name, arguments: args }); const text = r.result?.content?.[0]?.text; return { error: r.error, isError: !!r.result?.isError, value: text ? JSON.parse(text) as Record<string, unknown> : undefined }; };
  return { status: 200, call, list: () => rpc('tools/list') };
}
const docs = async (owner: Engram) => owner.listDocuments();

test('a session bound to a workspace writes there without naming it, and the stored record is in that workspace', async t => {
  const { owner, endpoint, tokens } = await setup(t);
  const s = await open(endpoint, tokens.a, 'proj-a'); assert.equal(s.status, 200);
  const put = await s.call('mdb_put', { kind: 'note', title: 'Default scope', body: 'no scope argument' });
  assert.equal(put.isError, false, JSON.stringify(put));
  const note = await s.call('engram_note_upsert', { noteId: 'n1', title: 'Typed note', body: 'typed and default scoped' });
  assert.equal(note.value?.persistence, 'COMMITTED');
  const all = await docs(owner); assert.equal(all.length, 2); assert.ok(all.every(d => d.scope.type === 'workspace' && d.scope.workspaceId === 'proj-a'));
  const listed = (await s.list()).result as unknown as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
  assert.ok(!listed.tools.find(x => x.name === 'mdb_put')!.inputSchema.required!.includes('scope'), 'scope is optional once a default workspace is bound');
  recordCase({ suite: 'memory', name: 'default-workspace-binds-writes', status: 'PASS' });
});

test('without a bound workspace the scope is still required: nothing is guessed', async t => {
  const { owner, endpoint, tokens } = await setup(t);
  const s = await open(endpoint, tokens.a); assert.equal(s.status, 200);
  const put = await s.call('mdb_put', { kind: 'note', title: 'No scope', body: 'x' });
  assert.equal(put.error?.code, -32602); assert.equal((await docs(owner)).length, 0);
  const typed = await s.call('engram_task_upsert', { taskId: 'T', title: 't', status: 'open' }); assert.equal(typed.error?.code, -32602);
});

test('a header naming a workspace the credential cannot use is refused at initialize; there is no fallback to a permitted one', async t => {
  const { owner, endpoint, tokens } = await setup(t);
  assert.equal((await open(endpoint, tokens.a, 'proj-b')).status, 403, 'agent-a has no access to proj-b');
  for (const bad of ['../etc', 'a b', 'x'.repeat(200), 'proj-a,proj-b']) assert.equal((await open(endpoint, tokens.a, bad)).status, 403, bad);
  assert.equal((await docs(owner)).length, 0);
});

test('an explicit scope still goes through the ACL, even when a default is bound, and a forbidden explicit scope writes nothing', async t => {
  const { owner, endpoint, tokens } = await setup(t);
  const s = await open(endpoint, tokens.a, 'proj-a');
  const denied = await s.call('mdb_put', { scope: { type: 'workspace', workspaceId: 'proj-b' }, kind: 'note', title: 'cross', body: 'must be refused' });
  assert.equal(denied.isError, true); assert.match(JSON.stringify(denied.value), /NOT_FOUND_OR_FORBIDDEN/);
  const deniedTyped = await s.call('engram_note_upsert', { scope: { type: 'workspace', workspaceId: 'proj-b' }, noteId: 'x', title: 'cross', body: 'refused' });
  assert.equal(deniedTyped.isError, true);
  assert.equal((await docs(owner)).length, 0, 'zero committed records');
});

test('with access to two workspaces, a search without scopes covers only the bound one; explicit scopes reach the other', async t => {
  const { owner, endpoint, tokens } = await setup(t);
  await owner.put({ scope: { type: 'workspace', workspaceId: 'proj-a' }, kind: 'note', title: 'Alpha', body: 'shared-term in a' });
  await owner.put({ scope: { type: 'workspace', workspaceId: 'proj-b' }, kind: 'note', title: 'Beta', body: 'shared-term in b' });
  const s = await open(endpoint, tokens.both, 'proj-a');
  const unscoped = await s.call('mdb_search', { query: 'shared-term' }); const titles = (r: typeof unscoped) => ((r.value?.hits ?? []) as Array<{ title: string }>).map(h => h.title).sort();
  assert.deepEqual(titles(unscoped), ['Alpha']);
  const explicit = await s.call('mdb_search', { query: 'shared-term', scopes: [{ type: 'workspace', workspaceId: 'proj-b' }] }); assert.deepEqual(titles(explicit), ['Beta']);
});

test('the binding cannot be changed mid-session by a later header or by tool arguments', async t => {
  const { owner, endpoint, tokens } = await setup(t);
  const res = await post(endpoint, tokens.both, INIT, { 'X-Engram-Workspace': 'proj-a' }); const session = res.headers.get('mcp-session-id')!;
  const call = async (args: unknown, headers: Record<string, string> = {}) => ((await (await post(endpoint, tokens.both, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'mdb_put', arguments: args } }, { 'Mcp-Session-Id': session, ...headers })).json()) as Reply);
  await call({ kind: 'note', title: 'Still A', body: 'x' }, { 'X-Engram-Workspace': 'proj-b' });
  const stored = await docs(owner); assert.equal(stored.length, 1); assert.equal((stored[0]!.scope as { workspaceId: string }).workspaceId, 'proj-a', 'a later header does not rebind the session');
  const smuggled = await call({ kind: 'note', title: 'Smuggle', body: 'x', defaultWorkspace: 'proj-b' }); assert.equal(smuggled.error?.code, -32602, 'unknown arguments are rejected');
});
