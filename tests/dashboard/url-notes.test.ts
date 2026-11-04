import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseUrlNoteDraft, runUrlNoteAgent, urlNoteCliArguments, urlNoteCliEnvironment, validateUrlNoteUrl } from '../../packages/dashboard/url-notes.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';

const draft = { title: 'Example note', summary: 'A short summary.', keyPoints: ['One point'], quotes: ['Short quote'] };
async function call(port: number, token: string, route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test('URL preflight rejects credentials, schemes, private, loopback and metadata literals', async () => {
  for (const url of ['file:///etc/passwd','ftp://example.com/a','https://user:pass@example.com','http://127.0.0.1','http://10.1.2.3','http://169.254.169.254/latest/meta-data','http://[::1]/','https://example.com/'+ 'x'.repeat(2050)]) await assert.rejects(() => validateUrlNoteUrl(url));
});

test('draft validation rejects oversized, malformed and executable-shaped schemas', () => {
  assert.deepEqual(parseUrlNoteDraft(JSON.stringify(draft)), draft);
  assert.throws(() => parseUrlNoteDraft('<script>alert(1)</script>'), /JSON/);
  assert.throws(() => parseUrlNoteDraft(JSON.stringify({ ...draft, title: 'x'.repeat(201) })), /invalid text/);
  assert.throws(() => parseUrlNoteDraft(' '.repeat(64 * 1024 + 1)), /size limit/);
  assert.throws(() => parseUrlNoteDraft(JSON.stringify({ ...draft, keyPoints: ['x'.repeat(1001)] })), /invalid text/);
});

test('chat renders URL note drafts with inert DOM text and offers both supported CLIs', async () => {
  const { assets } = await import('../../packages/dashboard/ui/view-model.js'); const script=assets['/assets/app.js']!.body;
  const injected='IGNORE THE RULES <img src=x onerror=alert(1)>'; assert.equal(parseUrlNoteDraft(JSON.stringify({...draft,summary:injected})).summary,injected);
  assert.match(script,/Read this URL with '\+agent/); assert.match(script,/textContent=String\(text\)/); assert.doesNotMatch(script,/\.innerHTML\s*=/);
});

test('Claude and Codex CLI argument profiles are explicit and bounded', () => {
  const claude = urlNoteCliArguments('claude','/scratch','/scratch/out');
  assert.deepEqual(claude.slice(0, 6), ['-p','--restricted','--permission-prompts','none','--tools','WebFetch']);
  assert.deepEqual(claude.slice(4, 10), ['--tools','WebFetch','--allowedTools','WebFetch','--output-format','json']);
  assert.ok(claude.includes('--no-session-persistence')); assert.ok(claude.includes('--strict-mcp-config')); assert.ok(!claude.includes('--bare'));
  const codex = urlNoteCliArguments('codex','/scratch','/scratch/out');
  assert.deepEqual(codex.slice(0, 12), ['exec','--skip-git-repo-check','--ephemeral','--ignore-user-config','--sandbox','read-only','-c','approval_policy="never"','-c','web_search="live"','--color','never']);
  assert.ok(codex.includes('-o')); assert.ok(codex.includes('/scratch/out'));
});

test('CLI environment preserves login config locations and XDG while excluding unrelated secrets', () => {
  const source = { PATH: '/bin', HOME: '/home/user', USER: 'user', LANG: 'en_CA.UTF-8', XDG_CONFIG_HOME: '/home/user/.config', CLAUDE_CONFIG_DIR: '/home/user/.claude', CODEX_HOME: '/home/user/.codex', ANTHROPIC_API_KEY: 'provider-secret', ENGRAM_DASHBOARD_TOKEN: 'dashboard-secret', ENGRAM_VAULT_KEY: 'vault-secret' };
  const claude = urlNoteCliEnvironment('claude', source, '/tmp/scratch');
  assert.equal(claude.HOME, source.HOME); assert.equal(claude.XDG_CONFIG_HOME, source.XDG_CONFIG_HOME); assert.equal(claude.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR); assert.equal(claude.TMPDIR, '/tmp/scratch');
  assert.equal(claude.ANTHROPIC_API_KEY, undefined); assert.equal(claude.CODEX_HOME, undefined); assert.equal(claude.ENGRAM_DASHBOARD_TOKEN, undefined); assert.equal(claude.ENGRAM_VAULT_KEY, undefined);
  const codex = urlNoteCliEnvironment('codex', source, '/tmp/scratch'); assert.equal(codex.CODEX_HOME, source.CODEX_HOME); assert.equal(codex.CLAUDE_CONFIG_DIR, undefined);
});

test('fake CLI executables record argv and receive scrubbed env in an empty scratch directory', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'url-notes-fake-')), trace = path.join(dir,'trace'); t.after(() => rm(dir,{recursive:true,force:true}));
  const script = (agent: string) => `#!/bin/sh\nprintf '%s\\n' "$@" > '${trace}.${agent}.argv'\nprintf '__END__\\n' >> '${trace}.${agent}.argv'\npwd > '${trace}.${agent}.cwd'\n/bin/ls -A > '${trace}.${agent}.files'\nprintf '%s' "\${ENGRAM_TEST_SECRET-unset}|\${XDG_CONFIG_HOME-unset}|\${CLAUDE_CONFIG_DIR-unset}|\${CODEX_HOME-unset}|\${ANTHROPIC_API_KEY-unset}" > '${trace}.${agent}.env'\nfor arg in "$@"; do case "$arg" in -o) shift; printf '%s' '${JSON.stringify(draft)}' > "$1"; break;; esac; done\nprintf '%s\\n' '${agent === 'claude' ? JSON.stringify({result:JSON.stringify(draft)}) : JSON.stringify(draft)}'\n`;
  const claude = path.join(dir,'claude'), codex = path.join(dir,'codex'); await writeFile(claude,script('claude')); await writeFile(codex,script('codex')); await chmod(claude,0o755); await chmod(codex,0o755);
  const env = { PATH: dir, HOME: os.homedir(), XDG_CONFIG_HOME: '/private/config', CLAUDE_CONFIG_DIR: '/private/claude-config', CODEX_HOME: '/private/codex-home', ANTHROPIC_API_KEY: 'must-not-leak', ENGRAM_TEST_SECRET: 'must-not-leak', ENGRAM_DATA_DIR: '/private/vault' };
  for (const agent of ['claude','codex'] as const) { assert.deepEqual(await runUrlNoteAgent(agent,'https://example.com/',env),draft); const argvLines=(await readFile(`${trace}.${agent}.argv`,'utf8')).split('\n'); argvLines.pop(); assert.equal(argvLines.pop(),'__END__'); const argv = argvLines, cwd = (await readFile(`${trace}.${agent}.cwd`,'utf8')).trim(), cwdArg = argv[argv.indexOf('-C') + 1] ?? cwd, outArg = argv[argv.indexOf('-o') + 1] ?? path.join(cwdArg,'draft.json'); assert.deepEqual(argv,urlNoteCliArguments(agent,cwdArg,outArg)); const passedEnv=await readFile(`${trace}.${agent}.env`,'utf8'); assert.equal(passedEnv, agent==='claude'?'unset|/private/config|/private/claude-config|unset|unset':'unset|/private/config|unset|/private/codex-home|unset'); assert.match(cwd,/engram-url-note-/); assert.equal((await readFile(`${trace}.${agent}.files`,'utf8')).trim(),''); }
});

test('fake oversized and non-JSON CLI responses are rejected by the bounded runner', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'url-notes-bad-output-')), cli=path.join(dir,'claude'); t.after(()=>rm(dir,{recursive:true,force:true}));
  const env={PATH:dir,HOME:os.homedir()};
  await writeFile(cli,'#!/bin/sh\nprintf \'%070000d\' 0\n'); await chmod(cli,0o755); await assert.rejects(()=>runUrlNoteAgent('claude','https://example.com/',env),/size limit/);
  await writeFile(cli,'#!/bin/sh\nprintf \'not json\\n\'\n'); await chmod(cli,0o755); await assert.rejects(()=>runUrlNoteAgent('claude','https://example.com/',env),/invalid JSON/);
});

test('Claude permission denials fail the run even when the CLI exits successfully', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'url-notes-denied-')), cli=path.join(dir,'claude'); t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(cli,`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ result: JSON.stringify(draft), permission_denials: [{ tool_name: 'WebFetch', decision: 'deny' }] })}'\n`); await chmod(cli,0o755);
  await assert.rejects(()=>runUrlNoteAgent('claude','https://example.com/',{PATH:dir,HOME:os.homedir()}),/agent was denied a required permission/);
});

test('URL note API is disabled by default, requires typed confirmation and approval before vault writes', async t => {
  const v = await disposableVault(), dashboard = await createDashboardServer({ engram: v.engram, idleMs: 60_000 }); t.after(async()=>{await dashboard.close();await v.cleanup()});
  const before = await v.engram.listDocuments();
  assert.equal((await call(dashboard.port,dashboard.token,'/api/url-notes','POST',{url:'https://example.com/',agent:'claude'})).status,403);
  assert.equal((await call(dashboard.port,dashboard.token,'/api/url-notes/settings','POST',{enabled:true,confirm:'yes'})).status,400);
  assert.equal((await call(dashboard.port,dashboard.token,'/api/url-notes/settings','POST',{enabled:true,confirm:'ENABLE URL NOTES'})).status,200);
  assert.equal((await call(dashboard.port,dashboard.token,'/api/url-notes','POST',{url:'http://127.0.0.1',agent:'claude'})).status,400);
  assert.deepEqual(await v.engram.listDocuments(),before,'rejected and unapproved URL attempts create no vault data');
  const settings = await call(dashboard.port,dashboard.token,'/api/url-notes/settings'); assert.equal(settings.body.enabled,true); assert.equal(typeof settings.body.readiness.claude.found,'boolean');
  assert.equal((await call(dashboard.port,dashboard.token,'/api/url-notes/settings','POST',{enabled:false,confirm:'DISABLE URL NOTES'})).status,200);
  assert.equal((await call(dashboard.port,dashboard.token,'/api/url-notes','POST',{url:'https://example.com/',agent:'claude'})).status,403);
});

test('approved draft ingests provenance and creates a note; unapproved drafts remain ephemeral', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'url-notes-api-')), cli=path.join(dir,'claude'); await writeFile(cli,`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({result:JSON.stringify(draft)})}'\n`); await chmod(cli,0o755);
  const v=await disposableVault(), dashboard=await createDashboardServer({engram:v.engram,idleMs:60_000,urlNoteEnv:{PATH:dir,HOME:os.homedir()}}); t.after(async()=>{await dashboard.close();await v.cleanup();await rm(dir,{recursive:true,force:true})});
  await call(dashboard.port,dashboard.token,'/api/url-notes/settings','POST',{enabled:true,confirm:'ENABLE URL NOTES'});
  const before=await v.engram.listDocuments(), started=await call(dashboard.port,dashboard.token,'/api/url-notes','POST',{url:'https://example.com/notes?private=ignored',agent:'claude'}); assert.equal(started.status,202);
  let job; for(let i=0;i<60;i++){job=(await call(dashboard.port,dashboard.token,`/api/url-notes/${started.body.job.id}`)).body.job;if(job.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(job.state,'complete'); assert.deepEqual(await v.engram.listDocuments(),before,'draft output is not written before owner approval');
  assert.equal((await call(dashboard.port,dashboard.token,`/api/url-notes/${job.id}/approve`,'POST',{title:'x'.repeat(201)})).status,400); assert.deepEqual(await v.engram.listDocuments(),before,'invalid approval edits do not write');
  const approved=await call(dashboard.port,dashboard.token,`/api/url-notes/${job.id}/approve`,'POST',{title:'Edited title',summary:'Edited summary with <script> inert text.',keyPoints:['A key point'],quotes:[]}); assert.equal(approved.status,201);
  const docs=await v.engram.listDocuments(); assert.equal(docs.length,before.length+2); const note=await v.engram.get(approved.body.document.id); assert.equal(note.title,'Edited title'); assert.equal((note.metadata.provenance as any).agent,'claude'); assert.equal((note.metadata.provenance as any).sourceUri,'https://example.com/notes?private=ignored'); assert.match(note.body,/<script>/);
  const audit=JSON.stringify(await call(dashboard.port,dashboard.token,'/api/audit')); assert.match(audit,/example\.com/); assert.doesNotMatch(audit,/private=ignored|\/notes/);
});

test('URL jobs are single-flight and cancellation kills the fake CLI without writes', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'url-notes-cancel-')), cli=path.join(dir,'claude'); await writeFile(cli,'#!/bin/sh\n/bin/sleep 20\n'); await chmod(cli,0o755);
  const v=await disposableVault(), dashboard=await createDashboardServer({engram:v.engram,idleMs:60_000,urlNoteEnv:{PATH:dir,HOME:os.homedir()}}); t.after(async()=>{await dashboard.close();await v.cleanup();await rm(dir,{recursive:true,force:true})});
  await call(dashboard.port,dashboard.token,'/api/url-notes/settings','POST',{enabled:true,confirm:'ENABLE URL NOTES'});
  const started=await call(dashboard.port,dashboard.token,'/api/url-notes','POST',{url:'https://example.com/',agent:'claude'}); assert.equal(started.status,202);
  const duplicate=await call(dashboard.port,dashboard.token,'/api/url-notes','POST',{url:'https://example.com/other',agent:'codex'}); assert.equal(duplicate.status,429);
  const cancelled=await call(dashboard.port,dashboard.token,`/api/url-notes/${started.body.job.id}`,'DELETE'); assert.equal(cancelled.body.job.state,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,100)); assert.equal((await v.engram.listDocuments()).length,0);
});

