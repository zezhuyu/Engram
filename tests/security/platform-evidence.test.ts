import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MANDATORY_SUITE_NAMES } from '../../scripts/lib/suite-inventory.js';
import { skipClassificationHash, skipClassificationId } from '../../scripts/lib/skip-classifications.js';
import { aggregatePlatformEvidence, currentPlatformEvidence, loadPlatformEvidence, type PlatformEvidenceContext } from '../../scripts/lib/platform-evidence.js';
import type { TrustedProvenance } from '../../scripts/lib/release-policy.js';
import type { SuiteReport } from '../../scripts/lib/suite.js';

const provenance: TrustedProvenance = { fingerprint: 'f'.repeat(64), commit: 'a'.repeat(40), files: { 'src.ts': 'b'.repeat(64) } };
const context: PlatformEvidenceContext = { trusted: provenance, inventories: {} };
for (const suite of MANDATORY_SUITE_NAMES) context.inventories[suite] = { minimumTests: 1, requiredTests: [`${suite}-test`], requiredCases: [`${suite}-case`], casesByPlatform: { darwin: [`${suite}-case`], linux: [`${suite}-case`] }, allowedSkippedTests: { darwin: [], linux: [] } };

async function fixture(platform = 'darwin') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-platform-evidence-'));
  const dir = path.join(root, 'reports'); const platformDir = path.join(dir, platform);
  await mkdir(platformDir, { recursive: true });
  for (const suite of MANDATORY_SUITE_NAMES) await writeReport(platformDir, suite, platform, {});
  return { root, dir, platformDir };
}
async function writeReport(base: string, suite: string, platform: string, changes: Record<string, unknown>) {
  const inventory = context.inventories[suite]!;
  const report = {
    suite, git_commit: provenance.commit, treeState: 'clean', status: 'PASS', exitCode: 0, run_at: new Date().toISOString(),
    evidenceSource: { fingerprint: provenance.fingerprint, files: provenance.files },
    environment: { platform }, counts: { pass: 1, fail: 0, skipped: 0, total: 1 },
    tests: [{ name: inventory.requiredTests[0], status: 'PASS' }], cases: 1, caseFailures: [], caseDetails: [{ name: inventory.casesByPlatform?.[platform]?.[0], status: 'PASS' }],
    ...changes,
  };
  const target = path.join(base, suite); await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'report.json'), JSON.stringify(report));
}
async function withFixture(fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, platform = 'darwin') {
  const f = await fixture(platform); try { await fn(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}

test('valid imported reports pass and supported-platform aggregation requires every platform', async () => withFixture(async f => {
  const imported = await loadPlatformEvidence(f.dir, 'darwin', context);
  assert.equal(imported.status, 'PASS'); assert.equal(imported.suites.length, 13);
  const currentReports = Object.fromEntries(MANDATORY_SUITE_NAMES.map(suite => {
    const inventory = context.inventories[suite]!;
    return [suite, {
      suite, git_commit: provenance.commit, treeState: 'clean', status: 'PASS', exitCode: 0,
      evidenceSource: { fingerprint: provenance.fingerprint, files: provenance.files }, environment: { platform: 'linux' },
      counts: { pass: 1, fail: 0, skipped: 0, total: 1 }, tests: [{ name: inventory.requiredTests[0], status: 'PASS' }],
      cases: 1, caseFailures: [], caseDetails: [{ name: inventory.casesByPlatform?.linux?.[0], status: 'PASS' }],
    }];
  }));
  const current = currentPlatformEvidence('linux', currentReports as unknown as Record<string, SuiteReport | undefined>, context);
  assert.equal(current.status, 'PASS');
  assert.equal(aggregatePlatformEvidence([current, imported]), 'PASS');
  assert.equal(aggregatePlatformEvidence([imported, imported]), 'FAIL', 'duplicate platform directory keys are invalid');
  assert.equal(aggregatePlatformEvidence([imported, { ...imported, platform: 'linux', status: 'NOT_RUN' }]), 'NOT_RUN');
  assert.equal(aggregatePlatformEvidence([imported, { ...imported, platform: 'linux', status: 'FAIL' }]), 'FAIL');
}));

test('wrong commit, fingerprint, report platform, and dirty tree fail closed', async () => withFixture(async f => {
  const targets = [
    { git_commit: 'c'.repeat(40) },
    { evidenceSource: { fingerprint: 'd'.repeat(64), files: provenance.files } },
    { environment: { platform: 'linux' } },
    { treeState: 'dirty' },
  ];
  for (const change of targets) {
    await writeReport(f.platformDir, 'acid', 'darwin', change);
    assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
    await writeReport(f.platformDir, 'acid', 'darwin', {});
  }
  assert.equal((await loadPlatformEvidence(f.dir, 'linux', context)).status, 'NOT_RUN');
}));

test('missing suite, missing directory, tampered counts, and failing tests are distinguished', async () => withFixture(async f => {
  await rm(path.join(f.platformDir, 'unix'), { recursive: true });
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'NOT_RUN');
  await mkdir(path.join(f.platformDir, 'unix'));
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'NOT_RUN');
  await writeReport(f.platformDir, 'unix', 'darwin', { counts: { pass: 0, fail: 0, skipped: 0, total: 1 } });
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
  await writeReport(f.platformDir, 'unix', 'darwin', { tests: [{ name: 'unix-test', status: 'FAIL' }], counts: { pass: 0, fail: 1, skipped: 0, total: 1 }, caseFailures: ['failed'] });
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
}));

test('real-model skips remain INCOMPLETE while reviewed GNU-tool skips pass only with platform inventory binding', async () => withFixture(async f => {
  const real = Object.values((await import('../../scripts/lib/skip-classifications.js')).allSkipClassifications()).find(item => item.class === 'real-model' && item.platforms.includes('darwin'))!;
  const gnu = Object.values((await import('../../scripts/lib/skip-classifications.js')).allSkipClassifications()).find(item => item.class === 'gnu-tools' && item.platforms.includes('darwin') && item.reviewedBy !== 'pending-owner-review')!;
  assert.notEqual(real.suite, gnu.suite);
  const installSkip = async (item: NonNullable<typeof real>, suite: string) => {
    const inv = context.inventories[suite]!; const allowed = { name: item.test, classificationId: skipClassificationId(item.suite, item.test), classificationHash: skipClassificationHash(item) };
    const testNames = [item.test]; inv.minimumTests = 1; inv.requiredTests = testNames; inv.allowedSkippedTests = { darwin: [allowed], linux: [] };
    await writeReport(f.platformDir, suite, 'darwin', { suite: item.suite, status: 'SKIPPED', counts: { pass: 0, fail: 0, skipped: 1, total: 1 }, tests: [{ name: item.test, status: 'SKIPPED' }] });
  };
  await installSkip(real, real.suite);
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'INCOMPLETE');
  context.inventories[real.suite] = { minimumTests: 1, requiredTests: [`${real.suite}-test`], requiredCases: [`${real.suite}-case`], casesByPlatform: { darwin: [`${real.suite}-case`], linux: [`${real.suite}-case`] }, allowedSkippedTests: { darwin: [], linux: [] } };
  await writeReport(f.platformDir, real.suite, 'darwin', {});
  await installSkip(gnu, gnu.suite);
  const gnuResult = await loadPlatformEvidence(f.dir, 'darwin', context);
  assert.equal(gnuResult.status, 'PASS', JSON.stringify(gnuResult.suites.filter(item => item.status !== 'PASS')));
  context.inventories[gnu.suite]!.allowedSkippedTests = { darwin: [], linux: [] };
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
  // Restore shared fixture inventory for later tests.
  context.inventories[real.suite] = { minimumTests: 1, requiredTests: [`${real.suite}-test`], requiredCases: [`${real.suite}-case`], casesByPlatform: { darwin: [`${real.suite}-case`], linux: [`${real.suite}-case`] }, allowedSkippedTests: { darwin: [], linux: [] } };
  context.inventories[gnu.suite] = { minimumTests: 1, requiredTests: [`${gnu.suite}-test`], requiredCases: [`${gnu.suite}-case`], casesByPlatform: { darwin: [`${gnu.suite}-case`], linux: [`${gnu.suite}-case`] }, allowedSkippedTests: { darwin: [], linux: [] } };
}));

test('oversized and symlinked reports are rejected', async () => withFixture(async f => {
  const report = path.join(f.platformDir, 'acid', 'report.json');
  await writeFile(report, ' '.repeat(8 * 1024 * 1024 + 1));
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
  await rm(report); await writeFile(path.join(f.root, 'target.json'), '{}'); await symlink(path.join(f.root, 'target.json'), report);
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
  const linkDir = path.join(f.root, 'darwin'); await symlink(f.platformDir, linkDir);
  assert.equal((await loadPlatformEvidence(f.root, 'darwin', context)).status, 'FAIL');
}));

test('suite identities cannot be duplicated or substituted', async () => withFixture(async f => {
  await writeReport(f.platformDir, 'acid', 'darwin', { suite: 'security' });
  assert.equal((await loadPlatformEvidence(f.dir, 'darwin', context)).status, 'FAIL');
}));
