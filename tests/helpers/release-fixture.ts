import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROFILE_REQUIREMENTS, type ReleaseProfileName, type TrustedProvenance } from '../../scripts/lib/release-policy.js';

export interface ReleaseFixture { root: string; provenance: TrustedProvenance; statuses: Record<string, string | undefined> }
export async function createReleaseFixture(): Promise<ReleaseFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-release-fixture-'));
  const provenance: TrustedProvenance = { fingerprint: 'f'.repeat(64), commit: 'a'.repeat(40), files: { 'packages/core/vault.ts': 'b'.repeat(64) } };
  const ids = new Set(Object.values(PROFILE_REQUIREMENTS).flatMap(profile => [...profile.requiredGateIds, ...profile.requiredMandatoryIds]));
  const core = new Set([...PROFILE_REQUIREMENTS['core-beta'].requiredGateIds, ...PROFILE_REQUIREMENTS['core-beta'].requiredMandatoryIds]);
  const statuses = Object.fromEntries([...ids].map(id => [id, core.has(id) ? 'PASS' : 'NOT_RUN'])) as Record<string, string | undefined>;
  await writeFile(path.join(root, 'release-gate-statuses.json'), `${JSON.stringify({ synthetic: true, fingerprint: provenance.fingerprint, git_commit: provenance.commit, statuses })}\n`);
  for (const name of ['release-capabilities.json', 'durability/report.json', 'suite/report.json', 'benchmarks/100k.json']) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ synthetic: true, fingerprint: provenance.fingerprint, git_commit: provenance.commit, evidenceSource: { files: provenance.files } })}\n`);
  }
  return { root, provenance, statuses };
}
export function setRequiredStatus(statuses: Record<string, string | undefined>, profile: ReleaseProfileName, id: string, status: string | undefined): void {
  if (PROFILE_REQUIREMENTS[profile].requiredGateIds.includes(id) || PROFILE_REQUIREMENTS[profile].requiredMandatoryIds.includes(id)) statuses[id] = status;
}
