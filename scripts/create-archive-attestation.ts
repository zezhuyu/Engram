import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { parseStrictJson } from './lib/strict-json.js';

export interface ArchiveAttestation {
  fingerprint: string;
  git_commit: string;
  archive_sha256: string;
  created_by: 'ci';
  created_at: string;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function createArchiveAttestation(root: string, archivePath: string, attestationPath: string): Promise<ArchiveAttestation> {
  const source = await currentSourceEvidence(root);
  if (source.treeState.state !== 'clean') throw new Error(`Refusing archive attestation for ${source.treeState.state} source tree${source.treeState.modified.length || source.treeState.untracked.length ? `: ${[...source.treeState.modified, ...source.treeState.untracked].slice(0, 20).join(', ')}` : ''}`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  if (commit !== source.treeState.commit) throw new Error('HEAD changed while creating the archive attestation');
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  await fs.mkdir(path.dirname(path.resolve(archivePath)), { recursive: true });
  await fs.writeFile(archivePath, archive);
  const attestation: ArchiveAttestation = { fingerprint: source.fingerprint, git_commit: commit, archive_sha256: sha256(archive), created_by: 'ci', created_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(path.resolve(attestationPath)), { recursive: true });
  await fs.writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
  return attestation;
}

export async function verifyArchiveAttestation(root: string, archivePath: string, attestationPath: string, expectedCommit: string): Promise<ArchiveAttestation> {
  const readRegularFile = async (file: string, label: string): Promise<Buffer> => {
    let info;
    try { info = await fs.lstat(file); } catch { throw new Error(`${label} is missing or unavailable`); }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink or directory`);
    try { return await fs.readFile(file); } catch { throw new Error(`${label} is missing or unavailable`); }
  };
  if (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(expectedCommit)) throw new Error('Expected commit is missing or invalid');
  const parsed = parseStrictJson((await readRegularFile(attestationPath, 'Archive attestation')).toString('utf8'), 'archive attestation') as Partial<ArchiveAttestation>;
  const keys = ['archive_sha256', 'created_at', 'created_by', 'fingerprint', 'git_commit'];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join('\0') !== keys.join('\0')) throw new Error('Archive attestation has an invalid shape');
  if (parsed.created_by !== 'ci' || !Number.isFinite(Date.parse(parsed.created_at ?? '')) || new Date(parsed.created_at!).toISOString() !== parsed.created_at || !/^[a-f0-9]{64}$/.test(parsed.fingerprint ?? '') || !/^[a-f0-9]{40,64}$/.test(parsed.git_commit ?? '') || !/^[a-f0-9]{64}$/.test(parsed.archive_sha256 ?? '')) throw new Error('Archive attestation has invalid field values');
  if (parsed.git_commit !== expectedCommit) throw new Error('Archive attestation commit does not match expected commit');
  if (sha256(await readRegularFile(archivePath, 'Archive')) !== parsed.archive_sha256) throw new Error('Archive SHA-256 does not match attestation');
  const source = await currentSourceEvidence(root);
  if (source.treeState.state !== 'no-git' || source.fingerprint !== parsed.fingerprint) throw new Error('Extracted source fingerprint does not match archive attestation');
  return parsed as ArchiveAttestation;
}

function option(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name} <path>`);
  return args[i + 1]!;
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'create') {
    const result = await createArchiveAttestation(process.cwd(), option(args, '--archive'), option(args, '--attestation'));
    console.log(JSON.stringify({ fingerprint: result.fingerprint, git_commit: result.git_commit, archive_sha256: result.archive_sha256 }));
  } else if (mode === 'verify') {
    const result = await verifyArchiveAttestation(option(args, '--root'), option(args, '--archive'), option(args, '--attestation'), option(args, '--commit'));
    console.log(JSON.stringify({ fingerprint: result.fingerprint, git_commit: result.git_commit, archive_sha256: result.archive_sha256 }));
  } else throw new Error('Usage: create-archive-attestation.js create --archive <path> --attestation <path> | verify --root <path> --archive <path> --attestation <path> --commit <git-sha>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
