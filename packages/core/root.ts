import os from 'node:os';
import path from 'node:path';

export const DATA_DIR_ENV = 'ENGRAM_DATA_DIR';
export const LEGACY_ROOT_ENV = 'MDB_ROOT';
export const DEFAULT_DATA_DIR_NAME = '.Engram';

/**
 * Resolves the vault directory. Precedence: explicit (--root) > ENGRAM_DATA_DIR > MDB_ROOT (legacy alias) > ~/.Engram.
 * A leading "~" expands to the home directory; other relative paths resolve against the working directory.
 */
export function resolveRoot(explicit?: string, env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  const chosen = [explicit, env[DATA_DIR_ENV], env[LEGACY_ROOT_ENV]].find(value => value !== undefined && value.trim() !== '');
  if (chosen === undefined) return path.join(home, DEFAULT_DATA_DIR_NAME);
  const value = chosen.trim();
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return path.resolve(value);
}
