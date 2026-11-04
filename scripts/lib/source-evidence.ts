import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseStrictJson } from './strict-json.js';

export interface SourceEvidence {
  algorithm: 'sha256';
  fingerprint: string;
  files: Record<string, string>;
  treeState: { commit: string; state: 'clean' | 'dirty' | 'no-git'; modified: string[]; untracked: string[]; headTreeMatches: boolean; reasonCode?: 'SYMLINK_IN_SOURCE' | 'HARDLINK_IN_SOURCE'; symlinks?: string[]; hardlinks?: string[] };
}

export function archiveAttestationMatches(text: string, fingerprint: string): boolean {
  try {
    const value = parseStrictJson(text, 'archive attestation') as { fingerprint?: string; git_commit?: string; archive_sha256?: string; created_by?: string; created_at?: string };
    return Object.keys(value).sort().join('\0') === ['archive_sha256', 'created_at', 'created_by', 'fingerprint', 'git_commit'].join('\0')
      && value.fingerprint === fingerprint && /^[a-f0-9]{40,64}$/.test(value.git_commit ?? '') && /^[a-f0-9]{64}$/.test(value.archive_sha256 ?? '')
      && value.created_by === 'ci' && Number.isFinite(Date.parse(value.created_at ?? '')) && new Date(value.created_at!).toISOString() === value.created_at;
  } catch { return false; }
}

function sourceBytes(name: string, bytes: Buffer): Buffer {
  if (name !== 'AGENTS.md') return bytes;
  const text = bytes.toString('utf8');
  const open = '<claude-mem-context>', close = '</claude-mem-context>';
  const start = text.indexOf(open);
  if (start < 0) return bytes;
  const end = text.indexOf(close, start + open.length);
  if (end < 0) throw new Error('AGENTS.md has an unterminated generated claude-mem-context block');
  return Buffer.from(`${text.slice(0, start)}${text.slice(end + close.length)}`, 'utf8');
}

const SOURCE_DIRS = ['.github', 'bin', 'ci', 'deploy', 'docs', 'fixtures', 'integrations', 'linux', 'macos', 'packages', 'scripts', 'skills', 'tests'];
const ROOT_FILES = ['.dockerignore', '.gitignore', 'AGENTS.md', 'Makefile', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.nvmrc'];
const EVALUATION_INPUTS = ['verification/profile/labeled-corpus.json', 'verification/profile/correction-corpus.json', 'fixtures/inputs/profile/holdout-corpus.json', 'verification/dream/labeled-scenarios.json', 'verification/benchmarks/corpus-manifest.json'];

/** Hash application, test, deployment and evaluation inputs without consulting or changing the Git index. */
export async function currentSourceEvidence(root = process.cwd()): Promise<SourceEvidence> {
  const names = new Set<string>();
  const symlinks = new Set<string>();
  const hardlinks = new Set<string>();
  const sourceStat = async (name: string) => fs.lstat(path.join(root, name)).catch(() => undefined);
  // HEAD is a read-only baseline: it lets us detect a required tracked source deleted
  // from the working tree, which a walk of existing files alone cannot observe.
  const git = (args: string[]): string => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }); } catch { return ''; } };
  const gitTop = git(['rev-parse', '--show-toplevel']).trim();
  const [canonicalGitTop, canonicalRoot] = await Promise.all([gitTop ? fs.realpath(gitTop).catch(() => '') : Promise.resolve(''), fs.realpath(root).catch(() => path.resolve(root))]);
  const gitDir = !!canonicalGitTop && canonicalGitTop === canonicalRoot;
  if (gitDir) {
    const tracked = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);
    for (const name of tracked) if (ROOT_FILES.includes(name) || EVALUATION_INPUTS.includes(name) || SOURCE_DIRS.some(dir => name.startsWith(`${dir}/`))) {
      const stat = await sourceStat(name);
      if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) throw new Error(`Required tracked source is missing from the working tree: ${name}`);
      names.add(name);
    }
  }
  for (const name of ROOT_FILES) { const stat = await sourceStat(name); if (stat?.isFile() || stat?.isSymbolicLink()) names.add(name); }
  for (const name of EVALUATION_INPUTS) { const stat = await sourceStat(name); if (stat?.isFile() || stat?.isSymbolicLink()) names.add(name); }
  const walk = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    const directoryStat = await fs.lstat(absolute).catch(() => undefined);
    if (directoryStat?.isSymbolicLink()) { names.add(relative.split(path.sep).join(path.posix.sep)); symlinks.add(relative.split(path.sep).join(path.posix.sep)); return; }
    if (directoryStat && !directoryStat.isDirectory()) return;
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isSymbolicLink()) { names.add(child); symlinks.add(child); }
      // These directories are the declared release input set. Include extensionless and
      // dot-example deployment files too; a filename extension is not a security boundary.
      else if (entry.isFile()) names.add(child);
    }
  };
  for (const directory of SOURCE_DIRS) await walk(directory);
  const files: Record<string, string> = {};
  const hash = createHash('sha256');
  for (const name of [...names].sort()) {
    const stat = await sourceStat(name);
    if (stat?.isFile() && stat.nlink > 1) hardlinks.add(name);
    const bytes = stat?.isSymbolicLink()
      ? Buffer.from(`symlink:${await fs.readlink(path.join(root, name))}`, 'utf8')
      : sourceBytes(name, await fs.readFile(path.join(root, name)));
    if (stat?.isSymbolicLink()) symlinks.add(name);
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    files[name] = fileHash;
    hash.update(name).update('\0').update(fileHash).update('\n');
  }
  const commit = gitDir ? git(['rev-parse', 'HEAD']).trim() : 'no-git-repository';
  let treeState: SourceEvidence['treeState'] = { commit, state: 'no-git', modified: [], untracked: [], headTreeMatches: false };
  if (gitDir) {
    const paths = Object.keys(files);
    const head = new Map<string, string>();
    for (const row of git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)) { const [meta, name] = row.split('\t'); if (name && meta) head.set(name, meta); }
    const index = new Map<string, string>();
    for (const row of git(['ls-files', '-s', '-z']).split('\0').filter(Boolean)) { const [meta, name] = row.split('\t'); if (name && meta) index.set(name, meta); }
    const tracked = paths.filter(name => head.has(name) || index.has(name));
    const untrackedSet = new Set(git(['ls-files', '--others', '-z', '--', ...paths]).split('\0').filter(Boolean));
    const untracked = paths.filter(name => untrackedSet.has(name)).sort();
    const modified: string[] = [];
    for (const name of tracked) {
      const headMeta = head.get(name)?.split(' ') ?? [];
      const indexMeta = index.get(name)?.split(' ') ?? [];
      let workingHash = '';
      try { workingHash = git(['hash-object', '--', name]).trim(); } catch { /* absent */ }
      const mode = await fs.lstat(path.join(root, name)).then(s => s.isFile() && !s.isSymbolicLink() ? s.mode & 0o111 ? '100755' : '100644' : '').catch(() => '');
      if (!headMeta[2] || !indexMeta[2] || headMeta[0] !== indexMeta[0] || headMeta[2] !== indexMeta[1] || headMeta[0] !== mode || headMeta[2] !== workingHash) modified.push(name);
    }
    const symlinkPaths = [...symlinks].sort();
    const hardlinkPaths = [...hardlinks].sort();
    const headTreeMatches = modified.length === 0 && untracked.length === 0 && symlinkPaths.length === 0 && hardlinkPaths.length === 0 && paths.every(name => head.has(name));
    treeState = { commit, state: headTreeMatches ? 'clean' : 'dirty', modified: modified.sort(), untracked, headTreeMatches,
      ...(symlinkPaths.length ? { reasonCode: 'SYMLINK_IN_SOURCE' as const, symlinks: symlinkPaths } : hardlinkPaths.length ? { reasonCode: 'HARDLINK_IN_SOURCE' as const, hardlinks: hardlinkPaths } : {}) };
  } else if (symlinks.size) {
    const symlinkPaths = [...symlinks].sort();
    treeState = { ...treeState, state: 'dirty', reasonCode: 'SYMLINK_IN_SOURCE', symlinks: symlinkPaths };
  } else if (hardlinks.size) { const hardlinkPaths = [...hardlinks].sort(); treeState = { ...treeState, state: 'dirty', reasonCode: 'HARDLINK_IN_SOURCE', hardlinks: hardlinkPaths }; }
  return { algorithm: 'sha256', fingerprint: hash.digest('hex'), files, treeState };
}
