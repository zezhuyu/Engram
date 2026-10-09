import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { MDB, MCP_BIN, run, tempDir } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';
import { Engram } from '../../packages/sdk/index.js';
import { runCaptured } from '../../packages/unix/index.js';
import { Vault } from '../../packages/core/vault.js';
import type { Scope } from '../../packages/core/types.js';

const app: Scope = { type: 'workspace', workspaceId: 'app' };
const rec = (name: string) => recordCase({ suite: 'unix-features', name, status: 'PASS' });
type T = { after(fn: () => void | Promise<void>): void };
const mdb = (args: string[], input = '', env: Record<string, string> = {}) => run(args, { input, env });

async function world(t: T) {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('app', '', { agent: ['read'] }); await vault.createWorkspace('secret', '', {});
  await vault.createCollection?.('c1', 'app', '').catch(() => undefined);
  const a = await vault.put({ scope: app, kind: 'note', title: 'Deploy runbook', body: 'run the pipeline\nasync steps are fine\nverify rollback\n', tags: ['ops'] });
  const b = await vault.put({ scope: app, kind: 'decision', title: 'Alert tuning', body: 'tune thresholds\nasync alerts\n[[Deploy runbook]]', tags: ['ops', 'alerts'] });
  const s = await vault.put({ scope: { type: 'workspace', workspaceId: 'secret' }, kind: 'note', title: 'Secret plan', body: 'SECRET-TOKEN async rocket\n' });
  const w = await vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Glossary', body: 'deploy means release\n' });
  const owner = new Engram(root); const agent = new Engram(root, { actorId: 'agent', permissions: ['workspace:app:read', 'global:wiki:read'] });
  return { root, vault, a, b, s, w, owner, agent };
}

test('formats: NDJSON rows keep their metadata through filters; auto-detection uses the first record only; JSON arrays work; bad input is an error', async () => {
  const rows = ['{"text":"b 2","k":1}', '{"text":"a 1","k":2}', '{"text":"c 3","k":3}'].join('\n') + '\n';
  const sorted = await mdb(['sort'], rows); assert.deepEqual(sorted.stdout.trim().split('\n').map(l => JSON.parse(l)), [{ text: 'a 1', k: 2 }, { text: 'b 2', k: 1 }, { text: 'c 3', k: 3 }], 'ndjson in -> ndjson out, metadata kept');
  const asText = await mdb(['sort', '--format', 'text'], rows); assert.equal(asText.stdout, 'a 1\nb 2\nc 3\n');
  const forced = await mdb(['sort', '--in', 'text'], rows); assert.ok(forced.stdout.startsWith('{"text":"a 1"'), '--in text treats JSON lines as plain text (sorted as text)');
  const plain = await mdb(['head', '-n', '1'], 'x\n{"text":"y"}\n'); assert.equal(plain.stdout, 'x\n', 'first record decides: plain text');
  const grep = await mdb(['grep', '-n', 'a'], rows); assert.deepEqual(JSON.parse(grep.stdout.trim()), { text: '2:a 1', k: 2, file: null, lineNumber: 2, selected: true });
  const json = await mdb(['tail', '-n', '2', '--in', 'json', '--format', 'json'], JSON.stringify([{ text: 'one' }, { text: 'two' }, { text: 'three' }])); assert.deepEqual(JSON.parse(json.stdout), [{ text: 'two' }, { text: 'three' }]);
  const bad = await mdb(['head', '--in', 'ndjson'], '{"text":"ok"}\nnot json\n'); assert.notEqual(bad.code, 0); assert.match(bad.stderr, /invalid NDJSON/);
  const wc = await mdb(['wc', '-l', '--format', 'ndjson'], 'a\nb\n'); assert.deepEqual(JSON.parse(wc.stdout), { file: null, lines: 2 });
  rec('formats');
});
test('null-delimited records: -z on every record tool, and find -print0', async () => {
  assert.equal((await mdb(['sort', '-z'], 'b\0a\0c\0')).stdout, 'a\0b\0c\0');
  assert.equal((await mdb(['head', '-z', '-n', '2'], 'b\0a\0c\0')).stdout, 'b\0a\0');
  assert.equal((await mdb(['uniq', '-z'], 'a\0a\0b\0')).stdout, 'a\0b\0');
  assert.equal((await mdb(['grep', '-z', 'a'], 'xa\0b\0ya\0')).stdout, 'xa\0ya\0');
  assert.equal((await mdb(['cut', '-z', '-c', '1'], 'ab\0cd\0')).stdout, 'a\0c\0');
  assert.equal((await mdb(['sort', '-z'], 'line one\nwith newline\0a\0')).stdout, 'a\0line one\nwith newline\0', 'newlines inside records survive');
  rec('null-delimited');
});
test('streaming and bounds: head stops reading (SIGPIPE-like), tail is a ring, sort/line/deadline limits are errors not hangs', async t => {
  // head exits as soon as it has its lines, while the producer is still writing
  const producer = spawn(process.execPath, ['-e', 'let n=0;const w=()=>{while(process.stdout.write("line "+(n++)+"\\n")){}};process.stdout.on("drain",w);process.stdout.on("error",()=>process.exit(0));w();'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const head = spawn(process.execPath, [MDB, 'head', '-n', '3'], { stdio: [producer.stdout, 'pipe', 'pipe'] }); let out = ''; head.stdout.on('data', d => { out += d; });
  const code = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { head.kill(); resolve(-999); }, 20_000); head.on('close', c => { clearTimeout(timer); resolve(c); }); }); producer.kill();
  assert.equal(code, 0); assert.equal(out, 'line 0\nline 1\nline 2\n');
  const big = Array.from({ length: 200_000 }, (_, i) => `row ${i}`).join('\n') + '\n';
  assert.equal((await mdb(['tail', '-n', '2'], big)).stdout, 'row 199998\nrow 199999\n');
  const limited = await mdb(['sort'], big, { MDB_UNIX_MAX_BUFFER_LINES: '1000' }); assert.equal(limited.code, 2); assert.match(limited.stderr, /no external merge/);
  const long = await mdb(['head'], 'x'.repeat(5000) + '\n', { MDB_UNIX_MAX_LINE_BYTES: '1000' }); assert.notEqual(long.code, 0); assert.match(long.stderr, /line longer than/);
  const bytes = await mdb(['wc', '-c'], 'x'.repeat(5000), { MDB_UNIX_MAX_INPUT_BYTES: '1000' }); assert.notEqual(bytes.code, 0);
  const hang = spawn(process.execPath, [MDB, 'sort'], { env: { ...process.env, MDB_UNIX_DEADLINE_MS: '500' }, stdio: ['pipe', 'pipe', 'pipe'] }); let err = ''; hang.stderr.on('data', d => { err += d; }); hang.stdin.write('a\n');
  const hc = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { hang.kill(); resolve(-999); }, 20_000); hang.on('close', c => { clearTimeout(timer); resolve(c); }); }); t.after(() => hang.kill());
  assert.equal(hc, 130); assert.match(err, /deadline/);
  rec('streaming-and-bounds');
});
test('exit codes follow the tools: grep 0/1/2, diff 0/1/2, comm and sort -c report disorder with 1, usage errors never look like success', async () => {
  assert.equal((await mdb(['grep', 'a'], 'abc\n')).code, 0); assert.equal((await mdb(['grep', 'zzz'], 'abc\n')).code, 1);
  assert.equal((await mdb(['grep', '-E', '(a|b'], 'abc\n')).code, 2, 'bad pattern'); assert.equal((await mdb(['grep', 'a', '/nonexistent/file'], '')).code, 2, 'missing file');
  assert.equal((await mdb(['grep', '-q', 'a', '-', '/nonexistent/file'], 'abc\n')).code, 0, '-q: a match wins over errors');
  assert.equal((await mdb(['grep', '--bogus', 'x'], '')).code, 2); assert.equal((await mdb(['head', '--bogus'], '')).code, 1);
  const dir = await tempDir({ after: () => undefined }, 'unix-exit'); await fs.writeFile(path.join(dir, 'a'), 'x\ny\n'); await fs.writeFile(path.join(dir, 'b'), 'x\nz\n'); await fs.writeFile(path.join(dir, 'same'), 'x\ny\n');
  assert.equal((await mdb(['diff', path.join(dir, 'a'), path.join(dir, 'same')])).code, 0); assert.equal((await mdb(['diff', path.join(dir, 'a'), path.join(dir, 'b')])).code, 1); assert.equal((await mdb(['diff', path.join(dir, 'a'), path.join(dir, 'nope')])).code, 2);
  assert.equal((await mdb(['sort', '-c'], 'b\na\n')).code, 1); assert.equal((await mdb(['sort', '-c'], 'a\nb\n')).code, 0);
  await fs.writeFile(path.join(dir, 'u'), 'b\na\n'); await fs.writeFile(path.join(dir, 's'), 'a\nb\n'); const c = await mdb(['comm', path.join(dir, 'u'), path.join(dir, 's')]); assert.equal(c.code, 1); assert.match(c.stderr, /not in sorted order/);
  await fs.rm(dir, { recursive: true, force: true });
  rec('exit-codes');
});
test('vault operands: access control, pinned revisions, and local files inside a vault are refused', async t => {
  const w = await world(t); const id = w.a.id;
  const cat = await runCaptured('cat', [`mdb:${id}`], { client: w.owner }); assert.equal(cat.exitCode, 0); assert.equal(cat.stdout, 'run the pipeline\nasync steps are fine\nverify rollback\n');
  const hidden = await runCaptured('cat', [`mdb:${w.s.id}`], { client: w.agent }); assert.equal(hidden.exitCode, 1); assert.ok(!hidden.stdout.includes('SECRET')); assert.ok(!hidden.stderr.includes('Secret plan'));
  const missing = await runCaptured('cat', ['mdb:obj_doesnotexist'], { client: w.agent }); assert.equal(hidden.stderr.replace(w.s.id, 'X'), missing.stderr.replace('obj_doesnotexist', 'X'), 'unreadable and missing look the same');
  const rev1 = (await w.vault.get(id)).revisionId; const patched = await w.vault.patch({ objectId: id, expectedRevisionId: rev1, body: 'run the pipeline\nasync steps changed\nverify rollback\n' });
  const d = await runCaptured('diff', ['-u', '--label', 'old', '--label', 'new', `mdb:${id}@${rev1}`, `mdb:${id}`], { client: w.owner }); assert.equal(d.exitCode, 1);
  assert.equal(d.stdout, '--- old\n+++ new\n@@ -1,3 +1,3 @@\n run the pipeline\n-async steps are fine\n+async steps changed\n verify rollback\n'); void patched;
  const local = await run(['cat', path.join(w.root, 'mdb.yaml'), '--root', w.root]); assert.notEqual(local.code, 0);
  const inside = await run(['wc', '-l', path.join(w.root, '.mdb', 'events', 'commits.jsonl'), '--root', w.root]); assert.notEqual(inside.code, 0); assert.match(inside.stderr, /inside a vault/);
  const noLocal = await runCaptured('wc', ['/etc/passwd'], { client: w.owner }); assert.equal(noLocal.exitCode, 1);
  rec('vault-operands');
});
test('find and tree: deterministic, ACL-bound virtual tree; -print0; predicates; ndjson', async t => {
  const w = await world(t);
  const ownerFind = await runCaptured('find', ['/', '-type', 'f'], { client: w.owner }); const paths = ownerFind.stdout.trim().split('\n');
  assert.deepEqual(paths, [...paths].sort(), 'sorted output'); assert.equal(paths.length, 4); assert.ok(paths.every(p => p.endsWith('.md')));
  const again = await runCaptured('find', ['/', '-type', 'f'], { client: w.owner }); assert.equal(again.stdout, ownerFind.stdout, 'identical across runs');
  const agentFind = await runCaptured('find', ['/', '-type', 'f'], { client: w.agent }); assert.ok(!agentFind.stdout.includes(w.s.id) && !agentFind.stdout.includes('secret'), 'no hint of unreadable objects'); assert.equal(agentFind.stdout.trim().split('\n').length, 3);
  const dirsAgent = await runCaptured('find', ['/', '-type', 'd'], { client: w.agent }); assert.ok(!dirsAgent.stdout.includes('/workspaces/secret'));
  assert.equal((await runCaptured('find', ['/workspaces/app', '-kind', 'decision'], { client: w.owner })).stdout, `/workspaces/app/${w.b.id}.md\n`);
  assert.equal((await runCaptured('find', ['/', '-tag', 'alerts', '-print0'], { client: w.owner })).stdout, `/workspaces/app/${w.b.id}.md\0`);
  assert.equal((await runCaptured('find', ['/', '-title', 'deploy*'], { client: w.owner })).stdout, '', '-title is case-sensitive'); assert.equal((await runCaptured('find', ['/', '-ititle', 'deploy*'], { client: w.owner })).stdout, `/workspaces/app/${w.a.id}.md\n`);
  assert.equal((await runCaptured('find', ['/', '-type', 'f', '(', '-kind', 'note', '-o', '-kind', 'wiki_page', ')', '-not', '-path', '*secret*'], { client: w.owner })).stdout.trim().split('\n').length, 2);
  assert.equal((await runCaptured('find', ['/', '-maxdepth', '1'], { client: w.owner })).stdout.trim().split('\n').length, 6, '/ plus wiki shared discoveries profile workspaces');
  assert.equal((await runCaptured('find', ['/nope'], { client: w.owner })).exitCode, 1);
  const nd = await runCaptured('find', ['/', '-type', 'f', '--format', 'ndjson'], { client: w.owner }); assert.ok(nd.stdout.trim().split('\n').every(l => JSON.parse(l).path.endsWith('.md')));
  const tree = await runCaptured('tree', ['/', '--charset', 'ascii'], { client: w.agent }); assert.match(tree.stdout, /^\/\n/); assert.ok(!tree.stdout.includes('secret')); assert.match(tree.stdout, /\n\d+ directories, 3 files\n$/);
  const treeJson = JSON.parse((await runCaptured('tree', ['/', '-J', '-L', '2'], { client: w.owner })).stdout); assert.equal(treeJson[0].type, 'directory'); assert.equal(treeJson.at(-1).type, 'report');
  // a pipeline the way a shell would use it: find -print0 | xargs -0
  const piped = spawnSync('sh', ['-c', `"${process.execPath}" "${MDB}" find / -type f -name '*.md' -print0 --root "${w.root}" | xargs -0 -n1 echo`], { encoding: 'utf8' }); assert.equal(piped.stdout.trim().split('\n').length, 4);
  rec('find-tree');
});
test('grep --vault uses the text index and respects ACLs; cat/find ids chain into each other', async t => {
  const w = await world(t);
  const hit = await runCaptured('grep', ['--vault', '-F', 'async'], { client: w.owner }); assert.equal(hit.exitCode, 0); assert.equal(hit.stdout.trim().split('\n').length, 3, 'two app lines + the secret one for the owner');
  const agent = await runCaptured('grep', ['--vault', '-F', 'async'], { client: w.agent }); assert.ok(!agent.stdout.includes('SECRET')); assert.equal(agent.stdout.trim().split('\n').length, 2);
  assert.match(agent.stdout, new RegExp(`/workspaces/app/${w.a.id}|mdb://workspaces/app/objects/${w.a.id}`));
  assert.equal((await runCaptured('grep', ['--vault', '-F', 'nonexistent-needle'], { client: w.agent })).exitCode, 1);
  rec('grep-vault');
});
test('tee: copies stdin to stdout and files; never writes inside a vault, never follows symlinks, not available through MCP', async t => {
  const w = await world(t); const dir = await tempDir(t, 'tee');
  const ok = await run(['tee', path.join(dir, 'copy.txt')], { input: 'hello\nworld' }); assert.equal(ok.stdout, 'hello\nworld'); assert.equal(await fs.readFile(path.join(dir, 'copy.txt'), 'utf8'), 'hello\nworld');
  await run(['tee', '-a', path.join(dir, 'copy.txt')], { input: '!' }); assert.equal(await fs.readFile(path.join(dir, 'copy.txt'), 'utf8'), 'hello\nworld!');
  const inVault = await run(['tee', path.join(w.root, 'workspaces', 'note.md'), '--root', w.root], { input: 'x' }); assert.notEqual(inVault.code, 0); assert.match(inVault.stderr, /inside a vault/); await assert.rejects(fs.stat(path.join(w.root, 'workspaces', 'note.md')));
  const target = path.join(dir, 'target.txt'); await fs.writeFile(target, 'keep'); await fs.symlink(target, path.join(dir, 'link.txt'));
  const viaLink = await run(['tee', path.join(dir, 'link.txt')], { input: 'overwrite' }); assert.notEqual(viaLink.code, 0); assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  await assert.rejects(runCaptured('tee', ['x'], { client: w.owner }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await w.vault.verify()).ok, true);
  rec('tee-guards');
});
test('interoperability: installed jq / awk / sed consume our output; the bridge runs only sandboxable tools with an argument vector', async t => {
  const w = await world(t);
  const jq = spawnSync('which', ['jq']).status === 0;
  if (jq) {
    const nd = await mdb(['grep', '-n', 'async', `mdb:${w.a.id}`, '--root', w.root]); void nd;
    const lines = await run(['cat', w.a.id, '--format', 'ndjson', '--root', w.root]); const viaJq = spawnSync('jq', ['-r', '.lineNumber'], { input: lines.stdout, encoding: 'utf8' }); assert.equal(viaJq.stdout, '1\n2\n3\n');
    const bridge = await run(['filter', 'jq', '-r', '.text', '--root', w.root], { input: lines.stdout }); assert.equal(bridge.stdout.trim().split('\n').length, 3);
    for (const bad of [['-f', '/etc/hosts', '.'], ['--rawfile', 'x', '/etc/hosts', '.'], ['.', '/etc/hosts'], ['import "x" as x; .'], ['env']]) { const r = await run(['filter', 'jq', ...bad, '--root', w.root], { input: '{}' }); assert.notEqual(r.code, 0, bad.join(' ')); }
    rec('jq-bridge');
  }
  const awk = spawnSync('awk', ['{ print $1 }'], { input: (await run(['cat', w.a.id, '--root', w.root])).stdout, encoding: 'utf8' }); assert.equal(awk.stdout, 'run\nasync\nverify\n');
  const gawk = spawnSync('which', ['gawk']).status === 0;
  const viaAwk = await run(['filter', 'awk', '{print $1}', '--root', w.root], { input: 'a b\n' });
  if (gawk) assert.equal(viaAwk.stdout, 'a\n'); else { assert.notEqual(viaAwk.code, 0); assert.match(viaAwk.stderr, /GNU awk|gawk/); recordCase({ suite: 'unix-features', name: 'awk-bridge', status: 'PASS', detail: { notRun: 'gawk not installed: refusal verified, execution NOT_RUN' } }); }
  const tools = JSON.parse((await run(['tools', '--root', w.root])).stdout) as { interop: Array<{ tool: string; usable: boolean }>; nativeCommands: string[] }; assert.ok(tools.nativeCommands.includes('comm')); assert.equal(tools.interop.length, 3);
  rec('interop');
});
test('MCP mdb_unix: same results as the CLI, bound to the host identity, no local files, bounded output', async t => {
  const w = await world(t);
  const call = (tool: string, args: unknown, actor: [string, string]) => { const r = spawnSync(process.execPath, [MCP_BIN, '--root', w.root], { input: [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }].map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MDB_ACTOR_ID: actor[0], MDB_PERMISSIONS: actor[1] } }); const reply = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown }; return reply.result ? JSON.parse(reply.result.content[0]!.text) as Record<string, unknown> : { rpcError: reply.error }; };
  const owner: [string, string] = ['owner-host', '*'], agent: [string, string] = ['agent', 'workspace:app:read,global:wiki:read'];
  const viaMcp = call('mdb_unix', { command: 'cat', args: [`mdb:${w.a.id}`] }, owner) as { exitCode: number; stdout: string }; assert.equal(viaMcp.stdout, 'run the pipeline\nasync steps are fine\nverify rollback\n');
  assert.equal(viaMcp.stdout, (await run(['cat', w.a.id, '--root', w.root])).stdout, 'MCP and CLI agree');
  assert.equal((call('mdb_unix', { command: 'cat', args: [`mdb:${w.s.id}`] }, agent) as { exitCode: number }).exitCode, 1, 'agent cannot read the secret');
  assert.ok(!(call('mdb_unix', { command: 'find', args: ['/', '-type', 'f'] }, agent) as { stdout: string }).stdout.includes(w.s.id));
  assert.equal((call('mdb_unix', { command: 'sort', args: ['-r'], input: 'a\nc\nb\n' }, agent) as { stdout: string }).stdout, 'c\nb\na\n');
  assert.equal((call('mdb_unix', { command: 'wc', args: ['/etc/passwd'] }, owner) as { exitCode: number }).exitCode, 1, 'local files are not reachable');
  assert.ok(call('mdb_unix', { command: 'tee', args: [] }, owner).rpcError, 'tee is not an MCP command');
  assert.ok(call('mdb_unix', { command: 'cat', args: ['-'], principalId: 'owner' }, agent).rpcError, 'unknown keys are rejected');
  const big = call('mdb_unix', { command: 'cat', args: ['-'], input: 'x'.repeat(1_900_000) }, owner) as { stdout: string; truncated: boolean }; assert.ok(big.stdout.length <= 4_000_000);
  rec('mcp');
});
test('legacy meanings keep working: grep TEXT is still the index search, diff ID FROM TO is still the revision diff', async t => {
  const w = await world(t); const first = (await w.vault.get(w.a.id)).revisionId; const next = await w.vault.patch({ objectId: w.a.id, expectedRevisionId: first, body: 'changed\n' });
  const search = await run(['grep', 'async', '--root', w.root, '--json']); assert.equal(search.code, 0); assert.ok(Array.isArray((JSON.parse(search.stdout) as { hits: unknown[] }).hits));
  const scoped = await run(['grep', 'async', '--scope', 'workspace:app', '--root', w.root]); assert.equal(scoped.code, 0); assert.ok(JSON.parse(scoped.stdout).hits.length >= 1);
  const rev = await run(['diff', w.a.id, first, next.revisionId, '--root', w.root]); assert.equal(rev.code, 0, rev.stderr); assert.ok(rev.stdout.length > 0);
  void Vault;
});
