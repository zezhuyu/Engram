import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { appendAudit } from './audit.js';
import { withVaultLock } from '../storage-local/index.js';
import { parseStrictJson } from '../../scripts/lib/strict-json.js';

export type DashboardCredentialMode = 'admin' | 'view';
type Entry = { id: string; label: string; mode: DashboardCredentialMode; tokenHash: string; createdAt: string; expiresAt: string; lastUsedAt?: string; lastUsedIp?: string; sourceIps?: string[] };
type Store = { version: 1; credentials: Entry[] };
const CAP = 100;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const fileFor = (root: string) => path.join(root, '.mdb', 'dashboard', 'credentials.json');

async function read(root: string): Promise<Store> {
  try {
    const store = parseStrictJson(await fs.readFile(fileFor(root), 'utf8'), 'Dashboard credential registry') as Store;
    if (store.version !== 1 || !Array.isArray(store.credentials) || store.credentials.length > CAP || store.credentials.some(item => !item || typeof item.id !== 'string' || typeof item.label !== 'string' || !['admin', 'view'].includes(item.mode) || !/^[a-f0-9]{64}$/.test(item.tokenHash) || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.expiresAt)) || item.lastUsedAt !== undefined && !Number.isFinite(Date.parse(item.lastUsedAt)) || item.sourceIps !== undefined && (!Array.isArray(item.sourceIps) || item.sourceIps.some(ip => typeof ip !== 'string' || isIP(ip) === 0)))) throw new Error('shape');
    return store;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, credentials: [] }; throw new Error('Dashboard credential registry is invalid'); }
}
async function write(root: string, store: Store): Promise<void> {
  const file = fileFor(root); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); await fs.chmod(file, 0o600); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function createDashboardCredential(root: string, input: { label: string; mode: DashboardCredentialMode; expiresAt?: string; sourceIps?: string[] }) {
  const label = input.label.trim(); if (!label || label.length > 80 || !['admin', 'view'].includes(input.mode)) throw new Error('A label (1–80 characters) and mode admin|view are required');
  const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : Date.now() + 90 * 24 * 60 * 60_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 366 * 24 * 60 * 60_000) throw new Error('Credential expiry must be within the next 366 days');
  if (input.sourceIps && (input.sourceIps.length > 64 || input.sourceIps.some(ip => isIP(ip) === 0))) throw new Error('Invalid source IP allowlist');
  const token = `mdb_dash_${randomBytes(32).toString('base64url')}`, entry: Entry = { id: `dash_${randomBytes(10).toString('hex')}`, label, mode: input.mode, tokenHash: digest(token), createdAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(), ...(input.sourceIps?.length ? { sourceIps: [...new Set(input.sourceIps)] } : {}) };
  await withVaultLock(root, async () => { const store = await read(root); if (store.credentials.length >= CAP) throw new Error('Dashboard credential limit reached'); store.credentials.push(entry); await write(root, store); });
  await appendAudit(root, { at: entry.createdAt, key: 'dashboard.credential.create', oldValue: null, newValue: { id: entry.id, label, mode: entry.mode, expiresAt: entry.expiresAt }, result: 'applied' });
  return { id: entry.id, token, label, mode: entry.mode, expiresAt: entry.expiresAt };
}
export async function listDashboardCredentials(root: string) { return (await read(root)).credentials.map(({ tokenHash: _secret, ...entry }) => ({ ...entry, lastUsedAt: entry.lastUsedAt ?? null, lastUsedIp: entry.lastUsedIp ?? null })); }
export async function revokeDashboardCredential(root: string, id: string) {
  let removed = false;
  await withVaultLock(root, async () => { const store = await read(root), before = store.credentials.length; store.credentials = store.credentials.filter(item => item.id !== id); removed = store.credentials.length !== before; if (removed) await write(root, store); });
  if (removed) await appendAudit(root, { at: new Date().toISOString(), key: 'dashboard.credential.revoke', oldValue: null, newValue: { id }, result: 'applied' }); return removed;
}
export async function resolveDashboardCredential(root: string, token: string | undefined, ip: string): Promise<{ id: string; label: string; mode: DashboardCredentialMode } | undefined> {
  if (!token) return undefined;
  const candidate = Buffer.from(digest(token)), store = await read(root); let matched: Entry | undefined;
  for (const entry of store.credentials) { const expected = Buffer.from(entry.tokenHash); if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) matched = entry; }
  if (!matched || Date.parse(matched.expiresAt) <= Date.now() || matched.sourceIps && !matched.sourceIps.includes(ip)) return undefined;
  await withVaultLock(root, async () => { const current = await read(root), active = current.credentials.find(item => item.id === matched!.id && item.tokenHash === matched!.tokenHash); if (!active || Date.parse(active.expiresAt) <= Date.now() || active.sourceIps && !active.sourceIps.includes(ip)) { matched = undefined; return; } active.lastUsedAt = new Date().toISOString(); active.lastUsedIp = ip; await write(root, current); });
  if (!matched) return undefined;
  return { id: matched.id, label: matched.label, mode: matched.mode };
}
