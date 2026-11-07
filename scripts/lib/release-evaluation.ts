import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { requiredGateStatuses, type ReleaseProfileName, type TrustedProvenance } from './release-policy.js';
import { parseStrictJson } from './strict-json.js';

export interface GateStatus { id: string; status: string }
export interface ProfileEvaluation { eligible: boolean; profile: ReleaseProfileName; requiredGates: GateStatus[]; notPass: string[] }

async function canonicalPathUnder(candidate: string, parent: string, resolvePath: typeof realpath = realpath): Promise<boolean> {
  try {
    const [canonicalCandidate, canonicalParent] = await Promise.all([resolvePath(candidate), resolvePath(parent)]);
    const relative = path.relative(canonicalParent, canonicalCandidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  } catch {
    return false;
  }
}

export async function trustedTempBases(resolvePath: typeof realpath, testBases?: readonly string[]): Promise<string[]> {
  const candidates = testBases ? [...testBases] : ['/tmp', '/private/tmp', '/var/tmp'];
  if (!testBases && process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) candidates.push(result.stdout.trim());
  }
  return (await Promise.all(candidates.map(async candidate => { try { return await resolvePath(candidate); } catch { return undefined; } }))).filter((item): item is string => !!item);
}
export async function assertSyntheticEvidenceAllowed(evidenceRoot: string, resolvePath: typeof realpath = realpath, trustedBasesForTests?: readonly string[]): Promise<void> {
  const root = path.resolve(evidenceRoot);
  try { if ((await lstat(root)).isSymbolicLink()) throw new Error(`symlink evidence root: ${root}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const bases = await trustedTempBases(resolvePath, trustedBasesForTests);
  const trusted = async (candidate: string) => { for (const base of bases) if (await canonicalPathUnder(candidate, base, resolvePath)) return true; return false; };
  let escapedTempSymlink = false;
  if (process.env.TMPDIR) {
    if (!path.isAbsolute(process.env.TMPDIR)) escapedTempSymlink = true;
    else try { const stat = await lstat(process.env.TMPDIR); if (stat.isSymbolicLink() && !await trusted(process.env.TMPDIR)) escapedTempSymlink = true; } catch { /* missing TMPDIR cannot grant trust */ }
  }
  const fixture = process.env.MDB_RELEASE_FIXTURE === '1' && !escapedTempSymlink && await trusted(evidenceRoot) && await trusted(process.cwd());
  async function visit(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { throw new Error(`cannot read evidence directory ${dir}: ${(error as Error).message}`); }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in evidence tree: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        {
          const value = parseStrictJson(await readFile(file, 'utf8'), file) as unknown;
          const containsSynthetic = (item: unknown): boolean => {
            if (!item || typeof item !== 'object') return false;
            if (!Array.isArray(item) && (item as { synthetic?: unknown }).synthetic === true) return true;
            return Object.values(item).some(containsSynthetic);
          };
          if (containsSynthetic(value) && !fixture) throw new Error(`synthetic evidence rejected: ${path.relative(root, file)}`);
        }
      }
    }
  }
  await visit(root);
}

/** Shared ID-level eligibility evaluator. Missing and unknown requested IDs fail closed as NOT_RUN. */
export function evaluateProfileGateStatuses(profile: ReleaseProfileName, statuses: Record<string, string | undefined>): ProfileEvaluation {
  const requiredGates = requiredGateStatuses(profile, statuses);
  const notPass = requiredGates.filter(gate => gate.status !== 'PASS').map(gate => gate.id);
  return { eligible: notPass.length === 0, profile, requiredGates, notPass };
}

/** Testable evidence-root entry point; validates the fixture trust boundary and evaluates supplied machine gate evidence. */
export async function evaluateReleaseEvidence(evidenceRoot: string, profile: ReleaseProfileName, provenance: TrustedProvenance, suppliedStatuses?: Record<string, string | undefined>, trustedBasesForTests?: readonly string[]): Promise<ProfileEvaluation> {
  if (!provenance.fingerprint || !provenance.commit || !Object.keys(provenance.files).length) throw new Error('trusted provenance is incomplete');
  await assertSyntheticEvidenceAllowed(evidenceRoot, realpath, trustedBasesForTests);
  let gateStatuses = suppliedStatuses;
  if (!gateStatuses) {
    const record = parseStrictJson(await readFile(path.join(evidenceRoot, 'release-gate-statuses.json'), 'utf8'), 'release gate statuses') as { fingerprint?: string; git_commit?: string; statuses?: Record<string, string | undefined> };
    if (record.fingerprint !== provenance.fingerprint || record.git_commit !== provenance.commit || !record.statuses) throw new Error('gate-status evidence provenance does not match the trusted candidate');
    gateStatuses = record.statuses;
  }
  return evaluateProfileGateStatuses(profile, gateStatuses);
}
