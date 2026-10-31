import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface SourceEvidence {
  algorithm: 'sha256';
  fingerprint: string;
  files: Record<string, string>;
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
  // HEAD is a read-only baseline: it lets us detect a required tracked source deleted
  // from the working tree, which a walk of existing files alone cannot observe.
  const gitDir = existsSync(path.join(root, '.git'));
  if (gitDir) {
    const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const name of tracked) if (ROOT_FILES.includes(name) || EVALUATION_INPUTS.includes(name) || SOURCE_DIRS.some(dir => name.startsWith(`${dir}/`))) {
      if (!(await fs.stat(path.join(root, name)).catch(() => undefined))?.isFile()) throw new Error(`Required tracked source is missing from the working tree: ${name}`);
      names.add(name);
    }
  }
  for (const name of ROOT_FILES) if ((await fs.stat(path.join(root, name)).catch(() => undefined))?.isFile()) names.add(name);
  for (const name of EVALUATION_INPUTS) if ((await fs.stat(path.join(root, name)).catch(() => undefined))?.isFile()) names.add(name);
  const walk = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
      if (entry.isDirectory()) await walk(child);
      // These directories are the declared release input set. Include extensionless and
      // dot-example deployment files too; a filename extension is not a security boundary.
      else if (entry.isFile()) names.add(child);
    }
  };
  for (const directory of SOURCE_DIRS) await walk(directory);
  const files: Record<string, string> = {};
  const hash = createHash('sha256');
  for (const name of [...names].sort()) {
    const bytes = sourceBytes(name, await fs.readFile(path.join(root, name)));
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    files[name] = fileHash;
    hash.update(name).update('\0').update(fileHash).update('\n');
  }
  return { algorithm: 'sha256', fingerprint: hash.digest('hex'), files };
}
