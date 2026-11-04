import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';

export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
export type RequestOptions = { method?: string; headers?: Record<string, string>; body?: string; host?: string };

export function requestDashboard(port: number, url: string, options: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const req = request({ host: '127.0.0.1', port, path: url, method: options.method ?? 'GET', headers: {
      Host: options.host ?? `127.0.0.1:${port}`,
      ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
      ...options.headers,
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', error => reject(new Error(`${options.method ?? 'GET'} ${url}: ${error.message}`, { cause: error })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function makeDisposableVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-dashboard-matrix-'));
  const prior = process.env.MDB_DASHBOARD_AUTH_FILE;
  process.env.MDB_DASHBOARD_AUTH_FILE = path.join(root, '.auth', 'dashboard.json');
  const engram = new Engram(root);
  await engram.init({ sqlite: false });
  return {
    root,
    engram,
    async cleanup() {
      try { await engram.close(); } catch { /* cleanup must continue */ }
      try { await rm(root, { recursive: true, force: true }); } catch { /* cleanup must continue */ }
      try {
        if (prior === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE;
        else process.env.MDB_DASHBOARD_AUTH_FILE = prior;
      } catch { /* cleanup must continue */ }
    },
  };
}

export async function stopDashboard(handle: { close(): Promise<void> } | undefined): Promise<void> {
  try { await handle?.close(); } catch { /* best-effort server shutdown */ }
}
