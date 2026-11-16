import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSuiteStatus, mandatorySuitesEffectivePass, suiteDerivedGateStatus, suiteEvidenceStatus, type SuiteEvidenceLike, type SuiteInventory } from '../../scripts/lib/release-policy.js';
import { allSkipClassifications, getSkipClassification, skipClassificationHash, skipClassificationId, type SkipClassification } from '../../scripts/lib/skip-classifications.js';

const platformSkip = getSkipClassification('adaptive/launchd plist is well-formed (plutil -lint on macOS), runs only the explicit worker command, and escapes special characters')!;
const gnuSkip = getSkipClassification('unix/awk: gawk --sandbox runs programs but cannot run commands, redirect, pipe, or read program files')!;
const realModelSkip = getSkipClassification('wiki/real model: incremental wiki compilation obeys the safety gates (and we record whether it also complied with the citation rules)')!;
const realHostSkip = getSkipClassification('memory/real Claude Code: hooks installed by the adapter capture a real task; another principal recalls it; the host works with MDB broken or absent')!;

function fixture(classification: SkipClassification, platform = classification.platforms[0]!) {
  const name = classification.test;
  const report: SuiteEvidenceLike = {
    suite: classification.suite, status: 'SKIPPED', exitCode: 0,
    counts: { pass: 1, fail: 0, skipped: 1, total: 2 },
    tests: [{ name: 'covered test', status: 'PASS' }, { name, status: 'SKIPPED' }],
    cases: 1, caseDetails: [{ name: 'case-a', status: 'PASS' }], caseFailures: [],
    environment: { platform }, treeState: 'clean', fingerprint: 'fixture-fingerprint', commit: 'fixture-commit',
    evidenceSource: { files: { 'fixture.ts': 'a'.repeat(64) } }
  };
  const inventory: SuiteInventory = {
    minimumTests: 2, requiredTests: ['covered test', name], requiredCases: ['case-a'],
    casesByPlatform: { [platform]: ['case-a'] },
    allowedSkippedTests: { [platform]: [{ name, classificationId: skipClassificationId(classification.suite, name), classificationHash: skipClassificationHash(classification) }] }
  };
  const context = { currentFiles: { 'fixture.ts': 'a'.repeat(64) }, trusted: { fingerprint: 'fixture-fingerprint', commit: 'fixture-commit' } };
  return { report, inventory, context };
}

const status = (value: ReturnType<typeof fixture>, registry?: { get: typeof getSkipClassification; hash: typeof skipClassificationHash }) => effectiveSuiteStatus(value.report, value.inventory, { ...value.context, registry });

test('reviewed platform-specific skip on its platform is effective PASS', () => {
  const value = fixture(platformSkip, 'linux');
  assert.equal(status(value), 'PASS');
  const { report } = value;
  assert.equal(suiteEvidenceStatus(report), 'SKIPPED', 'the suite report remains unchanged');
});

test('reviewed GNU-tool skip on macOS is effective PASS', () => {
  assert.equal(status(fixture(gnuSkip, 'darwin')), 'PASS');
});

test('same classification on the wrong platform remains blocking', () => {
  assert.equal(status(fixture(platformSkip, 'darwin')), 'SKIPPED');
});

test('reviewed real-model skip remains blocking', () => {
  assert.equal(status(fixture(realModelSkip)), 'SKIPPED');
});

test('reviewed real-host skip remains blocking', () => {
  assert.equal(status(fixture(realHostSkip, 'darwin')), 'SKIPPED');
});

test('pending-owner-review classification remains blocking', () => {
  const pending = { ...platformSkip, reviewedBy: 'pending-owner-review' };
  const value = fixture(pending, 'linux');
  const registry = { get: (id: string) => id === skipClassificationId(pending.suite, pending.test) ? pending : getSkipClassification(id), hash: skipClassificationHash };
  value.inventory.allowedSkippedTests!.linux![0]!.classificationHash = skipClassificationHash(pending);
  assert.equal(status(value, registry), 'SKIPPED');
});

test('classification edited after inventory hash was recorded remains blocking', () => {
  const value = fixture(platformSkip, 'linux');
  const edited = { ...platformSkip, reason: `${platformSkip.reason} edited` };
  const registry = { get: (id: string) => id === skipClassificationId(edited.suite, edited.test) ? edited : getSkipClassification(id), hash: skipClassificationHash };
  assert.equal(status(value, registry), 'SKIPPED');
});

test('dirty-tree or stale-source skip report remains blocking', () => {
  const value = fixture(platformSkip, 'linux');
  assert.equal(effectiveSuiteStatus({ ...value.report, treeState: 'dirty' }, value.inventory, value.context), 'SKIPPED');
  assert.equal(effectiveSuiteStatus({ ...value.report, evidenceSource: { files: { 'fixture.ts': 'b'.repeat(64) } } }, value.inventory, value.context), 'SKIPPED');
});

test('inventory missing the allowed-skip entry remains blocking', () => {
  const value = fixture(platformSkip, 'linux');
  value.inventory.allowedSkippedTests = { linux: [] };
  assert.equal(status(value), 'SKIPPED');
});

test('skip for a test not in the registry remains blocking', () => {
  const value = fixture(platformSkip, 'linux');
  const { report, inventory } = value;
  report.tests![1]!.name = 'unregistered test';
  inventory.requiredTests[1] = 'unregistered test';
  inventory.allowedSkippedTests!.linux![0]!.name = 'unregistered test';
  assert.equal(status(value), 'SKIPPED');
});

test('FAIL status or nonzero exit remains blocking', () => {
  const value = fixture(platformSkip, 'linux');
  assert.equal(effectiveSuiteStatus({ ...value.report, status: 'FAIL', exitCode: 1 }, value.inventory), 'FAIL');
  assert.equal(status({ ...value, report: { ...value.report, exitCode: 1 } }), 'SKIPPED');
});

test('one acceptable skip mixed with a blocking skip remains blocking', () => {
  const value = fixture(platformSkip, 'linux');
  const { report, inventory } = value;
  const blocking = realModelSkip;
  report.tests!.push({ name: blocking.test, status: 'SKIPPED' });
  report.counts = { pass: 1, fail: 0, skipped: 2, total: 3 };
  inventory.minimumTests = 3;
  inventory.requiredTests.push(blocking.test);
  inventory.allowedSkippedTests!.linux!.push({ name: blocking.test, classificationId: skipClassificationId(blocking.suite, blocking.test), classificationHash: skipClassificationHash(blocking) });
  assert.equal(status(value), 'SKIPPED');
});

test('INVENTORY and DREAM_SCHEDULER gate construction use reviewed effective status', () => {
  const value = fixture(platformSkip, 'linux');
  assert.equal(mandatorySuitesEffectivePass(['adaptive'], { adaptive: value.report }, { adaptive: value.inventory }, value.context.currentFiles, value.context.trusted), true);
  assert.equal(suiteDerivedGateStatus(value.report, value.inventory, value.context.currentFiles, value.context.trusted, ['PASS']), 'PASS');
  const blocked = fixture(realModelSkip);
  assert.equal(mandatorySuitesEffectivePass(['wiki'], { wiki: blocked.report }, { wiki: blocked.inventory }, blocked.context.currentFiles, blocked.context.trusted), false);
  assert.equal(suiteDerivedGateStatus(blocked.report, blocked.inventory, blocked.context.currentFiles, blocked.context.trusted, ['PASS']), 'INCOMPLETE');
});

test('registry fixture classifications cover all existing release skip classes', () => {
  assert.ok(allSkipClassifications().some(entry => entry.class === 'platform-specific'));
  assert.ok(allSkipClassifications().some(entry => entry.class === 'gnu-tools'));
});
