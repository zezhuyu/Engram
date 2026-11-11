import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MDBError } from './types.js';
import { looksSecret } from '../memory/redact.js';
import type { ProfileDomain } from '../profile/domains.js';

/**
 * Project binding: which workspace, server and hosts a project directory uses. It lives in `.engram/project.json`, is gitignored, and holds
 * names only: the credential is referenced by environment-variable NAME, and no token, profile text or private data is ever stored here.
 */
export const BINDING_FILE = path.join('.engram', 'project.json');
export const BINDING_HOSTS = ['claude-code', 'codex'] as const;
export type BindingHost = (typeof BINDING_HOSTS)[number];
export interface ProjectBinding {
  schemaVersion: 1; projectRoot: '.'; workspaceId: string; serverUrl?: string; mode?: 'local'|'remote'|'replica'; replicaId?: string; hosts: BindingHost[]; credentialRef?: string; registrationId?: string;
  captureConsent: boolean; fileSyncConsent: boolean; /** false keeps accepted-profile text out of AGENTS.md/CLAUDE.md (it is still delivered at session start) */ profileInFiles?: boolean; notesInclude: string[]; notesExclude: string[]; profileMaxTokens: number; sessionContextMaxTokens: number;
  /** Omitted on legacy bindings to preserve their historical unfiltered projection. */ domains?: ProfileDomain[];
  managed: { version: number; projectionRevision?: string; generatedAt?: string };
}
const KEYS = new Set(['schemaVersion', 'projectRoot', 'workspaceId', 'serverUrl', 'mode', 'replicaId', 'hosts', 'credentialRef', 'registrationId', 'captureConsent', 'fileSyncConsent', 'profileInFiles', 'notesInclude', 'notesExclude', 'profileMaxTokens', 'sessionContextMaxTokens', 'domains', 'managed']);
const invalid = (message: string): never => { throw new MDBError('INVALID_INPUT', `Invalid project binding: ${message}`); };
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function defaultBinding(input: { workspaceId: string; serverUrl?: string; hosts?: BindingHost[]; credentialRef?: string; registrationId?: string; captureConsent?: boolean }): ProjectBinding {
  return { schemaVersion: 1, projectRoot: '.', workspaceId: input.workspaceId, ...(input.serverUrl ? { serverUrl: input.serverUrl, mode: 'remote' as const } : { mode: 'local' as const }), hosts: input.hosts ?? [], ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}), ...(input.registrationId ? { registrationId: input.registrationId } : {}),
    captureConsent: input.captureConsent ?? false, fileSyncConsent: false, notesInclude: ['notes/**/*.md', '.engram/notes/**/*.md'], notesExclude: ['**/.env*', '**/.git/**', '**/node_modules/**'], profileMaxTokens: 900, sessionContextMaxTokens: 2500, managed: { version: 1 } };
}
function glob(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 200) invalid(`${label} entries must be short strings`);
  const text = value as string;
  if (path.isAbsolute(text) || text.startsWith('~') || text.split('/').includes('..') || text.includes('\0') || looksSecret(text)) invalid(`${label} entry is not a safe relative pattern`);
  return text;
}
export function parseBinding(raw: unknown): ProjectBinding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('not an object');
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!KEYS.has(key)) invalid(`unknown field ${key.slice(0, 30)}`);
  if (v.schemaVersion !== 1) invalid('schemaVersion must be 1');
  if (v.projectRoot !== '.') invalid('projectRoot must be "."');
  if (typeof v.workspaceId !== 'string' || !WORKSPACE.test(v.workspaceId)) invalid('workspaceId');
  if (v.serverUrl !== undefined) { try { const u = new URL(String(v.serverUrl)); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) invalid('serverUrl'); } catch (error) { if (error instanceof MDBError) throw error; invalid('serverUrl'); } }
  if (v.mode !== undefined && !['local','remote','replica'].includes(String(v.mode))) invalid('mode');
  if (v.replicaId !== undefined && (typeof v.replicaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.replicaId))) invalid('replicaId');
  if (v.mode === 'replica' && (!v.replicaId || !v.serverUrl)) invalid('replica mode requires replicaId and serverUrl');
  if (!Array.isArray(v.hosts) || v.hosts.some(h => !(BINDING_HOSTS as readonly string[]).includes(h as string)) || new Set(v.hosts).size !== v.hosts.length) invalid('hosts');
  if (v.credentialRef !== undefined && (typeof v.credentialRef !== 'string' || !ENV_NAME.test(v.credentialRef) || v.credentialRef.length > 80)) invalid('credentialRef must be an environment variable name');
  if (v.registrationId !== undefined && (typeof v.registrationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(v.registrationId))) invalid('registrationId');
  for (const flag of ['captureConsent', 'fileSyncConsent'] as const) if (typeof v[flag] !== 'boolean') invalid(flag);
  if (v.profileInFiles !== undefined && typeof v.profileInFiles !== 'boolean') invalid('profileInFiles');
  if (v.domains !== undefined) { if (!Array.isArray(v.domains) || !v.domains.length || v.domains.length > 3 || v.domains.some(item => typeof item !== 'string' || (item !== 'general' && !/^[a-z][a-z0-9-]{1,23}$/.test(item)))) invalid('domains must contain 1–3 valid domain slugs'); }
  for (const list of ['notesInclude', 'notesExclude'] as const) { if (!Array.isArray(v[list]) || (v[list] as unknown[]).length > 50) invalid(list); (v[list] as unknown[]).forEach(item => glob(item, list)); }
  for (const item of v.notesInclude as string[]) if (!item.endsWith('.md')) invalid('notesInclude patterns must end in .md');
  const inRange = (value: unknown, lo: number, hi: number, label: string) => { if (!Number.isInteger(value) || (value as number) < lo || (value as number) > hi) invalid(`${label} must be ${lo}-${hi}`); };
  inRange(v.profileMaxTokens, 100, 4000, 'profileMaxTokens'); inRange(v.sessionContextMaxTokens, 100, 8000, 'sessionContextMaxTokens');
  const m = v.managed as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object' || !Number.isInteger(m.version) || Object.keys(m).some(k => !['version', 'projectionRevision', 'generatedAt'].includes(k)) || (m.projectionRevision !== undefined && (typeof m.projectionRevision !== 'string' || m.projectionRevision.length > 100)) || (m.generatedAt !== undefined && !Number.isFinite(Date.parse(String(m.generatedAt))))) invalid('managed');
  return { ...v, mode: (v.mode as ProjectBinding['mode']) ?? (v.serverUrl ? 'remote' : 'local') } as unknown as ProjectBinding;
}

export async function readBinding(projectDir: string): Promise<ProjectBinding> {
  const file = path.join(projectDir, BINDING_FILE);
  const info = await fs.lstat(file);
  if (info.isSymbolicLink()) throw new MDBError('INVALID_INPUT', 'Project binding must not be a symlink');
  let parsed: unknown; try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return invalid('file is not valid JSON'); }
  return parseBinding(parsed);
}
/**
 * Nearest binding at or above `startDir`, or undefined (local mode). The search never leaves the repository the directory belongs to: the first directory that holds a `.git`
 * (a folder, or the file a worktree has) is the last one examined, so a separate repository or worktree nested inside a bound project does not inherit that project's workspace.
 * A malformed or symlinked binding is an error, never silently skipped.
 */
export async function findBinding(startDir: string): Promise<{ root: string; binding: ProjectBinding } | undefined> {
  let dir = await fs.realpath(path.resolve(startDir));
  for (;;) {
    try { await fs.lstat(path.join(dir, BINDING_FILE)); return { root: dir, binding: await readBinding(dir) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (await fs.lstat(path.join(dir, '.git')).then(() => true, () => false)) return undefined; // repository boundary
    const parent = path.dirname(dir); if (parent === dir) return undefined; dir = parent;
  }
}
/** Atomic replace: temp file in the same directory, then rename. Directory 0700, file 0600. */
export async function writeBinding(projectDir: string, binding: ProjectBinding): Promise<void> {
  parseBinding(binding);
  const file = path.join(projectDir, BINDING_FILE); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}
/** Adds `.engram/` to the project's .gitignore unless an equivalent line exists. Keeps every other line and the file's line endings. Returns whether it changed the file. */
export async function ensureGitignore(projectDir: string, entry = '.engram/'): Promise<boolean> {
  const file = path.join(projectDir, '.gitignore'); let existing = ''; try { existing = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bare = entry.replace(/\/$/, '');
  if (existing.split(/\r?\n/).some(line => [bare, `${bare}/`, `/${bare}`, `/${bare}/`].includes(line.trim()))) return false;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  await fs.writeFile(file, `${existing}${existing && !existing.endsWith('\n') ? eol : ''}${entry}${eol}`); return true;
}
