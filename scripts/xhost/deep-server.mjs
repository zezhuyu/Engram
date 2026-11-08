// Server-side supervisor for scripts/xhost/physical-deep.mjs (run on the SERVER machine, with a disposable vault).
// It runs the Engram HTTP MCP service, restarts it when it exits, and exposes a tiny control interface for the deep client on the LAN path (separate from the
// network path that the client cuts): restart, kill9, markers?run=ID, rotate?id=CRED, revoke?id=CRED, verify. Every path must carry the one-time hook token.
//   node scripts/xhost/deep-server.mjs ROOT HOOKTOKEN LOGFILE HOOK_HOST [MCP_PORT=3333] [REQUESTS_PER_MINUTE]
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [root, token, logFile, hookHost, mcpPort = '3333', rpm = '1500'] = process.argv.slice(2);
if (!root || !token || token.length < 16 || !logFile || !hookHost) throw new Error('usage: deep-server.mjs ROOT HOOKTOKEN LOGFILE HOOK_HOST [PORT] [RPM]');
const repo = path.resolve(new URL('../../', import.meta.url).pathname); let child, starts = 0, stopping = false;
const allowedHosts = process.env.DEEP_ALLOWED_HOSTS ?? `127.0.0.1:${mcpPort},172.10.0.2:8444`;
// Clock skew for the SERVER process only: DEEP_FAKETIME_LIB names libfaketime's dylib, and the /faketime hook sets the offset (for example "+1d", empty for real time) and restarts the service.
let fake = '';
const fakeEnv = () => fake && process.env.DEEP_FAKETIME_LIB ? { DYLD_INSERT_LIBRARIES: process.env.DEEP_FAKETIME_LIB, DYLD_FORCE_FLAT_NAMESPACE: '1', FAKETIME: fake } : {};
const start = () => { if (stopping) return; starts++; child = spawn(process.execPath, ['bin/mdb-mcp.js'], { cwd: repo, env: { ...process.env, ...fakeEnv(), MDB_ROOT: root, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: mcpPort, MDB_MCP_HTTP_ALLOWED_HOSTS: allowedHosts, MDB_MCP_HTTP_REQUESTS_PER_MINUTE: rpm }, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')] }); child.on('exit', () => setTimeout(start, 500)); };
start();
const mdb = (...a) => spawnSync(process.execPath, ['bin/mdb.js', '--root', root, ...a], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const [, t, action] = url.pathname.split('/'); const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (t !== token) return send(404, {});
  if (action === 'restart') { child.kill('SIGTERM'); return send(200, { action, starts }); }
  if (action === 'kill9') { child.kill('SIGKILL'); return send(200, { action, starts }); }
  if (action === 'markers') { const out = path.join(os.tmpdir(), `deep-markers-${process.pid}.json`); const r = spawnSync(process.execPath, ['scripts/xhost/physical.mjs', 'server', '--root', root, '--run-id', url.searchParams.get('run') ?? '', '--out', out], { cwd: repo, encoding: 'utf8', timeout: 120_000 }); try { return send(200, JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { return send(500, { error: r.stderr.slice(0, 200) }); } }
  if (action === 'rotate') { const r = mdb('credential', 'rotate', url.searchParams.get('id') ?? '', '--json'); try { return send(200, JSON.parse(r.stdout)); } catch { return send(500, { error: (r.stderr || r.stdout).slice(0, 200) }); } }
  if (action === 'revoke') { const r = mdb('credential', 'revoke', url.searchParams.get('id') ?? ''); try { return send(200, JSON.parse(r.stdout)); } catch { return send(500, { revoked: false, error: (r.stderr || r.stdout).slice(0, 100) }); } }
  if (action === 'verify') { const r = mdb('verify'); try { return send(200, JSON.parse(r.stdout)); } catch { return send(500, {}); } }
  // events the server accepted over HTTP and then rejected during its asynchronous commit (for example "timestamp in the future"), counted by reason
  if (action === 'rejected') { const dir = path.join(root, '.mdb/capture/rejected'); const reasons = {}; let total = 0; try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.json')) continue; total++; try { const reason = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).reason ?? 'unknown'; reasons[reason] = (reasons[reason] ?? 0) + 1; } catch { reasons.unreadable = (reasons.unreadable ?? 0) + 1; } } } catch { /* no rejected directory yet */ } return send(200, { total, reasons }); }
  if (action === 'faketime') { fake = url.searchParams.get('value') ?? ''; if (fake && !/^[+-]\d+[smhd]$/.test(fake)) { fake = ''; return send(400, { error: 'value must look like +1d, -3h or empty' }); } child.kill('SIGTERM'); return send(200, { faketime: fake, enabled: !!process.env.DEEP_FAKETIME_LIB }); }
  // createdAt of the committed events of one run, as the SERVER recorded them (to see what a skewed client or server clock did to the timestamps)
  if (action === 'times') { const code = `import { Vault } from ${JSON.stringify(path.join(repo, 'dist/packages/core/vault.js'))}; const v = new Vault(${JSON.stringify(root)}); const run = ${JSON.stringify(url.searchParams.get('run') ?? '')}; const docs = (await v.listDocuments()).filter(d => String(d.body).includes('PHYS-' + run + '-')); console.log(JSON.stringify(docs.map(d => ({ createdAt: d.createdAt, updatedAt: d.updatedAt, marker: /PHYS-[\\\\w-]+/.exec(String(d.body))?.[0], capturedAt: d.metadata?.capturedAt ?? d.metadata?.event?.capturedAt }))));`; const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repo, encoding: 'utf8', timeout: 120_000 }); try { return send(200, JSON.parse(r.stdout.trim().split('\\n').pop())); } catch { return send(500, { error: (r.stderr || r.stdout).slice(0, 200) }); } }
  send(404, {});
}).listen(8450, hookHost, () => console.error(`deep-server: MCP on 127.0.0.1:${mcpPort}, hooks on ${hookHost}:8450`));
process.on('SIGTERM', () => { stopping = true; child?.kill('SIGKILL'); process.exit(0); });
