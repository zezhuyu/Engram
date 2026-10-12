#!/usr/bin/env node
// Physical multi-host remote-capture verification kit. Run `client` on each client machine, `server` on the machine that runs the Engram HTTP MCP server, then `merge`.
//   client: node scripts/xhost/physical.mjs client --url https://HOST/mcp --registration REG --token-env ENGRAM_TOKEN --cut 'CMD' --restore 'CMD' [--ca ca.pem] [--restart-server 'CMD'] [--out client.json]
//   server: node scripts/xhost/physical.mjs server --root /srv/engram --run-id RUNID [--out server.json]
//   merge : node scripts/xhost/physical.mjs merge client.json [client2.json ...] server.json [--out verification/memory/physical-hosts.json]
// `--cut` / `--restore` are shell commands YOU supply that really interrupt and restore the client's network path (e.g. a firewall rule or a disabled interface). The kit never
// guesses them, never disables TLS verification, and records host identity so the release gate can refuse evidence that does not come from distinct, non-container machines.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
const [, , role, ...rest] = process.argv; const argv = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--'))); /* positional arguments only: a flag's value is not one */ const flag = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const root = new URL('../../', import.meta.url).pathname; const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex');
function hostIdentity() {
  let machineId = ''; try { machineId = process.platform === 'darwin' ? /IOPlatformUUID" = "([^"]+)/.exec(execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }))?.[1] ?? '' : readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* unknown */ }
  const container = existsSync('/.dockerenv') || (existsSync('/proc/1/cgroup') && /docker|kubepods|containerd/.test(readFileSync('/proc/1/cgroup', 'utf8')));
  const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && !n.internal && n.family === 'IPv4').map(n => n.address).sort();
  return { hostId: machineId ? sha(machineId).slice(0, 24) : 'unknown', hostname: os.hostname(), platform: `${os.type()} ${os.release()} ${os.arch()}`, addresses: nets, containerDetected: !!container, node: process.version };
}
const out = async (name, report) => { const file = flag('out') ?? name; await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true }); await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(`wrote ${file}: ${report.steps ? report.steps.map(s => `${s.id}=${s.status}`).join(' ') : report.status}`); };
const runShell = cmd => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 120000 });

if (role === 'client') {
  const url = flag('url'), registration = flag('registration'), tokenEnv = flag('token-env'); const cut = flag('cut'), restore = flag('restore');
  if (!url || !registration || !tokenEnv || !process.env[tokenEnv]) { console.error('client needs --url, --registration and --token-env (with the token set)'); process.exit(2); }
  const { queueRemoteCapture, drainRemoteCaptureSpool } = await import(new URL('dist/packages/memory/remote-spool.js', `file://${root}`).href);
  const runId = flag('run-id') ?? randomUUID().slice(0, 8); const token = process.env[tokenEnv]; const spool = flag('spool') ?? await fs.mkdtemp(path.join(os.tmpdir(), 'engram-physical-'));
  if (flag('ca')) process.env.NODE_EXTRA_CA_CERTS = path.resolve(flag('ca'));
  const steps = []; const step = (id, status, detail) => { steps.push({ id, status, ...(detail === undefined ? {} : { detail }) }); console.log(`${status.padEnd(8)} ${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 200)}`); };
  const markers = []; const payload = (n, kind) => { const m = `PHYS-${runId}-${kind}-${n}`; markers.push(m); return { hook_event_name: 'UserPromptSubmit', session_id: `phys-${runId}`, cwd: '/w', prompt_id: m, prompt: `physical verification ${m}` }; };
  const base = new URL(url); const captureUrl = `${base.origin}${base.pathname.replace(/\/mcp$/, '')}/capture`;
  step('identity', 'PASS', hostIdentity());
  // TLS: the platform trust store (or --ca) must accept the server certificate and host name; nothing is bypassed.
  const { isTailnetHost, tailnetTrusted } = await import(new URL('dist/packages/core/private-network.js', `file://${root}`).href);
  // Opt-in private-network mode (MDB_TRANSPORT_TRUST=tailscale): plain HTTP to a tailnet host. TLS is then NOT tested and the report says so; it is never silently skipped.
  const tailnetMode = base.protocol === 'http:' && tailnetTrusted(process.env) && isTailnetHost(base.hostname);
  const cert = tailnetMode ? { authorized: false } : await new Promise(resolve => { const s = tls.connect({ host: base.hostname, port: Number(base.port || 443), servername: base.hostname }, () => { const c = s.getPeerCertificate(); resolve({ authorized: s.authorized, authError: s.authorizationError ?? null, subject: c.subject?.CN ?? null, issuer: c.issuer?.CN ?? null, validTo: c.valid_to ?? null, fingerprint256: c.fingerprint256 ?? null, protocol: s.getProtocol() }); s.end(); }); s.on('error', e => resolve({ authorized: false, authError: e.code ?? e.message })); });
  if (tailnetMode) { const mine = Object.values(os.networkInterfaces()).flat().some(n => n && n.family === 'IPv4' && isTailnetHost(n.address)); step('tls-certificate-verified', mine ? 'NOT_APPLICABLE' : 'FAIL', { transport: 'tailscale-wireguard', tlsTested: false, serverHost: base.hostname, clientHasTailnetAddress: mine }); }
  else step('tls-certificate-verified', cert.authorized ? 'PASS' : 'FAIL', cert);
  const probe = async tok => { try { const r = await fetch(captureUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: '{}', signal: AbortSignal.timeout(5000) }); return r.status; } catch (e) { return `error:${e.cause?.code ?? e.code ?? e.name}`; } };
  step('unauthorized-rejected', (await probe('')) === 401 && (await probe('engram_invalid_token_for_physical_check_000000')) === 401 ? 'PASS' : 'FAIL');
  let before = 0; for (let i = 1; i <= 3; i++) { const r = await queueRemoteCapture({ url, registrationId: registration, token, payload: payload(i, 'online'), directory: spool }); before += r.delivered; }
  const queuedOnline = (await fs.readdir(spool)).filter(n => n.endsWith('.json')).length; step('online-delivery', queuedOnline === 0 ? 'PASS' : 'FAIL', { delivered: before, queued: queuedOnline });
  if (!cut || !restore) { step('network-interruption', 'NOT_RUN', 'supply --cut and --restore commands that really interrupt and restore this machine\'s path to the server'); }
  else {
    const c = runShell(cut); await sleep(1500); const down = await probe(token); step('network-interruption', String(down).startsWith('error:') && c.status === 0 ? 'PASS' : 'FAIL', { cutExit: c.status, probe: down });
    const times = []; for (let i = 1; i <= 20; i++) { const t = Date.now(); await queueRemoteCapture({ url, registrationId: registration, token, payload: payload(i, 'offline'), directory: spool }).catch(() => undefined); times.push(Date.now() - t); }
    const end = { hook_event_name: 'SessionEnd', session_id: `phys-${runId}`, cwd: '/w', reason: 'other' }; await queueRemoteCapture({ url, registrationId: registration, token, payload: end, directory: spool }).catch(() => undefined);
    const buffered = (await fs.readdir(spool)).filter(n => n.endsWith('.json')).length; step('offline-buffering-fail-open', buffered >= 21 && Math.max(...times) < 5000 ? 'PASS' : 'FAIL', { buffered, maxMs: Math.max(...times) });
    // duplicate and reorder the buffered stream
    const names = (await fs.readdir(spool)).filter(n => n.endsWith('.json')).sort(); const bodies = await Promise.all(names.map(n => fs.readFile(path.join(spool, n), 'utf8'))); for (const n of names) await fs.rm(path.join(spool, n));
    [...bodies].reverse().concat(bodies.slice(0, 3)).forEach((b, i) => fs.writeFile(path.join(spool, `${String(i + 1).padStart(14, '0')}-shuffled-${i}.json`), b));
    await sleep(200); step('duplicate-reorder-injected', 'PASS', { entries: bodies.length + 3 });
    if (flag('restart-server')) { const r = runShell(flag('restart-server')); step('server-restart-during-outage', r.status === 0 ? 'PASS' : 'FAIL', { exit: r.status }); } else step('server-restart-during-outage', 'NOT_RUN', 'supply --restart-server to restart the server while this client is offline');
    const r = runShell(restore); await sleep(2000); const up = await probe(''); step('network-restored', r.status === 0 && up === 401 ? 'PASS' : 'FAIL', { restoreExit: r.status, probe: up });
    let rounds = 0, delivered = 0, left = 1; while (left && rounds++ < 50) { const d = await drainRemoteCaptureSpool({ token, directory: spool }); delivered += d.delivered; left = d.queued; if (left) await sleep(500); } step('backlog-drained', left === 0 ? 'PASS' : 'FAIL', { delivered, left, rounds });
  }
  await out(`verification/memory/physical-client-${hostIdentity().hostname}.json`, { role: 'client', runId, at: new Date().toISOString(), url: `${base.origin}`, registration, host: hostIdentity(), markers, steps });
} else if (role === 'server') {
  const rootDir = flag('root'), runId = flag('run-id'); if (!rootDir || !runId) { console.error('server needs --root and --run-id'); process.exit(2); }
  const { Vault } = await import(new URL('dist/packages/core/vault.js', `file://${root}`).href); const vault = new Vault(rootDir); const docs = await vault.listDocuments();
  const mine = docs.filter(d => String(d.body).includes(`PHYS-${runId}-`)); const markers = mine.map(d => /PHYS-[\w-]+/.exec(String(d.body))?.[0]).filter(Boolean); const counts = new Map(); for (const m of markers) counts.set(m, (counts.get(m) ?? 0) + 1);
  const verify = await vault.verify(); const actors = [...new Set(mine.map(d => d.createdBy))]; const closed = docs.filter(d => d.kind === 'session' && d.metadata.lifecycle === 'closed' && String(d.title).length).length;
  await out(`verification/memory/physical-server-${hostIdentity().hostname}.json`, { role: 'server', runId, at: new Date().toISOString(), host: hostIdentity(), committed: markers.length, unique: counts.size, duplicates: [...counts].filter(([, n]) => n > 1).map(([m]) => m), markers: [...counts.keys()].sort(), actors, closedSessions: closed, journalVerifyOk: verify.ok, status: verify.ok ? 'OK' : 'JOURNAL_INVALID' });
} else if (role === 'merge') {
  const files = argv; const reports = await Promise.all(files.map(async f => JSON.parse(await fs.readFile(f, 'utf8')))); const clients = reports.filter(r => r.role === 'client'), servers = reports.filter(r => r.role === 'server');
  const problems = []; if (!clients.length || servers.length !== 1) problems.push('need at least one client report and exactly one server report'); const server = servers[0];
  const hostIds = new Set([...clients, ...servers].map(r => r.host?.hostId)); if (hostIds.has('unknown') || hostIds.size < clients.length + servers.length) problems.push('every report must come from a distinct machine with a readable machine id'); if (clients.length + servers.length < 2) problems.push('at least two machines are required');
  for (const r of [...clients, ...servers]) if (r.host?.containerDetected) problems.push(`${r.host.hostname} looks like a container, which does not count as a physical host`);
  const required = ['tls-certificate-verified', 'unauthorized-rejected', 'online-delivery', 'network-interruption', 'offline-buffering-fail-open', 'duplicate-reorder-injected', 'network-restored', 'backlog-drained'];
  for (const c of clients) for (const id of required) { const s = c.steps.find(x => x.id === id); const tailnetTls = id === 'tls-certificate-verified' && s?.status === 'NOT_APPLICABLE' && s.detail?.transport === 'tailscale-wireguard' && s.detail?.clientHasTailnetAddress === true; if (!s || (s.status !== 'PASS' && !tailnetTls)) problems.push(`${c.host.hostname}: ${id} is ${s?.status ?? 'missing'}`); }
  const transports = [...new Set(clients.map(c => c.steps.find(x => x.id === 'tls-certificate-verified')?.status === 'PASS' ? 'https' : 'tailscale-wireguard'))]; if (transports.length > 1) problems.push('clients used different transports: ' + transports.join(', '));
  for (const c of clients) { const expected = new Set(c.markers); const got = new Set(server?.markers ?? []); const missing = [...expected].filter(m => !got.has(m)); if (missing.length) problems.push(`${c.host.hostname}: ${missing.length} marker(s) never committed on the server`); }
  if (server) { if (server.duplicates.length) problems.push(`server committed duplicates: ${server.duplicates.length}`); if (!server.journalVerifyOk) problems.push('server journal does not verify'); }
  const optional = clients.flatMap(c => c.steps.filter(s => s.status === 'NOT_RUN').map(s => `${c.host.hostname}: ${s.id}`));
  const report = { kind: 'physical-multi-host-remote-capture', at: new Date().toISOString(), physicalHostVerified: problems.length === 0, transport: transports[0] ?? 'unknown', tlsVerified: transports[0] === 'https', hosts: [...clients, ...servers].map(r => ({ role: r.role, ...r.host })), problems, notRunOptional: optional, requiredSteps: required };
  await fs.mkdir('verification/memory', { recursive: true }); await fs.writeFile(flag('out') ?? 'verification/memory/physical-hosts.json', JSON.stringify(report, null, 2) + '\n'); console.log(report.physicalHostVerified ? 'PHYSICAL HOST VERIFICATION: PASS' : `PHYSICAL HOST VERIFICATION: INCOMPLETE\n - ${problems.join('\n - ')}`); process.exit(report.physicalHostVerified ? 0 : 1);
} else { console.error('usage: physical.mjs client|server|merge (see the header of this file)'); process.exit(2); }
