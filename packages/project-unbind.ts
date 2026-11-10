import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MDBError } from './core/types.js';
import { locateManagedBlock, removeClaudeMcp, removeCodexMcp, removeManagedBlock } from './project-init.js';
import { untrustProject } from './core/project-trust.js';
import { createAdapter } from './memory/adapters.js';
import { projectSettingsPath } from './project-init.js';

const MANIFEST = path.join('.engram', 'init-manifest.json');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type ManifestFile = { path: string; action: 'create' | 'modify'; sha256Before: string | null; sha256After: string | null; backupPath: string | null; beforeMode: number | null };

/** Reverses only files recorded by project init. Any drift aborts before the first change. */
export async function unbindProject(projectDir: string, options: { dryRun?: boolean; vaultRoot?: string } = {}): Promise<{ projectDir: string; manifest: boolean; restored: string[]; removed: string[]; conflicts: string[] }> {
  const root = path.resolve(projectDir);
  let value: { schemaVersion?: number; files?: ManifestFile[] } | undefined;
  try { value = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8')) as typeof value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MDBError('INVALID_INPUT', `Cannot read init manifest: ${(error as Error).message}`); }
  if (!value) {
    const removed: string[] = [];
    for (const file of ['CLAUDE.md', 'AGENTS.md']) if (await removeManagedBlock(path.join(root, file), { start: '<!-- engram:managed:start -->', end: '<!-- engram:managed:end -->' }, { dryRun: options.dryRun })) removed.push(file);
    if (!options.dryRun) for (const host of ['claude-code', 'codex'] as const) await createAdapter(host, { root: options.vaultRoot ?? root, settingsPath: projectSettingsPath(root, host) }).removeProjectHooks(root);
    if (!options.dryRun) { await removeClaudeMcp(path.join(root, '.mcp.json')); await removeCodexMcp(path.join(root, '.codex', 'config.toml')); }
    if (!options.dryRun) await untrustProject(root);
    return { projectDir: root, manifest: false, restored: [], removed, conflicts: [] };
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.files)) throw new MDBError('INVALID_INPUT', 'Unsupported or malformed init manifest');
  const conflicts: string[] = [];
  for (const item of value.files) {
    if (!item || typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split('/').includes('..')) { conflicts.push(String(item?.path ?? '(invalid path)')); continue; }
    const file = path.join(root, item.path);
    try {
      if (item.sha256Before) {
        const backupPath = item.backupPath;
        if (!backupPath || path.isAbsolute(backupPath) || backupPath.split('/').includes('..') || !backupPath.startsWith('.engram/unbind-backup/')) { conflicts.push(`${item.path} (invalid backup reference)`); continue; }
        const backup = await fs.readFile(path.join(root, backupPath)); if (sha256(backup) !== item.sha256Before) { conflicts.push(`${item.path} (backup hash mismatch)`); continue; }
      }
      const current = await fs.readFile(file);
      if (['CLAUDE.md', 'AGENTS.md'].includes(item.path)) {
        try { if (!locateManagedBlock(current.toString('utf8'), file, { start: '<!-- engram:managed:start -->', end: '<!-- engram:managed:end -->' })) conflicts.push(item.path); }
        catch { conflicts.push(item.path); }
      } else if (!item.sha256After || sha256(current) !== item.sha256After) conflicts.push(item.path);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || item.sha256After !== null) conflicts.push(item.path); }
  }
  if (conflicts.length) return { projectDir: root, manifest: true, restored: [], removed: [], conflicts };
  if (options.dryRun) return { projectDir: root, manifest: true, restored: value.files.filter(f => f.sha256Before !== null).map(f => f.path), removed: value.files.filter(f => f.sha256Before === null).map(f => f.path), conflicts: [] };
  const restored: string[] = [], removed: string[] = [];
  const bindingFile = '.engram/project.json';
  const orderedFiles = [...value.files.filter(item => item.path !== bindingFile), ...value.files.filter(item => item.path === bindingFile)];
  for (const item of orderedFiles) {
    if (item.path === bindingFile) continue;
    const file = path.join(root, item.path);
    if (['CLAUDE.md', 'AGENTS.md'].includes(item.path)) {
      const bytes = await fs.readFile(file); const unchanged = item.sha256After === sha256(bytes);
      if (item.sha256Before === null && unchanged) { await fs.rm(file, { force: true }); removed.push(item.path); }
      else if (item.sha256Before !== null && unchanged) { await fs.writeFile(file, await fs.readFile(path.join(root, item.backupPath!)), { mode: item.beforeMode ?? 0o644 }); restored.push(item.path); }
      else { await removeManagedBlock(file, { start: '<!-- engram:managed:start -->', end: '<!-- engram:managed:end -->' }); restored.push(item.path); }
      continue;
    }
    if (item.sha256Before === null) { await fs.rm(file, { force: true }); removed.push(item.path); continue; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await fs.readFile(path.join(root, item.backupPath!)), { mode: item.beforeMode ?? 0o600 }); restored.push(item.path);
  }
  await untrustProject(root);
  for (const item of orderedFiles.filter(item => item.path === bindingFile)) {
    const file = path.join(root, item.path);
    if (item.sha256Before === null) { await fs.rm(file, { force: true }); removed.push(item.path); }
    else { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, await fs.readFile(path.join(root, item.backupPath!)), { mode: item.beforeMode ?? 0o600 }); restored.push(item.path); }
  }
  await fs.rm(path.join(root, MANIFEST), { force: true });
  await fs.rm(path.join(root, '.engram/unbind-backup'), { recursive: true, force: true });
  for (const dir of [path.join(root, '.engram'), path.join(root, '.codex'), path.join(root, '.claude')]) await fs.rmdir(dir).catch(() => undefined);
  return { projectDir: root, manifest: true, restored, removed, conflicts: [] };
}
