import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MDBError } from '../core/types.js';
import { Vault } from '../core/vault.js';
import { findExecutable } from '../models/cli.js';
import { createRegistration, listRegistrations, revokeRegistration } from './capture.js';
import { DEFAULT_CAPTURE, type MemoryEventType, type Registration } from './types.js';

export interface InstallOptions { consent: boolean; dryRun?: boolean; principalId: string; workspaceId: string; collectionId?: string; capture?: MemoryEventType[]; toolAllowlist?: string[]; excludePatterns?: string[]; mcpUrl?: string; tokenEnv?: string; registrationId?: string }
export interface AdapterStatus { installed: boolean; capture: MemoryEventType[]; recall: boolean; coverage: 'full' | 'partial' | 'none'; notes: string[]; registrations: string[]; settingsPath: string }
export interface HarnessAdapter {
  id: string;
  detect(): Promise<{ supported: boolean; capabilities: string[]; notes: string[] }>;
  install(options: InstallOptions): Promise<{ changed: boolean; planned?: unknown; registrationId?: string; backup?: string }>;
  status(): Promise<AdapterStatus>;
  uninstall(): Promise<{ removed: number }>;
}
const MARKER = '# engram-mdb:';
const REMOTE_MARKER = '# engram-mdb-remote:';
type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

interface HostSpec {
  id: 'claude-code' | 'codex'; executable: string; defaultSettings: string; /** hook event -> memory event type */ events: Record<string, MemoryEventType>;
  /** What the host is known to emit, for truthful coverage reporting. */ verified: string; notes: string[]; featureCheck?: () => Promise<string | undefined>;
}
const home = () => process.env.HOME ?? os.homedir();
export const HOSTS: Record<'claude-code' | 'codex', HostSpec> = {
  'claude-code': { id: 'claude-code', executable: 'claude', defaultSettings: path.join('.claude', 'settings.json'), events: { SessionStart: 'session.start', UserPromptSubmit: 'user.message', PostToolUse: 'tool.result', Stop: 'assistant.message', SessionEnd: 'session.end' }, verified: 'Hook payload fields recorded from a live Claude Code 2.1.285 session (tests/fixtures/hook-payloads/claude-code.json). SessionEnd is best-effort: other hooks were cancelled at exit in -p mode.', notes: [] },
  codex: {
    id: 'codex', executable: 'codex', defaultSettings: path.join('.codex', 'hooks.json'), events: { SessionStart: 'session.start', UserPromptSubmit: 'user.message', PostToolUse: 'tool.result', Stop: 'assistant.message', SessionEnd: 'session.end' },
    verified: 'Lifecycle hooks use Codex hooks.json events and stdin payloads (session_id, turn_id, prompt, tool_name/tool_input/tool_output, last_assistant_message, and SessionEnd reason).', notes: ['Codex requires the user to trust new or changed hooks before they run; hook failures are fail-open.'],
    featureCheck: async () => { try { return /^\s*hooks\s*=\s*false/m.test(await fs.readFile(path.join(home(), '.codex', 'config.toml'), 'utf8')) ? 'Codex hooks are disabled in ~/.codex/config.toml.' : undefined; } catch { return undefined; } }
  }
};
const quote = (value: string): string => { if (/["`$\\\n\r]/.test(value)) throw new MDBError('INVALID_INPUT', 'Refusing to place a path with shell metacharacters into a hook command'); return `"${value}"`; };
const mdbBinary = () => fileURLToPath(new URL('../../../bin/mdb.js', import.meta.url));
export function hookCommand(host: string, root: string, registrationId: string, node = process.execPath): string {
  return `${quote(node)} ${quote(mdbBinary())} memory capture --root ${quote(root)} --host ${host} --registration ${registrationId} ${MARKER}${registrationId}`;
}
export function remoteHookCommand(host: string, url: string, tokenEnv: string, registrationId: string, node = process.execPath): string {
  return `${quote(node)} ${quote(mdbBinary())} memory capture --host ${host} --registration ${registrationId} --remote-url ${quote(url)} --token-env ${quote(tokenEnv)} ${REMOTE_MARKER}${registrationId}`;
}
const ownedBy = (entry: HookEntry, ids: Set<string>): boolean => entry.hooks?.some(h => typeof h.command === 'string' && [...ids].some(id => h.command.includes(`${MARKER}${id}`)));
const anyOwned = (entry: HookEntry, root: string): boolean => entry.hooks?.some(h => typeof h.command === 'string' && h.command.includes(MARKER) && h.command.includes(`--root ${JSON.stringify(root)}`));

export class HookFileAdapter implements HarnessAdapter {
  readonly id: string; private readonly spec: HostSpec; readonly settingsPath: string;
  constructor(host: 'claude-code' | 'codex', private readonly options: { root: string; settingsPath?: string }) { this.spec = HOSTS[host]; this.id = host; this.settingsPath = path.resolve(options.settingsPath ?? path.join(home(), this.spec.defaultSettings)); }
  async detect() {
    const found = !!findExecutable(this.spec.executable); const flag = await this.spec.featureCheck?.();
    const hasFile = await fs.stat(this.settingsPath).then(() => true, () => false);
    return { supported: found || hasFile, capabilities: Object.values(this.spec.events), notes: [this.spec.verified, ...this.spec.notes, ...(flag ? [flag] : []), ...(found ? [] : [`${this.spec.executable} executable not found on PATH`])] };
  }
  private async read(): Promise<{ settings: Settings; existed: boolean }> {
    try { const parsed = JSON.parse(await fs.readFile(this.settingsPath, 'utf8')) as Settings; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.hooks !== undefined && (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)))) throw new Error('shape'); return { settings: parsed, existed: true }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, existed: false }; throw new MDBError('INVALID_INPUT', `Host settings at ${this.settingsPath} are not a JSON object with an object "hooks" field; nothing was changed`); }
  }
  private async write(settings: Settings): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    const mode = await fs.stat(this.settingsPath).then(s => s.mode & 0o777, () => 0o600);
    const tmp = `${this.settingsPath}.engram-${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode }); await fs.rename(tmp, this.settingsPath);
  }
  private async mine(): Promise<Registration[]> { return (await listRegistrations(this.options.root)).filter(r => r.host === this.id && r.settingsPath === this.settingsPath); }

  async install(options: InstallOptions) {
    if (options.consent !== true) throw new MDBError('INVALID_INPUT', 'Installing capture hooks requires explicit consent');
    const capture = options.capture ?? DEFAULT_CAPTURE;
    const remote = !!options.mcpUrl;
    if (remote && (!options.registrationId || !options.tokenEnv || !/^[A-Z_][A-Z0-9_]*$/.test(options.tokenEnv) || !/^https:\/\//i.test(options.mcpUrl!) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(options.mcpUrl!))) throw new MDBError('INVALID_INPUT', 'Remote capture requires a server registration, token environment variable, and HTTPS URL (HTTP is allowed only for localhost)');
    const { settings, existed } = await this.read();
    const existing = remote ? undefined : (await this.mine()).find(r => r.principalId === options.principalId && r.workspaceId === options.workspaceId && (r.collectionId ?? '') === (options.collectionId ?? ''));
    const registrationId = remote ? options.registrationId! : existing?.id;
    const events = Object.entries(this.spec.events).filter(([, type]) => capture.includes(type));
    if (registrationId && events.every(([name]) => (settings.hooks?.[name] ?? []).some(e => ownedBy(e, new Set([registrationId]))))) return { changed: false, registrationId };
    const planned = { settingsPath: this.settingsPath, events: events.map(([name, type]) => ({ hook: name, records: type })), createsFile: !existed };
    if (options.dryRun) return { changed: false, planned };
    const owner = new Vault(this.options.root);
    const registration: Registration = remote ? { id: registrationId!, host: this.id, principalId: options.principalId, workspaceId: options.workspaceId, ...(options.collectionId ? { collectionId: options.collectionId } : {}), capture, toolAllowlist: options.toolAllowlist ?? [], excludePatterns: options.excludePatterns ?? [], consentPolicyId: 'remote-server-registration', createdAt: new Date().toISOString(), permissions: [] } : existing ?? await createRegistration(owner, { host: this.id, principalId: options.principalId, workspaceId: options.workspaceId, ...(options.collectionId ? { collectionId: options.collectionId } : {}), capture, ...(options.toolAllowlist ? { toolAllowlist: options.toolAllowlist } : {}), ...(options.excludePatterns ? { excludePatterns: options.excludePatterns } : {}), consent: true });
    let backup: string | undefined;
    if (existed) { backup = `${this.settingsPath}.engram-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`; await fs.copyFile(this.settingsPath, backup); }
    const next: Settings = structuredClone(settings); next.hooks ??= {};
    for (const [name] of events) {
      const list = (next.hooks[name] ??= []);
      if (list.some(e => ownedBy(e, new Set([registration.id])))) continue;
      list.push({ hooks: [{ type: 'command', command: remote ? remoteHookCommand(this.id, options.mcpUrl!, options.tokenEnv!, registration.id) : hookCommand(this.id, this.options.root, registration.id), timeout: 5 }] });
    }
    await this.write(next);
    if (!remote) {
      await fs.mkdir(path.join(this.options.root, '.mdb/capture/registrations'), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(this.options.root, '.mdb/capture/registrations', `${registration.id}.json`), JSON.stringify({ ...registration, settingsPath: this.settingsPath, createdSettingsFile: !existed && !existing?.createdSettingsFile ? true : registration.createdSettingsFile }, null, 1), { mode: 0o600 });
    }
    return { changed: true, registrationId: registration.id, ...(backup ? { backup } : {}) };
  }

  async status(): Promise<AdapterStatus> {
    const regs = await this.mine(); const ids = new Set(regs.map(r => r.id)); const notes: string[] = [this.spec.verified, ...this.spec.notes];
    let installedEvents: MemoryEventType[] = [];
    try { const { settings } = await this.read(); installedEvents = Object.entries(this.spec.events).filter(([name]) => (settings.hooks?.[name] ?? []).some(e => ownedBy(e, ids) || e.hooks?.some(h => h.command.includes(REMOTE_MARKER)))).map(([, type]) => type); } catch (e) { notes.push((e as Error).message); }
    const flag = await this.spec.featureCheck?.(); if (flag) notes.push(flag);
    // 'full' = every event type the owner asked for is hooked AND this host emits a hook for each lifecycle point we rely on (Codex has no SessionEnd and its payloads are unverified).
    const wanted = new Set(regs.flatMap(r => r.capture).filter(t => Object.values(this.spec.events).includes(t)));
    const complete = [...wanted].every(t => installedEvents.includes(t)) && wanted.size > 0;
    return { installed: installedEvents.length > 0, capture: installedEvents, recall: true, coverage: !installedEvents.length ? 'none' : complete ? 'full' : 'partial', notes, registrations: [...ids], settingsPath: this.settingsPath };
  }

  async uninstall() {
    const regs = await this.mine(); const ids = new Set(regs.map(r => r.id)); let removed = 0;
    let parsed: { settings: Settings; existed: boolean }; try { parsed = await this.read(); } catch { parsed = { settings: {}, existed: false }; }
    if (parsed.existed) {
      const next: Settings = structuredClone(parsed.settings);
      for (const [name, list] of Object.entries(next.hooks ?? {})) {
        const kept = list.filter(e => { const own = ownedBy(e, ids) || anyOwned(e, this.options.root) || e.hooks?.some(h => h.command.includes(REMOTE_MARKER)); if (own) removed++; return !own; });
        if (kept.length) next.hooks![name] = kept; else delete next.hooks![name];
      }
      if (next.hooks && !Object.keys(next.hooks).length && !('hooks' in parsed.settings && (parsed.settings.hooks && Object.keys(parsed.settings.hooks).length === 0))) delete next.hooks;
      if (removed) {
        if (regs.some(r => r.createdSettingsFile) && !Object.keys(next).length) await fs.rm(this.settingsPath, { force: true }); else await this.write(next);
      }
    }
    for (const id of ids) await revokeRegistration(this.options.root, id);
    return { removed };
  }
}
export const createAdapter = (host: string, options: { root: string; settingsPath?: string }): HarnessAdapter => {
  if (host !== 'claude-code' && host !== 'codex') throw new MDBError('CAPABILITY_UNAVAILABLE', `No adapter for host "${host}". Supported: claude-code, codex. Other hosts can use the MCP tools, the CLI, or the SDK LifecycleAdapter; automatic capture is not available for them.`);
  return new HookFileAdapter(host, options);
};
