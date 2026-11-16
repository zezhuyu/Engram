import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MDBError } from '../core/types.js';
import { DATA_DIR_ENV, DEFAULT_DATA_DIR_NAME, ensureStorageDirectory, hasExplicitDataDir, resolveStoragePath } from '../core/root.js';
import { remoteUrlAllowed } from '../core/private-network.js';
import { BINDING_HOSTS, type BindingHost } from '../core/project-binding.js';
import { assertDurableWriteCapacity } from '../core/storage-lifecycle.js';

/**
 * User-level capture settings, written once after the user's explicit consent. They name a server, the environment variable that holds the token, the user's own
 * workspace and registration, and what to leave out. No token or secret is ever stored. The file is machine-local and owner-only.
 */
export interface UserConfig { schemaVersion: 1; serverUrl: string; tokenEnv: string; workspaceId: string; registrationId: string; principalId: string; hosts: BindingHost[]; captureConsent: true; paused: boolean; excludeProjects: string[]; /** when non-empty, ONLY working directories matching one of these patterns are recorded; exclusions still win */ includeProjects?: string[] }
export const userConfigPath = (env: NodeJS.ProcessEnv = process.env): string => resolveStoragePath('config', env);
const invalid = (message: string): never => { throw new MDBError('INVALID_INPUT', `Invalid user config: ${message}`); };
const KEYS = new Set(['schemaVersion', 'serverUrl', 'tokenEnv', 'workspaceId', 'registrationId', 'principalId', 'hosts', 'captureConsent', 'paused', 'excludeProjects', 'includeProjects']);
export function parseUserConfig(raw: unknown): UserConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('not an object');
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!KEYS.has(key)) invalid(`unknown field ${key.slice(0, 30)}`);
  if (v.schemaVersion !== 1 || v.captureConsent !== true || typeof v.paused !== 'boolean') invalid('schemaVersion, captureConsent and paused');
  try { const url = new URL(String(v.serverUrl)); if (url.username || url.password || url.hash || !remoteUrlAllowed(url)) invalid('serverUrl must be HTTPS, loopback, or an opted-in tailnet host without credentials'); } catch (error) { if (error instanceof MDBError) throw error; invalid('serverUrl'); }
  if (typeof v.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(v.tokenEnv)) invalid('tokenEnv must be an environment variable name');
  for (const key of ['workspaceId', 'registrationId', 'principalId']) if (typeof v[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v[key] as string)) invalid(key);
  if (!Array.isArray(v.hosts) || !v.hosts.length || v.hosts.some(h => !(BINDING_HOSTS as readonly string[]).includes(h as string))) invalid('hosts');
  if (!Array.isArray(v.excludeProjects) || v.excludeProjects.length > 50) invalid('excludeProjects');
  if (v.includeProjects !== undefined && (!Array.isArray(v.includeProjects) || v.includeProjects.length > 50)) invalid('includeProjects');
  for (const pattern of [...(v.excludeProjects as unknown[]), ...((v.includeProjects as unknown[] | undefined) ?? [])]) { if (typeof pattern !== 'string' || !pattern || pattern.length > 200) invalid('excludeProjects entries'); try { new RegExp(pattern as string, 'i'); } catch { invalid('excludeProjects entry is not a valid pattern'); } }
  return v as unknown as UserConfig;
}
export async function readUserConfig(env: NodeJS.ProcessEnv = process.env): Promise<UserConfig | undefined> {
  const file = userConfigPath(env); if (hasExplicitDataDir(env)) await ensureStorageDirectory('config', env);
  try { const info = await fs.lstat(file); if (info.isSymbolicLink()) throw new MDBError('INVALID_INPUT', 'User config must not be a symlink'); return parseUserConfig(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function writeUserConfig(config: UserConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  parseUserConfig(config); const file = userConfigPath(env); await ensureStorageDirectory('config', env);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  await assertDurableWriteCapacity(path.dirname(file), Buffer.byteLength(serialized) + 4096, env);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, serialized, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}

/**
 * The environment under which the user's shell and agent hooks resolve capture storage. Hooks usually run with ENGRAM_DATA_DIR exported by the shell, but a
 * launchd or systemd service (the client dashboard) starts without it and would look in the plain default location and report capture as off. When no explicit
 * setting is present and the capture config exists only under the default data directory, resolve storage as the hooks do. Read-only: nothing is created.
 */
export async function hookStorageEnv(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Promise<NodeJS.ProcessEnv> {
  if (hasExplicitDataDir(env) || env.ENGRAM_USER_CONFIG?.trim()) return env;
  const exists = async (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);
  if (await exists(resolveStoragePath('config', env, home))) return env;
  const withDataDir = { ...env, [DATA_DIR_ENV]: path.join(home, DEFAULT_DATA_DIR_NAME) };
  return await exists(resolveStoragePath('config', withDataDir, home)) ? withDataDir : env;
}
