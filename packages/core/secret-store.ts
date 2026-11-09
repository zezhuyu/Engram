import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SECRET_BYTES = 16 * 1024;
export interface SecretStoreOptions { env?: NodeJS.ProcessEnv; home?: string }

function secretPath(name: string, options: SecretStoreOptions = {}): { configHome: string; directory: string; file: string } {
  if (!NAME.test(name)) throw new Error('Invalid secret name');
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? process.env.HOME;
  if (!home) throw new Error('Secret store home directory is unavailable');
  const root = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const directory = path.join(root, 'engram', 'secrets');
  return { configHome: root, directory, file: path.join(directory, name) };
}
function secureStat(file: string, directory: boolean): void {
  const stat = lstatSync(file);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error('Secret store permissions are unsafe');
}
function ensureDirectory(directory: string): void {
  const parent = path.dirname(directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  secureStat(parent, true); secureStat(directory, true);
}
function secureConfigHome(directory: string): void {
  const stat = lstatSync(directory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error('Secret store permissions are unsafe');
}

export function writeSecret(name: string, value: string, options: SecretStoreOptions = {}): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error('Invalid secret value');
  const { configHome, directory, file } = secretPath(name, options);
  mkdirSync(configHome, { recursive: true, mode: 0o700 });
  secureConfigHome(configHome);
  ensureDirectory(directory);
  try { secureStat(file, false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = path.join(directory, `.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, value.replace(/(?:\r?\n)+$/u, ''), 'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    const dirFd = openSync(directory, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    secureStat(file, false);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* rename already consumed the temp file */ }
  }
}

export function readSecret(name: string, options: SecretStoreOptions = {}): string | undefined {
  const { configHome, directory, file } = secretPath(name, options);
  try { secureConfigHome(configHome); secureStat(path.dirname(directory), true); secureStat(directory, true); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try { secureStat(file, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const value = readFileSync(file, 'utf8').replace(/(?:\r?\n)+$/u, '');
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error('Secret store entry exceeds size limit');
  return value;
}

export function deleteSecret(name: string, options: SecretStoreOptions = {}): boolean {
  const { configHome, directory, file } = secretPath(name, options);
  try { secureConfigHome(configHome); secureStat(path.dirname(directory), true); secureStat(directory, true); secureStat(file, false); unlinkSync(file); const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function hasSecret(name: string, options: SecretStoreOptions = {}): boolean { return readSecret(name, options) !== undefined; }

/** Opaque metadata revision for optimistic settings concurrency; never derived from or exposes secret bytes. */
export function secretVersion(name: string | undefined, options: SecretStoreOptions = {}): string | undefined {
  if (!name) return undefined;
  const { configHome, directory, file } = secretPath(name, options);
  try {
    secureConfigHome(configHome); secureStat(path.dirname(directory), true); secureStat(directory, true); secureStat(file, false);
    const info = statSync(file, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
