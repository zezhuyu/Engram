import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, realpath, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allowedSkippedTestsForReport } from '../scripts/lib/suite-inventory.js';
import { getSkipClassification, skipClassificationHash, skipClassificationId } from '../scripts/lib/skip-classifications.js';
import { PROFILE_REQUIREMENTS, durabilityEvidenceStatus, sourceEvidenceMatches, performanceSourceMatches, suiteEvidenceStatus, suiteReportConsistent } from '../scripts/lib/release-policy.js';
import { assertSyntheticEvidenceAllowed, evaluateProfileGateStatuses, evaluateReleaseEvidence } from '../scripts/lib/release-evaluation.js';
import { createReleaseFixture } from './helpers/release-fixture.js';

const realVerification = path.resolve('verification');
async function releaseReportHash(): Promise<string> {
  try { return createHash('sha256').update(await readFile(path.join(realVerification, 'release-report.json'))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
}

test('explicit profile matrices nest, and Core fixture is eligible only for Core', async () => {
  const core = new Set([...PROFILE_REQUIREMENTS['core-beta'].requiredGateIds, ...PROFILE_REQUIREMENTS['core-beta'].requiredMandatoryIds]);
  const full = new Set([...PROFILE_REQUIREMENTS['full-intelligence-beta'].requiredGateIds, ...PROFILE_REQUIREMENTS['full-intelligence-beta'].requiredMandatoryIds]);
  const ga = new Set([...PROFILE_REQUIREMENTS.ga.requiredGateIds, ...PROFILE_REQUIREMENTS.ga.requiredMandatoryIds]);
  assert.notDeepEqual(PROFILE_REQUIREMENTS['core-beta'], PROFILE_REQUIREMENTS['full-intelligence-beta']);
  assert.notDeepEqual(PROFILE_REQUIREMENTS['full-intelligence-beta'], PROFILE_REQUIREMENTS.ga);
  assert.ok([...core].every(id => full.has(id)));
  assert.ok([...full].every(id => ga.has(id)));
  const fixture = await createReleaseFixture();
  const previous = process.env.MDB_RELEASE_FIXTURE;
  const cwd = process.cwd();
  process.env.MDB_RELEASE_FIXTURE = '1';
  process.chdir(fixture.root);
  try {
    assert.equal((await evaluateReleaseEvidence(fixture.root, 'core-beta', fixture.provenance)).eligible, true);
    assert.equal((await evaluateReleaseEvidence(fixture.root, 'full-intelligence-beta', fixture.provenance)).eligible, false);
    assert.equal((await evaluateReleaseEvidence(fixture.root, 'ga', fixture.provenance)).eligible, false);
  } finally { process.chdir(cwd); if (previous === undefined) delete process.env.MDB_RELEASE_FIXTURE; else process.env.MDB_RELEASE_FIXTURE = previous; await rm(fixture.root, { recursive: true, force: true }); }
});

test('every required gate and mandatory ID fails closed when removed or not PASS', () => {
  for (const [profile, requirements] of Object.entries(PROFILE_REQUIREMENTS) as Array<[keyof typeof PROFILE_REQUIREMENTS, typeof PROFILE_REQUIREMENTS[keyof typeof PROFILE_REQUIREMENTS]]>) {
    for (const id of [...requirements.requiredGateIds, ...requirements.requiredMandatoryIds]) {
      const statuses = Object.fromEntries([...requirements.requiredGateIds, ...requirements.requiredMandatoryIds].map(required => [required, 'PASS'])) as Record<string, string | undefined>;
      delete statuses[id];
      const verdict = evaluateProfileGateStatuses(profile, statuses);
      assert.equal(verdict.eligible, false, `${profile}/${id}`);
      assert.ok(verdict.notPass.includes(id), `${profile}/${id} must be reported non-PASS`);
    }
  }
});

const d2Scenarios = [
  ['core-beta-4','S1'],['core-beta-5','S2'],['core-beta-6','S3'],['core-beta-7','S4'],['core-beta-8','S5'],['core-beta-9','S6'],['core-beta-10','S7'],['core-beta-11','M1'],['core-beta-12','Q1'],['core-beta-13','X1'],['core-beta-14','S8'],['core-beta-15','P-1k'],['core-beta-16','P-10k'],['core-beta-17','P-100k'],['core-beta-18','QB-1k'],['core-beta-19','QB-10k'],['core-beta-20','QB-100k'],['core-beta-21','PB-keyword p95'],['core-beta-22','PB-grep p95'],['core-beta-23','PB-durable write p95'],['core-beta-24','REMOTE_CAPTURE'],['core-beta-25','AGENT_IDENTITY'],['core-beta-26','RELEASE_CAPABILITIES'],['core-beta-27','RELEASE_CAPABILITIES'],['core-beta-28','S9'],['core-beta-29','S8'],['core-beta-30','S9'],['core-beta-31','M1'],['core-beta-32','M1'],['core-beta-33','Q1'],['core-beta-34','Q1'],['core-beta-35','INVENTORY'],['core-beta-36','Q1'],
] as const;
test('all 33 prior D2 falsification scenarios fail their required gate; control passes', () => {
  assert.equal(d2Scenarios.length, 33);
  for (const [scenario, id] of d2Scenarios) {
    const statuses = Object.fromEntries([...PROFILE_REQUIREMENTS['core-beta'].requiredGateIds, ...PROFILE_REQUIREMENTS['core-beta'].requiredMandatoryIds].map(required => [required, 'PASS'])) as Record<string, string | undefined>;
    statuses[id] = 'NOT_RUN';
    const verdict = evaluateProfileGateStatuses('core-beta', statuses);
    assert.equal(verdict.eligible, false, scenario);
    assert.ok(verdict.notPass.includes(id), scenario);
  }
  assert.equal(evaluateProfileGateStatuses('core-beta', Object.fromEntries([...PROFILE_REQUIREMENTS['core-beta'].requiredGateIds, ...PROFILE_REQUIREMENTS['core-beta'].requiredMandatoryIds].map(id => [id, 'PASS']))).eligible, true);
});

test('suite provenance binds fingerprint and commit; mandatory skipped tests require reviewed platform allow-list', () => {
  const name = 'real model: wiki synthesis and critic return schema-valid, evidence-bound, review-gated output';
  const classification = getSkipClassification(`intelligence/${name}`)!;
  const classificationId = skipClassificationId(classification.suite, classification.test);
  const inventory = { minimumTests: 1, requiredTests: [name], requiredCases: [], casesByPlatform: { linux: [] }, allowedSkippedTests: { linux: [{ name, classificationId, classificationHash: skipClassificationHash(classification) }] } };
  const report = { suite: 'intelligence', status: 'PASS', exitCode: 0, counts: { pass: 0, fail: 0, skipped: 1, total: 1 }, tests: [{ name, status: 'SKIPPED' }], cases: 0, caseDetails: [], caseFailures: [], environment: { platform: 'linux' } };
  assert.equal(suiteReportConsistent(report, inventory), false, 'pending-owner-review is rejected by default');
  assert.equal(suiteReportConsistent(report, inventory, true), false, 'a mandatory skipped test is never PASS evidence, even with a local pending-classification allowance');
  assert.equal(suiteEvidenceStatus(report), 'SKIPPED');
  assert.equal(suiteReportConsistent(report, { ...inventory, allowedSkippedTests: {} }), false);
  assert.deepEqual(allowedSkippedTestsForReport({ suite: 'intelligence', environment: { platform: 'linux' }, tests: [{ name, status: 'SKIPPED', detail: 'set MDB_REAL_MODEL_TEST=1 to run' }] }), [{ name, classificationId, classificationHash: skipClassificationHash(classification) }]);
  assert.throws(() => allowedSkippedTestsForReport({ suite: 'intelligence', environment: { platform: 'linux' }, tests: [{ name: 'new skip', status: 'SKIPPED' }] }), /unreviewed skipped test/);
  const provenance = { fingerprint: 'f'.repeat(64), commit: 'a'.repeat(40) };
  const base = { fingerprint: provenance.fingerprint, git_commit: provenance.commit, evidenceSource: { files: { x: 'y' } } };
  assert.equal(sourceEvidenceMatches(base, { x: 'y' }, provenance), true);
  assert.equal(sourceEvidenceMatches({ ...base, git_commit: 'c'.repeat(40) }, { x: 'y' }, provenance), false);
  assert.equal(sourceEvidenceMatches({ ...base, fingerprint: undefined }, { x: 'y' }, provenance), false);
  const binding = { fingerprint: provenance.fingerprint, workingTreeSourceFingerprint: provenance.fingerprint, fullSourceFileCount: 1, files: { x: 'y' }, git_commit: provenance.commit };
  assert.equal(performanceSourceMatches(binding, { fingerprint: provenance.fingerprint, files: { x: 'y' } }, ['x'], provenance), true);
  assert.equal(performanceSourceMatches({ ...binding, commit: undefined, git_commit: undefined }, { fingerprint: provenance.fingerprint, files: { x: 'y' } }, ['x'], provenance), false);
});

test('S9 requires fresh passing QEMU points, EIO recovery, full source and exact commit', async () => {
  const fixture = await createReleaseFixture();
  const valid = {
    status: 'PASS', run_at: new Date().toISOString(),
    fingerprint: fixture.provenance.fingerprint, git_commit: fixture.provenance.commit,
    acceptedImplementationCommit: fixture.provenance.commit,
    evidenceSource: { fingerprint: fixture.provenance.fingerprint, files: fixture.provenance.files },
    results: { isolated_linux_vm_power_cut: { status: 'PASS', points: [1, 2, 3].map(() => ({ acknowledgedSurvived: true, verify: true, repeatedRecoveryStable: true })) }, actual_kernel_fsync_eio: { status: 'PASS', nodeReceived: 'EIO', postErrorRecoveryVerify: true } },
  };
  try {
    assert.equal(durabilityEvidenceStatus(valid, fixture.provenance), 'PASS');
    assert.equal(durabilityEvidenceStatus(undefined, fixture.provenance), 'NOT_RUN');
    assert.equal(durabilityEvidenceStatus({ ...valid, run_at: '2000-01-01T00:00:00Z' }, fixture.provenance), 'NOT_RUN');
    assert.equal(durabilityEvidenceStatus({ ...valid, results: { ...valid.results, isolated_linux_vm_power_cut: { status: 'PASS', points: [] } } }, fixture.provenance), 'NOT_RUN');
    assert.equal(durabilityEvidenceStatus({ ...valid, results: { ...valid.results, actual_kernel_fsync_eio: { status: 'FAIL', nodeReceived: 'EIO', postErrorRecoveryVerify: false } } }, fixture.provenance), 'FAIL');
    assert.equal(durabilityEvidenceStatus({ ...valid, git_commit: 'c'.repeat(40) }, fixture.provenance), 'NOT_RUN');
    assert.equal(durabilityEvidenceStatus({ ...valid, fingerprint: 'c'.repeat(64) }, fixture.provenance), 'NOT_RUN');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('synthetic evidence is accepted only from an opted-in temp fixture; real verification remains byte-identical', async () => {
  const before = await releaseReportHash();
  const fixture = await createReleaseFixture();
  const previous = process.env.MDB_RELEASE_FIXTURE;
  const cwd = process.cwd();
  try {
    process.chdir(fixture.root);
    delete process.env.MDB_RELEASE_FIXTURE;
    await assert.rejects(assertSyntheticEvidenceAllowed(fixture.root), /temporary release fixtures require MDB_RELEASE_FIXTURE=1|synthetic evidence rejected/);
    process.env.MDB_RELEASE_FIXTURE = '1';
    await assert.doesNotReject(assertSyntheticEvidenceAllowed(fixture.root));
    process.chdir(cwd);
    const tempParent = await mkdtemp(path.join(os.tmpdir(), 'engram-release-guard-test-'));
    const fakeTemp = path.join(tempParent, 'temp');
    const outside = path.join(tempParent, 'outside');
    try {
      await Promise.all([mkdir(fakeTemp), mkdir(outside)]);
      await writeFile(path.join(outside, 'record.json'), '{"synthetic":true}');
      await assert.rejects(assertSyntheticEvidenceAllowed(outside, realpath, [fakeTemp]), /synthetic evidence rejected/);
      await writeFile(path.join(outside, 'nested.json'), JSON.stringify({ wrapper: { evidence: [{ synthetic: true }] } }));
      await assert.rejects(assertSyntheticEvidenceAllowed(outside, realpath, [fakeTemp]), /synthetic evidence rejected/);
      await writeFile(path.join(fakeTemp, 'record.json'), '{"synthetic":true}');
      process.chdir(fakeTemp);
      await assert.doesNotReject(assertSyntheticEvidenceAllowed(fakeTemp, realpath, [fakeTemp]));
      process.chdir(cwd);
      await assert.rejects(async () => { try { await writeFile(path.join(outside, 'aborted.json'), 'temporary'); throw new Error('injected abort'); } finally { await rm(path.join(outside, 'aborted.json'), { force: true }); } }, /injected abort/);
      assert.deepEqual((await readdir(outside)).sort(), ['nested.json', 'record.json']);
      process.chdir(outside);
      await assert.rejects(evaluateReleaseEvidence(outside, 'core-beta', fixture.provenance, undefined, [fakeTemp]), /synthetic evidence rejected/);
      process.chdir(cwd);
    } finally { await rm(tempParent, { recursive: true, force: true }); await assert.rejects(access(tempParent), { code: 'ENOENT' }); }
    process.chdir(cwd);
    const after = await releaseReportHash();
    assert.equal(after, before);
  } finally { process.chdir(cwd); if (previous === undefined) delete process.env.MDB_RELEASE_FIXTURE; else process.env.MDB_RELEASE_FIXTURE = previous; await rm(fixture.root, { recursive: true, force: true }); }
});

test('synthetic fixture paths are canonicalized across temp aliases and fail closed', async t => {
  const fixture = await createReleaseFixture();
  const previous = process.env.MDB_RELEASE_FIXTURE;
  const cwd = process.cwd();
  process.env.MDB_RELEASE_FIXTURE = '1';
  try {
    process.chdir(fixture.root);
    // createReleaseFixture uses mkdtemp(os.tmpdir()), matching the default macOS TMPDIR spelling.
    const canonicalRoot = await realpath(fixture.root);
    const aliasRoot = canonicalRoot.replace(/^\/private\/var\/folders\//, '/var/folders/');
    await assert.doesNotReject(assertSyntheticEvidenceAllowed(fixture.root));
    await assert.doesNotReject(assertSyntheticEvidenceAllowed(canonicalRoot));

    await t.test('existing /var temp alias canonicalizes to /private/var', async aliasTest => {
      if (aliasRoot === canonicalRoot) {
        aliasTest.skip('fixture path has no /private/var spelling to check');
        return;
      }
      let resolvedAlias: string;
      try { resolvedAlias = await realpath(aliasRoot); }
      catch { aliasTest.skip('the /var temp alias does not exist on this host'); return; }
      if (resolvedAlias !== canonicalRoot) {
        aliasTest.skip(`/var alias resolves to ${resolvedAlias}, not the canonical fixture`);
        return;
      }
      await assert.doesNotReject(assertSyntheticEvidenceAllowed(aliasRoot));
      process.chdir(aliasRoot);
      await assert.doesNotReject(assertSyntheticEvidenceAllowed(aliasRoot));
    });

    // Exercise both the evidence root and working directory through the canonical spelling.
    process.chdir(canonicalRoot);
    await assert.doesNotReject(assertSyntheticEvidenceAllowed(fixture.root));
    const actualTmp = await realpath(os.tmpdir());
    const parent = await mkdtemp(path.join(actualTmp, 'engram-guard-'));
    const fakeTmp = path.join(parent, 'tmp');
    const sibling = path.join(parent, 'tmp-evil');
    const outside = path.join(parent, 'outside');
    await Promise.all([mkdir(fakeTmp), mkdir(sibling), mkdir(outside)]);
    await writeFile(path.join(outside, 'record.json'), '{"synthetic":true}');
    const previousTmpdir = os.tmpdir;
    try {
      // Substitute a private temp base so the production canonical containment check
      // is exercised without creating a sibling of the machine's real temp directory.
      os.tmpdir = () => fakeTmp;
      process.chdir(fakeTmp);
      await writeFile(path.join(fakeTmp, 'record.json'), '{"synthetic":true}');
      await writeFile(path.join(sibling, 'record.json'), '{"synthetic":true}');
      await assert.doesNotReject(assertSyntheticEvidenceAllowed(fakeTmp));
      await symlink(fakeTmp, path.join(parent, 'tmp-alias'), 'dir');
      await symlink(outside, path.join(fakeTmp, 'escape'), 'dir');
      await assert.rejects(assertSyntheticEvidenceAllowed(sibling, realpath, [fakeTmp]), /synthetic evidence rejected/,
        'a sibling directory with the trusted base as a string prefix is outside the trusted base');
      await assert.rejects(assertSyntheticEvidenceAllowed(path.join(fakeTmp, '..', 'outside'), realpath, [fakeTmp]), /synthetic evidence rejected/,
        'parent traversal cannot escape a trusted base');
      await assert.rejects(assertSyntheticEvidenceAllowed(path.join(parent, 'tmp-alias')), /symlink evidence root/);
      await assert.rejects(assertSyntheticEvidenceAllowed(path.join(fakeTmp, 'escape')), /symlink (?:evidence root|in evidence tree)/);

      const resolveWithCanonicalizationFailure = (async (candidate: Parameters<typeof realpath>[0]) => {
        if (path.resolve(candidate.toString()) === path.resolve(fakeTmp)) throw new Error('canonical path unavailable');
        return realpath(candidate);
      }) as typeof realpath;
      await assert.rejects(assertSyntheticEvidenceAllowed(fakeTmp, resolveWithCanonicalizationFailure), /synthetic evidence rejected|symlink/);
    } finally {
      os.tmpdir = previousTmpdir;
      process.chdir(canonicalRoot);
      await rm(parent, { recursive: true, force: true });
    }

    process.chdir(canonicalRoot);
    await assert.rejects(assertSyntheticEvidenceAllowed(fixture.root, async () => { throw new Error('realpath denied'); }), /synthetic evidence rejected/);
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.MDB_RELEASE_FIXTURE; else process.env.MDB_RELEASE_FIXTURE = previous;
    await rm(fixture.root, { recursive: true, force: true });
  }
});
