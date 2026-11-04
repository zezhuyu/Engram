import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function browserExecutable(): string | undefined {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? [] : ['google-chrome', 'chromium', 'chromium-browser'];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try { requireAccess(candidate); return candidate; } catch { continue; }
    }
    const found = process.env.PATH?.split(path.delimiter).map(dir => path.join(dir, candidate)).find(file => {
      try { requireAccess(file); return true; } catch { return false; }
    });
    if (found) return found;
  }
  return undefined;
}

function requireAccess(file: string): void {
  // accessSync is synchronous so browser discovery can be used in node:test's skip option.
  accessSync(file);
}
import { accessSync } from 'node:fs';

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function tempDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').then(() => true, () => true);
  child.kill('SIGTERM');
  if (await Promise.race([exited, new Promise<false>(resolve => setTimeout(() => resolve(false), 3000))])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
}

type CdpResponse = { id: number; result?: Record<string, unknown>; error?: { message?: string } };
type CdpEvent = { method: string; params?: Record<string, unknown> };

export class Cdp {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly events: CdpEvent[] = [];
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as CdpResponse & CdpEvent;
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? 'DevTools command failed'));
        else pending.resolve(message.result ?? {});
      } else if (message.method) this.events.push(message);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools')), 8_000);
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome DevTools')), { once: true });
      socket.addEventListener('open', () => clearTimeout(timer), { once: true });
      socket.addEventListener('error', () => clearTimeout(timer), { once: true });
    });
    return new Cdp(socket);
  }
  command(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const response = await this.command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
    const result = response.result as { value?: T; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Page evaluation failed');
    return result?.value as T;
  }
  async close(): Promise<void> {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('DevTools connection closed')); }
    this.pending.clear();
    this.socket.close();
  }
}

export async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

export async function removeTree(directory: string | undefined): Promise<void> {
  if (directory) await rm(directory, { recursive: true, force: true });
}
