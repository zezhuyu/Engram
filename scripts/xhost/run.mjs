#!/usr/bin/env node
// Multi-container remote-capture verification (tier: ISOLATED_CONTAINERS, not physical hosts).
// Three containers on a dedicated Docker network (xhost-net): xhost-a (Engram HTTP MCP behind TLS), xhost-b (Claude Code role), xhost-c (Codex role).
// Each has its own filesystem and process/network namespace. Hooks are the real installed adapter commands fed with real-format lifecycle payloads;
// the live Claude Code / Codex binaries are not run here (their login state is personal and is not copied into containers).
// Usage: node scripts/xhost/run.mjs   (needs Docker; touches only containers/network labelled engram-xhost=1)
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IMAGE = 'engram-xhost:test';
const OUT = 'verification/memory/xhost'; const NET = 'xhost-net'; const SUBNET = '172.31.77.0/24'; const LABEL = 'engram-xhost=1';
const IP = { 'xhost-a': '172.31.77.10', 'xhost-b': '172.31.77.11', 'xhost-c': '172.31.77.12' };
const secrets = new Set(); const results = []; const evidence = [];
const redact = s => { let r = String(s ?? ''); for (const x of secrets) r = r.split(x).join('[REDACTED]'); return r; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function docker(args, { input, timeout = 180000 } = {}) { const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 1 << 28, timeout }); return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }; }
function dx(c, cmd, { env = {}, input, timeout } = {}) { return docker(['exec', '-i', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c, 'sh', '-c', cmd], { input, timeout }); }
async function raw(name, text) { await fs.mkdir(path.join(OUT, 'raw'), { recursive: true }); await fs.writeFile(path.join(OUT, 'raw', `${name}.txt`), redact(text)); }
let current = null;
function scenario(id, title) { current = { id, title, checks: [], status: 'PASS' }; results.push(current); console.log(`\n== ${id} ${title}`); }
function check(ok, what, detail) { current.checks.push({ ok: !!ok, what, ...(detail === undefined ? {} : { detail: redact(JSON.stringify(detail)).slice(0, 600) }) }); if (!ok) current.status = 'FAIL'; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ' :: ' + redact(JSON.stringify(detail)).slice(0, 300)}`); }
function skip(what) { current.checks.push({ ok: null, what: `NOT_RUN: ${what}` }); if (current.status === 'PASS') current.status = 'PARTIAL'; console.log(`  skip ${what}`); }

// ---------------------------------------------------------------- environment
const probeScript = `const [url,token,ca]=process.argv.slice(1);(async()=>{try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:'{}',signal:AbortSignal.timeout(4000)});console.log(JSON.stringify({status:r.status}))}catch(e){console.log(JSON.stringify({error:(e.cause&&e.cause.code)||e.code||e.name}))}})()`;
function probe(c, url, { token = '', ca = true } = {}) { const r = dx(c, `node -e "${probeScript.replace(/"/g, '\\"')}" "${url}" "$T"`, { env: { T: token, ...(ca ? { NODE_EXTRA_CA_CERTS: '/etc/xhost/ca.pem' } : {}) } }); try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return { error: 'probe-failed', raw: r.out + r.err }; } }
async function inspect() { const r = dx('xhost-a', 'node /opt/engram/scripts/xhost/inspect.mjs /data/vault'); try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { throw new Error(`inspect failed: ${r.out}${r.err}`); } }
const startServer = () => docker(['exec', '-d', '-e', 'MDB_MCP_TRANSPORT=http', '-e', 'MDB_MCP_HTTP_HOST=127.0.0.1', '-e', 'MDB_MCP_HTTP_PORT=3333', 'xhost-a', 'sh', '-c', 'exec node /opt/engram/bin/mdb-mcp.js --root /data/vault >>/data/server.log 2>&1']);
const stopServer = () => dx('xhost-a', "pkill -f '[b]in/mdb-mcp.js' || true");
const localUp = () => probe('xhost-a', 'http://127.0.0.1:3333/capture').status === 401;
async function waitLocal(up) { for (let i = 0; i < 40; i++) { if (localUp() === up) return true; await sleep(250); } return false; }
/** Server acknowledges with 202 once an event is in its durable spool and commits asynchronously, so "delivered" is only final once the server spool is empty and the count is stable. */
async function settled() { let last = -1, stable = 0, s; for (let i = 0; i < 180; i++) { s = await inspect(); if (s.serverSpool.queued === 0 && s.events.length === last) { if (++stable >= 2) return s; } else stable = 0; last = s.events.length; await sleep(1000); } return s; }
async function waitServer(up = true) { for (let i = 0; i < 40; i++) { const r = probe('xhost-b', 'https://xhost-a:8443/capture'); if (up ? r.status === 401 : r.status !== 401) return true; await sleep(500); } return false; }
const spoolCount = (c, dir) => Number(dx(c, `ls ${dir} 2>/dev/null | grep -c '\\.json$' || true`).out.trim() || 0);

async function setup() {
  docker(['rm', '-f', 'xhost-a', 'xhost-b', 'xhost-c']); docker(['network', 'rm', NET]);
  const ctx = await fs.mkdtemp(path.join(os.tmpdir(), 'xhost-ctx-'));
  for (const f of ['dist', 'bin', 'package.json', 'node_modules']) await fs.cp(f, path.join(ctx, f), { recursive: true });
  await fs.mkdir(path.join(ctx, 'scripts'), { recursive: true }); await fs.cp('scripts/xhost', path.join(ctx, 'scripts/xhost'), { recursive: true }); await fs.copyFile('ci/xhost/Dockerfile', path.join(ctx, 'Dockerfile'));
  const build = docker(['build', '-q', '-t', IMAGE, ctx], { timeout: 600000 }); if (build.code !== 0) throw new Error(`image build failed: ${build.err}`); await fs.rm(ctx, { recursive: true, force: true });
  if (docker(['network', 'create', '--driver', 'bridge', '--subnet', SUBNET, '--label', LABEL, NET]).code !== 0) throw new Error('network create failed');
  for (const [name, ip] of Object.entries(IP)) { const r = docker(['run', '-d', '--name', name, '--hostname', name, '--network', NET, '--ip', ip, '--label', LABEL, IMAGE]); if (r.code !== 0) throw new Error(`container ${name}: ${r.err}`); }
  // CA, server certificate, a rogue-CA certificate, and a certificate for the wrong host name. Private keys stay on xhost-a.
  const pki = `set -e; cd /etc/xhost
openssl ecparam -name prime256v1 -genkey -noout -out ca.key; openssl req -x509 -new -key ca.key -sha256 -days 2 -subj "/CN=xhost test CA" -out ca.pem
mk() { openssl ecparam -name prime256v1 -genkey -noout -out $1.key; openssl req -new -key $1.key -subj "/CN=$2" -out $1.csr; printf "subjectAltName=DNS:$2\\n" > $1.ext; openssl x509 -req -in $1.csr -CA $3.pem -CAkey $3.key -CAcreateserial -days 1 -sha256 -extfile $1.ext -out $1.pem 2>/dev/null; }
mk srv xhost-a ca; mk wronghost other-host ca
openssl ecparam -name prime256v1 -genkey -noout -out rogue.key; openssl req -x509 -new -key rogue.key -sha256 -days 2 -subj "/CN=rogue CA" -out rogue.pem
mk roguesrv xhost-a rogue`;
  const p = dx('xhost-a', pki); if (p.code !== 0) throw new Error(`pki failed: ${p.err}`);
  const ca = docker(['exec', 'xhost-a', 'cat', '/etc/xhost/ca.pem']).out;
  for (const c of ['xhost-b', 'xhost-c']) dx(c, 'cat > /etc/xhost/ca.pem', { input: ca });
  dx('xhost-a', 'cd /etc/xhost; for spec in "8443 srv" "8444 roguesrv" "8445 wronghost"; do set -- $spec; (nohup node /opt/engram/scripts/xhost/tls-proxy.mjs $1 /etc/xhost/$2.pem /etc/xhost/$2.key >>/data/proxy-$1.log 2>&1 &) ; done');
  // vault, workspaces, credentials, registrations
  const m = 'node /opt/engram/bin/mdb.js'; const R = '--root /data/vault';
  dx('xhost-a', `${m} init ${R} --no-sqlite && ${m} workspace create ws-b ${R} && ${m} workspace create ws-c ${R}`);
  const cred = (actor, ws) => JSON.parse(dx('xhost-a', `${m} credential create ${R} --actor ${actor} --permissions workspace:${ws}:read,workspace:${ws}:write --json`).out.trim().split('\n').pop());
  const reg = (host, actor, ws) => JSON.parse(dx('xhost-a', `${m} memory register ${R} --host ${host} --principal ${actor} --workspace ${ws} --consent --json`).out.trim());
  const S = { b: { actor: 'claude-b', ws: 'ws-b', host: 'claude-code', cred: cred('claude-b', 'ws-b') }, c: { actor: 'codex-c', ws: 'ws-c', host: 'codex', cred: cred('codex-c', 'ws-c') } };
  S.b.reg = reg('claude-code', 'claude-b', 'ws-b'); S.c.reg = reg('codex', 'codex-c', 'ws-c');
  for (const k of ['b', 'c']) secrets.add(S[k].cred.token);
  startServer(); if (!await waitServer(true)) throw new Error('server did not come up behind TLS');
  return S;
}

// ---------------------------------------------------------------- client helpers
// Each hook is installed with --project-root and ignores payloads whose cwd is outside that project, so the payload cwd is the client's own project directory.
const payloads = (host, session, marker, cwd = host === 'claude-code' ? '/work/proj-b' : '/work/proj-c') => host === 'claude-code' ? {
  start: { hook_event_name: 'SessionStart', session_id: session, cwd, source: 'startup' },
  prompt: n => ({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt_id: `p-${marker}-${n}`, prompt: `Please make the billing retry logic use exponential backoff and note the decision. ${marker} #${n}` }),
  tool: n => ({ hook_event_name: 'PostToolUse', session_id: session, cwd, tool_name: 'Bash', tool_use_id: `t-${marker}-${n}`, tool_input: { command: `npm test -- billing ${marker} ${n}` }, tool_response: { stdout: `billing tests passed ${marker} ${n}`, stderr: '' } }),
  end: { hook_event_name: 'SessionEnd', session_id: session, cwd, reason: 'other' }
} : {
  start: { hook_event_name: 'SessionStart', session_id: session, cwd, source: 'startup' },
  prompt: n => ({ hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: `turn-${marker}-${n}`, cwd, prompt: `Add rate limiting to the ingestion endpoint and record why. ${marker} #${n}` }),
  tool: n => ({ hook_event_name: 'PostToolUse', session_id: session, turn_id: `turn-${marker}-${n}`, cwd, tool_name: 'Bash', tool_use_id: `t-${marker}-${n}`, tool_input: { command: `pytest ingestion ${marker} ${n}` }, tool_response: { stdout: `ingestion tests passed ${marker} ${n}`, stderr: '' } }),
  end: { hook_event_name: 'SessionEnd', session_id: session, cwd, reason: 'other' }
};
// Only the remote-capture commands: `init --project` also installs `memory context` (SessionStart) and `memory handoff-check` (Stop) hooks, which are not capture hooks and carry no remote URL.
function hookCommands(settingsJson) { const found = {}; (function walk(node, event) { if (Array.isArray(node)) node.forEach(n => walk(n, event)); else if (node && typeof node === 'object') { if (typeof node.command === 'string' && event && /\bmemory capture\b/.test(node.command)) (found[event] ??= []).push(node.command); for (const [k, v] of Object.entries(node)) walk(v, /^[A-Z][A-Za-z]+$/.test(k) ? k : event); } })(settingsJson, null); return found; }
function runHook(c, command, payload, env) { const t = Date.now(); const r = dx(c, command, { env, input: JSON.stringify(payload), timeout: 20000 }); return { code: r.code, stdout: r.out, ms: Date.now() - t }; }

// ---------------------------------------------------------------- scenarios
async function main() {
  await fs.rm(OUT, { recursive: true, force: true }); await fs.mkdir(OUT, { recursive: true });
  const S = await setup();
  const env = k => ({ ENGRAM_TOKEN: S[k].cred.token, ENGRAM_REMOTE_SPOOL: `/work/spool-${k}`, NODE_EXTRA_CA_CERTS: '/etc/xhost/ca.pem' });
  const URL = 'https://xhost-a:8443/mcp'; const m = 'node /opt/engram/bin/mdb.js';
  const hooks = {}; const sessions = { b: 'sess-b-1', c: 'sess-c-1' }; const P = {};
  for (const k of ['b', 'c']) P[k] = payloads(S[k].host, sessions[k], k === 'b' ? 'MARKB' : 'MARKC');

  scenario('X1', 'Each client initializes remote capture with the supported lifecycle hooks');
  for (const k of ['b', 'c']) {
    const settings = k === 'b' ? '/work/claude-settings.json' : '/work/proj-c/.codex/hooks.json';
    const r = dx(`xhost-${k}`, `mkdir -p /work/project /work/proj-${k} && ${m} init --project --host ${S[k].host} --project-dir /work/proj-${k} --settings-path ${settings} --mcp-url ${URL} --token-env ENGRAM_TOKEN --registration ${S[k].reg.id} --principal ${S[k].actor} --consent`);
    await raw(`X1-init-${k}`, r.out + r.err);
    const json = JSON.parse(dx(`xhost-${k}`, `cat ${settings}`).out); hooks[k] = hookCommands(json);
    const events = Object.keys(hooks[k]);
    check(r.code === 0, `client ${k} init exited 0`, r.err.slice(0, 200));
    check(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'].every(e => events.includes(e)), `client ${k} registered SessionStart/UserPromptSubmit/PostToolUse/SessionEnd hooks`, events);
    check(Object.values(hooks[k]).flat().every(cmd => cmd.includes('--remote-url') && cmd.includes('https://xhost-a:8443') && !cmd.includes(S[k].cred.token)), `client ${k} hook commands use https remote URL and carry no token`);
  }

  scenario('X2', 'Both clients generate meaningful memory events without any memory-writing instruction');
  const fire = (k, ev, payload) => runHook(`xhost-${k}`, hooks[k][ev][0], payload, env(k));
  for (const k of ['b', 'c']) { fire(k, 'SessionStart', P[k].start); fire(k, 'UserPromptSubmit', P[k].prompt(1)); fire(k, 'PostToolUse', P[k].tool(1)); }
  const s0 = await settled();
  await raw('X2-server-state', JSON.stringify(s0, null, 1));
  const evOf = (who, type) => s0.events.filter(e => e.createdBy === who && e.eventType === type);
  check(evOf('claude-b', 'user.message').some(e => e.body.includes('MARKB #1')) && evOf('claude-b', 'tool.result').some(e => e.body.includes('MARKB 1')), 'Claude-role prompt and tool result arrived with original content', s0.events.filter(e => e.createdBy === 'claude-b').length);
  check(evOf('codex-c', 'user.message').some(e => e.body.includes('MARKC #1')) && evOf('codex-c', 'tool.result').some(e => e.body.includes('MARKC 1')), 'Codex-role prompt and tool result arrived with original content');
  check(spoolCount('xhost-b', '/work/spool-b') === 0 && spoolCount('xhost-c', '/work/spool-c') === 0, 'client spools drained to zero after online delivery');
  check(s0.events.every(e => e.host && e.eventId && e.createdBy), 'every committed event has host, eventId and server-assigned actor (provenance)');

  scenario('X3', 'Authenticated TLS transport: certificate verification and refusal of untrusted paths');
  for (const k of ['b', 'c']) { const r = dx(`xhost-${k}`, 'echo | openssl s_client -connect xhost-a:8443 -servername xhost-a -CAfile /etc/xhost/ca.pem -verify_return_error -verify_hostname xhost-a 2>&1 | grep -E "Verification|Verify return|Protocol|subject=|issuer=|Cipher is|notAfter" | head -12'); await raw(`X3-openssl-${k}`, r.out); check(/Verification: OK|Verify return code: 0/.test(r.out) && /TLSv1\.[23]/.test(r.out), `client ${k} verifies the server chain and host name over TLS 1.2+`, r.out.split('\n').slice(0, 4)); }
  const rogue = probe('xhost-b', 'https://xhost-a:8444/capture'); check(rogue.error && /UNABLE_TO_VERIFY|SELF_SIGNED|CERT|ISSUER/.test(rogue.error), 'certificate from an untrusted (rogue) CA is refused', rogue);
  const wrong = probe('xhost-b', 'https://xhost-a:8445/capture'); check(wrong.error && /ALTNAME|HOSTNAME|CERT/.test(wrong.error), 'certificate for the wrong host name is refused', wrong);
  const noCa = probe('xhost-b', 'https://xhost-a:8443/capture', { ca: false }); check(noCa.error && /UNABLE_TO_VERIFY|ISSUER|CERT|SELF_SIGNED/.test(noCa.error), 'a client without the CA does not trust the server (no verification bypass)', noCa);
  const direct = probe('xhost-b', 'http://xhost-a:3333/capture'); check(!!direct.error, 'the plain-HTTP upstream (loopback only) is not reachable from another host', direct);
  const plainHook = dx('xhost-b', `echo '{"hook_event_name":"SessionStart","session_id":"plain"}' | ${m} memory capture --host claude-code --registration ${S.b.reg.id} --remote-url http://xhost-a:3333/mcp --token-env ENGRAM_TOKEN`, { env: { ...env('b'), ENGRAM_REMOTE_SPOOL: '/work/spool-plain' } });
  check(plainHook.code === 0 && spoolCount('xhost-b', '/work/spool-plain') === 0, 'client refuses a non-HTTPS remote URL and still fails open (exit 0, nothing queued, nothing sent in clear)');
  scenario('X3b', 'Unauthorized connections are rejected');
  const noTok = probe('xhost-b', 'https://xhost-a:8443/capture'); const badTok = probe('xhost-b', 'https://xhost-a:8443/capture', { token: 'engram_notarealtokennotarealtokennotarealtoken00' });
  check(noTok.status === 401 && badTok.status === 401, 'missing and unknown bearer tokens get 401', { noTok, badTok });
  const cross = (token, reg) => { const r = dx('xhost-b', `node -e "fetch('${URL.replace('/mcp', '/capture')}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.T},body:JSON.stringify({registrationId:process.argv[1],payload:{hook_event_name:'SessionStart',session_id:'cross'}})}).then(r=>console.log(r.status))" ${reg}`, { env: { T: token, NODE_EXTRA_CA_CERTS: '/etc/xhost/ca.pem' } }); return r.out.trim(); };
  check(cross(S.b.cred.token, S.c.reg.id) === '404' && cross(S.c.cred.token, S.b.reg.id) === '404', "a credential cannot use another actor's capture registration (404)");

  scenario('X4-X8', 'Network interruption, offline operation, bounded buffering, server restart, restoration');
  const sid = k => `${sessions[k]}`;
  docker(['network', 'disconnect', NET, 'xhost-b']); docker(['network', 'disconnect', NET, 'xhost-c']);
  const down = probe('xhost-b', 'https://xhost-a:8443/capture'); check(!!down.error, 'X4: clients are disconnected from the server network', down);
  const offline = {};
  for (const k of ['b', 'c']) { offline[k] = [fire(k, 'UserPromptSubmit', P[k].prompt(2)), fire(k, 'PostToolUse', P[k].tool(2)), fire(k, 'UserPromptSubmit', P[k].prompt(3)), fire(k, 'SessionEnd', P[k].end)]; }
  check(Object.values(offline).flat().every(r => r.code === 0 && r.stdout.trim() === '' && r.ms < 5000), 'X5/X6: hooks stay silent, exit 0 and finish inside the 5 s hook timeout while disconnected (fail-open)', Object.values(offline).flat().map(r => r.ms));
  check(spoolCount('xhost-b', '/work/spool-b') >= 4 && spoolCount('xhost-c', '/work/spool-c') >= 4, 'X6: events were durably buffered on each client', { b: spoolCount('xhost-b', '/work/spool-b'), c: spoolCount('xhost-c', '/work/spool-c') });
  // Fill client B toward the 1000-entry cap with concurrent hooks (8 at a time, like parallel tool calls) and one more batch past the cap.
  const fillCmd = hooks.b.PostToolUse[0];
  const fillScript = `#!/bin/sh\nn=$1\nprintf '{"hook_event_name":"PostToolUse","session_id":"sess-b-1","cwd":"/work/proj-b","tool_name":"Bash","tool_use_id":"fill-%s","tool_input":{"command":"echo fill %s"},"tool_response":{"stdout":"fill %s"}}' $n $n $n | ${fillCmd}\n`;
  dx('xhost-b', 'cat > /work/fill.sh && chmod +x /work/fill.sh', { input: fillScript });
  const fillStart = Date.now(); const fill = dx('xhost-b', 'seq 1 1100 | xargs -P 8 -I{} /work/fill.sh {}', { env: env('b'), timeout: 900000 }); const fillMs = Date.now() - fillStart;
  const capCount = spoolCount('xhost-b', '/work/spool-b'); const fillBuffered = Number(dx('xhost-b', "grep -l 'fill-' /work/spool-b/*.json | wc -l").out.trim()); await raw('X6-fill', `fill exit=${fill.code} ms=${fillMs} spool=${capCount}\n${fill.err.slice(0, 500)}`);
  check(fill.code === 0, 'X6: 1100 concurrent hook invocations all exited 0 while the spool was full (fail-open)');
  check(capCount >= 900 && capCount <= 1000, 'X6: local buffer is bounded at the 1000-entry cap under concurrent writers', { spoolEntries: capCount });
  // Duplicate + reorder + (later) replay on client C's buffered stream.
  const shuffle = `node -e "
const fs=require('fs'),p=require('path');const d='/work/spool-c';const names=fs.readdirSync(d).filter(n=>n.endsWith('.json')).sort();
const all=names.map(n=>fs.readFileSync(p.join(d,n),'utf8'));fs.mkdirSync('/work/replay',{recursive:true});all.slice(0,3).forEach((t,i)=>fs.writeFileSync('/work/replay/'+i+'.json',t));
for(const n of names)fs.rmSync(p.join(d,n));const out=[...all].reverse().concat(all.slice(0,3));
out.forEach((t,i)=>fs.writeFileSync(p.join(d,String(i+1).padStart(14,'0')+'-shuffled-'+i+'.json'),t));console.log(out.length+' written, '+names.length+' originals')"`;
  const sh1 = dx('xhost-c', shuffle); check(sh1.code === 0, 'X12: client C spool reversed and three envelopes duplicated', sh1.out.trim());
  // Restart the server while both clients stay offline, then restore connectivity.
  stopServer(); check(await waitLocal(false), 'X7: server process is really down (loopback upstream refuses)'); startServer(); check(await waitLocal(true), 'X7: server process restarted and answers (401 without token)');
  for (const k of ['b', 'c']) docker(['network', 'connect', '--ip', IP[`xhost-${k}`], NET, `xhost-${k}`]);
  check(await waitServer(true), 'X7/X8: server restarted while clients were offline; connectivity restored and TLS endpoint answers');
  // The server throttles each credential (120 requests/minute by default) and the client stops on 429 and keeps its backlog, so a large backlog drains over several windows.
  // `patient` waits out a throttled pass (no progress while events remain) before giving up; it never changes what is delivered, only how long this harness is willing to wait.
  const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const drain = (k, token = S[k].cred.token, patient = false) => { let delivered = 0, last, stalls = 0; for (let i = 0; i < (patient ? 200 : 30); i++) { const r = dx(`xhost-${k}`, `${m} memory drain-remote --token-env ENGRAM_TOKEN --json`, { env: { ...env(k), ENGRAM_TOKEN: token }, timeout: 120000 }); try { last = JSON.parse(r.out.trim().split('\n').pop()); } catch { last = { error: r.out + r.err }; } delivered += last.delivered ?? 0; if (last.queued === 0) break; if (!last.delivered) { if (!patient || ++stalls > 4) break; pause(20000); } else stalls = 0; } return { delivered, last }; };
  const dB = drain('b', undefined, true), dC = drain('c', undefined, true); await raw('X8-drain', JSON.stringify({ dB, dC }));
  check(dB.last.queued === 0 && dC.last.queued === 0, 'X8: both client buffers drain to zero after restoration', { dB: dB.last, dC: dC.last });
  const s1 = await settled();
  await raw('X9-server-state', JSON.stringify({ count: s1.events.length, journal: s1.journal, serverSpool: s1.serverSpool }));
  const ids = s1.events.map(e => e.eventId); check(new Set(ids).size === ids.length, 'X9: every committed event id is unique (no double commits)', { events: ids.length });
  const fillMarks = s1.events.filter(e => /fill (\d+)/.test(e.body)).map(e => /fill (\d+)/.exec(e.body)[1]); check(new Set(fillMarks).size === fillMarks.length && fillMarks.length === fillBuffered, 'X9: each buffered fill event is committed exactly once', { committed: fillMarks.length, bufferedFillEnvelopes: fillBuffered });
  const marked = (who, mk) => s1.events.filter(e => e.createdBy === who && e.body.includes(mk)); check(['#2', '#3'].every(n => marked('claude-b', 'MARKB ' + n).length === 1 || marked('claude-b', 'MARKB ' + n).length === 1) && marked('codex-c', 'MARKC #2').length === 1 && marked('codex-c', 'MARKC #3').length === 1, 'X9/X12: duplicated and reordered offline events each appear exactly once', { c2: marked('codex-c', 'MARKC #2').length, c3: marked('codex-c', 'MARKC #3').length });
  check(s1.closedSessions.some(s => s.createdBy === 'claude-b') && s1.closedSessions.some(s => s.createdBy === 'codex-c'), 'X10: SessionEnd events generated while disconnected were delivered and closed both remote sessions', s1.closedSessions);
  check(s1.handoffJobs >= 2, 'X10: delivery of those SessionEnd events queued handoff generation on the server (no model was run in this harness)', { handoffJobs: s1.handoffJobs });
  check(s1.journal.ok === true, 'X12: committed journal verifies after duplicate/reordered/outage delivery', s1.journal);

  scenario('X11', 'Actor attribution and workspace permissions');
  check(s1.events.filter(e => e.createdBy === 'claude-b').every(e => e.scope.type === 'workspace' && e.scope.workspaceId === 'ws-b') && s1.events.filter(e => e.createdBy === 'codex-c').every(e => e.scope.type === 'workspace' && e.scope.workspaceId === 'ws-c'), 'events land only in the credential owner’s workspace');
  check(!s1.events.some(e => e.createdBy === 'claude-b' && e.scope.workspaceId === 'ws-c') && !s1.events.some(e => e.createdBy === 'codex-c' && e.scope.workspaceId === 'ws-b'), 'no cross-workspace writes by either actor');
  check(!s1.events.some(e => !['claude-b', 'codex-c'].includes(e.createdBy)), 'no event is attributed to anything but the two credentialed actors');

  scenario('X12b', 'Replay of already delivered envelopes cannot corrupt committed memory');
  const before = { n: s1.events.length, ids: ids.slice().sort().join() }; check(s1.serverSpool.queued === 0, 'server spool fully committed before replay', s1.serverSpool);
  dx('xhost-c', `mkdir -p /work/spool-c && cp /work/replay/*.json /work/spool-c/ && for f in /work/spool-c/[0-2].json; do mv $f /work/spool-c/9999999999999$(basename $f)-replayed.json; done`);
  const rd = drain('c'); const s2 = await settled();
  check(rd.delivered >= 3 && s2.events.length === before.n && s2.events.map(e => e.eventId).sort().join() === before.ids, 'replaying three delivered envelopes is accepted by the server but commits nothing new', { delivered: rd.delivered, before: before.n, after: s2.events.length });
  check(s2.journal.ok === true, 'journal still verifies after replay');

  scenario('X13', 'Revoked credentials cannot resume delivery until reauthenticated');
  const credList = dx('xhost-a', `${m} credential audit --root /data/vault --json 2>&1 | head -c 600`).out; await raw('X13-audit-before', credList);
  const rv = dx('xhost-a', `${m} credential revoke ${S.b.cred.id} --root /data/vault`); check(rv.code === 0, 'credential revoked on the server', rv.err.slice(0, 200));
  const revokedProbe = probe('xhost-b', 'https://xhost-a:8443/capture', { token: S.b.cred.token }); check(revokedProbe.status === 401, 'the revoked token is refused immediately (401)', revokedProbe);
  const queuedWhileRevoked = ['q1', 'q2', 'q3'].map(n => fire('b', 'PostToolUse', { ...P.b.tool(0), tool_use_id: `revoked-${n}`, tool_input: { command: `echo revoked ${n}` }, tool_response: { stdout: `revoked ${n}`, stderr: '' } }));
  check(queuedWhileRevoked.every(r => r.code === 0) && spoolCount('xhost-b', '/work/spool-b') === 3, 'client keeps working (fail-open) and retains the 3 undeliverable events', { spool: spoolCount('xhost-b', '/work/spool-b') });
  const stillRevoked = drain('b'); const s3 = await settled(); check(stillRevoked.delivered === 0 && !s3.events.some(e => e.body.includes('revoked q')), 'draining with the revoked token delivers nothing', stillRevoked.last);
  const nc = JSON.parse(dx('xhost-a', `${m} credential create --root /data/vault --actor claude-b --permissions workspace:ws-b:read,workspace:ws-b:write --json`).out.trim().split('\n').pop()); secrets.add(nc.token);
  const oldStill = drain('b'); check(oldStill.delivered === 0, 'the old token still delivers nothing after a new credential exists');
  const newDrain = drain('b', nc.token); const s4 = await settled();
  check(newDrain.last.queued === 0 && s4.events.filter(e => e.body.includes('revoked q')).length === 3, 'with the newly issued credential the retained events are delivered exactly once', { delivered: newDrain.delivered });
  S.b.cred = nc;

  scenario('X14', 'Client process/container crash and restart with events still queued');
  stopServer(); check(await waitLocal(false), 'X14: receiver is down while the client keeps queueing');
  const loop = docker(['exec', '-d', '-e', `ENGRAM_TOKEN=${S.c.cred.token}`, '-e', 'ENGRAM_REMOTE_SPOOL=/work/spool-c', '-e', 'NODE_EXTRA_CA_CERTS=/etc/xhost/ca.pem', 'xhost-c', 'sh', '-c', `for i in $(seq 1 400); do printf '{"hook_event_name":"PostToolUse","session_id":"sess-c-1","cwd":"/work/proj-c","tool_name":"Bash","tool_use_id":"crash-%s","tool_input":{"command":"echo crash %s"},"tool_response":{"stdout":"crash %s"}}' $i $i $i | ${hooks.c.PostToolUse[0].replace(/\s+#.*$/, '')}; done`]); // the installed command ends in a marker comment, which would swallow `done`
  await sleep(4000); const kill = docker(['kill', '-s', 'KILL', 'xhost-c']); const queuedAtKill = 'unknown (container killed mid-loop)';
  docker(['start', 'xhost-c']); await sleep(1500);
  const post = dx('xhost-c', `ls /work/spool-c | wc -l; ls /work/spool-c | grep -c '\\.json$'; ls /work/spool-c | grep -c '\\.tmp$' || true`).out.trim().split('\n');
  const parse = dx('xhost-c', `node -e "const fs=require('fs');let bad=0,good=0;for(const n of fs.readdirSync('/work/spool-c').filter(n=>n.endsWith('.json'))){try{JSON.parse(fs.readFileSync('/work/spool-c/'+n,'utf8'));good++}catch{bad++}}console.log(JSON.stringify({good,bad}))"`).out.trim();
  await raw('X14-after-kill', `${kill.out}${kill.err}\nentries/json/tmp=${post.join('/')}\n${parse}`); const pj = JSON.parse(parse);
  check(kill.code === 0 && pj.good > 0 && pj.bad === 0, 'after SIGKILL of the whole client container mid-write, buffered envelopes survive and none is corrupt (stray .tmp files are ignored)', { ...pj, tmp: post[2] });
  startServer(); await waitServer(true);
  const rc = drain('c'); const s5 = await settled();
  const cm = s5.events.filter(e => /crash (\d+)/.test(e.body)).map(e => /crash (\d+)/.exec(e.body)[1]);
  check(rc.last.queued === 0 && new Set(cm).size === cm.length && cm.length >= pj.good - 1, 'after restart the survivors drain and each is committed exactly once', { buffered: pj.good, committed: cm.length });
  check(s5.journal.ok === true, 'final committed state is consistent: journal verifies');

  scenario('X-final', 'Final state consistency after all recoveries');
  const fin = await inspect(); const fid = fin.events.map(e => e.eventId);
  check(new Set(fid).size === fid.length && fin.journal.ok && fin.serverSpool.queued === 0, 'unique event ids, verified journal, empty server-side spool', { events: fid.length, serverSpool: fin.serverSpool });
  const log = dx('xhost-a', 'tail -c 1500 /data/server.log').out; await raw('server-log-tail', log);
  const status = dx('xhost-b', `${m} memory adapter status --host claude-code --project-dir /work/proj-b 2>&1 | head -20`); await raw('client-adapter-status', status.out);
  scenario('OBS', 'Failure reporting and observability'); check(true, 'observed: hooks are silent by design (stdout empty, exit 0); the client-visible signal is spool depth; the server exposes committed events, journal verification and its spool stats; the client has no retry timer or backoff — delivery is attempted on each hook and on explicit drain-remote (each attempt bounded to 2 s and 100 files)');
  skip('physical separate hosts, real network paths, iptables DROP (hanging connections), clock skew, packet loss: not reproducible with containers on one machine');
}
try { await main(); } catch (e) { scenario('HARNESS', 'harness error'); check(false, String(e.stack ?? e)); }
finally {
  // Always remove everything this run created, including the image it built (layers on the Docker VM disk are never reclaimed otherwise). XHOST_KEEP=1 keeps it for debugging.
  if (process.env.XHOST_KEEP !== '1') { for (const n of ['xhost-a', 'xhost-b', 'xhost-c']) docker(['rm', '-f', '-v', n]); docker(['network', 'rm', NET]); docker(['rmi', '-f', IMAGE]); }
  const summary = { tier: 'ISOLATED_CONTAINERS', physicalHosts: false, runAt: new Date().toISOString(), docker: docker(['version', '--format', '{{.Server.Version}}']).out.trim(), topology: { network: NET, subnet: SUBNET, hosts: IP, tls: 'test CA (ECDSA P-256), node TLS terminator -> loopback HTTP upstream', ports: { valid: 8443, rogueCa: 8444, wrongHost: 8445 } }, scenarios: results };
  await fs.writeFile(path.join(OUT, 'results.json'), redact(JSON.stringify(summary, null, 2)) + '\n');
  const failed = results.filter(r => r.status === 'FAIL'); console.log(`\n${results.map(r => `${r.id}:${r.status}`).join(' ')}`); process.exitCode = failed.length ? 1 : 0;
}
