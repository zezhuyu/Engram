import { RELEASE_POLICY_VERSION, suiteReportConsistent, type SuiteEvidenceLike, type SuiteInventory } from './release-policy.js';
import { allSkipClassifications, skipClassificationHash, skipClassificationId, type SkipClassification } from './skip-classifications.js';

export const MANDATORY_SUITE_NAMES = [
  'acid', 'security', 'search', 'intelligence', 'recovery', 'platforms', 'memory',
  'profile', 'wiki', 'dream', 'adaptive', 'query', 'unix'
] as const;

export interface InventoryReport extends SuiteEvidenceLike {
  suite?: string;
  git_commit?: string;
  evidenceSource?: { fingerprint?: string; files?: Record<string, string> };
}

export function allowedSkippedTestsForReport(report: InventoryReport): Array<{ name: string; classificationId: string; classificationHash: string }> {
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : '';
  return (report.tests ?? []).filter(test => test.status === 'SKIPPED').map(test => {
    const name = test.name ?? '';
    const matches = allSkipClassifications().filter(item => item.test === name && item.platforms.includes(platform) && (!report.suite || report.suite === item.suite));
    if (matches.length !== 1) throw new Error(`${report.suite ?? 'suite'}/${name}: unreviewed skipped test for platform ${platform || '(missing)'}`);
    const classification = matches[0] as SkipClassification;
    return { name, classificationId: skipClassificationId(classification.suite, classification.test), classificationHash: skipClassificationHash(classification) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * An inventory may be captured from a passing suite or a successful suite with
 * explicitly skipped optional tests (for example, tools unavailable on that
 * platform). This does not promote the suite result: the report retains its
 * SKIPPED status for release policy. It only allows the observed test/case
 * names to be recorded for that platform after validating the report's own
 * arithmetic, identifiers, and exit status.
 */
export function inventoryReportUsable(report: InventoryReport | undefined, allowPending = false): boolean {
  if (!report || !['PASS', 'SKIPPED'].includes(String(report.status)) || report.exitCode !== 0) return false;
  if (!Array.isArray(report.tests) || !Array.isArray(report.caseDetails) || !Array.isArray(report.caseFailures)) return false;
  const testNames = report.tests.map(test => test.name);
  const caseNames = report.caseDetails.map(item => item.name);
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : undefined;
  if (!platform || testNames.some(name => typeof name !== 'string' || !name) || caseNames.some(name => typeof name !== 'string' || !name)) return false;
  if (report.tests.some(test => test.status === 'FAIL') || report.caseFailures.length > 0) return false;
  let allowedSkippedTests: SuiteInventory['allowedSkippedTests'];
  try { allowedSkippedTests = { [platform]: allowedSkippedTestsForReport(report) }; }
  catch { return false; }
  const observed: SuiteInventory = {
    minimumTests: testNames.length,
    requiredTests: testNames as string[],
    requiredCases: caseNames as string[],
    casesByPlatform: { [platform]: caseNames as string[] },
    allowedSkippedTests
  };
  return suiteReportConsistent(report, observed, allowPending || process.env.MDB_ALLOW_PENDING_SKIP_CLASSIFICATIONS === '1');
}

export function buildSuiteInventoryForReport(report: InventoryReport, previous?: SuiteInventory): SuiteInventory {
  const observedSkipped = allowedSkippedTestsForReport(report);
  if (!inventoryReportUsable(report, true)) throw new Error(`${report.suite ?? 'suite'}: report is not a successful, structurally consistent PASS/SKIPPED report`);
  const testNames = report.tests?.map(test => test.name);
  const caseNames = report.caseDetails?.map(item => item.name);
  if (!testNames?.length || testNames.some(item => typeof item !== 'string' || !item) || new Set(testNames).size !== testNames.length) throw new Error(`${report.suite ?? 'suite'}: missing or duplicate top-level test names`);
  if (!caseNames || caseNames.some(item => typeof item !== 'string' || !item) || new Set(caseNames).size !== caseNames.length) throw new Error(`${report.suite ?? 'suite'}: missing or duplicate case names`);
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : undefined;
  if (!platform) throw new Error(`${report.suite ?? 'suite'}: report platform missing`);
  const testStrings = testNames as string[];
  const caseStrings = caseNames as string[];
  if (previous?.requiredTests.some(name => !testStrings.includes(name))) throw new Error(`${report.suite ?? 'suite'}: mandatory test removal or rename is not adoptable`);
  const currentPlatformCases = previous?.casesByPlatform?.[platform];
  if (currentPlatformCases && currentPlatformCases.some(name => !caseStrings.includes(name))) throw new Error(`${report.suite ?? 'suite'}: mandatory case removal or rename is not adoptable on ${platform}`);
  const casesByPlatform = { ...(previous?.casesByPlatform ?? {}), [platform]: [...caseStrings].sort() };
  const requiredCases = [...new Set([...Object.values(casesByPlatform).flat(), ...caseStrings])].sort();
  return {
    minimumTests: testNames.length,
    requiredTests: [...testStrings].sort(),
    requiredCases,
    casesByPlatform,
    allowedSkippedTests: { ...(previous?.allowedSkippedTests ?? {}), [platform]: observedSkipped },
  };
}

export function inventoryDrift(report: InventoryReport | undefined, inventory: SuiteInventory | undefined): string[] {
  const issues: string[] = [];
  if (!report) return ['suite report is missing'];
  if (!inventory) return ['suite inventory is missing'];
  if (!Array.isArray(report.tests) || !Array.isArray(report.caseDetails)) return ['report test or case list is missing'];
  const tests = report.tests.map(test => test.name);
  const cases = report.caseDetails.map(item => item.name);
  if (tests.some(name => typeof name !== 'string' || !name) || new Set(tests).size !== tests.length) issues.push('test names are missing or duplicated');
  if (cases.some(name => typeof name !== 'string' || !name) || new Set(cases).size !== cases.length) issues.push('case names are missing or duplicated');
  if (!sameStrings(tests as string[], inventory.requiredTests)) {
    const expected = new Set(inventory.requiredTests), actual = new Set(tests as string[]);
    for (const name of inventory.requiredTests) if (!actual.has(name)) issues.push(`mandatory test missing or renamed: ${name}`);
    for (const name of tests as string[]) if (!expected.has(name)) issues.push(`unreviewed test added: ${name}`);
  }
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : undefined;
  if (!platform && report.tests.some(test => test.status === 'SKIPPED')) issues.push('report platform is missing for skipped tests');
  if (platform) {
    const entries = inventory.allowedSkippedTests?.[platform] ?? [];
    if (!Array.isArray(entries) || entries.some(item => !item || typeof item.name !== 'string' || !item.name || typeof item.classificationId !== 'string' || !item.classificationId || typeof item.classificationHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.classificationHash))) issues.push(`allowed skipped-test inventory is invalid for ${platform}`);
    const allowed = new Set(Array.isArray(entries) ? entries.map(item => item.name) : []);
    for (const test of report.tests) if (test.status === 'SKIPPED' && !allowed.has(String(test.name))) issues.push(`unreviewed skipped mandatory test: ${test.name ?? '(unnamed)'}`);
    for (const item of Array.isArray(entries) ? entries : []) {
      if (!item || typeof item !== 'object') { issues.push(`allowed skipped-test inventory is invalid for ${platform}`); continue; }
      const classification = allSkipClassifications().find(value => skipClassificationId(value.suite, value.test) === item.classificationId);
      if (!classification || classification.test !== item.name || report.suite && classification.suite !== report.suite || !classification.platforms.includes(platform) || skipClassificationHash(classification) !== item.classificationHash || classification.policyVersion !== RELEASE_POLICY_VERSION || classification.reason.length < 40 || classification.reason === 'Observed skipped test in current-source reviewed report.') issues.push(`invalid or tampered skip classification: ${item.classificationId}`);
      else if (classification.reviewedBy === 'pending-owner-review' && process.env.MDB_ALLOW_PENDING_SKIP_CLASSIFICATIONS !== '1') issues.push(`unreviewed skip classification: ${item.classificationId}`);
      if (!report.tests.some(test => test.name === item.name && test.status === 'SKIPPED')) issues.push(`stale skipped-test classification: ${item.name}`);
    }
  }
  const expectedCases = platform ? inventory.casesByPlatform?.[platform] : undefined;
  if (inventory.casesByPlatform) {
    if (!platform) issues.push('report platform is missing');
    else if (!expectedCases) issues.push(`no case inventory declared for platform ${platform}`);
    else if (!sameStrings(cases as string[], expectedCases)) {
      const expected = new Set(expectedCases), actual = new Set(cases as string[]);
      for (const name of expectedCases) if (!actual.has(name)) issues.push(`mandatory case missing or renamed: ${name}`);
      for (const name of cases as string[]) if (!expected.has(name)) issues.push(`unreviewed case added: ${name}`);
    }
  }
  return issues;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || actual.length !== expected.length) return false;
  const values = new Set(expected);
  return actual.every(value => values.has(value));
}
