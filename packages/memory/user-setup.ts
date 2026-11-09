import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MDBError } from '../core/types.js';
import { remoteUrlAllowed } from '../core/private-network.js';
import type { BindingHost } from '../core/project-binding.js';
import { findTrustedBinding } from '../core/project-trust.js';
import { createAdapter } from './adapters.js';
import { defaultRemoteSpoolDirectory, queueRemoteCapture } from './remote-spool.js';
import { readUserConfig, userConfigPath, writeUserConfig, type UserConfig } from './user-config.js';
import { removeClaudeMcp, removeCodexMcp, upsertClaudeMcp, upsertCodexMcp } from '../project-init.js';
import { manageInstructions } from './global-instructions.js';

export interface UserSetupOptions { hosts: BindingHost[]; mcpUrl: string; tokenEnv: string; registrationId: string; principalId: string; workspaceId?: string; exclude?: string[]; /** record only matching projects */ include?: string[]; consent?: boolean; noInstructions?: boolean; settingsPaths?: Partial<Record<BindingHost, string>>; claudeJsonPath?: string; codexConfigPath?: string; claudeInstructionsPath?: string; codexInstructionsPath?: string; instructionEnv?: NodeJS.ProcessEnv }
type InstructionOverrides = Pick<UserSetupOptions, 'claudeInstructionsPath' | 'codexInstructionsPath' | 'instructionEnv'>;
function instructionOptions(options: InstructionOverrides) {
  const paths = { ...(options.claudeInstructionsPath ? { 'claude-code': options.claudeInstructionsPath } : {}), ...(options.codexInstructionsPath ? { codex: options.codexInstructionsPath } : {}) };
  return { ...(Object.keys(paths).length ? { paths } : {}), ...(options.instructionEnv ? { env: options.instructionEnv } : {}) };
}
const claudeJson = (o: { claudeJsonPath?: string }) => o.claudeJsonPath ?? path.join(process.env.HOME ?? os.homedir(), '.claude.json');
const codexToml = (o: { codexConfigPath?: string }) => o.codexConfigPath ?? path.join(process.env.HOME ?? os.homedir(), '.codex', 'config.toml');

/** One-time, consented, user-level setup: hooks for every session of the chosen hosts, a user-level MCP entry bound to the user's own workspace, and the config the hooks read at run time. */
export async function setupUser(options: UserSetupOptions): Promise<{ configPath: string; workspaceId: string; hooks: Record<string, unknown>; mcp: Record<string, string>; instructions?: Record<string, unknown>; notes: string[] }> {
  if (options.consent !== true) throw new MDBError('INVALID_INPUT', 'Recording every conversation needs your explicit consent (--consent); nothing was changed');
  if (!options.hosts.length) throw new MDBError('INVALID_INPUT', 'Select at least one host');
  if (!remoteUrlAllowed(new URL(options.mcpUrl))) throw new MDBError('INVALID_INPUT', 'The server URL must be HTTPS, loopback, or an opted-in tailnet host (MDB_TRANSPORT_TRUST=tailscale)');
  const workspaceId = options.workspaceId ?? 'personal';
  const config: UserConfig = { schemaVersion: 1, serverUrl: options.mcpUrl, tokenEnv: options.tokenEnv, workspaceId, registrationId: options.registrationId, principalId: options.principalId, hosts: [...new Set(options.hosts)].sort() as BindingHost[], captureConsent: true, paused: false, excludeProjects: options.exclude ?? [], includeProjects: options.include ?? [] };
  await writeUserConfig(config);
  const hooks: Record<string, unknown> = {}, mcp: Record<string, string> = {};
  for (const host of config.hosts) {
    const settingsPath = options.settingsPaths?.[host];
    hooks[host] = await createAdapter(host, { root: path.dirname(userConfigPath()), ...(settingsPath ? { settingsPath } : {}) }).install({ consent: true, principalId: options.principalId, workspaceId, mcpUrl: options.mcpUrl, tokenEnv: options.tokenEnv, registrationId: options.registrationId, userLevel: true });
    if (host === 'claude-code') { await upsertClaudeMcp(claudeJson(options), options.mcpUrl, options.tokenEnv, workspaceId); mcp[host] = claudeJson(options); }
    else { await upsertCodexMcp(codexToml(options), options.mcpUrl, options.tokenEnv, workspaceId); mcp[host] = codexToml(options); }
  }
  const instructions = options.noInstructions ? undefined : await manageInstructions('install', config.hosts.length === 2 ? 'both' : config.hosts[0]!, instructionOptions(options));
  return { configPath: userConfigPath(), workspaceId, hooks, mcp, ...(instructions ? { instructions } : {}), notes: ['Every session of the selected hosts is now recorded to your user workspace unless the project is bound (its own hooks handle it), excluded, or capture is paused.', 'Assistant replies are not recorded unless the registration allows them; secrets are redacted before anything leaves this machine.'] };
}
export async function setUserPaused(paused: boolean): Promise<UserConfig> {
  const config = await readUserConfig(); if (!config) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'User-level capture is not set up');
  const next = { ...config, paused }; await writeUserConfig(next); return next;
}
export async function userStatus(options: InstructionOverrides = {}): Promise<{ configured: boolean; instructions: Record<string, unknown>; recording?: 'ALL_NON_EXCLUDED_PROJECTS' | 'ALLOWLISTED_PROJECTS_ONLY' | 'PAUSED'; paused?: boolean; workspaceId?: string; hosts?: string[]; includeProjects?: string[]; excludeProjects?: string[]; tokenAvailable?: boolean; queuedLocally?: number; assistantReplies?: string }> {
  const config = await readUserConfig(); const instructions = await manageInstructions('status', 'both', instructionOptions(options)); if (!config) return { configured: false, instructions };
  const queued = (await fs.readdir(defaultRemoteSpoolDirectory()).catch(() => [] as string[])).filter(n => n.endsWith('.json')).length;
  return { configured: true, instructions, recording: config.paused ? 'PAUSED' : config.includeProjects?.length ? 'ALLOWLISTED_PROJECTS_ONLY' : 'ALL_NON_EXCLUDED_PROJECTS', paused: config.paused, workspaceId: config.workspaceId, hosts: config.hosts, includeProjects: config.includeProjects ?? [], excludeProjects: config.excludeProjects, tokenAvailable: !!process.env[config.tokenEnv], queuedLocally: queued, assistantReplies: 'recorded only if the server-side registration allows assistant.message (off by default)' };
}
export async function uninstallUser(options: Pick<UserSetupOptions, 'settingsPaths' | 'claudeJsonPath' | 'codexConfigPath'> & InstructionOverrides = {}): Promise<{ hooksRemoved: number; mcpRemoved: string[]; configRemoved: boolean; instructionsRemoved: Record<string, unknown> }> {
  const config = await readUserConfig(); let hooksRemoved = 0; const mcpRemoved: string[] = [];
  for (const host of config?.hosts ?? ['claude-code', 'codex'] as BindingHost[]) {
    const settingsPath = options.settingsPaths?.[host];
    hooksRemoved += await createAdapter(host, { root: path.dirname(userConfigPath()), ...(settingsPath ? { settingsPath } : {}) }).removeUserHooks();
    if (host === 'claude-code' ? await removeClaudeMcp(claudeJson(options)) : await removeCodexMcp(codexToml(options))) mcpRemoved.push(host);
  }
  const configRemoved = await fs.rm(userConfigPath(), { force: true }).then(() => !!config, () => false);
  const instructionsRemoved = await manageInstructions('remove', 'both', instructionOptions(options));
  return { hooksRemoved, mcpRemoved, configRemoved, instructionsRemoved };
}

/** True when the hook payload's working directory is inside `root` (both resolved through realpath, so a symlink cannot escape). Anything unreadable is outside: record nothing. */
export async function insideProject(stdin: string, root: string): Promise<boolean> {
  try {
    const cwd = (JSON.parse(stdin) as { cwd?: unknown }).cwd; if (typeof cwd !== 'string' || !cwd) return false;
    const [real, base] = await Promise.all([fs.realpath(cwd), fs.realpath(root)]); const relative = path.relative(base, real);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch { return false; }
}

export type UserCaptureOutcome = 'queued' | 'ignored:not-allowlisted' | 'ignored:not-configured' | 'ignored:paused' | 'ignored:excluded' | 'ignored:no-cwd' | 'deferred:project-capture' | 'ignored:bad-payload' | 'error';
/** The user-level hook. Fail-open and silent. A project with its own consented binding is recorded by that project's hook (never twice); everything else goes to the user workspace. */
export async function captureForUser(host: string, stdin: string, env: NodeJS.ProcessEnv = process.env): Promise<UserCaptureOutcome> {
  try {
    const config = await readUserConfig(env); if (!config) return 'ignored:not-configured'; if (config.paused) return 'ignored:paused';
    if (!(config.hosts as string[]).includes(host)) return 'ignored:not-configured';
    let payload: Record<string, unknown>; try { payload = JSON.parse(stdin) as Record<string, unknown>; } catch { return 'ignored:bad-payload'; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'ignored:bad-payload';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''; if (!cwd) return 'ignored:no-cwd';
    if (config.excludeProjects.some(pattern => new RegExp(pattern, 'i').test(cwd))) return 'ignored:excluded'; // checked before anything is queued: an excluded project never reaches the spool
    if (config.includeProjects?.length && !config.includeProjects.some(pattern => new RegExp(pattern, 'i').test(cwd))) return 'ignored:not-allowlisted';
    const bound = await findTrustedBinding(cwd, env).catch(() => undefined);
    if (bound?.trusted && bound.binding.captureConsent && bound.binding.serverUrl) return 'deferred:project-capture'; // an untrusted binding is not obeyed, so it cannot silence or redirect user-level capture
    await queueRemoteCapture({ url: config.serverUrl, registrationId: config.registrationId, ...(env[config.tokenEnv] ? { token: env[config.tokenEnv]! } : {}), payload });
    return 'queued';
  } catch { return 'error'; }
}
