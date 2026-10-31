import { suiteReportConsistent, type SuiteEvidenceLike, type SuiteInventory } from './release-policy.js';

export const MANDATORY_SUITE_NAMES = [
  'acid', 'security', 'search', 'intelligence', 'recovery', 'platforms', 'memory',
  'profile', 'wiki', 'dream', 'adaptive', 'query', 'unix'
] as const;

export interface InventoryReport extends SuiteEvidenceLike {
  suite?: string;
  evidenceSource?: { fingerprint?: string; files?: Record<string, string> };
}

/**
 * An inventory may be captured from a passing suite or a successful suite with
 * explicitly skipped optional tests (for example, tools unavailable on that
 * platform). This does not promote the suite result: the report retains its
 * SKIPPED status for release policy. It only allows the observed test/case
 * names to be recorded for that platform after validating the report's own
 * arithmetic, identifiers, and exit status.
 */
export function inventoryReportUsable(report: InventoryReport | undefined): boolean {
  if (!report || !['PASS', 'SKIPPED'].includes(String(report.status)) || report.exitCode !== 0) return false;
  if (!Array.isArray(report.tests) || !Array.isArray(report.caseDetails) || !Array.isArray(report.caseFailures)) return false;
  const testNames = report.tests.map(test => test.name);
  const caseNames = report.caseDetails.map(item => item.name);
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : undefined;
  if (!platform || testNames.some(name => typeof name !== 'string' || !name) || caseNames.some(name => typeof name !== 'string' || !name)) return false;
  if (report.tests.some(test => test.status === 'FAIL') || report.caseFailures.length > 0) return false;
  const observed: SuiteInventory = {
    minimumTests: testNames.length,
    requiredTests: testNames as string[],
    requiredCases: caseNames as string[],
    casesByPlatform: { [platform]: caseNames as string[] }
  };
  return suiteReportConsistent(report, observed);
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
