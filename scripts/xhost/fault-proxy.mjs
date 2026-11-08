// TLS fault-injection proxy for the physical fault tests (run on the SERVER machine, in front of the Engram HTTP service on 127.0.0.1:3333).
// It emulates a lossy path at the connection level without root: resets, replies lost AFTER the server committed them, delay, black hole, truncated replies.
// The mode is set over a control endpoint that needs the token.   node fault-proxy.mjs CERTDIR LISTEN_HOST LISTEN_PORT CTL_HOST CTL_PORT CTL_TOKEN
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
const [dir, host, port, ctlHost, ctlPort, token] = process.argv.slice(2);
if (!dir || !host || !port || !ctlHost || !ctlPort || !token || token.length < 16) throw new Error('usage: fault-proxy.mjs CERTDIR HOST PORT CTL_HOST CTL_PORT TOKEN');
const MODES = new Set(['ok', 'reset', 'lose-response', 'delay', 'blackhole', 'truncate']);
let mode = 'ok'; const stats = {}; const bump = key => { stats[key] = (stats[key] ?? 0) + 1; }; const chance = p => Math.random() < p;
https.createServer({ cert: fs.readFileSync(`${dir}/srv.pem`), key: fs.readFileSync(`${dir}/srv.key`) }, (req, res) => {
  const m = mode; bump(m);
  if (m === 'blackhole') { req.resume(); return; } // the request is read and never answered
  if (m === 'reset' && chance(0.4)) { bump('reset-applied'); req.socket.destroy(); return; }
  const forward = () => {
    const up = http.request({ host: '127.0.0.1', port: 3333, method: req.method, path: req.url, headers: req.headers }, r => {
      if (m === 'lose-response' && chance(0.5)) { bump('response-dropped'); r.resume(); r.on('end', () => req.socket.destroy()); return; } // the server already handled the request
      if (m === 'truncate' && chance(0.5)) { bump('truncated'); res.writeHead(r.statusCode ?? 502, { ...r.headers, 'content-length': '1000' }); res.write('x'); setTimeout(() => req.socket.destroy(), 50); return; }
      res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  };
  if (m === 'delay') setTimeout(forward, 3000); else forward();
}).listen(Number(port), host, () => console.error(`fault-proxy on ${host}:${port} -> 127.0.0.1:3333`));
http.createServer((req, res) => {
  const [, t, action, value] = req.url.split('/'); res.setHeader('content-type', 'application/json');
  if (t !== token) { res.writeHead(404).end('{}'); return; }
  if (action === 'mode' && MODES.has(value)) { mode = value; res.end(JSON.stringify({ mode })); return; }
  if (action === 'stats') { res.end(JSON.stringify({ mode, stats })); return; }
  res.writeHead(404).end('{}');
}).listen(Number(ctlPort), ctlHost);
