import { readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requiredGateStatuses, type ReleaseProfileName, type TrustedProvenance } from './release-policy.js';

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

export async function assertSyntheticEvidenceAllowed(evidenceRoot: string, resolvePath: typeof realpath = realpath, tempBase = os.tmpdir()): Promise<void> {
  const root = path.resolve(evidenceRoot);
  const underTemp = await canonicalPathUnder(evidenceRoot, tempBase, resolvePath);
  const cwdUnderTemp = await canonicalPathUnder(process.cwd(), tempBase, resolvePath);
  const fixture = process.env.MDB_RELEASE_FIXTURE === '1' && underTemp && cwdUnderTemp;
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
          const containsSynthetic = (item: unknown): boolean => {
            if (!item || typeof item !== 'object') return false;
            if (!Array.isArray(item) && (item as { synthetic?: unknown }).synthetic === true) return true;
            return Object.values(item).some(containsSynthetic);
          };
          if (containsSynthetic(value) && !fixture) throw new Error(`synthetic evidence rejected: ${path.relative(root, file)}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('synthetic evidence rejected:')) throw error;
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
export async function evaluateReleaseEvidence(evidenceRoot: string, profile: ReleaseProfileName, provenance: TrustedProvenance, suppliedStatuses?: Record<string, string | undefined>, tempBase = os.tmpdir()): Promise<ProfileEvaluation> {
  if (!provenance.fingerprint || !provenance.commit || !Object.keys(provenance.files).length) throw new Error('trusted provenance is incomplete');
  await assertSyntheticEvidenceAllowed(evidenceRoot, realpath, tempBase);
  let gateStatuses = suppliedStatuses;
  if (!gateStatuses) {
    const record = JSON.parse(await readFile(path.join(evidenceRoot, 'release-gate-statuses.json'), 'utf8')) as { fingerprint?: string; git_commit?: string; statuses?: Record<string, string | undefined> };
    if (record.fingerprint !== provenance.fingerprint || record.git_commit !== provenance.commit || !record.statuses) throw new Error('gate-status evidence provenance does not match the trusted candidate');
    gateStatuses = record.statuses;
  }
  return evaluateProfileGateStatuses(profile, gateStatuses);
}
