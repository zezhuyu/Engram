import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withVaultLock } from '../storage-local/index.js';

const LEGACY_FILE = '.mdb/dashboard/auth.json';
const N = 1 << 15, R = 8, P = 1, KEY_LENGTH = 64;
export interface PasswordRecord { version: 1; salt: string; hash: string; params: { N: number; r: number; p: number; keyLength: number }; createdAt: string; changedAt: string }
export interface DashboardAuthLocationOptions { env?: NodeJS.ProcessEnv; homeDir?: string; platform?: NodeJS.Platform }
export interface DashboardSession { createdAt: number; lastSeen: number }

export function dashboardAuthFile(root: string, options: DashboardAuthLocationOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.MDB_DASHBOARD_AUTH_FILE) return path.resolve(env.MDB_DASHBOARD_AUTH_FILE);
  const home = options.homeDir ?? os.homedir();
  const base = (options.platform ?? process.platform) === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Engram')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'engram');
  return path.join(base, 'dashboard', 'auth.json');
}
export function dashboardSessionFile(authFile: string): string { return path.join(path.dirname(authFile), 'sessions.json'); }
function resetMarker(authFile: string): string { return path.join(path.dirname(authFile), 'auth-reset.json'); }

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}
async function atomicPrivateWrite(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
    const directoryHandle = await fs.open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
async function validateRecord(file: string, repairPermissions = true): Promise<PasswordRecord> {
  let record: PasswordRecord;
  try { record = JSON.parse(await fs.readFile(file, 'utf8')) as PasswordRecord; }
  catch (error) { throw new Error(`Dashboard password file is corrupt or unreadable (${file}): ${(error as Error).message}`); }
  if (record.version !== 1 || !record.params || !Number.isSafeInteger(record.params.N) || record.params.N < N || record.params.N > (1 << 18) || (record.params.N & (record.params.N - 1)) !== 0 || !Number.isSafeInteger(record.params.r) || record.params.r < 1 || record.params.r > 16 || !Number.isSafeInteger(record.params.p) || record.params.p < 1 || record.params.p > 4 || record.params.keyLength !== KEY_LENGTH || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{128}$/.test(record.hash) || typeof record.createdAt !== 'string' || typeof record.changedAt !== 'string') {
    throw new Error(`Dashboard password file is corrupt or unreadable (${file}): invalid scrypt record.`);
  }
  const stat = await fs.stat(file);
  if (repairPermissions && (stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
  return record;
}
async function existing(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function effectiveFile(root: string, options: DashboardAuthLocationOptions = {}): Promise<string> {
  const file = dashboardAuthFile(root, options);
  if (await existing(file)) return file;
  if (await existing(resetMarker(file))) return file;
  const legacy = path.join(root, LEGACY_FILE);
  if (await existing(legacy)) {
    const record = await validateRecord(legacy, false);
    await atomicPrivateWrite(file, `${JSON.stringify(record)}\n`);
    await fs.rm(resetMarker(file), { force: true });
    process.stderr.write(`Migrated dashboard password to ${file}\n`);
    return file;
  }
  return file;
}
export async function passwordFilePath(root: string, options: DashboardAuthLocationOptions = {}): Promise<string> { return effectiveFile(root, options); }
async function read(root: string, options: DashboardAuthLocationOptions = {}): Promise<PasswordRecord | undefined> {
  const file = await effectiveFile(root, options);
  if (!await existing(file)) return undefined;
  return validateRecord(file);
}
export async function passwordIsSet(root: string, options: DashboardAuthLocationOptions = {}): Promise<boolean> { return !!await read(root, options); }
export function validatePassword(password: unknown, token?: string): string | undefined {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) return 'Password must be between 12 and 256 characters.';
  if (token && password === token) return 'Choose a password different from the sign-in token.';
  if (/^(?:password|password123|password123456|123456789012|qwerty123456|letmein123456|admin123456)$/i.test(password)) return 'Choose a less common password.';
  return undefined;
}
async function hash(password: string, salt: string, params = { N, r: R, p: P, keyLength: KEY_LENGTH }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, Buffer.from(salt, 'hex'), params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r + 16 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived)));
}
export async function verifyPassword(root: string, password: unknown, options: DashboardAuthLocationOptions = {}): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 256) { await hash('invalid-password-padding', '00000000000000000000000000000000'); return false; }
  const record = await read(root, options); if (!record) { await hash(password || 'invalid-password-padding', '00000000000000000000000000000000'); return false; }
  const actual = await hash(password, record.salt, record.params), expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function setPassword(root: string, password: string, token?: string, options: DashboardAuthLocationOptions = {}): Promise<void> {
  const invalid = validatePassword(password, token); if (invalid) throw new Error(invalid);
  await withVaultLock(root, async () => {
    if (await read(root, options)) throw new Error('Password setup is already complete.');
    const file = dashboardAuthFile(root, options), at = new Date().toISOString(), salt = randomBytes(16).toString('hex'), params = { N, r: R, p: P, keyLength: KEY_LENGTH };
    const record: PasswordRecord = { version: 1, salt, hash: (await hash(password, salt, params)).toString('hex'), params, createdAt: at, changedAt: at };
    await atomicPrivateWrite(file, `${JSON.stringify(record)}\n`);
    await fs.rm(resetMarker(file), { force: true });
  });
}
export async function changePassword(root: string, password: string, options: DashboardAuthLocationOptions = {}): Promise<void> {
  const invalid = validatePassword(password); if (invalid) throw new Error(invalid);
  await withVaultLock(root, async () => {
    const previous = await read(root, options); if (!previous) throw new Error('Password setup is required.');
    const file = dashboardAuthFile(root, options), salt = randomBytes(16).toString('hex'), params = { N, r: R, p: P, keyLength: KEY_LENGTH };
    const record: PasswordRecord = { ...previous, salt, hash: (await hash(password, salt, params)).toString('hex'), params, changedAt: new Date().toISOString() };
    await atomicPrivateWrite(file, `${JSON.stringify(record)}\n`);
    await clearDashboardSessions(file);
  });
}
export async function resetPassword(root: string, options: DashboardAuthLocationOptions = {}): Promise<boolean> {
  return withVaultLock(root, async () => {
    const file = await effectiveFile(root, options);
    const removed = await fs.rm(file).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
    const legacy = path.join(root, LEGACY_FILE);
    if (await existing(legacy)) await atomicPrivateWrite(resetMarker(file), `${JSON.stringify({ resetAt: new Date().toISOString() })}\n`);
    await clearDashboardSessions(file);
    return removed;
  });
}
export function dashboardSessionKey(cookieValue: string): string { return createHash('sha256').update(cookieValue).digest('hex'); }
export async function loadDashboardSessions(authFile: string, idleMs: number, maxAgeMs: number, maxSessions = 8, now = Date.now()): Promise<Map<string, DashboardSession>> {
  const file = dashboardSessionFile(authFile);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); throw new Error(`Dashboard sessions file is unreadable (${file}): ${(error as Error).message}`); }
  let decoded: Record<string, DashboardSession>;
  try { decoded = JSON.parse(raw) as Record<string, DashboardSession>; } catch { throw new Error(`Dashboard sessions file is corrupt (${file}).`); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error(`Dashboard sessions file is corrupt (${file}).`);
  const sessions = new Map<string, DashboardSession>();
  for (const [key, value] of Object.entries(decoded)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(value?.createdAt) || !Number.isFinite(value?.lastSeen)) throw new Error(`Dashboard sessions file is corrupt (${file}).`);
    if (now - value.lastSeen < idleMs && now - value.createdAt < maxAgeMs) sessions.set(key, value);
  }
  while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value!);
  if (sessions.size !== Object.keys(decoded).length) await saveDashboardSessions(authFile, sessions);
  const info = await fs.stat(file); if ((info.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
  return sessions;
}
export async function saveDashboardSessions(authFile: string, sessions: Map<string, DashboardSession>): Promise<void> {
  const now = Date.now(), kept = Object.fromEntries([...sessions].filter(([key, value]) => /^[a-f0-9]{64}$/.test(key) && Number.isFinite(value.createdAt) && Number.isFinite(value.lastSeen) && now - value.lastSeen < 7 * 24 * 60 * 60_000));
  await atomicPrivateWrite(dashboardSessionFile(authFile), `${JSON.stringify(kept)}\n`);
}
export async function clearDashboardSessions(authFile: string): Promise<void> { await fs.rm(dashboardSessionFile(authFile), { force: true }); }
