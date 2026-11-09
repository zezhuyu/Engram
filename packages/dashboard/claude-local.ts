import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { localServerEntry, upsertClaudeLocalMcp, type LocalServerEntry } from '../project-init.js';

type Target = 'claude-code' | 'claude-desktop';
type Preview = { target: Target; file: string; backupPath: string | null; digest: string; next: string; diff: string; entry: LocalServerEntry };
const previews = new Map<string, Preview>();
const home = () => process.env.HOME || os.homedir();
export function desktopConfigTarget(platform = process.platform): { file: string | null; note: string | null } {
  if (platform === 'darwin') return { file: path.join(home(), 'Library/Application Support/Claude/claude_desktop_config.json'), note: null };
  if (platform === 'win32') return { file: path.join(process.env.APPDATA || path.join(home(), 'AppData/Roaming'), 'Claude/claude_desktop_config.json'), note: null };
  return { file: null, note: 'Linux Desktop config location is unverified; use the copy-only snippet.' };
}
async function existing(file: string): Promise<{ text: string; mode: number }> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Target config must be a regular file'); return { text: await fs.readFile(file, 'utf8'), mode: info.mode & 0o777 }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', mode: 0o600 }; throw error; }
}
function merge(text: string, entry: LocalServerEntry): string {
  let config: Record<string, unknown> = {};
  if (text) { try { config = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('Cannot parse target config'); } }
  const servers = config.mcpServers === undefined ? {} : config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcpServers must be an object');
  const prior = (servers as Record<string, unknown>).engram;
  const managed = typeof prior === 'object' && prior !== null && (((prior as { type?: string }).type === 'stdio' && Array.isArray((prior as { args?: unknown }).args) && ((prior as { args: unknown[] }).args).some(arg => typeof arg === 'string' && /mdb-mcp\.js$|^mcp-proxy$/.test(arg))) || ((prior as { type?: string }).type === 'http' && typeof (prior as { headers?: Record<string, unknown> }).headers?.['X-Engram-Workspace'] === 'string'));
  if (prior && !managed) throw new Error('Target already has a conflicting hand-written engram entry');
  (servers as Record<string, unknown>).engram = { type: 'stdio', ...entry }; config.mcpServers = servers;
  return JSON.stringify(config, null, 2) + '\n';
}
function diff(before: string, after: string): string { return '--- current\n+++ proposed\n' + (before ? before.split('\n').map(line => '-' + line).join('\n') + '\n' : '') + after.split('\n').map(line => '+' + line).join('\n'); }
async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.engram-tmp';
  try { await fs.writeFile(temp, content, { mode, flag: 'wx' }); await fs.chmod(temp, mode); await fs.rename(temp, file); await fs.chmod(file, mode); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
export async function localClaudeState(root: string, workspaces: Array<{ id: string }>) {
  const workspace = workspaces[0]?.id ?? 'default';
  const entry = localServerEntry(root, workspace, 'local-dashboard');
  const claudeCodeFile = path.join(home(), '.claude.json'); let claudeCode: unknown = { exists: false, engramPresent: false };
  try { const parsed = JSON.parse(await fs.readFile(claudeCodeFile, 'utf8')); const server = parsed?.mcpServers?.engram; claudeCode = { exists: true, engramPresent: !!server, ...(server ? { type: typeof server.type === 'string' ? server.type : 'unknown', ...(typeof server.url === 'string' ? { urlHost: (() => { try { return new URL(server.url).host; } catch { return null; } })() } : {}) } : {}) }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') claudeCode = { exists: true, engramPresent: false, unreadable: true }; }
  const desktop = desktopConfigTarget(); let desktopState: unknown = { exists: false, engramPresent: false };
  if (desktop.file) { try { const parsed = JSON.parse(await fs.readFile(desktop.file, 'utf8')); desktopState = { exists: true, engramPresent: !!parsed?.mcpServers?.engram }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') desktopState = { exists: true, engramPresent: false, unreadable: true }; } }
  const safeEntry = entry ?? { command: process.execPath, args: [path.resolve(root, 'mdb-mcp.js'), '--root', path.resolve(root)], env: { MDB_ACTOR_ID: 'local-dashboard', MDB_PERMISSIONS: `workspace:${workspace}:read,workspace:${workspace}:write`, MDB_DEFAULT_WORKSPACE: workspace } };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return { node: safeEntry.command, mdbMcp: safeEntry.args[0], root: path.resolve(root), claudeCode: { file: claudeCodeFile, state: claudeCode }, desktop: { file: desktop.file, state: desktopState, note: desktop.note }, entry: safeEntry, command: 'claude mcp add --scope user --transport stdio engram -- ' + [safeEntry.command, ...safeEntry.args].map(quote).join(' '), snippets: { mcpJson: JSON.stringify({ mcpServers: { engram: safeEntry } }, null, 2), desktopJson: JSON.stringify({ mcpServers: { engram: safeEntry } }, null, 2), remote: JSON.stringify({ mcpServers: { engram: { command: 'mdb', args: ['mcp-proxy', '--url', 'https://your-server.example/mcp', '--token-env', 'ENGRAM_MCP_TOKEN'] } } }, null, 2) } };
}
export async function previewClaudeLocal(root: string, target: Target, entry: LocalServerEntry): Promise<Omit<Preview, 'next' | 'entry'> & { previewId: string }> {
  const file = target === 'claude-code' ? path.join(home(), '.claude.json') : desktopConfigTarget().file;
  if (!file) throw new Error(desktopConfigTarget().note ?? 'Target path is unavailable');
  const current = await existing(file), next = merge(current.text, entry), backupPath = current.text ? `${file}.engram-backup-${new Date().toISOString().replace(/[:.]/g, '-')}` : null;
  const digest = createHash('sha256').update(file).update('\0').update(current.text).update('\0').update(next).digest('hex'), previewId = randomBytes(24).toString('base64url');
  while (previews.size >= 128) previews.delete(previews.keys().next().value!);
  previews.set(previewId, { target, file, backupPath, digest, next, diff: diff(current.text, next), entry });
  return { target, file, backupPath, digest, diff: diff(current.text, next), previewId };
}
export async function applyClaudeLocal(root: string, previewId: string, expectedDigest: string): Promise<{ file: string; backupPath: string | null; restartRequired: boolean }> {
  const preview = previews.get(previewId); previews.delete(previewId);
  if (!preview || preview.digest !== expectedDigest) throw new Error('Preview expired or digest did not match');
  const current = await existing(preview.file), digest = createHash('sha256').update(preview.file).update('\0').update(current.text).update('\0').update(preview.next).digest('hex');
  if (digest !== expectedDigest) throw new Error('Target changed after preview; create a new preview');
  if (preview.target === 'claude-code') await upsertClaudeLocalMcp(preview.file, preview.entry, { backupPath: preview.backupPath ?? undefined });
  else {
    if (preview.backupPath) await fs.copyFile(preview.file, preview.backupPath);
    await writeAtomic(preview.file, preview.next, current.mode);
  }
  return { file: preview.file, backupPath: preview.backupPath, restartRequired: preview.target === 'claude-desktop' };
}
