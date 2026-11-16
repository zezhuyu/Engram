import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Vault } from '../core/vault.js';
import { createHttpCredential, listHttpCredentials, revokeHttpCredential, rotateHttpCredential } from '../mcp/credentials.js';
import { findExecutable } from '../models/cli.js';
import { PERSONAL_WORKSPACE_ID } from '../chat/projects.js';

export type GatewayWorkspace = { name: string; workspace: string; collection?: string; allowWrites: boolean; credentialId: string; tokenEnv: string };
type OpenAIConfig = { profileName: string; workspaces: GatewayWorkspace[]; allowAnyWorkspaceByName?: boolean; chatGPTMayWrite?: boolean; writePolicyVersion?: number; dynamicWritableWorkspaces?: string[]; gatewayWorkspaceNames?: string[]; gatewayCredentialId?: string; gatewayTokenEnv?: string; defaultRowRemoved?: boolean };
const slug = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const TUNNEL_HEALTH_PORT = 3337;
const TUNNEL_STARTING_GRACE_MS = 15_000;
export const SERVICE_STATUS_PROBE_TIMEOUT_MS = 5_000;
const tunnelFirstSeen = new Map<number, number>();
const home = () => process.env.HOME ?? '';
const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'engram');
const configFile = (root: string) => path.join(root, '.mdb', 'dashboard', 'connectors.json');
const privateDir = async (dir: string) => { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700); };
async function atomicPrivate(file: string, data: string): Promise<void> {
  await privateDir(path.dirname(file));
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await fs.chmod(temp, 0o600); await fs.rename(temp, file); await fs.chmod(file, 0o600); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
function parseEnv(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    // Decode the single-quoted shell format emitted by quoteEnv without evaluating it.
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'");
    result.set(match[1]!, value);
  }
  return result;
}
function quoteEnv(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
async function readEnv(file: string): Promise<Map<string, string>> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Private environment file must be an owned regular 0600 file');
    return parseEnv(await fs.readFile(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); throw error; }
}
async function writeEnv(file: string, values: Map<string, string>): Promise<void> { await atomicPrivate(file, [...values].map(([key, value]) => key + '=' + quoteEnv(value)).join('\n') + '\n'); }
async function readStore(root: string): Promise<Record<string, any>> {
  try { const parsed = JSON.parse(await fs.readFile(configFile(root), 'utf8')); return parsed && parsed.version === 1 && parsed.connectors && typeof parsed.connectors === 'object' ? parsed.connectors : {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Connector configuration is invalid'); }
}
async function writeStore(root: string, store: Record<string, any>): Promise<void> {
  await privateDir(path.dirname(configFile(root)));
  const file = configFile(root), temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify({ version: 1, connectors: store }, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); await fs.chmod(file, 0o600); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
function empty(): OpenAIConfig { return { profileName: 'engram-keyed', workspaces: [], allowAnyWorkspaceByName: true, chatGPTMayWrite: true, defaultRowRemoved: false }; }
async function recentGatewayWrites(vault: Vault): Promise<Array<{ at: string; target: string; revisionId: string }>> {
  const events = (await vault.eventsSince(0)).slice(-1000).reverse(), writes: Array<{ at: string; target: string; revisionId: string }> = [];
  for (const event of events) {
    const doc = await vault.get(event.objectId, event.revisionId).catch(() => undefined);
    if (!doc || event.operation === 'purge' || !(event.idempotencyActorId === 'chatgpt-gateway' || doc.createdBy === 'chatgpt-gateway' || doc.metadata.actorId === 'chatgpt-gateway')) continue;
    writes.push({ at: event.timestamp, target: doc.uri, revisionId: event.revisionId });
    if (writes.length === 20) break;
  }
  return writes;
}
/** Whether Engram should bring the tunnel services up by itself. On unless the owner pressed Stop; Start turns it back on. */
export async function openAIAutoStart(root: string): Promise<boolean> {
  try { return (await readStore(root)).openai?.autoStart !== false; } catch { return true; }
}
/** Best effort: the service action already succeeded, so a failure to remember the choice must not turn it into an error. */
async function setOpenAIAutoStart(root: string, enabled: boolean): Promise<void> {
  try {
    const store = await readStore(root);
    if ((store.openai?.autoStart !== false) === enabled) return;
    await writeStore(root, { ...store, openai: { ...(store.openai ?? {}), autoStart: enabled } });
  } catch { /* the preference is simply not recorded */ }
}
export async function openAIConfig(root: string, vault?: Vault) {
  const all = await readStore(root), saved = all.openai ?? {}, env = await readEnv(path.join(configDir(), 'chatgpt-tunnel.env'));
  const rows: GatewayWorkspace[] = Array.isArray(saved.workspaces) ? saved.workspaces : [];
  const accessible: string[] = vault ? (await vault.listWorkspaces()).map(item => item.id).filter(name => slug.test(name)) : Array.isArray(saved.gatewayWorkspaceNames) ? saved.gatewayWorkspaceNames : [];
  const writable = new Set<string>(saved.chatGPTMayWrite === false ? [] : Array.isArray(saved.dynamicWritableWorkspaces) ? saved.dynamicWritableWorkspaces : accessible);
  const explicit = new Map(rows.map((row: GatewayWorkspace) => [row.name, row]));
  const writesEnabled = saved.chatGPTMayWrite !== false;
  return { tunnelId: env.get('ENGRAM_TUNNEL_ID') ?? '', apiKeySet: !!env.get('ENGRAM_TUNNEL_RUNTIME_KEY'), organizationId: env.get('ENGRAM_OPENAI_ORGANIZATION_ID') ?? '', profileName: typeof saved.profileName === 'string' ? saved.profileName : 'engram-keyed', allowAnyWorkspaceByName: saved.allowAnyWorkspaceByName !== false, chatGPTMayWrite: writesEnabled, reservedNames: ['profile', 'user-insight', 'wiki'], recentWrites: vault ? await recentGatewayWrites(vault) : [], reachableWorkspaces: [{ name: 'wiki', workspace: 'wiki', allowWrites: writesEnabled }, ...accessible.filter(name => name !== 'wiki').map(name => ({ name, workspace: name, allowWrites: writesEnabled && (explicit.has(name) ? explicit.get(name)!.allowWrites : writable.has(name)) }))], workspaces: rows.map(({ name, workspace, collection, allowWrites, credentialId }: GatewayWorkspace) => ({ name, workspace, ...(collection ? { collection } : {}), allowWrites: writesEnabled && allowWrites === true, isDefault: name === PERSONAL_WORKSPACE_ID && credentialId === saved.gatewayCredentialId })) };
}
export async function saveOpenAIConfig(root: string, values: Record<string, unknown>, vault?: Vault): Promise<void> {
  const store = await readStore(root), existing = { ...empty(), ...(store.openai ?? {}) }, next = { ...existing };
  if (values.profileName !== undefined) {
    const value = values.profileName;
    if (typeof value !== 'string' || !slug.test(value)) throw new Error('Profile name must be a lowercase slug');
    next.profileName = value;
  }
  if (values.chatGPTMayWrite !== undefined) {
    if (typeof values.chatGPTMayWrite !== 'boolean') throw new Error('chatGPTMayWrite must be a boolean');
    next.chatGPTMayWrite = values.chatGPTMayWrite;
  }
  const file = path.join(configDir(), 'chatgpt-tunnel.env'), env = await readEnv(file);
  for (const [field, key] of [['tunnelId', 'ENGRAM_TUNNEL_ID'], ['organizationId', 'ENGRAM_OPENAI_ORGANIZATION_ID'], ['apiKey', 'ENGRAM_TUNNEL_RUNTIME_KEY']] as const) {
    const value = values[field]; if (value === undefined) continue;
    if (value === null || value === '') { env.delete(key); continue; }
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('Invalid OpenAI tunnel setting');
    env.set(key, value);
  }
  await writeEnv(file, env);
  await writeStore(root, { ...store, openai: next });
  if (vault) await syncChatGateway(root, vault);
  else await saveGatewayFiles(next.workspaces ?? [], next.profileName ?? 'engram-keyed', { tokenEnv: next.gatewayTokenEnv, names: next.gatewayWorkspaceNames, writable: next.dynamicWritableWorkspaces, enabled: next.allowAnyWorkspaceByName, writesEnabled: next.chatGPTMayWrite !== false });
}
export function validateWorkspaceRow(input: unknown): Omit<GatewayWorkspace, 'credentialId' | 'tokenEnv'> {
  if (!input || typeof input !== 'object') throw new Error('Workspace row is required');
  const value = input as Record<string, unknown>;
  if (typeof value.name !== 'string' || !slug.test(value.name)) throw new Error('Workspace name must be a lowercase slug');
  if (typeof value.workspace !== 'string' || !identifier.test(value.workspace)) throw new Error('Workspace ID is invalid');
  if (value.collection !== undefined && value.collection !== null && value.collection !== '' && (typeof value.collection !== 'string' || !identifier.test(value.collection))) throw new Error('Collection ID is invalid');
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean') throw new Error('allowWrites must be a boolean');
  return { name: value.name, workspace: value.workspace, ...(typeof value.collection === 'string' && value.collection ? { collection: value.collection } : {}), allowWrites: value.allowWrites !== false };
}
async function saveGatewayFiles(rows: GatewayWorkspace[], profileName: string, dynamic: { tokenEnv?: string; names?: string[]; writable?: string[]; enabled?: boolean; writesEnabled?: boolean } = {}): Promise<void> {
  const dir = configDir(), values = new Map<string, string>();
  const old = await readEnv(path.join(dir, 'keyed-gateway.env'));
  for (const row of rows) {
    const key = row.tokenEnv;
    const token = old.get(key);
    if (token) values.set(key, token);
  }
  if (dynamic.tokenEnv && old.has(dynamic.tokenEnv)) values.set(dynamic.tokenEnv, old.get(dynamic.tokenEnv)!);
  values.set('GATEWAY_WORKSPACES', JSON.stringify(rows.map(({ name, workspace, collection, allowWrites, tokenEnv }) => ({ name, tokenEnv, scope: { type: 'workspace', workspaceId: workspace, ...(collection ? { collectionId: collection } : {}) }, allowWrites }))));
  values.set('GATEWAY_DYNAMIC_TOKEN_ENV', dynamic.tokenEnv ?? 'ENGRAM_TOKEN_CHATGPT_GATEWAY');
  values.set('GATEWAY_DYNAMIC_WORKSPACES', JSON.stringify(dynamic.names ?? []));
  values.set('GATEWAY_DYNAMIC_WRITABLE_WORKSPACES', JSON.stringify(dynamic.writable ?? [PERSONAL_WORKSPACE_ID]));
  values.set('GATEWAY_ALLOW_ANY_WORKSPACE_BY_NAME', dynamic.enabled === false ? 'false' : 'true');
  values.set('GATEWAY_WRITES_ENABLED', dynamic.writesEnabled === false ? 'false' : 'true');
  values.set('GATEWAY_PORT', process.env.ENGRAM_KEYED_GATEWAY_PORT || '3335');
  values.set('ENGRAM_UPSTREAM', 'http://127.0.0.1:3333/mcp');
  await writeEnv(path.join(dir, 'keyed-gateway.env'), values);
  const tunnelDir = path.join(dir, 'tunnel-client'); await privateDir(tunnelDir);
  const tunnelEnv = await readEnv(path.join(dir, 'chatgpt-tunnel.env'));
  const tunnelId = tunnelEnv.get('ENGRAM_TUNNEL_ID') ?? '${ENGRAM_TUNNEL_ID}';
  const profile = 'config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: "' + tunnelId.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"\n  api_key: "env:ENGRAM_TUNNEL_RUNTIME_KEY"\nhealth:\n  listen_addr: "127.0.0.1:' + TUNNEL_HEALTH_PORT + '"\nadmin_ui:\n  open_browser: false\nlog:\n  level: info\n  format: json\nmcp:\n  server_urls:\n    - channel: main\n      url: "http://127.0.0.1:3335/mcp"\n';
  await atomicPrivate(path.join(tunnelDir, profileName + '.yaml'), profile);
}
function gatewayPermissions(names: string[], writable: string[], writesEnabled: boolean): string[] {
  return [...names.flatMap(name => [`workspace:${name}:read`, ...(writesEnabled && writable.includes(name) ? [`workspace:${name}:write`] : [])]), 'global:profile:read', ...(writesEnabled ? ['global:profile:write', 'global:wiki:write'] : []), 'global:shared:read', 'global:wiki:read'].sort();
}
async function syncChatGateway(root: string, vault: Vault): Promise<void> {
  let store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) };
  let workspaces = await vault.listWorkspaces();
  if (!workspaces.some(item => item.id === PERSONAL_WORKSPACE_ID)) {
    await vault.createWorkspace(PERSONAL_WORKSPACE_ID, 'Personal conversations and account-scoped chat registry');
    workspaces = await vault.listWorkspaces();
  }
  const names = workspaces.map(item => item.id).filter(name => slug.test(name)).sort();
  const allowWrites = cfg.chatGPTMayWrite !== false;
  const savedWritable = cfg.writePolicyVersion === 16 && Array.isArray(cfg.dynamicWritableWorkspaces) ? cfg.dynamicWritableWorkspaces : names;
  const writable = allowWrites ? [...new Set(savedWritable)].filter(name => names.includes(name)) : [];
  const actorId = 'chatgpt-gateway', tokenEnv = cfg.gatewayTokenEnv ?? 'ENGRAM_TOKEN_CHATGPT_GATEWAY';
  const previousGatewayCredentialId = cfg.gatewayCredentialId;
  for (const name of names) await vault.grant(name, actorId, ['read', ...(writable.includes(name) ? ['write' as const] : [])]);
  for (const oldName of cfg.gatewayWorkspaceNames ?? []) if (!names.includes(oldName)) await vault.revoke(oldName, actorId).catch(() => undefined);
  const permissions = gatewayPermissions(names, writable, allowWrites);
  const credentials = await listHttpCredentials(vault);
  const current = credentials.find(item => item.id === cfg.gatewayCredentialId) ?? credentials.find(item => item.actorId === actorId);
  const envFile = path.join(configDir(), 'keyed-gateway.env'), env = await readEnv(envFile);
  let credential: { id: string; token: string } | undefined;
  if (!current) credential = await createHttpCredential(vault, actorId, permissions);
  else if (JSON.stringify([...current.permissions].sort()) !== JSON.stringify(permissions) || !env.get(tokenEnv)) credential = await rotateHttpCredential(vault, current.id, permissions);
  if (credential) env.set(tokenEnv, credential.token);
  const gatewayCredentialId = credential?.id ?? current?.id ?? cfg.gatewayCredentialId;
  if (!gatewayCredentialId) throw new Error('ChatGPT gateway credential could not be configured');
  const wasStep15 = cfg.writePolicyVersion !== 16;
  cfg = { ...cfg, gatewayCredentialId, gatewayTokenEnv: tokenEnv, gatewayWorkspaceNames: names, dynamicWritableWorkspaces: writable, writePolicyVersion: 16, allowAnyWorkspaceByName: cfg.allowAnyWorkspaceByName !== false };
  const rows = (cfg.workspaces ?? []).map(row => row.name === PERSONAL_WORKSPACE_ID && (row.tokenEnv === tokenEnv || row.credentialId === previousGatewayCredentialId) ? { ...row, allowWrites: writable.includes(PERSONAL_WORKSPACE_ID), credentialId: gatewayCredentialId, tokenEnv } : wasStep15 && !row.allowWrites ? { ...row, allowWrites: writable.includes(row.workspace) } : row);
  if (!cfg.defaultRowRemoved && !rows.some(row => row.name === PERSONAL_WORKSPACE_ID)) rows.unshift({ name: PERSONAL_WORKSPACE_ID, workspace: PERSONAL_WORKSPACE_ID, allowWrites: writable.includes(PERSONAL_WORKSPACE_ID), credentialId: gatewayCredentialId, tokenEnv });
  cfg.workspaces = rows;
  for (const row of rows) {
    if (!row.credentialId || row.credentialId === gatewayCredentialId) continue;
    const expected = [`workspace:${row.workspace}:${row.collection ? `collection:${row.collection}:` : ''}read`, ...(allowWrites && row.allowWrites ? [`workspace:${row.workspace}:${row.collection ? `collection:${row.collection}:` : ''}write`] : [])].sort();
    const currentRowCredential = (await listHttpCredentials(vault)).find(item => item.id === row.credentialId);
    if (currentRowCredential && JSON.stringify([...currentRowCredential.permissions].sort()) === JSON.stringify(expected) && env.get(row.tokenEnv)) continue;
    if (!currentRowCredential) continue;
    const replacement = await rotateHttpCredential(vault, row.credentialId, expected);
    env.set(row.tokenEnv, replacement.token); row.credentialId = replacement.id;
  }
  await writeEnv(envFile, env);
  await writeStore(root, { ...store, openai: cfg });
  await saveGatewayFiles(rows.map(row => ({ ...row, allowWrites: allowWrites && row.allowWrites })), cfg.profileName ?? 'engram-keyed', { tokenEnv, names, writable, enabled: cfg.allowAnyWorkspaceByName, writesEnabled: cfg.chatGPTMayWrite !== false });
}
export async function upsertOpenAIWorkspace(root: string, vault: Vault, input: unknown): Promise<void> {
  await syncChatGateway(root, vault);
  const row = validateWorkspaceRow(input), store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) };
  if (row.name === PERSONAL_WORKSPACE_ID && cfg.workspaces.some(item => item.name === row.name && item.credentialId === cfg.gatewayCredentialId)) throw new Error('The default personal row is managed by ChatGPT connector settings');
  const actorId = 'chatgpt-' + row.name, tokenEnv = 'ENGRAM_TOKEN_' + row.name.toUpperCase().replaceAll('-', '_');
  const permissions = [`workspace:${row.workspace}:${row.collection ? 'collection:' + row.collection + ':' : ''}read`, ...(row.allowWrites ? [`workspace:${row.workspace}:${row.collection ? 'collection:' + row.collection + ':' : ''}write`] : [])];
  const old = cfg.workspaces.find(item => item.name === row.name);
  const credential = old ? await rotateHttpCredential(vault, old.credentialId, permissions) : await createHttpCredential(vault, actorId, permissions);
  try {
    if (old && old.workspace !== row.workspace) await vault.revoke(old.workspace, actorId);
    await vault.grant(row.workspace, actorId, row.allowWrites ? ['read', 'write'] : ['read']);
    const envFile = path.join(configDir(), 'keyed-gateway.env'), env = await readEnv(envFile);
    env.set(tokenEnv, credential.token);
    const next = [...cfg.workspaces.filter(item => item.name !== row.name), { ...row, credentialId: credential.id, tokenEnv }];
    cfg.workspaces = next; await writeStore(root, { ...store, openai: cfg }); await writeEnv(envFile, env); await syncChatGateway(root, vault);
  } catch (error) { await revokeHttpCredential(vault, credential.id).catch(() => undefined); throw error; }
}
export async function removeOpenAIWorkspace(root: string, vault: Vault, name: string): Promise<boolean> {
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) }, row = cfg.workspaces.find(item => item.name === name);
  if (!row) return false;
  const isGatewayCredential = row.credentialId === cfg.gatewayCredentialId;
  if (isGatewayCredential) cfg.defaultRowRemoved = true;
  else { await revokeHttpCredential(vault, row.credentialId); await vault.revoke(row.workspace, 'chatgpt-' + row.name); }
  const next = cfg.workspaces.filter(item => item.name !== name), envFile = path.join(configDir(), 'keyed-gateway.env'), env = await readEnv(envFile);
  if (!isGatewayCredential) env.delete(row.tokenEnv);
  cfg.workspaces = next;
  if (!next.length) cfg.defaultRowRemoved = true;
  await writeStore(root, { ...store, openai: cfg }); await writeEnv(envFile, env); await syncChatGateway(root, vault); return true;
}
export async function rotateOpenAIWorkspace(root: string, vault: Vault, name: string): Promise<boolean> {
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) }, row = cfg.workspaces.find(item => item.name === name);
  if (!row) return false;
  if (row.credentialId === cfg.gatewayCredentialId) throw new Error('The default personal credential is managed by ChatGPT connector settings');
  const permissions = [`workspace:${row.workspace}:${row.collection ? 'collection:' + row.collection + ':' : ''}read`, ...(row.allowWrites ? [`workspace:${row.workspace}:${row.collection ? 'collection:' + row.collection + ':' : ''}write`] : [])];
  const replacement = await rotateHttpCredential(vault, row.credentialId, permissions), envFile = path.join(configDir(), 'keyed-gateway.env'), env = await readEnv(envFile);
  env.set(row.tokenEnv, replacement.token); row.credentialId = replacement.id;
  await writeStore(root, { ...store, openai: cfg }); await writeEnv(envFile, env); await syncChatGateway(root, vault); return true;
}
export async function setOpenAIByNameEnabled(root: string, vault: Vault, enabled: boolean): Promise<void> {
  await syncChatGateway(root, vault);
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}), allowAnyWorkspaceByName: enabled };
  await writeStore(root, { ...store, openai: cfg }); await syncChatGateway(root, vault);
}
export async function setOpenAIWorkspaceWriteAccess(root: string, vault: Vault, name: string, allowWrites: boolean): Promise<void> {
  if (!slug.test(name) || typeof allowWrites !== 'boolean') throw new Error('Workspace write setting is invalid');
  await syncChatGateway(root, vault);
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) }, row = cfg.workspaces.find(item => item.name === name);
  if (row && row.credentialId !== cfg.gatewayCredentialId) { await upsertOpenAIWorkspace(root, vault, { name: row.name, workspace: row.workspace, collection: row.collection, allowWrites }); return; }
  if (!cfg.gatewayWorkspaceNames?.includes(name)) throw new Error('Workspace not found or not accessible');
  if (name === PERSONAL_WORKSPACE_ID && !cfg.gatewayWorkspaceNames?.includes(name)) throw new Error('Workspace not found or not accessible');
  const writable = new Set(cfg.dynamicWritableWorkspaces ?? [PERSONAL_WORKSPACE_ID]);
  if (allowWrites) writable.add(name); else writable.delete(name);
  cfg.dynamicWritableWorkspaces = [...writable]; cfg.writePolicyVersion = 16;
  await writeStore(root, { ...store, openai: cfg }); await syncChatGateway(root, vault);
}
export async function setOpenAIWriteEnabled(root: string, vault: Vault, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}), chatGPTMayWrite: enabled };
  cfg.writePolicyVersion = 16;
  if (enabled && !Array.isArray(cfg.dynamicWritableWorkspaces)) cfg.dynamicWritableWorkspaces = (await vault.listWorkspaces()).map(item => item.id);
  await writeStore(root, { ...store, openai: cfg }); await syncChatGateway(root, vault);
}
export async function discoverTunnelClient(): Promise<{ found: boolean; path: string | null }> {
  const candidates = [path.join(home(), 'Library/Application Support/agent-slack-desktop/tools/tunnel-client/tunnel-client'), path.join(configDir(), 'tunnel-client/tunnel-client'), findExecutable('tunnel-client')].filter((value): value is string => !!value);
  for (const candidate of candidates) { try { const info = await fs.lstat(candidate); await fs.access(candidate, 1); if (info.isFile() && !info.isSymbolicLink()) return { found: true, path: path.resolve(candidate) }; } catch { /* next fixed candidate */ } }
  return { found: false, path: null };
}
export type TunnelState = 'unknown' | 'stopped' | 'starting' | 'connected' | 'running-not-ready' | 'failing';
export function deriveTunnelState(input: { loaded: boolean; running: boolean; ready: boolean; uptimeMs: number | null; failureReason?: string; statusUnknown?: boolean }): TunnelState {
  if (input.statusUnknown) return 'unknown';
  if (!input.loaded) return 'stopped';
  if (!input.running) return input.failureReason ? 'failing' : 'stopped';
  if (input.ready) return 'connected';
  if (input.uptimeMs === null || input.uptimeMs < TUNNEL_STARTING_GRACE_MS) return 'starting';
  if (input.failureReason) return 'failing';
  return 'running-not-ready';
}
function redactTunnelText(value: string): string {
  return value.replace(/(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;"}]+/ig, '[redacted]').replace(/https?:\/\/[^\s"}]+/ig, '[URL]').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
}
async function readTunnelLogTail(file: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat(), length = Math.min(stat.size, 256 * 1024), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch { return ''; }
  finally { await handle?.close().catch(() => undefined); }
}
function tunnelLogEntries(text: string): Array<{ line: string; level: string; at?: number }> {
  return text.split(/\r?\n/u).filter(Boolean).flatMap(raw => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const level = String(parsed.level ?? parsed.severity ?? '').toLowerCase();
      const message = String(parsed.message ?? parsed.msg ?? parsed.event ?? '');
      const atValue = parsed.timestamp ?? parsed.time ?? parsed.ts;
      const at = typeof atValue === 'number' ? (atValue < 10_000_000_000 ? atValue * 1000 : atValue) : typeof atValue === 'string' ? Date.parse(atValue) : NaN;
      return message ? [{ line: redactTunnelText(message), level, ...(Number.isFinite(at) ? { at } : {}) }] : [];
    } catch {
      const match = /\b(ERROR|WARN|WARNING)\b\s*[: -]?\s*(.*)/i.exec(raw);
      return match ? [{ line: redactTunnelText(match[2]!), level: match[1]!.toLowerCase() }] : [];
    }
  });
}
function tunnelFailureSummary(entries: Array<{ line: string; level: string }>): string | undefined {
  const relevant = entries.filter(entry => ['error', 'warn', 'warning'].includes(entry.level) && !(/OAuth discovery failed/i.test(entry.line) && /404|empty body/i.test(entry.line)));
  const last = relevant.at(-1)?.line;
  if (!last) return undefined;
  if (/tunnel.?id|api.?key|unauthori[sz]ed|forbidden|401|403/i.test(last)) return 'Tunnel ID or API key was rejected; verify both values in tunnel settings.';
  if (/organi[sz]ation|org.?id/i.test(last)) return 'Organization ID mismatch; check the organization configured for this tunnel.';
  if (/network|unreachable|connection refused|timeout|dns|resolve/i.test(last)) return 'Tunnel service cannot reach its network endpoint; check connectivity and DNS.';
  return last;
}
export function summarizeTunnelClientLog(text: string): { failureReason?: string; recentLogLines: string[] } {
  const entries = tunnelLogEntries(text).filter(entry => !(/OAuth discovery failed/i.test(entry.line) && /404|empty body/i.test(entry.line)));
  const failureReason = tunnelFailureSummary(entries);
  return { ...(failureReason ? { failureReason } : {}), recentLogLines: entries.slice(-5).map(entry => entry.line) };
}
function tunnelHealthUrl(profile: string, log: string): string | undefined {
  const configured = /(?:^|\n)\s*listen_addr:\s*["']?([^"'\s]+)["']?/m.exec(profile)?.[1];
  const logged = [...log.matchAll(/(?:health_url|health-url)["']?\s*[=:]\s*["']?(https?:\/\/[^\s"'}]+)/ig)].at(-1)?.[1];
  const candidate = configured && !configured.endsWith(':0') ? 'http://' + configured + '/readyz' : logged;
  if (!candidate) return undefined;
  try { const url = new URL(candidate); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) && Number(url.port) > 0 ? 'http://127.0.0.1:' + Number(url.port) + '/readyz' : undefined; } catch { return undefined; }
}
async function probeTunnel(url?: string): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500), redirect: 'error' });
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader(), first = await reader.read();
    await reader.cancel().catch(() => undefined);
    return !!first.value && first.value.byteLength <= 16 && new TextDecoder().decode(first.value).trim().toLowerCase() === 'ready';
  } catch { return false; }
}
export async function openAIStatus(root: string, platform: NodeJS.Platform = process.platform) {
  const config = await openAIConfig(root), binary = await discoverTunnelClient(), dir = configDir(), gatewayLogPath = path.join(home(), 'Library/Logs/Engram/keyed-gateway.log'), tunnelLogPath = path.join(home(), 'Library/Logs/Engram/tunnel-client.log');
  let logAgeMs: number | null = null; try { logAgeMs = Math.max(0, Date.now() - (await fs.stat(gatewayLogPath)).mtimeMs); } catch { /* absent */ }
  let gatewayHealth: unknown = null; try { const response = await fetch('http://127.0.0.1:' + (process.env.ENGRAM_KEYED_GATEWAY_PORT || '3335') + '/health', { signal: AbortSignal.timeout(500) }); if (response.ok) gatewayHealth = await response.json(); } catch { /* down */ }
  const profilePath = path.join(dir, 'tunnel-client', config.profileName + '.yaml');
  const services = await Promise.all(['dev.engram.keyed-gateway', 'dev.engram.tunnel-client'].map(label => serviceStatus(label, platform)));
  const keyedGateway = services[0]!, tunnelService = services[1]!;
  let failureReason: string | undefined;
  if (!keyedGateway.statusUnknown && keyedGateway.loaded && (!keyedGateway.running || keyedGateway.lastExitCode !== null && keyedGateway.lastExitCode !== 0)) {
    const log = await fs.readFile(gatewayLogPath, 'utf8').catch(() => '');
    failureReason = 'Gateway is failing: ' + safeGatewayLogLine(log);
  }
  const [profile, tunnelLog] = await Promise.all([fs.readFile(profilePath, 'utf8').catch(() => ''), readTunnelLogTail(tunnelLogPath)]);
  const logEntries = tunnelLogEntries(tunnelLog), summary = summarizeTunnelClientLog(tunnelLog), tunnelFailure = summary.failureReason;
  let tunnelLogAt: string | null = null; try { tunnelLogAt = (await fs.stat(tunnelLogPath)).mtime.toISOString(); } catch { /* absent */ }
  const healthUrl = tunnelHealthUrl(profile, tunnelLog), ready = !tunnelService.statusUnknown && tunnelService.running && await probeTunnel(healthUrl);
  const now = Date.now();
  if (tunnelService.pid && !tunnelFirstSeen.has(tunnelService.pid)) tunnelFirstSeen.set(tunnelService.pid, now);
  for (const pid of tunnelFirstSeen.keys()) if (pid !== tunnelService.pid) tunnelFirstSeen.delete(pid);
  const loggedStart = [...logEntries].reverse().find(entry => /tunnel-client started/i.test(entry.line) && entry.at !== undefined)?.at;
  const uptimeMs = tunnelService.pid ? Math.max(0, now - (loggedStart ?? tunnelFirstSeen.get(tunnelService.pid) ?? now)) : null;
  const state = deriveTunnelState({ loaded: tunnelService.loaded, running: tunnelService.running, ready, uptimeMs, failureReason: tunnelFailure, statusUnknown: tunnelService.statusUnknown });
  const failure = state === 'failing' ? tunnelFailure ?? 'Tunnel client is not running; inspect its launch service and recent logs.' : tunnelFailure;
  return { autoStart: await openAIAutoStart(root), gateway: { state: keyedGateway.statusUnknown ? 'unknown' : gatewayHealth ? 'healthy' : 'stopped', healthy: !!gatewayHealth, health: gatewayHealth, ...(failureReason ? { failureReason } : {}) }, keyedGateway, tunnelClient: { ...tunnelService, state, ready, healthUrl: healthUrl ?? null, uptimeSeconds: uptimeMs === null ? null : Math.floor(uptimeMs / 1000), failureReason: failure ?? null, lastLogAt: tunnelLogAt, recentLogLines: summary.recentLogLines }, binaryFound: binary.found, profilePresent: !!(await fs.stat(profilePath).catch(() => undefined)), logAgeMs };
}
export type ServiceStatus = { loaded: boolean; running: boolean; pid: number | null; lastExitCode: number | null; restartCount: number | null; statusUnknown?: true };
export function parseSystemdServiceStatus(output: string, exitCode: number | null): ServiceStatus {
  const properties = new Map(output.split(/\r?\n/u).map(line => { const at = line.indexOf('='); return at < 0 ? ['', ''] : [line.slice(0, at), line.slice(at + 1)]; }));
  const loadState = properties.get('LoadState');
  const active = properties.get('ActiveState') === 'active';
  const pid = Number(properties.get('MainPID'));
  const status = Number(properties.get('ExecMainStatus'));
  const restarts = Number(properties.get('NRestarts'));
  const execMainStatus = properties.has('ExecMainStatus') && Number.isInteger(status) ? status : null;
  return {
    loaded: exitCode === 0 && loadState === 'loaded',
    running: active && Number.isInteger(pid) && pid > 0,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    lastExitCode: execMainStatus,
    restartCount: properties.has('NRestarts') && Number.isInteger(restarts) && restarts >= 0 ? restarts : null,
  };
}
export async function serviceStatus(label: string, platform: NodeJS.Platform = process.platform, options: { timeoutMs?: number } = {}): Promise<ServiceStatus> {
  const { spawn } = await import('node:child_process');
  if (platform !== 'darwin' && platform !== 'linux') return { loaded: false, running: false, pid: null, lastExitCode: null, restartCount: null };
  const macOS = platform === 'darwin';
  const executable = findExecutable(macOS ? 'launchctl' : 'systemctl') ?? (macOS ? '/bin/launchctl' : '/usr/bin/systemctl');
  const args = macOS ? ['print', 'gui/' + (typeof process.getuid === 'function' ? process.getuid() : 0) + '/' + label] : ['--user', 'show', label, '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,NRestarts,Result', '--no-page'];
  const timeoutMs = options.timeoutMs ?? SERVICE_STATUS_PROBE_TIMEOUT_MS;
  const probe = (): Promise<ServiceStatus> => new Promise(resolve => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false }); let output = '', settled = false;
    const stopped: ServiceStatus = { loaded: false, running: false, pid: null, lastExitCode: null, restartCount: null };
    const finish = (result: ServiceStatus) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ ...stopped, statusUnknown: true }); }, timeoutMs);
    child.stdout.on('data', chunk => { output += String(chunk).slice(0, 4096); });
    child.once('error', () => finish({ ...stopped, statusUnknown: true }));
    child.once('close', code => {
      if (macOS) {
        const pid = /(?:pid|MainPID)\s*=\s*(\d+)/i.exec(output)?.[1], exit = /last exit code\s*=\s*(-?\d+)/i.exec(output)?.[1];
        finish({ loaded: code === 0, running: /state = running/i.test(output), pid: pid && Number(pid) > 0 ? Number(pid) : null, lastExitCode: exit === undefined ? null : Number(exit), restartCount: null });
      } else finish(parseSystemdServiceStatus(output, code));
    });
  });
  const first = await probe();
  return first.statusUnknown ? probe() : first;
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
async function prepareAgents(root: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const config = await openAIConfig(root), binary = await discoverTunnelClient();
  if (!binary.found || !binary.path) throw new Error('tunnel-client not found; install it in the agent-slack tools directory, ~/.config/engram/tunnel-client, or PATH');
  const dir = configDir(), logs = path.join(home(), 'Library', 'Logs', 'Engram');
  await privateDir(dir); await fs.mkdir(logs, { recursive: true, mode: 0o700 });
  const gatewayEnv = path.join(dir, 'keyed-gateway.env'), profile = path.join(dir, 'tunnel-client', config.profileName + '.yaml');
  const nodePath = process.execPath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(moduleDir, '../../../../scripts/hosted/keyed-gateway.mjs'), path.resolve(moduleDir, '../../../scripts/hosted/keyed-gateway.mjs'), path.resolve(path.dirname(nodePath), '../app/scripts/hosted/keyed-gateway.mjs')];
  const resolvedGateway = (await Promise.all(candidates.map(async candidate => (await fs.stat(candidate).catch(() => undefined))?.isFile() ? candidate : undefined))).find(Boolean);
  if (!resolvedGateway) throw new Error('Packaged keyed gateway script was not found');
  const gatewayLauncher = '#!/bin/sh\nset -eu\nset -a\n. ' + shellQuote(gatewayEnv) + '\nset +a\nexec ' + shellQuote(nodePath) + ' ' + shellQuote(resolvedGateway) + '\n';
  const runArgs = ' run --profile ' + shellQuote(config.profileName) + ' --profile-dir ' + shellQuote(path.join(dir, 'tunnel-client'));
  const tunnelLauncher = '#!/bin/sh\nset -eu\nset -a\n. ' + shellQuote(path.join(dir, 'chatgpt-tunnel.env')) + '\nset +a\nif [ -n "${ENGRAM_OPENAI_ORGANIZATION_ID:-}" ]; then\n  exec ' + shellQuote(binary.path) + runArgs + ' --control-plane.organization-id "$ENGRAM_OPENAI_ORGANIZATION_ID"\nfi\nexec ' + shellQuote(binary.path) + runArgs + '\n';
  const gatewayPath = path.join(dir, 'keyed-gateway-launcher.sh'), tunnelPath = path.join(dir, 'tunnel-client-launcher.sh');
  await atomicPrivate(gatewayPath, gatewayLauncher); await fs.chmod(gatewayPath, 0o700); await atomicPrivate(tunnelPath, tunnelLauncher); await fs.chmod(tunnelPath, 0o700);
  if (platform === 'darwin') {
    const launchAgents = path.join(home(), 'Library', 'LaunchAgents'); await fs.mkdir(launchAgents, { recursive: true, mode: 0o700 });
    for (const [label, launcher, name] of [['dev.engram.keyed-gateway', gatewayPath, 'keyed-gateway'], ['dev.engram.tunnel-client', tunnelPath, 'tunnel-client']] as Array<[string, string, string]>) {
      const plist = path.join(launchAgents, label + '.plist'), log = path.join(logs, name + '.log'), escaped = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      const xml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>' + label + '</string><key>ProgramArguments</key><array><string>' + escaped(launcher) + '</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>' + escaped(log) + '</string><key>StandardErrorPath</key><string>' + escaped(log) + '</string></dict></plist>';
      await atomicPrivate(plist, xml);
    }
  } else if (platform === 'linux') {
    const units = path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'systemd', 'user'); await privateDir(units);
    for (const [label, launcher] of [['dev.engram.keyed-gateway', gatewayPath], ['dev.engram.tunnel-client', tunnelPath]]) await atomicPrivate(path.join(units, label + '.service'), '[Unit]\nDescription=Engram keyed tunnel service\n[Service]\nExecStart=' + launcher + '\nRestart=on-failure\n[Install]\nWantedBy=default.target\n');
  } else throw new Error('OpenAI tunnel services are supported on macOS and Linux');
}
async function validateOpenAIStart(root: string): Promise<string[]> {
  const config = await openAIConfig(root), envFile = await readEnv(path.join(configDir(), 'chatgpt-tunnel.env')), binary = await discoverTunnelClient();
  const dir = path.join(configDir(), 'tunnel-client'), profile = path.join(dir, config.profileName + '.yaml');
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const scripts = [path.resolve(moduleDir, '../../../../scripts/hosted/keyed-gateway.mjs'), path.resolve(moduleDir, '../../../scripts/hosted/keyed-gateway.mjs'), path.resolve(path.dirname(process.execPath), '../app/scripts/hosted/keyed-gateway.mjs')];
  const gatewayScript = (await Promise.all(scripts.map(async file => (await fs.stat(file).catch(() => undefined))?.isFile()))).some(Boolean);
  const missing: string[] = [];
  if (!config.workspaces.length) missing.push('at least one workspace row');
  if (!envFile.get('ENGRAM_TUNNEL_ID') || !envFile.get('ENGRAM_TUNNEL_RUNTIME_KEY')) missing.push('tunnel ID and API key');
  if (!binary.found || !binary.path) missing.push('an executable tunnel-client binary');
  if (!(await fs.stat(profile).catch(() => undefined))?.isFile()) missing.push('the tunnel-client profile file');
  if (!gatewayScript) missing.push('the keyed-gateway script');
  return missing;
}
export function safeGatewayLogLine(text: string): string {
  const lines = text.split(/\r?\n/u);
  const errorLine = [...lines].reverse().find(line => /^(?:\w*Error|Error):\s*/.test(line.trim()));
  const thrownMessage = [...lines].reverse().find(line => /throw new Error\(/.test(line));
  let line = errorLine?.trim() ?? thrownMessage?.trim() ?? 'Gateway did not report a safe error line';
  line = line.replace(/^throw new Error\((['"])(.*?)\1\);?\s*$/, '$2');
  if (/no keys configured/i.test(line)) line = 'No workspace keys are configured: add at least one workspace row below, then start the gateway.';
  return line.replace(/(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/ig, '[redacted]').replace(/https?:\/\/[^\s]+/ig, '[URL]').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
}
async function waitForGatewayHealth(timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch('http://127.0.0.1:' + (process.env.ENGRAM_KEYED_GATEWAY_PORT || '3335') + '/health', { signal: AbortSignal.timeout(300), redirect: 'error' }); if (response.ok) return true; } catch { /* gateway is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}
let serviceActionTail: Promise<boolean> = Promise.resolve(false);
export function controlOpenAIServices(root: string, action: 'start' | 'stop' | 'restart', vault?: Vault, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const current = serviceActionTail.then(() => runOpenAIServices(root, action, vault, platform));
  serviceActionTail = current.catch(() => false);
  return current;
}
async function runOpenAIServices(root: string, action: 'start' | 'stop' | 'restart', vault?: Vault, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (action === 'start') {
    const current = await openAIStatus(root, platform);
    if (current.gateway.healthy && current.keyedGateway.running && current.tunnelClient.state === 'connected') { await setOpenAIAutoStart(root, true); return true; }
  }
  if (action !== 'stop' && vault) await syncChatGateway(root, vault);
  if (action !== 'stop') {
    const missing = await validateOpenAIStart(root);
    if (missing.includes('at least one workspace row')) throw new Error('Cannot start ChatGPT connector: needs workspace rows (add at least one workspace row below).');
    if (missing.length) throw new Error('Cannot start ChatGPT connector; missing: ' + missing.join(', '));
    await prepareAgents(root, platform);
  }
  const labels = ['dev.engram.keyed-gateway', 'dev.engram.tunnel-client'];
  const run = async (label: string, operation: 'start' | 'stop' | 'restart') => {
    const { spawn } = await import('node:child_process');
    const call = (executable: string, args: string[]) => new Promise<void>((resolve, reject) => { const child = spawn(executable, args, { stdio: 'ignore', shell: false }); child.once('error', () => reject(new Error('Service manager action failed'))); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Service manager action failed'))); });
    if (platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0, target = 'gui/' + uid, executable = findExecutable('launchctl') ?? '/bin/launchctl', plist = path.join(home(), 'Library', 'LaunchAgents', label + '.plist');
      if (operation !== 'start') await call(executable, ['bootout', target + '/' + label]).catch(() => undefined);
      if (operation !== 'stop') { await call(executable, ['bootstrap', target, plist]).catch(() => undefined); await call(executable, ['kickstart', '-k', target + '/' + label]); }
    } else if (platform === 'linux') {
      const executable = findExecutable('systemctl') ?? '/usr/bin/systemctl';
      await call(executable, ['--user', 'daemon-reload']);
      await call(executable, ['--user', operation, label]);
    } else throw new Error('OpenAI tunnel services are supported on macOS and Linux');
  };
  if (action === 'stop') { await run(labels[1]!, 'stop'); await run(labels[0]!, 'stop'); await setOpenAIAutoStart(root, false); return false; }
  if (action === 'restart') { await run(labels[1]!, 'stop').catch(() => undefined); await run(labels[0]!, 'restart'); }
  else await run(labels[0]!, 'start');
  if (!await waitForGatewayHealth()) {
    await run(labels[0]!, 'stop').catch(() => undefined);
    const log = await fs.readFile(path.join(home(), 'Library/Logs/Engram/keyed-gateway.log'), 'utf8').catch(() => '');
    throw new Error('Gateway did not become healthy. ' + safeGatewayLogLine(log));
  }
  await run(labels[1]!, action === 'restart' ? 'restart' : 'start');
  await setOpenAIAutoStart(root, true);
  return false;
}
export async function restartOpenAIServicesIfRunning(root: string): Promise<void> {
  const statuses = await Promise.all(['dev.engram.keyed-gateway','dev.engram.tunnel-client'].map(label => serviceStatus(label)));
  if (statuses.some(status => status.loaded)) await controlOpenAIServices(root, 'restart');
}

export type TunnelEnsureResult = { action: 'running' | 'started' | 'disabled' | 'not-configured' | 'unsupported' | 'failed'; detail?: string };
/**
 * Bring the ChatGPT tunnel services up when Engram starts, if they are configured and the owner has not stopped them. A service that is already running is left alone,
 * even while the tunnel is still connecting, so a slow handshake never causes a restart loop. Failures are reported, never thrown.
 */
export async function ensureOpenAIServicesRunning(root: string, vault?: Vault, platform: NodeJS.Platform = process.platform): Promise<TunnelEnsureResult> {
  if (platform !== 'darwin' && platform !== 'linux') return { action: 'unsupported' };
  try {
    if (!await openAIAutoStart(root)) return { action: 'disabled' };
    const missing = await validateOpenAIStart(root);
    if (missing.length) return { action: 'not-configured', detail: missing.join(', ') };
    const services = await Promise.all(['dev.engram.keyed-gateway', 'dev.engram.tunnel-client'].map(label => serviceStatus(label, platform)));
    if (services.some(service => service.statusUnknown)) return { action: 'failed', detail: 'service manager status is unavailable' };
    if (services.every(service => service.running)) return { action: 'running' };
    await controlOpenAIServices(root, 'start', vault, platform);
    return { action: 'started' };
  } catch (error) { return { action: 'failed', detail: (error as Error).message }; }
}
