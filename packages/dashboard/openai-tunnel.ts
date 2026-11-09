import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Vault } from '../core/vault.js';
import { createHttpCredential, revokeHttpCredential, rotateHttpCredential } from '../mcp/credentials.js';
import { findExecutable } from '../models/cli.js';

export type GatewayWorkspace = { name: string; workspace: string; collection?: string; allowWrites: boolean; credentialId: string; tokenEnv: string };
type OpenAIConfig = { profileName: string; workspaces: GatewayWorkspace[] };
const slug = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
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
function empty(): OpenAIConfig { return { profileName: 'engram-keyed', workspaces: [] }; }
export async function openAIConfig(root: string) {
  const all = await readStore(root), saved = all.openai ?? {}, env = await readEnv(path.join(configDir(), 'chatgpt-tunnel.env'));
  const rows = Array.isArray(saved.workspaces) ? saved.workspaces : [];
  return { tunnelId: env.get('ENGRAM_TUNNEL_ID') ?? '', apiKeySet: !!env.get('ENGRAM_TUNNEL_RUNTIME_KEY'), organizationId: env.get('ENGRAM_OPENAI_ORGANIZATION_ID') ?? '', profileName: typeof saved.profileName === 'string' ? saved.profileName : 'engram-keyed', workspaces: rows.map(({ name, workspace, collection, allowWrites }: GatewayWorkspace) => ({ name, workspace, ...(collection ? { collection } : {}), allowWrites: allowWrites === true })) };
}
export async function saveOpenAIConfig(root: string, values: Record<string, unknown>): Promise<void> {
  const store = await readStore(root), existing = store.openai ?? empty(), next = { ...existing };
  if (values.profileName !== undefined) {
    const value = values.profileName;
    if (typeof value !== 'string' || !slug.test(value)) throw new Error('Profile name must be a lowercase slug');
    next.profileName = value;
  }
  const file = path.join(configDir(), 'chatgpt-tunnel.env'), env = await readEnv(file);
  for (const [field, key] of [['tunnelId', 'ENGRAM_TUNNEL_ID'], ['organizationId', 'ENGRAM_OPENAI_ORGANIZATION_ID'], ['apiKey', 'ENGRAM_TUNNEL_RUNTIME_KEY']] as const) {
    const value = values[field]; if (value === undefined) continue;
    if (value === null || value === '') { env.delete(key); continue; }
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('Invalid OpenAI tunnel setting');
    env.set(key, value);
  }
  await writeStore(root, { ...store, openai: next });
  await writeEnv(file, env);
  await saveGatewayFiles((next.workspaces ?? []) as GatewayWorkspace[], next.profileName ?? 'engram-keyed');
}
export function validateWorkspaceRow(input: unknown): Omit<GatewayWorkspace, 'credentialId' | 'tokenEnv'> {
  if (!input || typeof input !== 'object') throw new Error('Workspace row is required');
  const value = input as Record<string, unknown>;
  if (typeof value.name !== 'string' || !slug.test(value.name)) throw new Error('Workspace name must be a lowercase slug');
  if (typeof value.workspace !== 'string' || !identifier.test(value.workspace)) throw new Error('Workspace ID is invalid');
  if (value.collection !== undefined && value.collection !== null && value.collection !== '' && (typeof value.collection !== 'string' || !identifier.test(value.collection))) throw new Error('Collection ID is invalid');
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean') throw new Error('allowWrites must be a boolean');
  return { name: value.name, workspace: value.workspace, ...(typeof value.collection === 'string' && value.collection ? { collection: value.collection } : {}), allowWrites: value.allowWrites === true };
}
async function saveGatewayFiles(rows: GatewayWorkspace[], profileName: string): Promise<void> {
  const dir = configDir(), values = new Map<string, string>();
  for (const row of rows) {
    const key = row.tokenEnv;
    const old = await readEnv(path.join(dir, 'keyed-gateway.env'));
    const token = old.get(key);
    if (token) values.set(key, token);
  }
  values.set('GATEWAY_WORKSPACES', JSON.stringify(rows.map(({ name, workspace, collection, allowWrites, tokenEnv }) => ({ name, tokenEnv, scope: { type: 'workspace', workspaceId: workspace, ...(collection ? { collectionId: collection } : {}) }, allowWrites }))));
  values.set('GATEWAY_PORT', process.env.ENGRAM_KEYED_GATEWAY_PORT || '3335');
  values.set('ENGRAM_UPSTREAM', 'http://127.0.0.1:3333/mcp');
  await writeEnv(path.join(dir, 'keyed-gateway.env'), values);
  const tunnelDir = path.join(dir, 'tunnel-client'); await privateDir(tunnelDir);
  const tunnelEnv = await readEnv(path.join(dir, 'chatgpt-tunnel.env'));
  const tunnelId = tunnelEnv.get('ENGRAM_TUNNEL_ID') ?? '${ENGRAM_TUNNEL_ID}';
  const profile = 'config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: "' + tunnelId.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"\n  api_key: "env:ENGRAM_TUNNEL_RUNTIME_KEY"\nhealth:\n  listen_addr: "127.0.0.1:0"\nadmin_ui:\n  open_browser: false\nlog:\n  level: info\n  format: json\nmcp:\n  server_urls:\n    - channel: main\n      url: "http://127.0.0.1:3335/mcp"\n';
  await atomicPrivate(path.join(tunnelDir, profileName + '.yaml'), profile);
}
export async function upsertOpenAIWorkspace(root: string, vault: Vault, input: unknown): Promise<void> {
  const row = validateWorkspaceRow(input), store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) };
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
    cfg.workspaces = next; await writeStore(root, { ...store, openai: cfg }); await writeEnv(envFile, env); await saveGatewayFiles(next, cfg.profileName);
  } catch (error) { await revokeHttpCredential(vault, credential.id).catch(() => undefined); throw error; }
}
export async function removeOpenAIWorkspace(root: string, vault: Vault, name: string): Promise<boolean> {
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) }, row = cfg.workspaces.find(item => item.name === name);
  if (!row) return false;
  await revokeHttpCredential(vault, row.credentialId); await vault.revoke(row.workspace, 'chatgpt-' + row.name);
  const next = cfg.workspaces.filter(item => item.name !== name), envFile = path.join(configDir(), 'keyed-gateway.env'), env = await readEnv(envFile); env.delete(row.tokenEnv);
  cfg.workspaces = next; await writeStore(root, { ...store, openai: cfg }); await writeEnv(envFile, env); await saveGatewayFiles(next, cfg.profileName); return true;
}
export async function rotateOpenAIWorkspace(root: string, vault: Vault, name: string): Promise<boolean> {
  const store = await readStore(root), cfg: OpenAIConfig = { ...empty(), ...(store.openai ?? {}) }, row = cfg.workspaces.find(item => item.name === name);
  if (!row) return false;
  const permissions = [`workspace:${row.workspace}:${row.collection ? 'collection:' + row.collection + ':' : ''}read`, ...(row.allowWrites ? [`workspace:${row.workspace}:${row.collection ? 'collection:' + row.collection + ':' : ''}write`] : [])];
  const replacement = await rotateHttpCredential(vault, row.credentialId, permissions), envFile = path.join(configDir(), 'keyed-gateway.env'), env = await readEnv(envFile);
  env.set(row.tokenEnv, replacement.token); row.credentialId = replacement.id;
  await writeStore(root, { ...store, openai: cfg }); await writeEnv(envFile, env); await saveGatewayFiles(cfg.workspaces, cfg.profileName); return true;
}
export async function discoverTunnelClient(): Promise<{ found: boolean; path: string | null }> {
  const candidates = [path.join(home(), 'Library/Application Support/agent-slack-desktop/tools/tunnel-client/tunnel-client'), path.join(configDir(), 'tunnel-client/tunnel-client'), findExecutable('tunnel-client')].filter((value): value is string => !!value);
  for (const candidate of candidates) { try { const info = await fs.lstat(candidate); await fs.access(candidate, 1); if (info.isFile() && !info.isSymbolicLink()) return { found: true, path: path.resolve(candidate) }; } catch { /* next fixed candidate */ } }
  return { found: false, path: null };
}
export async function openAIStatus(root: string) {
  const config = await openAIConfig(root), binary = await discoverTunnelClient(), dir = configDir(), logPath = path.join(home(), 'Library/Logs/Engram/keyed-gateway.log');
  let logAgeMs: number | null = null; try { logAgeMs = Math.max(0, Date.now() - (await fs.stat(logPath)).mtimeMs); } catch { /* absent */ }
  let gatewayHealth: unknown = null; try { const response = await fetch('http://127.0.0.1:' + (process.env.ENGRAM_KEYED_GATEWAY_PORT || '3335') + '/health', { signal: AbortSignal.timeout(500) }); if (response.ok) gatewayHealth = await response.json(); } catch { /* down */ }
  const profilePath = path.join(dir, 'tunnel-client', config.profileName + '.yaml');
  const services = await Promise.all(['dev.engram.keyed-gateway', 'dev.engram.tunnel-client'].map(label => serviceStatus(label)));
  const keyedGateway = services[0]!;
  let failureReason: string | undefined;
  if (keyedGateway.loaded && (!keyedGateway.running || keyedGateway.lastExitCode !== null && keyedGateway.lastExitCode !== 0)) {
    const log = await fs.readFile(logPath, 'utf8').catch(() => '');
    failureReason = 'Gateway is failing: ' + safeGatewayLogLine(log);
  }
  return { gateway: { healthy: !!gatewayHealth, health: gatewayHealth, ...(failureReason ? { failureReason } : {}) }, keyedGateway, tunnelClient: services[1]!, binaryFound: binary.found, profilePresent: !!(await fs.stat(profilePath).catch(() => undefined)), logAgeMs };
}
async function serviceStatus(label: string): Promise<{ loaded: boolean; running: boolean; pid: number | null; lastExitCode: number | null }> {
  const { spawn } = await import('node:child_process');
  const executable = findExecutable(process.platform === 'darwin' ? 'launchctl' : 'systemctl') ?? (process.platform === 'darwin' ? '/bin/launchctl' : '/usr/bin/systemctl');
  const args = process.platform === 'darwin' ? ['print', 'gui/' + (typeof process.getuid === 'function' ? process.getuid() : 0) + '/' + label] : ['--user', 'show', label, '--property=ActiveState,MainPID', '--no-page'];
  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false }); let output = '', settled = false;
    const finish = (result: { loaded: boolean; running: boolean; pid: number | null; lastExitCode: number | null }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ loaded: false, running: false, pid: null, lastExitCode: null }); }, 1000);
    child.stdout.on('data', chunk => { output += String(chunk).slice(0, 4096); });
    child.once('error', () => finish({ loaded: false, running: false, pid: null, lastExitCode: null }));
    child.once('exit', code => { const pid = /(?:pid|MainPID)\s*=\s*(\d+)/i.exec(output)?.[1], exit = /last exit code\s*=\s*(-?\d+)/i.exec(output)?.[1]; const running = /state = running|ActiveState=active/i.test(output); finish({ loaded: code === 0, running, pid: pid && Number(pid) > 0 ? Number(pid) : null, lastExitCode: exit === undefined ? null : Number(exit) }); });
  });
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
async function prepareAgents(root: string): Promise<void> {
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
  if (process.platform === 'darwin') {
    const launchAgents = path.join(home(), 'Library', 'LaunchAgents'); await fs.mkdir(launchAgents, { recursive: true, mode: 0o700 });
    for (const [label, launcher, name] of [['dev.engram.keyed-gateway', gatewayPath, 'keyed-gateway'], ['dev.engram.tunnel-client', tunnelPath, 'tunnel-client']] as Array<[string, string, string]>) {
      const plist = path.join(launchAgents, label + '.plist'), log = path.join(logs, name + '.log'), escaped = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      const xml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>' + label + '</string><key>ProgramArguments</key><array><string>' + escaped(launcher) + '</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>' + escaped(log) + '</string><key>StandardErrorPath</key><string>' + escaped(log) + '</string></dict></plist>';
      await atomicPrivate(plist, xml);
    }
  } else if (process.platform === 'linux') {
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
function safeGatewayLogLine(text: string): string {
  const line = text.split(/\r?\n/u).filter(Boolean).at(-1) ?? 'Gateway did not report a safe error line';
  return line.replace(/(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/ig, '[redacted]').replace(/https?:\/\/[^\s]+/ig, '[URL]').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}
async function waitForGatewayHealth(timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch('http://127.0.0.1:' + (process.env.ENGRAM_KEYED_GATEWAY_PORT || '3335') + '/health', { signal: AbortSignal.timeout(300), redirect: 'error' }); if (response.ok) return true; } catch { /* gateway is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}
let serviceActionTail: Promise<void> = Promise.resolve();
export function controlOpenAIServices(root: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const current = serviceActionTail.then(() => runOpenAIServices(root, action));
  serviceActionTail = current.catch(() => undefined);
  return current;
}
async function runOpenAIServices(root: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  if (action !== 'stop') {
    const missing = await validateOpenAIStart(root);
    if (missing.length) throw new Error('Cannot start ChatGPT connector; missing: ' + missing.join(', '));
    await prepareAgents(root);
  }
  const labels = ['dev.engram.keyed-gateway', 'dev.engram.tunnel-client'];
  const run = async (label: string, operation: 'start' | 'stop' | 'restart') => {
    const { spawn } = await import('node:child_process');
    const call = (executable: string, args: string[]) => new Promise<void>((resolve, reject) => { const child = spawn(executable, args, { stdio: 'ignore', shell: false }); child.once('error', () => reject(new Error('Service manager action failed'))); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Service manager action failed'))); });
    if (process.platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0, target = 'gui/' + uid, executable = findExecutable('launchctl') ?? '/bin/launchctl', plist = path.join(home(), 'Library', 'LaunchAgents', label + '.plist');
      if (operation !== 'start') await call(executable, ['bootout', target + '/' + label]).catch(() => undefined);
      if (operation !== 'stop') { await call(executable, ['bootstrap', target, plist]).catch(() => undefined); await call(executable, ['kickstart', '-k', target + '/' + label]); }
    } else if (process.platform === 'linux') {
      const executable = findExecutable('systemctl') ?? '/usr/bin/systemctl';
      await call(executable, ['--user', 'daemon-reload']);
      await call(executable, ['--user', operation, label]);
    } else throw new Error('OpenAI tunnel services are supported on macOS and Linux');
  };
  if (action === 'stop') { await run(labels[1]!, 'stop'); await run(labels[0]!, 'stop'); return; }
  if (action === 'restart') { await run(labels[1]!, 'stop').catch(() => undefined); await run(labels[0]!, 'restart'); }
  else await run(labels[0]!, 'start');
  if (!await waitForGatewayHealth()) {
    await run(labels[0]!, 'stop').catch(() => undefined);
    const log = await fs.readFile(path.join(home(), 'Library/Logs/Engram/keyed-gateway.log'), 'utf8').catch(() => '');
    throw new Error('Gateway did not become healthy. ' + safeGatewayLogLine(log));
  }
  await run(labels[1]!, action === 'restart' ? 'restart' : 'start');
}
export async function restartOpenAIServicesIfRunning(root: string): Promise<void> {
  const statuses = await Promise.all(['dev.engram.keyed-gateway','dev.engram.tunnel-client'].map(serviceStatus));
  if (statuses.some(status => status.loaded)) await controlOpenAIServices(root, 'restart');
}
