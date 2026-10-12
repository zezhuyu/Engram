import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MDBError } from '../core/types.js';
import { remoteUrlAllowed } from '../core/private-network.js';
import { findBinding, type BindingHost } from '../core/project-binding.js';
import { createAdapter } from './adapters.js';
import { queueRemoteCapture } from './remote-spool.js';
import { readUserConfig, userConfigPath, writeUserConfig, type UserConfig } from './user-config.js';
import { removeClaudeMcp, removeCodexMcp, upsertClaudeMcp, upsertCodexMcp } from '../project-init.js';

export interface UserSetupOptions { hosts: BindingHost[]; mcpUrl: string; tokenEnv: string; registrationId: string; principalId: string; workspaceId?: string; exclude?: string[]; consent?: boolean; settingsPaths?: Partial<Record<BindingHost, string>>; claudeJsonPath?: string; codexConfigPath?: string }
const claudeJson = (o: { claudeJsonPath?: string }) => o.claudeJsonPath ?? path.join(process.env.HOME ?? os.homedir(), '.claude.json');
const codexToml = (o: { codexConfigPath?: string }) => o.codexConfigPath ?? path.join(process.env.HOME ?? os.homedir(), '.codex', 'config.toml');

/** One-time, consented, user-level setup: hooks for every session of the chosen hosts, a user-level MCP entry bound to the user's own workspace, and the config the hooks read at run time. */
export async function setupUser(options: UserSetupOptions): Promise<{ configPath: string; workspaceId: string; hooks: Record<string, unknown>; mcp: Record<string, string>; notes: string[] }> {
  if (options.consent !== true) throw new MDBError('INVALID_INPUT', 'Recording every conversation needs your explicit consent (--consent); nothing was changed');
  if (!options.hosts.length) throw new MDBError('INVALID_INPUT', 'Select at least one host');
  if (!remoteUrlAllowed(new URL(options.mcpUrl))) throw new MDBError('INVALID_INPUT', 'The server URL must be HTTPS, loopback, or an opted-in tailnet host (MDB_TRANSPORT_TRUST=tailscale)');
  const workspaceId = options.workspaceId ?? 'personal';
  const config: UserConfig = { schemaVersion: 1, serverUrl: options.mcpUrl, tokenEnv: options.tokenEnv, workspaceId, registrationId: options.registrationId, principalId: options.principalId, hosts: [...new Set(options.hosts)].sort() as BindingHost[], captureConsent: true, paused: false, excludeProjects: options.exclude ?? [] };
  await writeUserConfig(config);
  const hooks: Record<string, unknown> = {}, mcp: Record<string, string> = {};
  for (const host of config.hosts) {
    const settingsPath = options.settingsPaths?.[host];
    hooks[host] = await createAdapter(host, { root: path.dirname(userConfigPath()), ...(settingsPath ? { settingsPath } : {}) }).install({ consent: true, principalId: options.principalId, workspaceId, mcpUrl: options.mcpUrl, tokenEnv: options.tokenEnv, registrationId: options.registrationId, userLevel: true });
    if (host === 'claude-code') { await upsertClaudeMcp(claudeJson(options), options.mcpUrl, options.tokenEnv, workspaceId); mcp[host] = claudeJson(options); }
    else { await upsertCodexMcp(codexToml(options), options.mcpUrl, options.tokenEnv, workspaceId); mcp[host] = codexToml(options); }
  }
  return { configPath: userConfigPath(), workspaceId, hooks, mcp, notes: ['Every session of the selected hosts is now recorded to your user workspace unless the project is bound (its own hooks handle it), excluded, or capture is paused.', 'Assistant replies are not recorded unless the registration allows them; secrets are redacted before anything leaves this machine.'] };
}
export async function setUserPaused(paused: boolean): Promise<UserConfig> {
  const config = await readUserConfig(); if (!config) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'User-level capture is not set up');
  const next = { ...config, paused }; await writeUserConfig(next); return next;
}
export async function userStatus(): Promise<{ configured: boolean; paused?: boolean; workspaceId?: string; hosts?: string[]; excludeProjects?: string[]; tokenAvailable?: boolean }> {
  const config = await readUserConfig(); if (!config) return { configured: false };
  return { configured: true, paused: config.paused, workspaceId: config.workspaceId, hosts: config.hosts, excludeProjects: config.excludeProjects, tokenAvailable: !!process.env[config.tokenEnv] };
}
export async function uninstallUser(options: Pick<UserSetupOptions, 'settingsPaths' | 'claudeJsonPath' | 'codexConfigPath'> = {}): Promise<{ hooksRemoved: number; mcpRemoved: string[]; configRemoved: boolean }> {
  const config = await readUserConfig(); let hooksRemoved = 0; const mcpRemoved: string[] = [];
  for (const host of config?.hosts ?? ['claude-code', 'codex'] as BindingHost[]) {
    const settingsPath = options.settingsPaths?.[host];
    hooksRemoved += await createAdapter(host, { root: path.dirname(userConfigPath()), ...(settingsPath ? { settingsPath } : {}) }).removeUserHooks();
    if (host === 'claude-code' ? await removeClaudeMcp(claudeJson(options)) : await removeCodexMcp(codexToml(options))) mcpRemoved.push(host);
  }
  const configRemoved = await fs.rm(userConfigPath(), { force: true }).then(() => !!config, () => false);
  return { hooksRemoved, mcpRemoved, configRemoved };
}

/** True when the hook payload's working directory is inside `root` (both resolved through realpath, so a symlink cannot escape). Anything unreadable is outside: record nothing. */
export async function insideProject(stdin: string, root: string): Promise<boolean> {
  try {
    const cwd = (JSON.parse(stdin) as { cwd?: unknown }).cwd; if (typeof cwd !== 'string' || !cwd) return false;
    const [real, base] = await Promise.all([fs.realpath(cwd), fs.realpath(root)]); const relative = path.relative(base, real);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch { return false; }
}

export type UserCaptureOutcome = 'queued' | 'ignored:not-configured' | 'ignored:paused' | 'ignored:excluded' | 'ignored:no-cwd' | 'deferred:project-capture' | 'ignored:bad-payload' | 'error';
/** The user-level hook. Fail-open and silent. A project with its own consented binding is recorded by that project's hook (never twice); everything else goes to the user workspace. */
export async function captureForUser(host: string, stdin: string, env: NodeJS.ProcessEnv = process.env): Promise<UserCaptureOutcome> {
  try {
    const config = await readUserConfig(env); if (!config) return 'ignored:not-configured'; if (config.paused) return 'ignored:paused';
    if (!(config.hosts as string[]).includes(host)) return 'ignored:not-configured';
    let payload: Record<string, unknown>; try { payload = JSON.parse(stdin) as Record<string, unknown>; } catch { return 'ignored:bad-payload'; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'ignored:bad-payload';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''; if (!cwd) return 'ignored:no-cwd';
    if (config.excludeProjects.some(pattern => new RegExp(pattern, 'i').test(cwd))) return 'ignored:excluded';
    const bound = await findBinding(cwd).catch(() => undefined);
    if (bound?.binding.captureConsent && bound.binding.serverUrl) return 'deferred:project-capture';
    await queueRemoteCapture({ url: config.serverUrl, registrationId: config.registrationId, ...(env[config.tokenEnv] ? { token: env[config.tokenEnv]! } : {}), payload });
    return 'queued';
  } catch { return 'error'; }
}
