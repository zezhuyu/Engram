// Minimal TLS terminator standing in for Caddy: HTTPS on 0.0.0.0:PORT -> HTTP on 127.0.0.1:3333 (the loopback upstream the deployment guide requires).
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
const [port, cert, key] = process.argv.slice(2);
https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: 3333, method: req.method, path: req.url, headers: req.headers }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(Number(port), '0.0.0.0', () => console.error(`tls-proxy listening on ${port}`));
