import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { remoteUrlAllowed } from '../core/private-network.js';
import { userConfigPath, readUserConfig, writeUserConfig } from '../memory/user-config.js';
import { createAdapter } from '../memory/adapters.js';
import { upsertClaudeMcp, upsertCodexMcp } from '../project-init.js';
import { manageClientService } from '../cli/service.js';

type FileState = { exists: boolean; bytes?: Buffer; mode?: number };
type Target = { target: string; exists: boolean; currentUrl: string | null; currentTokenFile?: string | null; path?: string; status?: string };
type Desired = { url: string; tokenFile: string };
const homeDir = () => process.env.HOME || os.homedir();
const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config'), 'engram');
const clientEnvPath = () => path.join(configDir(), 'client.env');
const claudeMcpPath = () => path.join(homeDir(), '.claude.json');
const codexMcpPath = () => path.join(homeDir(), '.codex', 'config.toml');
const settingsPath = (host: 'claude-code' | 'codex') => path.join(homeDir(), host === 'claude-code' ? '.claude/settings.json' : '.codex/hooks.json');
const normalizedUrl = (input: unknown): string => {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a valid capture server URL');
  let url: URL; try { url = new URL(input.trim()); } catch { throw new Error('Enter a valid capture server URL'); }
  if (!remoteUrlAllowed(url) || url.username || url.password || url.search || url.hash) throw new Error('Capture URL must be HTTPS, loopback, or an opted-in tailnet host without credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
};
function expandPath(value: string): string {
  const expanded = value.startsWith('~/') ? path.join(homeDir(), value.slice(2)) : value;
  return path.resolve(expanded);
}
async function validateTokenFile(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('Token file path is required');
  const file = expandPath(value.trim());
  try {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || ![0o600, 0o400].includes(stat.mode & 0o777) || stat.size < 1 || stat.size > 4096) throw new Error();
    } finally { await handle.close(); }
  } catch { throw new Error('Token file must be an owned regular file with mode 0600 or 0400'); }
  return file;
}
async function readState(file: string): Promise<FileState> {
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe configuration file: ${path.basename(file)}`); return { exists: true, bytes: await fs.readFile(file), mode: stat.mode & 0o777 }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }; throw error; }
}
async function atomicWrite(file: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { await fs.writeFile(temp, bytes, { mode, flag: 'wx' }); await fs.chmod(temp, mode); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function restore(file: string, state: FileState): Promise<void> {
  if (!state.exists) { await fs.rm(file, { force: true }); return; }
  await atomicWrite(file, state.bytes!, state.mode ?? 0o600);
}
function parseClientEnv(text: string): { url?: string; tokenFile?: string } {
  const values: { url?: string; tokenFile?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(ENGRAM_MCP_URL|ENGRAM_TOKEN_FILE)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (match[1] === 'ENGRAM_MCP_URL') values.url = value;
    else values.tokenFile = value;
  }
  return values;
}
function updateClientEnv(text: string, desired: Desired): string {
  const next = text.split(/\r?\n/), wanted: Record<string, string> = { ENGRAM_MCP_URL: desired.url, ENGRAM_TOKEN_FILE: desired.tokenFile };
  for (const [key, value] of Object.entries(wanted)) {
    const indexes = next.map((line, index) => /^\s*(?:export\s+)?(ENGRAM_MCP_URL|ENGRAM_TOKEN_FILE)\s*=/.exec(line)?.[1] === key ? index : -1).filter(index => index >= 0);
    if (indexes.length) {
      const first = indexes[0]!; const original = next[first]!; const comment = /\s+#.*$/.exec(original)?.[0] ?? '';
      next[first] = `${key}=${JSON.stringify(value)}${comment}`;
      for (const index of indexes.slice(1).reverse()) next.splice(index, 1);
    } else next.push(`${key}=${JSON.stringify(value)}`);
  }
  return next.join('\n');
}
function claudeEntry(text: string): { url: string | null; tokenEnv: string; workspace: string; offlineBuffer: boolean } | null {
  try {
    const config = JSON.parse(text) as { mcpServers?: { engram?: { type?: string; url?: string; args?: string[]; headers?: Record<string, string> } } }, entry = config.mcpServers?.engram;
    if (!entry) return null;
    const url = entry.url ?? entry.args?.find(arg => /^https?:\/\//.test(arg)) ?? null;
    const tokenEnv = /^Bearer \$\{([A-Z_][A-Z0-9_]*)\}$/.exec(entry.headers?.Authorization ?? '')?.[1] ?? 'ENGRAM_MCP_TOKEN';
    return { url, tokenEnv, workspace: entry.headers?.['X-Engram-Workspace'] ?? 'personal', offlineBuffer: entry.type === 'stdio' };
  } catch { return null; }
}
function extractClaudeUrl(text: string): string | null { return claudeEntry(text)?.url ?? null; }
function codexEntry(text: string): { url: string | null; tokenEnv: string; workspace: string; offlineBuffer: boolean; approveTools: boolean } | null {
  const block = /# engram:mcp:start\s+([\s\S]*?)# engram:mcp:end/.exec(text)?.[1]; if (!block) return null;
  const direct = /^url\s*=\s*("(?:\\.|[^"\\])*")/m.exec(block)?.[1];
  const args = /^args\s*=\s*(\[[^\n]*\])/m.exec(block)?.[1];
  try {
    const parsedArgs = args ? JSON.parse(args) as string[] : [];
    const workspaceRaw = /"X-Engram-Workspace"\s*=\s*("(?:\\.|[^"\\])*")/.exec(block)?.[1];
    const envRaw = /^env_vars\s*=\s*(\[[^\n]*\])/m.exec(block)?.[1];
    const tokenEnv = /^bearer_token_env_var\s*=\s*("(?:\\.|[^"\\])*")/m.exec(block)?.[1];
    return { url: direct ? JSON.parse(direct) as string : parsedArgs.find(value => /^https?:\/\//.test(value)) ?? null, tokenEnv: tokenEnv ? JSON.parse(tokenEnv) as string : envRaw ? (JSON.parse(envRaw) as string[])[0] ?? 'ENGRAM_MCP_TOKEN' : 'ENGRAM_MCP_TOKEN', workspace: workspaceRaw ? JSON.parse(workspaceRaw) as string : 'personal', offlineBuffer: parsedArgs.includes('mcp-proxy'), approveTools: /default_tools_approval_mode\s*=\s*"approve"/.test(block) };
  } catch { return null; }
}
function extractCodexUrl(text: string): string | null { return codexEntry(text)?.url ?? null; }
function extractHookUrls(text: string): string[] {
  try {
    const root = JSON.parse(text) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    return Object.values(root.hooks ?? {}).flatMap(entries => entries.flatMap(entry => entry.hooks ?? [])).map(hook => hook.command ?? '').filter(command => command.includes('engram-mdb-remote:') && command.includes('--remote-url')).flatMap(command => {
      const match = /--remote-url\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/.exec(command);
      if (!match) return [];
      try { return [JSON.parse(match[1]![0] === '"' ? match[1]! : `"${match[1]!.slice(1, -1)}"`) as string]; } catch { return []; }
    });
  } catch { return []; }
}
async function exists(file: string): Promise<boolean> { return fs.lstat(file).then(s => s.isFile() && !s.isSymbolicLink(), () => false); }
async function snapshot(file: string): Promise<FileState> { return readState(file); }
async function stateFingerprint(): Promise<string> {
  const files = [clientEnvPath(), userConfigPath(), claudeMcpPath(), codexMcpPath(), settingsPath('claude-code'), settingsPath('codex'), servicePaths().unit, servicePaths().metadata];
  const values = await Promise.all(files.map(async file => { const state = await snapshot(file); return [file, state.exists, state.mode ?? null, state.bytes ? createHash('sha256').update(state.bytes).digest('hex') : null]; }));
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
function servicePaths(): { unit: string; metadata: string } {
  const directory = process.platform === 'darwin' ? path.join(homeDir(), 'Library/LaunchAgents') : path.join(homeDir(), '.config/systemd/user');
  return { unit: path.join(directory, process.platform === 'darwin' ? 'dev.engram.outbox-watch.plist' : 'engram-outbox-watch.service'), metadata: path.join(directory, process.platform === 'darwin' ? 'dev.engram.outbox-watch.json' : 'engram-outbox-watch.json') };
}
async function targets(): Promise<Target[]> {
  const envFile = await readState(clientEnvPath()), env = parseClientEnv(envFile.bytes?.toString('utf8') ?? '');
  const serviceFiles = servicePaths(), serviceState = await readState(serviceFiles.metadata), service = serviceState.bytes ? JSON.parse(serviceState.bytes.toString('utf8')) as { url?: string } : {};
  const user = await readUserConfig();
  const claudeFile = await readState(claudeMcpPath()), codexFile = await readState(codexMcpPath());
  const claudeSettings = settingsPath('claude-code'), codexSettings = settingsPath('codex');
  const [claudeHooks, codexHooks] = await Promise.all([readState(claudeSettings), readState(codexSettings)]);
  const hookUrls = [...(claudeHooks.bytes ? extractHookUrls(claudeHooks.bytes.toString('utf8')) : []), ...(codexHooks.bytes ? extractHookUrls(codexHooks.bytes.toString('utf8')) : [])];
  const serviceInstalled = await exists(serviceFiles.unit);
  const claudeUrl = claudeFile.bytes ? extractClaudeUrl(claudeFile.bytes.toString('utf8')) : null;
  const codexUrl = codexFile.bytes ? extractCodexUrl(codexFile.bytes.toString('utf8')) : null;
  return [
    { target: 'client.env', exists: true, currentUrl: env.url ?? null, currentTokenFile: env.tokenFile ? expandPath(env.tokenFile) : null, path: clientEnvPath() },
    { target: 'outbox service', exists: serviceInstalled, currentUrl: service.url ?? null, path: serviceFiles.unit, status: serviceInstalled ? undefined : 'skipped' },
    { target: 'user.json', exists: !!user, currentUrl: user?.serverUrl ?? null, path: userConfigPath(), status: user ? undefined : 'skipped' },
    { target: 'Claude MCP', exists: !!claudeUrl, currentUrl: claudeUrl, path: claudeMcpPath(), status: claudeUrl ? undefined : 'skipped' },
    { target: 'Codex MCP', exists: !!codexUrl, currentUrl: codexUrl, path: codexMcpPath(), status: codexUrl ? undefined : 'skipped' },
    { target: 'hook commands', exists: hookUrls.length > 0, currentUrl: hookUrls.length ? [...new Set(hookUrls)].join(', ') : null, path: `${claudeSettings};${codexSettings}`, status: hookUrls.length ? undefined : 'skipped' },
  ];
}
export async function getClientServer(): Promise<unknown> {
  const list = await targets(), user = await readUserConfig();
  const env = parseClientEnv((await readState(clientEnvPath())).bytes?.toString('utf8') ?? '');
  const tokenFile = process.env.ENGRAM_TOKEN_FILE ?? env.tokenFile ?? path.join(configDir(), 'client.token');
  return { url: user?.serverUrl ?? process.env.ENGRAM_MCP_URL ?? env.url ?? null, tokenFile, workspace: user?.workspaceId ?? null, targets: list.map(({ path: _path, ...target }) => target) };
}
export async function previewClientServer(input: unknown): Promise<{ url: string; tokenFile: string; workspace: string | null; changes: Array<{ target: string; current: string | null; next: string; action: 'will-update' | 'unchanged' | 'skipped(not configured on this machine)' }>; digest: string }> {
  const body = input as { url?: unknown; tokenFile?: unknown };
  const desired = { url: normalizedUrl(body?.url), tokenFile: await validateTokenFile(body?.tokenFile) };
  const state = await targets();
  const changes = state.map(target => {
    const current = target.target === 'client.env' ? `${target.currentUrl ?? ''}\n${target.currentTokenFile ?? ''}` : target.currentUrl;
    const next = target.target === 'client.env' ? `${desired.url}\n${desired.tokenFile}` : desired.url;
    const action = target.status === 'skipped' ? 'skipped(not configured on this machine)' as const : current === next ? 'unchanged' as const : 'will-update' as const;
    return { target: target.target, current, next, action };
  });
  const binding = JSON.stringify({ desired, state: state.map(({ target, exists, currentUrl, currentTokenFile, status }) => ({ target, exists, currentUrl, currentTokenFile, status })), fingerprint: await stateFingerprint() });
  return { url: desired.url, tokenFile: desired.tokenFile, workspace: (await readUserConfig().catch(() => undefined))?.workspaceId ?? null, changes, digest: createHash('sha256').update(binding).digest('hex') };
}
export interface ClientServerApplyOperations {
  service?: (url: string, tokenFile: string) => Promise<unknown>;
  writeClaude?: (url: string, workspace: string) => Promise<unknown>;
  writeCodex?: (url: string, workspace: string) => Promise<unknown>;
  refreshHooks?: (url: string) => Promise<{ commands: number }>;
}
export async function applyClientServer(input: unknown, operations: ClientServerApplyOperations = {}): Promise<{ ok: true; results: Array<{ target: string; status: 'updated' | 'unchanged' | 'skipped' | 'failed'; reason?: string }> } | { ok: false; failedTarget: string; reason: string; rolledBack: string[]; results: Array<{ target: string; status: 'updated' | 'unchanged' | 'skipped' | 'failed'; reason?: string }> }> {
  const body = input as { url?: unknown; tokenFile?: unknown; digest?: unknown };
  const preview = await previewClientServer({ url: body?.url, tokenFile: body?.tokenFile });
  if (typeof body?.digest !== 'string' || body.digest !== preview.digest) throw Object.assign(new Error('Preview is stale; review a fresh preview before applying'), { status: 409, code: 'PREVIEW_STALE' });
  const desired = { url: preview.url, tokenFile: preview.tokenFile }, state = await targets(), results: Array<{ target: string; status: 'updated' | 'unchanged' | 'skipped' | 'failed'; reason?: string }> = [];
  const changed: Array<{ target: string; rollback: () => Promise<void> }> = [];
  const envFile = clientEnvPath(), envBefore = await snapshot(envFile), envOld = parseClientEnv(envBefore.bytes?.toString('utf8') ?? '');
  const service = servicePaths(), serviceBefore = await snapshot(service.unit), metadataBefore = await snapshot(service.metadata);
  const servicePrevious = metadataBefore.bytes ? JSON.parse(metadataBefore.bytes.toString('utf8')) as { url?: string; tokenFile?: string } : {};
  const userBefore = await snapshot(userConfigPath()), claudeBefore = await snapshot(claudeMcpPath()), codexBefore = await snapshot(codexMcpPath());
  const claudeHooksBefore = await snapshot(settingsPath('claude-code')), codexHooksBefore = await snapshot(settingsPath('codex'));
  const user = await readUserConfig();
  const urlChanged = async (target: Target, action: () => Promise<void>, rollback: () => Promise<void>) => {
    if (target.status === 'skipped') { results.push({ target: target.target, status: 'skipped', reason: 'Not configured on this machine' }); return; }
    if (target.target !== 'client.env' && target.currentUrl === desired.url) { results.push({ target: target.target, status: 'unchanged' }); return; }
    if (target.target === 'client.env' && target.currentUrl === desired.url && target.currentTokenFile === desired.tokenFile) { results.push({ target: target.target, status: 'unchanged' }); return; }
    try { await action(); changed.push({ target: target.target, rollback }); results.push({ target: target.target, status: 'updated' }); }
    catch (error) { await rollback().catch(() => undefined); throw Object.assign(error instanceof Error ? error : new Error('Target update failed'), { target: target.target }); }
  };
  try {
    await urlChanged(state[0]!, async () => { const text = updateClientEnv(envBefore.bytes?.toString('utf8') ?? '', desired); await atomicWrite(envFile, text, 0o600); }, async () => restore(envFile, envBefore));
    await urlChanged(state[1]!, async () => { await (operations.service ?? (async (url, tokenFile) => manageClientService({ action: 'reconfigure', url, tokenFile })))(desired.url, desired.tokenFile); }, async () => { if (serviceBefore.exists) await (operations.service ?? (async (url, tokenFile) => manageClientService({ action: 'reconfigure', url, tokenFile })))(servicePrevious.url ?? envOld.url ?? desired.url, servicePrevious.tokenFile ?? envOld.tokenFile ?? desired.tokenFile); await restore(service.unit, serviceBefore); await restore(service.metadata, metadataBefore); });
    await urlChanged(state[2]!, async () => { if (user) await writeUserConfig({ ...user, serverUrl: desired.url }); }, async () => restore(userConfigPath(), userBefore));
    await urlChanged(state[3]!, async () => { await (operations.writeClaude ?? ((url, workspace) => upsertClaudeMcp(claudeMcpPath(), url, 'ENGRAM_MCP_TOKEN', workspace, { backup: false, allowEndpointChange: true })))(desired.url, user?.workspaceId ?? 'personal'); }, async () => restore(claudeMcpPath(), claudeBefore));
    await urlChanged(state[4]!, async () => { await (operations.writeCodex ?? ((url, workspace) => upsertCodexMcp(codexMcpPath(), url, 'ENGRAM_MCP_TOKEN', workspace, { backup: false })))(desired.url, user?.workspaceId ?? 'personal'); }, async () => restore(codexMcpPath(), codexBefore));
    const hooksTarget = state[5]!;
    await urlChanged(hooksTarget, async () => {
      const count = operations.refreshHooks ? (await operations.refreshHooks(desired.url)).commands : (await Promise.all((['claude-code', 'codex'] as const).map(async host => createAdapter(host, { root: path.dirname(userConfigPath()), settingsPath: settingsPath(host) }).refreshRemoteUrl(desired.url)))).reduce((sum, item) => sum + item.commands, 0);
      if (!count) throw new Error('No installed Engram remote hook commands were refreshed');
    }, async () => { await restore(settingsPath('claude-code'), claudeHooksBefore); await restore(settingsPath('codex'), codexHooksBefore); });
    return { ok: true, results };
  } catch (error) {
    const failedTarget = (error as Error & { target?: string }).target ?? 'apply';
    const rolledBack: string[] = [];
    for (const item of changed.reverse()) { try { await item.rollback(); rolledBack.push(item.target); } catch { /* report incomplete rollback below */ } }
    const failed = error as Error & { message?: string };
    results.push({ target: failedTarget, status: 'failed', reason: failed.message ?? 'Target update failed' });
    for (const target of rolledBack) { const item = results.find(result => result.target === target); if (item) item.reason = 'Rolled back after a later target failed'; }
    return { ok: false, failedTarget, reason: 'Apply failed; changed targets were rolled back where possible', rolledBack, results };
  }
}
