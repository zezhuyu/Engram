import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { isIP } from 'node:net';

export function equalToken(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function allowedHost(host: string | undefined, port: number): boolean {
  const parsed = parseHostPort(host);
  return !!parsed && parsed.port === port && ['127.0.0.1', 'localhost', '::1'].includes(parsed.name);
}
function parseHostPort(value: string | undefined): { name: string; port: number } | undefined {
  if (!value || /[\s\u0000-\u001f\u007f,]/.test(value)) return undefined;
  const ipv6 = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(value);
  const ordinary = /^([^:[\]]+):(\d{1,5})$/.exec(value);
  const match = ipv6 ?? ordinary;
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { name: match[1]!.toLowerCase(), port };
}
export function allowedRemoteHost(host: string | undefined, port: number, bindHost: string, machineName = hostname()): boolean {
  const parsed = parseHostPort(host);
  if (!parsed || parsed.port !== port) return false;
  const name = parsed.name;
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === machineName.toLowerCase()) return true;
    return isIP(name) !== 0;
  }
  return name === bindHost.toLowerCase();
}
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try { const parsed = new URL(origin); return parsed.origin === `http://${host}`; } catch { return false; }
}
export function requestOrigin(req: IncomingMessage): string { return `${(req.socket as IncomingMessage['socket'] & { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}`; }
export function authorized(req: IncomingMessage, token: string, port: number): boolean {
  return allowedHost(req.headers.host, port) && sameOrigin(req.headers.origin, req.headers.host)
    && equalToken(token, req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
}
export function validRequestOrigin(req: IncomingMessage, port: number, remote: boolean, bindHost = '0.0.0.0'): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  let validOrigin = !origin;
  if (origin) { try { validOrigin = new URL(origin).origin === requestOrigin(req); } catch { validOrigin = false; } }
  return (remote ? allowedRemoteHost(host, port, bindHost) : allowedHost(host, port)) && validOrigin;
}
