import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryDrift, inventoryReportUsable } from '../../scripts/lib/suite-inventory.js';
import { suiteReportConsistent, type SuiteInventory } from '../../scripts/lib/release-policy.js';

const inventory: SuiteInventory = {
  minimumTests: 2,
  requiredTests: ['first test', 'second test'],
  requiredCases: ['security/case-a'],
  casesByPlatform: { darwin: ['security/case-a'] }
};
const report = {
  suite: 'security', status: 'PASS', exitCode: 0,
  counts: { pass: 2, fail: 0, skipped: 0, total: 2 },
  tests: [{ name: 'first test', status: 'PASS' }, { name: 'second test', status: 'PASS' }],
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
  assert.match(inventoryDrift({ ...report, environment: { platform: 'linux' } }, inventory).join('\n'), /no case inventory declared/);
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
    tests: [{ name: 'first test', status: 'PASS' }, { name: 'second test', status: 'SKIPPED' }],
    environment: { platform: 'linux' }
  };
  assert.equal(inventoryReportUsable(linuxReport), true);
  assert.equal(linuxReport.status, 'SKIPPED');
  assert.equal(inventoryReportUsable({ ...linuxReport, exitCode: 1 }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, counts: { ...linuxReport.counts, total: 3 } }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, tests: [...linuxReport.tests, { name: 'broken', status: 'FAIL' }], counts: { pass: 1, fail: 1, skipped: 1, total: 3 } }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, caseDetails: [{ name: 'security/case-a', status: 'FAIL' }], caseFailures: [{ name: 'security/case-a' }] }), false);
  assert.equal(inventoryReportUsable({ ...linuxReport, tests: [linuxReport.tests[0]!, linuxReport.tests[0]!] }), false);
});
