#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ownDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(ownDir, '..');
const valueFlags = new Set(['project-dir', 'workspace', 'hosts', 'backup-root', 'backup-dir', 'notes-include-file', 'mcp-url', 'token-env', 'size-cap', 'hash-limit-mb', 'runtime-ignore', 'node-bin', 'mdb-bin']);
const boolFlags = new Set(['apply', 'rollback', 'file-sync-consent', 'help']);
const args = process.argv.slice(2), flags = new Map();
for (let i = 0; i < args.length; i++) {
  const raw = args[i];
  if (!raw.startsWith('--')) { process.stderr.write(`Unknown argument: ${raw}. Use --help for usage.\n`); process.exit(2); }
  const key = raw.slice(2);
  if (!valueFlags.has(key) && !boolFlags.has(key)) { process.stderr.write(`Unknown flag: --${key}. Use --help for usage.\n`); process.exit(2); }
  if (boolFlags.has(key)) flags.set(key, true);
  else { const value = args[++i]; if (!value || value.startsWith('--')) { process.stderr.write(`--${key} requires a value. Use --help for usage.\n`); process.exit(2); }
    if (key === 'runtime-ignore') flags.set(key, [...(flags.get(key) ?? []), value]); else flags.set(key, value);
  }
}
const usage = `Usage: node scripts/project-migration.mjs --project-dir DIR --hosts claude-code[,codex] [options]\n\nSequence: preview (default), inspect the saved report, then rerun with --apply; rollback with --rollback --backup-dir DIR.\nBackup layout: <backup-root>/<project>/<timestamp>/{targets...,SHA256SUMS,TARGETS.json,dry-run.json,integrity-manifest.json}\n\nFlags: --project-dir DIR --workspace NAME --hosts LIST --backup-root DIR --backup-dir DIR\n       --notes-include-file FILE --file-sync-consent --mcp-url URL --token-env NAME\n       --size-cap BYTES (default 64 GiB) --hash-limit-mb N (default 256 MiB/file)\n       --runtime-ignore GLOB (repeatable; adds to the documented default ignore list)\n       --node-bin PATH --mdb-bin PATH (use the installed app's runtime so project hooks do not point at a development checkout)
       --apply --rollback --help\n`;
if (flags.has('help')) { process.stdout.write(usage); process.exit(0); }
const val = (key, fallback) => flags.get(key) ?? fallback;
const nodeBin = val('node-bin', process.execPath), mdbBin = val('mdb-bin', path.join(repo, 'bin/mdb.js'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
};
if (!val('project-dir')) throw new Error('--project-dir is required');
const project = path.resolve(val('project-dir'));
const realA = await fs.realpath(project), stat = await fs.stat(realA), realB = await fs.realpath(project);
if (!stat.isDirectory() || realA !== realB) throw new Error('Project must exist as a mounted directory with a stable real path');
await fs.statfs(realA);
const workspace = val('workspace', path.basename(realA).toLowerCase());
if (workspace !== path.basename(realA).toLowerCase() || !/^[a-z0-9]+$/.test(workspace)) throw new Error('Workspace must be the lowercase project folder name');
const hosts = val('hosts');
if (!hosts || hosts.split(',').some(host => !['claude-code', 'codex'].includes(host))) throw new Error('--hosts must list claude-code and/or codex');
for (const host of hosts.split(',')) {
  const file = host === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
  if (!(await fs.stat(path.join(realA, file)).then(info => info.isFile(), () => false))) throw new Error(`Host ${host} is selected only for projects with a pre-existing ${file}`);
}
const numberFlag = (key, fallback) => { const n = Number(val(key, fallback)); if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a non-negative number`); return n; };
const sizeCap = numberFlag('size-cap', 64 * 1024 ** 3), hashLimitBytes = numberFlag('hash-limit-mb', 256) * 1024 ** 2;
const backupRoot = path.resolve(val('backup-root', path.join(repo, '.migration-backups')));
const backupDir = path.join(backupRoot, path.basename(realA), new Date().toISOString().replace(/[:.]/g, '-'));
const skipNames = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'coverage', 'target']);
const runtimePatterns = ['.omx/state/**', '.omx/logs/**', '.omx/metrics/**', '.omx/notepad*', '.git/index', '.git/index.lock', '.git/*.lock', '.DS_Store', '**/.DS_Store', '**/__pycache__/**', '**/*.pyc', '.engram/**', ...[].concat(flags.get('runtime-ignore') ?? [])];
function globRegex(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) { const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { i++; out += '.*'; } else out += '[^/]*'; }
    else if (c === '?') out += '[^/]'; else out += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
const ignoreRegexes = runtimePatterns.map(globRegex);
const isIgnored = rel => ignoreRegexes.some(re => re.test(rel));
const initTarget = rel => ['CLAUDE.md', 'AGENTS.md', '.gitignore', '.mcp.json'].includes(rel) || rel.startsWith('.engram/') || rel.startsWith('.claude/') || rel.startsWith('.codex/');
async function countRegularFiles(dir) {
  let count = 0;
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) count += await countRegularFiles(child);
    else if (item.isFile()) count++;
  }
  return count;
}
async function listFiles(dir, rel = '', skippedCounts = {}) {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const childRel = path.posix.join(rel, item.name), child = path.join(dir, item.name);
    if (item.isSymbolicLink()) { result.push(childRel); continue; }
    if (item.isDirectory()) {
      if (skipNames.has(item.name)) { skippedCounts[item.name] = (skippedCounts[item.name] ?? 0) + await countRegularFiles(child); continue; }
      if (item.name === '.git') {
        for (const gitItem of await fs.readdir(child, { withFileTypes: true })) {
          const gitRel = path.posix.join(childRel, gitItem.name), gitChild = path.join(child, gitItem.name);
          if (gitItem.name === 'objects' && gitItem.isDirectory()) { skippedCounts['.git/objects'] = (skippedCounts['.git/objects'] ?? 0) + await countRegularFiles(gitChild); continue; }
          if (gitItem.isSymbolicLink()) result.push(gitRel);
          else if (gitItem.isDirectory()) result.push(...await listFiles(gitChild, gitRel, skippedCounts));
          else if (gitItem.isFile()) result.push(gitRel);
        }
      } else result.push(...await listFiles(child, childRel, skippedCounts));
    } else if (item.isFile()) result.push(childRel);
  }
  return result;
}
async function hashStream(filename, onProgress) {
  const hash = createHash('sha256');
  let chunks = 0, bytesRead = 0;
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); chunks++; bytesRead += chunk.length; onProgress(bytesRead); }
  return { sha256: hash.digest('hex'), chunks };
}
async function treeManifest(progressLabel = 'manifest') {
  const started = Date.now(), skipped = {}, files = await listFiles(realA, '', skipped), manifest = {}, runtime = [];
  let totalBytes = 0, hashedBytes = 0, streamedChunks = 0, count = 0, lastProgress = Date.now();
  for (const rel of files) {
    const full = path.join(realA, rel), info = await fs.lstat(full, { bigint: true });
    if (info.isSymbolicLink()) { manifest[rel] = { type: 'symlink', target: await fs.readlink(full) }; count++; continue; }
    if (!info.isFile()) continue;
    const size = Number(info.size); totalBytes += size;
    if (totalBytes > sizeCap) throw new Error(`Project tree exceeds --size-cap (${sizeCap} bytes); observed at least ${totalBytes} bytes`);
    const mtimeNs = info.mtimeNs.toString();
    if (isIgnored(rel)) { runtime.push(rel); manifest[rel] = { type: 'file', size, mtimeNs, ignored: true }; }
    else if (size <= hashLimitBytes) {
      const result = await hashStream(full, fileBytes => {
        if (Date.now() - lastProgress >= 3000) { process.stderr.write(`${progressLabel}: ${count + 1}/${files.length} files, ${hashedBytes + fileBytes} bytes hashed\n`); lastProgress = Date.now(); }
      });
      manifest[rel] = { type: 'file', size, mtimeNs, sha256: result.sha256 }; hashedBytes += size; streamedChunks += result.chunks;
    }
    else manifest[rel] = { type: 'file', size, mtimeNs, large: true };
    count++;
    if (Date.now() - lastProgress >= 3000) { process.stderr.write(`${progressLabel}: ${count}/${files.length} files, ${hashedBytes} bytes hashed\n`); lastProgress = Date.now(); }
  }
  const skippedFiles = Object.fromEntries([...skipNames, '.git/objects'].map(name => [name, skipped[name] ?? 0]));
  return { files: manifest, stats: { files: count, totalBytes, hashedBytes, streamedChunks, elapsedMs: Date.now() - started, skippedDirs: skippedFiles, runtimeIgnored: runtime } };
}
async function backup() {
  const files = (await listFiles(realA)).filter(rel => initTarget(rel) && !isIgnored(rel)), sums = [], targets = [];
  for (const rel of files) {
    const source = path.join(realA, rel), target = path.join(backupDir, rel); await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = await fs.readFile(source), mode = (await fs.stat(source)).mode & 0o777; await fs.writeFile(target, bytes, { mode }); await fs.chmod(target, mode); const copied = await fs.readFile(target);
    if (!bytes.equals(copied)) throw new Error(`Backup verification failed: ${rel}`);
    sums.push(`${sha(bytes)}  ${rel}`); targets.push({ path: rel, mode });
  }
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await fs.writeFile(path.join(backupDir, 'TARGETS.json'), JSON.stringify(targets, null, 2) + '\n');
}
async function instructionDiffs(dir) {
  const diffs = {};
  for (const rel of ['CLAUDE.md', 'AGENTS.md']) {
    const saved = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => ''), current = await fs.readFile(path.join(realA, rel), 'utf8').catch(() => '');
    if (saved === current) continue;
    diffs[rel] = [`--- backup/${rel}`, `+++ current/${rel}`, '@@', ...saved.split(/\r?\n/).filter((_, i, a) => i < a.length - 1).map(line => `-${line}`), ...current.split(/\r?\n/).filter((_, i, a) => i < a.length - 1).map(line => `+${line}`)].join('\n');
  }
  return diffs;
}
const sameEntry = (a, b) => {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'symlink') return a.target === b.target;
  if (a.ignored || b.ignored || a.large || b.large) return a.size === b.size && a.mtimeNs === b.mtimeNs;
  if (a.sha256 && b.sha256) return a.size === b.size && a.sha256 === b.sha256;
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
};
function changedEntries(before, after) {
  const changed = [], ignored = [];
  for (const rel of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (initTarget(rel)) continue;
    const a = before.files[rel], b = after.files[rel]; if (sameEntry(a, b)) continue;
    if (isIgnored(rel)) ignored.push(rel); else changed.push(rel);
  }
  return { changed, ignored };
}
if (flags.has('rollback')) {
  const from = path.resolve(val('backup-dir', ''));
  if (!val('backup-dir')) throw new Error('--rollback requires --backup-dir');
  run(nodeBin, [mdbBin, 'project', 'unbind', '--project-dir', realA, '--json'], { cwd: repo });
  const saved = JSON.parse(await fs.readFile(path.join(from, 'TARGETS.json'), 'utf8'));
  const savedPaths = saved.map(item => item.path);
  for (const rel of await listFiles(realA)) if (initTarget(rel) && !savedPaths.includes(rel)) await fs.rm(path.join(realA, rel), { force: true });
  for (const item of saved) { const source = path.join(from, item.path), target = path.join(realA, item.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); await fs.chmod(target, item.mode); }
  const savedManifest = JSON.parse(await fs.readFile(path.join(from, 'integrity-manifest.json'), 'utf8'));
  const restored = await treeManifest('rollback verify'), differences = changedEntries(savedManifest, restored);
  process.stdout.write(JSON.stringify({ rollback: 'complete', project: realA, backup: from, manifestDifferences: differences.changed, runtimeIgnoredChanged: differences.ignored.length, runtimeIgnoredSummary: `runtime-ignored: ${differences.ignored.length} files changed`, runtimeIgnoredPaths: differences.ignored, manifestStats: restored.stats }) + '\n');
  if (differences.changed.length) process.exitCode = 1;
} else {
  await backup();
  const notesFile = val('notes-include-file');
  const include = notesFile ? (await fs.readFile(path.resolve(notesFile), 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
  const command = [mdbBin, 'init', '--project', '--project-dir', realA, '--workspace', workspace, '--hosts', hosts, '--no-profile-in-files'];
  const mcpUrl = val('mcp-url'); if (mcpUrl) command.push('--mcp-url', mcpUrl, '--token-env', val('token-env', 'ENGRAM_MCP_TOKEN'));
  if (flags.has('file-sync-consent') && notesFile) {
    if (!include.length) throw new Error('The notes include-list file is empty; refusing to apply file-sync consent with default patterns');
    command.push('--file-sync-consent', '--notes-include', include.join(','));
  }
  const before = await treeManifest('before');
  const preview = run(nodeBin, [...command, '--dry-run', '--json'], { cwd: repo });
  await fs.writeFile(path.join(backupDir, 'dry-run.json'), preview);
  await fs.writeFile(path.join(backupDir, 'integrity-manifest.json'), JSON.stringify(before, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ preview: path.join(backupDir, 'dry-run.json'), backup: backupDir, applyRequired: true, manifestStats: before.stats, hashingPolicy: { perFileSha256LimitBytes: hashLimitBytes, sizeCapBytes: sizeCap }, runtimeIgnored: runtimePatterns, skippedDirs: before.stats.skippedDirs }) + '\n');
  if (flags.has('apply')) {
    const applyArgs = [...command]; if (mcpUrl) applyArgs.push('--consent');
    const output = run(nodeBin, applyArgs, { cwd: repo });
    const after = await treeManifest('after'), changes = changedEntries(before, after);
    if (changes.changed.length) throw new Error(`Files outside the init write set changed: ${changes.changed.join(', ')}`);
    const doctor = run(nodeBin, [mdbBin, 'doctor', '--project', '--project-dir', realA, '--json'], { cwd: repo });
    const actual = JSON.parse(await fs.readFile(path.join(realA, '.engram/project.json'), 'utf8'));
    if (actual.workspaceId !== workspace) throw new Error(`Binding workspace mismatch: expected ${workspace}, found ${actual.workspaceId}`);
    const diffs = await instructionDiffs(backupDir);
    for (const [file, diff] of Object.entries(diffs)) process.stdout.write(`${file} diff:\n${diff}\n`);
    process.stdout.write(JSON.stringify({ applied: true, workspace, doctor: JSON.parse(doctor), init: JSON.parse(output), unchangedOutsideWriteSet: true, runtimeIgnoredChanged: changes.ignored.length, runtimeIgnoredSummary: `runtime-ignored: ${changes.ignored.length} files changed`, runtimeIgnoredPaths: changes.ignored, manifestStats: { before: before.stats, after: after.stats }, instructionDiffs: diffs }) + '\n');
  }
}
