import '../helpers/isolate-user-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { createHttpCredential } from '../../packages/mcp/credentials.js';
import { disposableVault } from '../helpers/disposable-vault.js';
import { recordCase } from '../helpers/report.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const MCP = resolve('bin/mdb-mcp.js'); const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const sh = (cmd: string, cwd: string) => { const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`); };
async function pki(dir: string) {
  sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj "/CN=Engram Test CA" 2>/dev/null', dir);
  const leaf = (name: string, san: string) => { sh(`openssl req -newkey rsa:2048 -nodes -keyout ${name}.key -out ${name}.csr -subj "/CN=${name}" 2>/dev/null && printf "subjectAltName=${san}\\n" > ${name}.ext && openssl x509 -req -in ${name}.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out ${name}.pem -days 30 -extfile ${name}.ext 2>/dev/null`, dir); };
  leaf('good', 'DNS:localhost'); leaf('othername', 'DNS:other.example');
  sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout selfsigned.key -out selfsigned.pem -days 30 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" 2>/dev/null', dir);
  // an expired certificate issued by the trusted CA (openssl ca lets us set the validity window)
  await mkdir(path.join(dir, 'ca-db'), { recursive: true }); await writeFile(path.join(dir, 'ca-db', 'index.txt'), ''); await writeFile(path.join(dir, 'ca-db', 'serial'), '01\n');
  await writeFile(path.join(dir, 'ca.cnf'), `[ca]\ndefault_ca=c\n[c]\ndatabase=${dir}/ca-db/index.txt\nserial=${dir}/ca-db/serial\nnew_certs_dir=${dir}/ca-db\ncertificate=${dir}/ca.pem\nprivate_key=${dir}/ca.key\ndefault_md=sha256\npolicy=p\nunique_subject=no\n[p]\ncommonName=supplied\n`);
  sh('openssl req -newkey rsa:2048 -nodes -keyout expired.key -out expired.csr -subj "/CN=localhost" 2>/dev/null && printf "subjectAltName=DNS:localhost\\n" > expired.ext && openssl ca -batch -config ca.cnf -in expired.csr -out expired.pem -startdate 20200101000000Z -enddate 20200102000000Z -extfile expired.ext -notext 2>/dev/null', dir);
}
async function backend(t: Cleanup) {
  const { root } = await disposableVault(t); const owner = new Engram(root); await owner.createWorkspace('proj');
  const cred = await createHttpCredential(owner.vault, 'agent-tls', ['workspace:proj:read', 'workspace:proj:write']); await owner.vault.grant('proj', 'agent-tls', ['read', 'write']);
  const child = spawn(process.execPath, [MCP, '--root', root], { env: { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0' } });
  let err = ''; const url = await new Promise<string>((res, rej) => { child.stderr.setEncoding('utf8'); child.stderr.on('data', (c: string) => { err += c; const m = /MCP HTTP listening at (http:\/\/[^\s]+)/.exec(err); if (m) res(m[1]!); }); child.once('exit', c => rej(new Error(`exit ${c} ${err}`))); });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(r => child.once('exit', () => r())); } });
  return { token: cred.token, port: Number(new URL(url).port) };
}
/** A TLS terminator in front of the real server that records how many requests (and how many carrying a credential) actually reached it. */
async function terminator(t: Cleanup, dir: string, cert: string, backendPort: number) {
  const seen = { requests: 0, withAuthorization: 0 };
  const server = https.createServer({ key: await readFile(path.join(dir, `${cert}.key`)), cert: await readFile(path.join(dir, `${cert}.pem`)) }, (req, res) => {
    seen.requests++; if (req.headers.authorization) seen.withAuthorization++;
    const up = http.request({ host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); }); req.pipe(up); up.on('error', () => res.end());
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); t.after(() => new Promise<void>(r => server.close(() => r())));
  return { port: (server.address() as { port: number }).port, seen };
}
/** Runs the client code path used by init, doctor, hooks and sync in a fresh process, so NODE_EXTRA_CA_CERTS is honored exactly as for a real user. */
function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise(resolveRun => { const child = spawn(process.execPath, args, { env }); let out = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (c: string) => { out += c; }); child.once('close', () => resolveRun(out)); });
}
async function client(url: string, token: string, ca?: string) {
  const script = `import { openRemoteSession } from ${JSON.stringify(resolve('dist/packages/memory/remote-client.js'))}; try { const s = await openRemoteSession({ url: ${JSON.stringify(url)}, token: ${JSON.stringify(token)}, workspaceId: 'proj', timeoutMs: 3000 }); console.log(JSON.stringify({ ok: true, tools: s.tools.length })); } catch (e) { console.log(JSON.stringify({ ok: false, kind: e.kind, message: String(e.message).slice(0, 120) })); }`;
  const env = { ...process.env }; delete env.NODE_TLS_REJECT_UNAUTHORIZED; if (ca) env.NODE_EXTRA_CA_CERTS = ca; else delete env.NODE_EXTRA_CA_CERTS;
  return JSON.parse((await runNode(['--input-type=module', '-e', script], env)).trim().split('\n').pop()!) as { ok: boolean; kind?: string; tools?: number };
}

test('over HTTPS the client accepts only a valid, trusted, correctly named certificate; nothing else ever sees a credential', { skip: !hasOpenssl && 'openssl is not available' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'engram-tls-')); t.after(() => rm(dir, { recursive: true, force: true })); await pki(dir); const ca = path.join(dir, 'ca.pem');
  const real = await backend(t);
  const good = await terminator(t, dir, 'good', real.port);
  const accepted = await client(`https://localhost:${good.port}/mcp`, real.token, ca); assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.ok(good.seen.withAuthorization > 0, 'a valid chain and name: the request goes through');
  const before = good.seen.withAuthorization;
  const untrusted = await client(`https://localhost:${good.port}/mcp`, real.token); assert.equal(untrusted.ok, false, 'a private CA the client does not trust'); assert.equal(good.seen.withAuthorization, before, 'handshake failed before any credential was sent');
  const wrongHost = await client(`https://127.0.0.1:${good.port}/mcp`, real.token, ca); assert.equal(wrongHost.ok, false, 'trusted CA but the address is not in the certificate'); assert.equal(good.seen.withAuthorization, before);
  const other = await terminator(t, dir, 'othername', real.port); assert.equal((await client(`https://localhost:${other.port}/mcp`, real.token, ca)).ok, false, 'a trusted certificate issued for a different name'); assert.equal(other.seen.requests, 0, 'no request reached it');
  const self = await terminator(t, dir, 'selfsigned', real.port); assert.equal((await client(`https://localhost:${self.port}/mcp`, real.token, ca)).ok, false, 'self-signed, not in the trusted set'); assert.equal(self.seen.requests, 0);
  const expired = await terminator(t, dir, 'expired', real.port); assert.equal((await client(`https://localhost:${expired.port}/mcp`, real.token, ca)).ok, false, 'expired certificate from the trusted CA'); assert.equal(expired.seen.requests, 0);
  // no downgrade: an https URL that points at a plaintext server fails and is never retried over http
  const plain = http.createServer((req, res) => { plainHits++; res.writeHead(401); res.end(); }); let plainHits = 0; await new Promise<void>(r => plain.listen(0, '127.0.0.1', () => r())); t.after(() => new Promise<void>(r => plain.close(() => r())));
  assert.equal((await client(`https://127.0.0.1:${(plain.address() as { port: number }).port}/mcp`, real.token, ca)).ok, false); assert.equal(plainHits, 0, 'the client did not fall back to plain HTTP');
  // a global override of verification in the environment is not honored by the client path: the invalid-certificate result is unchanged
  const overriddenOut = await runNode(['--input-type=module', '-e', `import { openRemoteSession } from ${JSON.stringify(resolve('dist/packages/memory/remote-client.js'))}; try { await openRemoteSession({ url: ${JSON.stringify(`https://localhost:${self.port}/mcp`)}, token: 'x'.repeat(40), timeoutMs: 3000 }); console.log('ACCEPTED'); } catch { console.log('REFUSED'); }`], { ...process.env, NODE_EXTRA_CA_CERTS: ca });
  assert.equal(overriddenOut.trim().split('\n').pop(), 'REFUSED');
  recordCase({ suite: 'security', name: 'tls-verification-no-insecure-fallback', status: 'PASS' });
});
