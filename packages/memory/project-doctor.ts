import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BINDING_FILE, readBinding, type BindingHost, type ProjectBinding } from '../core/project-binding.js';
import { createAdapter } from './adapters.js';
import { defaultRemoteSpoolDirectory } from './remote-spool.js';
import { openRemoteSession, RemoteError } from './remote-client.js';
import { locateBlock, projectSettingsPath, type Capability, type FeatureStatus } from '../project-init.js';
import { contextStateFile, type ContextState } from './context-hook.js';
import { syncReport } from './file-sync.js';

const INSTRUCTION_FILE: Record<BindingHost, string> = { 'claude-code': 'CLAUDE.md', codex: 'AGENTS.md' };
const cap = (status: FeatureStatus, detail: string): Capability => ({ status, detail });
export interface HostReport { instructions: Capability; mcpConfig: Capability; capture: Capability; sessionContext: Capability }
export interface ProjectDoctorReport {
  projectDir: string; binding: { present: boolean; workspaceId?: string; hosts?: string[]; serverUrl?: string; credentialRef?: string; tokenAvailable?: boolean; registrationId?: string; error?: string };
  hosts: Record<string, HostReport>; features: { capture: Capability; context: Capability; notes: Capability; remote: Capability; offline: Capability; sessionContext: Capability; fileSync: Capability };
  summary: Record<FeatureStatus, number>;
}

async function hostReport(dir: string, host: BindingHost, binding: ProjectBinding, settingsPath?: string): Promise<HostReport> {
  const file = path.join(dir, INSTRUCTION_FILE[host]);
  let instructions: Capability;
  try {
    const text = await fs.readFile(file, 'utf8'); const located = locateBlock(text, file);
    if (!located) instructions = cap('FAIL', `${INSTRUCTION_FILE[host]} has no Engram managed block`);
    else {
      const block = text.slice(located.start, located.end); const marker = /<!-- ENGRAM workspace=(\S+) managed-version=(\d+) host=(\S+) projection=([0-9a-f]+|none) -->/.exec(block);
      if (!marker) instructions = cap('INCOMPLETE', 'managed block is from an older Engram version; run `mdb project refresh-context`');
      else if (marker[1] !== binding.workspaceId) instructions = cap('FAIL', `block names workspace ${marker[1]} but the binding says ${binding.workspaceId}`);
      else if (marker[4] !== (binding.managed.projectionRevision ?? 'none')) instructions = cap('INCOMPLETE', `block projection ${marker[4]} differs from the binding (${binding.managed.projectionRevision ?? 'none'}); run \`mdb project refresh-context\``);
      else instructions = cap('PASS', `markers intact, workspace ${marker[1]}, projection ${marker[4]}`);
    }
  } catch (error) { instructions = cap('FAIL', error instanceof Error ? error.message : String(error)); }
  let mcpConfig: Capability;
  try {
    if (!binding.serverUrl) mcpConfig = cap('DISABLED', 'local mode: no remote MCP configured');
    else if (host === 'claude-code') {
      const config = JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')) as { mcpServers?: { engram?: { url?: string; headers?: Record<string, string> } } }; const e = config.mcpServers?.engram;
      mcpConfig = !e ? cap('FAIL', '.mcp.json has no engram server') : e.url !== binding.serverUrl ? cap('FAIL', 'server URL differs from the binding') : e.headers?.['X-Engram-Workspace'] !== binding.workspaceId ? cap('INCOMPLETE', 'workspace header missing or different; rerun init') : cap('PASS', 'entry present with the bound workspace header (file check only; see remote)');
    } else {
      const toml = await fs.readFile(path.join(dir, '.codex', 'config.toml'), 'utf8');
      mcpConfig = !/\[mcp_servers\.engram\]/.test(toml) ? cap('FAIL', '.codex/config.toml has no engram server') : !toml.includes(binding.serverUrl) ? cap('FAIL', 'server URL differs from the binding') : !toml.includes(`"X-Engram-Workspace" = "${binding.workspaceId}"`) ? cap('INCOMPLETE', 'workspace header missing; rerun init') : cap('PASS', 'entry present with the bound workspace header (file check only; see remote)');
    }
  } catch (error) { mcpConfig = cap('FAIL', error instanceof Error ? error.message : String(error)); }
  let capture: Capability;
  if (!binding.captureConsent) capture = cap('DISABLED', 'no capture consent recorded');
  else try {
    const status = await createAdapter(host, { root: dir, ...(settingsPath ? { settingsPath } : {}) }).status();
    capture = !status.installed ? cap('FAIL', 'consent recorded but no hooks are installed') : binding.registrationId && !status.registrations.includes(binding.registrationId) && binding.serverUrl ? cap('INCOMPLETE', `hooks installed, none for registration ${binding.registrationId}`) : cap(status.coverage === 'full' ? 'PASS' : 'INCOMPLETE', `hooks installed, coverage ${status.coverage}${status.notes.length ? `; ${status.notes[0]}` : ''}`);
  } catch (error) { capture = cap('FAIL', error instanceof Error ? error.message : String(error)); }
  // Installed is not working: the hook records each attempt, and only a recorded fresh result counts as PASS.
  let sessionContext: Capability;
  try {
    const status = await createAdapter(host, { root: dir, ...(settingsPath ? { settingsPath } : {}) }).status();
    if (!status.sessionContext) sessionContext = cap('DISABLED', 'no SessionStart context hook is installed for this project');
    else {
      let states: Record<string, ContextState> = {}; try { states = JSON.parse(await fs.readFile(contextStateFile(), 'utf8')); } catch { /* never ran */ }
      const last = states[`${host}:${binding.workspaceId}`]; const ageDays = last ? (Date.now() - Date.parse(last.at)) / 86_400_000 : Infinity;
      if (!last) sessionContext = cap('INCOMPLETE', 'hook installed but it has not run yet (start a session in this project)');
      else if (last.outcome === 'fresh' && ageDays <= 7) sessionContext = host === 'codex' ? cap('INCOMPLETE', `hook produced fresh context at ${last.at}; Codex's use of SessionStart output is not verified on a real session`) : cap('PASS', `last session start produced fresh context at ${last.at} (model-side use is not observable)`);
      else if (last.outcome === 'fresh') sessionContext = cap('INCOMPLETE', `last fresh context was at ${last.at}, more than 7 days ago`);
      else if (last.outcome === 'stale') sessionContext = cap('INCOMPLETE', `last run used a STALE cached context (${last.reason ?? 'server unreachable'})`);
      else sessionContext = cap(last.outcome === 'revoked' ? 'FAIL' : 'INCOMPLETE', `last run produced nothing: ${last.outcome}${last.reason ? ` (${last.reason})` : ''}`);
    }
  } catch (error) { sessionContext = cap('FAIL', error instanceof Error ? error.message : String(error)); }
  return { instructions, mcpConfig, capture, sessionContext };
}

async function fileSyncFeature(dir: string, binding: ProjectBinding, settingsPaths: Partial<Record<BindingHost, string>> = {}): Promise<Capability> {
  if (!binding.fileSyncConsent) return cap('DISABLED', 'no file-sync consent; Markdown files are never uploaded');
  try {
    const report = await syncReport(dir, binding);
    let hooks = 0; for (const host of binding.hosts) if ((await createAdapter(host, { root: dir, settingsPath: settingsPaths[host] ?? projectSettingsPath(dir, host) }).status()).fileSync) hooks++;
    const parts = [`${report.committed} committed`, `${report.queued} queued (${report.queuedBytes} bytes)`, `${report.conflicts.length} conflict(s)`, `${report.quarantined.length} quarantined`, `${report.failed.length} failed`];
    if (hooks < binding.hosts.length) return cap('FAIL', `consent recorded but the file-sync hooks are missing for ${binding.hosts.length - hooks} host(s); ${parts.join(', ')}`);
    if (report.conflicts.length || report.failed.length) return cap('FAIL', parts.join(', '));
    if (report.queued || report.quarantined.length) return cap('INCOMPLETE', parts.join(', '));
    if (!report.committed) return cap('INCOMPLETE', `hooks installed for ${include(binding)}; nothing has been synchronized yet`);
    return cap('PASS', `${parts.join(', ')}; last sync ${report.lastSyncAt}; approved paths: ${include(binding)}`);
  } catch (error) { return cap('FAIL', error instanceof Error ? error.message : String(error)); }
}
const include = (binding: ProjectBinding): string => binding.notesInclude.join(', ');
export async function projectDoctor(projectDir: string, options: { settingsPaths?: Partial<Record<BindingHost, string>>; probeRemote?: boolean } = {}): Promise<ProjectDoctorReport> {
  const dir = path.resolve(projectDir); let binding: ProjectBinding;
  const none = (error: string): ProjectDoctorReport => { const features = { capture: cap('NOT_RUN', error), context: cap('NOT_RUN', error), notes: cap('NOT_RUN', error), remote: cap('NOT_RUN', error), offline: cap('NOT_RUN', error), sessionContext: cap('NOT_RUN', error), fileSync: cap('NOT_RUN', error) }; return { projectDir: dir, binding: { present: false, error }, hosts: {}, features, summary: summarize(features) }; };
  try { binding = await readBinding(dir); } catch (error) { return none((error as NodeJS.ErrnoException).code === 'ENOENT' ? `no ${BINDING_FILE}: this project is not initialized` : error instanceof Error ? error.message : String(error)); }
  const hosts: Record<string, HostReport> = {}; for (const host of binding.hosts) hosts[host] = await hostReport(dir, host, binding, options.settingsPaths?.[host] ?? projectSettingsPath(dir, host));
  const token = binding.credentialRef ? process.env[binding.credentialRef] : undefined;
  let remote: Capability, notes: Capability;
  if (!binding.serverUrl) { remote = cap('DISABLED', 'local mode'); notes = cap('PASS', 'local vault'); }
  else if (options.probeRemote === false) { remote = cap('NOT_RUN', 'remote probe skipped'); notes = cap('NOT_RUN', 'remote probe skipped'); }
  else if (!token) { remote = cap('INCOMPLETE', `$${binding.credentialRef} is not set in this shell`); notes = cap('INCOMPLETE', 'not verified without a token'); }
  else try {
    const session = await openRemoteSession({ url: binding.serverUrl, token, workspaceId: binding.workspaceId });
    remote = cap('PASS', `authenticated, workspace ${binding.workspaceId} bound, ${session.tools.length} tools`);
    notes = ['engram_note_upsert', 'engram_task_upsert', 'engram_handoff_write'].every(name => session.tools.includes(name)) ? cap('PASS', 'typed note/task/handoff tools available (last acknowledged write is not queried)') : cap('FAIL', 'typed note/task/handoff tools are missing on the server');
  } catch (error) { const kind = error instanceof RemoteError ? error.kind : 'network'; remote = cap(kind === 'network' ? 'INCOMPLETE' : 'FAIL', error instanceof Error ? error.message : String(error)); notes = cap('INCOMPLETE', 'not verified'); }
  let offline: Capability;
  if (!binding.serverUrl) offline = cap('DISABLED', 'local mode needs no spool');
  else try { const spool = defaultRemoteSpoolDirectory(); const names = (await fs.readdir(spool).catch(() => [] as string[])).filter(n => n.endsWith('.json')); let bytes = 0; for (const n of names) bytes += (await fs.stat(path.join(spool, n)).catch(() => ({ size: 0 }))).size; offline = cap(names.length ? 'INCOMPLETE' : 'PASS', `${names.length} queued event(s), ${bytes} bytes in ${spool}`); }
  catch (error) { offline = cap('FAIL', error instanceof Error ? error.message : String(error)); }
  const hostValues = Object.values(hosts);
  const worst = (parts: Capability[], empty: Capability): Capability => !parts.length ? empty : parts.find(p => p.status === 'FAIL') ?? parts.find(p => p.status === 'INCOMPLETE') ?? parts.find(p => p.status === 'NOT_RUN') ?? parts.find(p => p.status === 'DISABLED') ?? parts[0]!;
  const features = {
    capture: worst(hostValues.map(h => h.capture), cap('DISABLED', 'no hosts bound')),
    context: worst(hostValues.map(h => h.instructions), cap('NOT_RUN', 'no hosts bound')),
    notes, remote, offline,
    sessionContext: worst(hostValues.map(h => h.sessionContext), cap('NOT_RUN', 'no hosts bound')),
    fileSync: await fileSyncFeature(dir, binding, options.settingsPaths),
  };
  return { projectDir: dir, binding: { present: true, workspaceId: binding.workspaceId, hosts: binding.hosts, ...(binding.serverUrl ? { serverUrl: binding.serverUrl } : {}), ...(binding.credentialRef ? { credentialRef: binding.credentialRef, tokenAvailable: !!token } : {}), ...(binding.registrationId ? { registrationId: binding.registrationId } : {}) }, hosts, features, summary: summarize(features) };
}
function summarize(features: Record<string, Capability>): Record<FeatureStatus, number> { const out: Record<FeatureStatus, number> = { PASS: 0, INCOMPLETE: 0, DISABLED: 0, FAIL: 0, NOT_RUN: 0 }; for (const f of Object.values(features)) out[f.status]++; return out; }
