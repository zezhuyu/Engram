import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedSkippedTestsForReport, buildSuiteInventoryForReport, inventoryDrift, inventoryReportUsable } from '../../scripts/lib/suite-inventory.js';
import { suiteReportConsistent, type SuiteInventory } from '../../scripts/lib/release-policy.js';
import { getSkipClassification, skipClassificationHash, skipClassificationId } from '../../scripts/lib/skip-classifications.js';

const knownSkip = getSkipClassification('intelligence/real model: wiki synthesis and critic return schema-valid, evidence-bound, review-gated output')!;
const knownSkipId = skipClassificationId(knownSkip.suite, knownSkip.test);
const knownSkipHash = skipClassificationHash(knownSkip);

const inventory: SuiteInventory = {
  minimumTests: 2,
  requiredTests: ['first test', knownSkip.test],
  requiredCases: ['security/case-a'],
  casesByPlatform: { darwin: ['security/case-a'], linux: ['security/case-a'] },
  allowedSkippedTests: { darwin: [], linux: [{ name: knownSkip.test, classificationId: knownSkipId, classificationHash: knownSkipHash }] }
};
const report = {
  suite: 'intelligence', status: 'PASS', exitCode: 0,
  counts: { pass: 2, fail: 0, skipped: 0, total: 2 },
  tests: [{ name: 'first test', status: 'PASS' }, { name: knownSkip.test, status: 'PASS' }],
  cases: 1, caseDetails: [{ name: 'security/case-a', status: 'PASS' }], caseFailures: [],
  environment: { platform: 'darwin' }
};

test('mandatory suite inventory rejects omitted, renamed, newly added and duplicated tests', () => {
  assert.deepEqual(inventoryDrift(report, inventory), []);
  assert.match(inventoryDrift({ ...report, tests: [report.tests[0]!] }, inventory).join('\n'), /missing or renamed/);
  assert.match(inventoryDrift({ ...report, tests: [{ ...report.tests[0]!, name: 'renamed test' }, report.tests[1]!] }, inventory).join('\n'), /missing or renamed|unreviewed test added/);
  assert.match(inventoryDrift({ ...report, tests: [...report.tests, { name: 'new mandatory test', status: 'PASS' }] }, inventory).join('\n'), /unreviewed test added/);
  assert.match(inventoryDrift({ ...report, tests: [report.tests[0]!, report.tests[0]!] }, inventory).join('\n'), /duplicated/);
});

test('mandatory suite inventory rejects case drift, missing platform profiles and inconsistent totals', () => {
  assert.equal(suiteReportConsistent(report, inventory), true);
  assert.match(inventoryDrift({ ...report, caseDetails: [{ name: 'security/new-case', status: 'PASS' }] }, inventory).join('\n'), /case missing or renamed|case added/);
  assert.match(inventoryDrift({ ...report, environment: { platform: 'freebsd' } }, inventory).join('\n'), /no case inventory declared/);
  assert.equal(suiteReportConsistent({ ...report, counts: { ...report.counts, total: 3 } }, inventory), false);
  assert.equal(suiteReportConsistent({ ...report, tests: [...report.tests, { name: 'unreviewed test', status: 'PASS' }], counts: { pass: 3, fail: 0, skipped: 0, total: 3 } }, inventory), false);
});

test('zero case inventory is valid for mandatory suites that emit no case events', () => {
  const noCaseInventory: SuiteInventory = { minimumTests: 1, requiredTests: ['test'], requiredCases: [], casesByPlatform: { darwin: [] } };
  const noCases = { ...report, counts: { pass: 1, fail: 0, skipped: 0, total: 1 }, tests: [{ name: 'test', status: 'PASS' }], cases: 0, caseDetails: [] };
  assert.deepEqual(inventoryDrift(noCases, noCaseInventory), []);
  assert.equal(suiteReportConsistent(noCases, noCaseInventory), true);
});

test('inventory capture accepts structurally valid skipped platform reports without promoting their status', () => {
  const linuxReport = {
    ...report,
    status: 'SKIPPED',
    counts: { pass: 1, fail: 0, skipped: 1, total: 2 },
    tests: [{ name: 'first test', status: 'PASS' }, { name: knownSkip.test, status: 'SKIPPED' }],
    environment: { platform: 'linux' }
  };
  assert.equal(inventoryReportUsable(linuxReport), false, 'pending-owner-review classifications are not approved by default');
  assert.equal(inventoryReportUsable(linuxReport, true), true, 'local inventory development can explicitly include pending records');
  assert.equal(linuxReport.status, 'SKIPPED');
  assert.equal(inventoryReportUsable({ ...linuxReport, exitCode: 1 }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, counts: { ...linuxReport.counts, total: 3 } }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, tests: [...linuxReport.tests, { name: 'broken', status: 'FAIL' }], counts: { pass: 1, fail: 1, skipped: 1, total: 3 } }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, caseDetails: [{ name: 'security/case-a', status: 'FAIL' }], caseFailures: [{ name: 'security/case-a' }] }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, tests: [linuxReport.tests[0]!, linuxReport.tests[0]!] }), false);
});

test('skipped mandatory tests require a current platform classification and remain non-PASS evidence', () => {
  const skipped = {
    ...report,
    status: 'SKIPPED',
    counts: { pass: 1, fail: 0, skipped: 1, total: 2 },
    tests: [{ name: 'first test', status: 'PASS' }, { name: knownSkip.test, status: 'SKIPPED' }],
    environment: { platform: 'linux' }
  };
  assert.equal(suiteReportConsistent(skipped, inventory), false);
  assert.ok(inventoryDrift(skipped, { ...inventory, allowedSkippedTests: {} }).some(issue => issue.includes('unreviewed skipped mandatory test')));
  assert.ok(inventoryDrift(skipped, { ...inventory, allowedSkippedTests: { linux: [{ name: knownSkip.test, classificationId: knownSkipId, classificationHash: '0'.repeat(64) }] } }).some(issue => issue.includes('tampered')));
  assert.ok(inventoryDrift(skipped, { ...inventory, allowedSkippedTests: { linux: [{ name: knownSkip.test, classificationId: knownSkipId, classificationHash: knownSkipHash }] } }).some(issue => issue.includes('unreviewed skip classification')));
  assert.equal(suiteReportConsistent({ ...skipped, environment: { platform: undefined } }, inventory, true), false, 'platform metadata is mandatory for a classified skip');
  assert.equal(suiteReportConsistent({ ...skipped, environment: { platform: 'darwin' } }, inventory, true), false, 'classification must include the observed platform');
  assert.equal(suiteReportConsistent(skipped, inventory, true), true);
  assert.equal(skipped.tests.find(item => item.name === knownSkip.test)?.status, 'SKIPPED');
  assert.equal(skipped.counts.pass, 1, 'the skipped test is not counted as a passing test');
  const regenerated = buildSuiteInventoryForReport(skipped, inventory);
  assert.deepEqual(buildSuiteInventoryForReport(skipped, regenerated), regenerated, 'regeneration is idempotent');
  assert.throws(() => buildSuiteInventoryForReport({ ...skipped, tests: [skipped.tests[0]!], counts: { pass: 1, fail: 0, skipped: 0, total: 1 } }, inventory), /mandatory test removal/);
  assert.throws(() => allowedSkippedTestsForReport({ suite: 'intelligence', environment: { platform: 'linux' }, tests: [{ name: 'new unclassified mandatory test', status: 'SKIPPED' }] }), /unreviewed skipped test/);
  const newlySkipped = { ...skipped, tests: [...skipped.tests, { name: 'new unclassified mandatory test', status: 'SKIPPED' }], counts: { pass: 1, fail: 0, skipped: 2, total: 3 } };
  assert.throws(() => buildSuiteInventoryForReport(newlySkipped, inventory), /new unclassified mandatory test/);
});

test('skip classification entry changes invalidate its tracked hash', () => {
  const hash = skipClassificationHash(knownSkip);
  assert.notEqual(skipClassificationHash({ ...knownSkip, reason: `${knownSkip.reason} changed` }), hash);
  assert.notEqual(skipClassificationHash({ ...knownSkip, class: 'platform-specific' }), hash);
  assert.notEqual(skipClassificationHash({ ...knownSkip, platforms: ['darwin'] }), hash);
});
