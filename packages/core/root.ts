import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const DATA_DIR_ENV = 'ENGRAM_DATA_DIR';
export const LEGACY_ROOT_ENV = 'MDB_ROOT';
export const DEFAULT_DATA_DIR_NAME = '.Engram';

export type StoragePathKind = 'config' | 'state' | 'cache' | 'outbox' | 'remote-spool' | 'tmp' | 'logs' | 'index-scratch';

const RUNTIME_DIR = '.engram-runtime';
const storageOverrides: Partial<Record<StoragePathKind, string>> = {
  config: 'ENGRAM_USER_CONFIG', state: 'ENGRAM_STATE_DIR', cache: 'ENGRAM_CACHE_DIR',
  outbox: 'ENGRAM_OUTBOX', 'remote-spool': 'ENGRAM_REMOTE_SPOOL', tmp: 'ENGRAM_TEMP_DIR',
  logs: 'ENGRAM_LOG_DIR', 'index-scratch': 'ENGRAM_INDEX_SCRATCH_DIR',
};

/** Resolve Engram-managed side storage. Explicit class overrides are honored; otherwise an explicit ENGRAM_DATA_DIR roots every class under .engram-runtime. */
export function resolveStoragePath(kind: StoragePathKind, env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  const override = storageOverrides[kind] ? env[storageOverrides[kind]!] : undefined;
  const configuredRoot = env[DATA_DIR_ENV]?.trim();
  if (override?.trim()) {
    const resolved = path.resolve(expandHome(override.trim(), home));
    if (configuredRoot) {
      const root = path.resolve(expandHome(configuredRoot, home)); const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${storageOverrides[kind]} must remain inside ENGRAM_DATA_DIR`);
    }
    return resolved;
  }
  if (configuredRoot) {
    const base = path.join(resolveRoot(configuredRoot, env, home), RUNTIME_DIR, kind);
    return kind === 'config' ? path.join(base, 'user.json') : base;
  }
  const xdg = (name: string, fallback: string) => env[name]?.trim() ? path.resolve(expandHome(env[name]!.trim(), home)) : path.join(home, fallback);
  switch (kind) {
    case 'config': return path.join(xdg('XDG_CONFIG_HOME', '.config'), 'engram', 'user.json');
    case 'state': return path.join(xdg('XDG_STATE_HOME', '.local/state'), 'engram');
    case 'cache': return path.join(xdg('XDG_CACHE_HOME', '.cache'), 'engram');
    case 'outbox': return path.join(home, '.Engram-outbox');
    case 'remote-spool': return path.join(home, '.Engram-remote-spool');
    case 'tmp': return os.tmpdir();
    case 'logs': return path.join(xdg('XDG_STATE_HOME', '.local/state'), 'engram', 'logs');
    case 'index-scratch': return path.join(os.tmpdir(), 'engram-index');
  }
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

export function hasExplicitDataDir(env: Record<string, string | undefined> = process.env): boolean {
  return (env[DATA_DIR_ENV]?.trim().length ?? 0) > 0;
}

/** Create and validate a managed directory without following links beneath an explicitly configured root. */
export async function ensureStorageDirectory(kind: StoragePathKind, env: Record<string, string | undefined> = process.env): Promise<string> {
  const target = resolveStoragePath(kind, env);
  if (!hasExplicitDataDir(env)) {
    await fs.mkdir(kind === 'config' ? path.dirname(target) : target, { recursive: true, mode: 0o700 });
    return kind === 'config' ? path.dirname(target) : target;
  }
  const selectedRoot = path.resolve(resolveRoot(undefined, env));
  await fs.mkdir(selectedRoot, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(selectedRoot);
  const targetDirectory = path.resolve(kind === 'config' ? path.dirname(target) : target);
  const relative = path.relative(selectedRoot, targetDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Resolved Engram ${kind} path escaped ENGRAM_DATA_DIR`);
  const directory = path.resolve(root, relative);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const info = await fs.lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing symlink or non-directory in Engram storage path: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await fs.mkdir(cursor, { mode: 0o700 }); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        const raced = await fs.lstat(cursor);
        if (raced.isSymbolicLink() || !raced.isDirectory()) throw new Error(`Refusing symlink or non-directory in Engram storage path: ${cursor}`);
      }
    }
  }
  return directory;
}

/**
 * Resolves the vault directory. An explicit --root must match ENGRAM_DATA_DIR when configured; otherwise precedence is ENGRAM_DATA_DIR > --root > MDB_ROOT (legacy alias) > ~/.Engram.
 * A leading "~" expands to the home directory; other relative paths resolve against the working directory.
 */
export function resolveRoot(explicit?: string, env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  const configured = env[DATA_DIR_ENV]?.trim();
  if (explicit?.trim() && configured) {
    const explicitPath = path.resolve(expandHome(explicit.trim(), home));
    const configuredPath = path.resolve(expandHome(configured, home));
    if (explicitPath !== configuredPath) throw new Error('Explicit --root conflicts with ENGRAM_DATA_DIR; unset ENGRAM_DATA_DIR to intentionally use a separate root');
  }
  const chosen = [explicit, configured, env[LEGACY_ROOT_ENV]].find(value => value !== undefined && value.trim() !== '');
  if (chosen === undefined) return path.join(home, DEFAULT_DATA_DIR_NAME);
  const value = expandHome(chosen.trim(), home);
  if (value === home) return home;
  return path.resolve(value);
}
