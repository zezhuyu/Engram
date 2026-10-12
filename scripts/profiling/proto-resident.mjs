// Study experiment (NOT product code): the best case for a resident process. Usage: node proto-resident.mjs <vault root> [requests]
// Starts a warm in-process engine behind a Unix socket (no authentication: the prototype only bounds latency), then times (a) in-process requests and (b) fresh client processes that connect and ask.
import net from 'node:net'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync, spawn } from 'node:child_process'; import { performance } from 'node:perf_hooks';
const repo = path.resolve(import.meta.dirname, '../..');
if (process.argv[2] === '--client') { const [, , , sock, kind] = process.argv; const q = kind === 'cjk' ? { query: '知识库', mode: 'grep', limit: 1000 } : { query: 'zz-no-such-token-zz', mode: 'grep', limit: 50 }; const c = net.connect(sock, () => c.write(JSON.stringify(q) + '\n')); let buf = ''; c.on('data', d => { buf += d; if (buf.endsWith('\n')) { process.stdout.write(buf.length + ''); c.end(); } }); }
else {
  const [root, n = '200'] = process.argv.slice(2); const { Vault } = await import(path.join(repo, 'dist/packages/core/vault.js')); const { FilesystemSearch } = await import(path.join(repo, 'dist/packages/search-files/index.js'));
  const sock = path.join(os.tmpdir(), `engram-proto-${process.pid}.sock`); const boot = performance.now(); const engine = new FilesystemSearch(new Vault(root)); await engine.query({ query: 'zz-no-such-token-zz', mode: 'grep', limit: 50 }); const warmMs = performance.now() - boot;
  const server = net.createServer(c => { let buf = ''; c.on('data', async d => { buf += d; if (!buf.endsWith('\n')) return; const r = await engine.query(JSON.parse(buf)); c.write(JSON.stringify({ hits: r.hits.length }) + '\n'); buf = ''; }); }); await new Promise(r => server.listen(sock, r));
  const med = a => [...a].sort((x, y) => x - y)[a.length >> 1], p95 = a => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
  const out = { residentWarmupMs: +warmMs.toFixed(0) };
  for (const kind of ['nohit', 'cjk']) {
    const req = kind === 'cjk' ? { query: '知识库', mode: 'grep', limit: 1000 } : { query: 'zz-no-such-token-zz', mode: 'grep', limit: 50 }; const inproc = []; for (let i = 0; i < Number(n); i++) { const t = performance.now(); await engine.query(req); inproc.push(performance.now() - t); }
    const clients = []; const bare = []; for (let i = 0; i < 20; i++) { let t = performance.now(); await new Promise(res => { const p = spawn(process.execPath, [import.meta.filename, '--client', sock, kind], { stdio: 'ignore' }); p.on('exit', res); }); clients.push(performance.now() - t); t = performance.now(); spawnSync(process.execPath, ['-e', '']); bare.push(performance.now() - t); }
    out[kind] = { inProcessP50: +med(inproc).toFixed(1), inProcessP95: +p95(inproc).toFixed(1), freshClientProcessWallP50: +med(clients).toFixed(0), bareNodeP50: +med(bare).toFixed(0) };
  }
  server.close(); fs.rmSync(sock, { force: true }); console.log(JSON.stringify({ ...out, note: 'prototype without authentication, revocation, staleness checks or crash handling; it only bounds what a resident process can save' }, null, 2)); process.exit(0);
}
