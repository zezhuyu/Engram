import { promises as fs } from 'node:fs';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { loadSuiteReport } from './lib/suite.js';
import { inventoryReportUsable, MANDATORY_SUITE_NAMES, type InventoryReport } from './lib/suite-inventory.js';
import { sourceEvidenceMatches, type SuiteInventory } from './lib/release-policy.js';

type InventoryFile = { version: number; suites: Record<string, SuiteInventory> };
const write = process.argv.includes('--write');
const current = JSON.parse(await fs.readFile('scripts/lib/suite-inventory.json', 'utf8')) as InventoryFile;
const source = await currentSourceEvidence();
const next: InventoryFile = { version: 1, suites: {} };
for (const name of MANDATORY_SUITE_NAMES) {
  const report = await loadSuiteReport(`verification/${name}/report.json`) as InventoryReport | undefined;
  if (!report || !inventoryReportUsable(report) || !sourceEvidenceMatches(report, source.files)) throw new Error(`${name}: update requires a successful, structurally consistent PASS/SKIPPED report bound to current source`);
  const testNames = report.tests?.map(test => test.name);
  const caseNames = report.caseDetails?.map(item => item.name);
  if (!testNames?.length || testNames.some(item => typeof item !== 'string' || !item) || new Set(testNames).size !== testNames.length) throw new Error(`${name}: missing or duplicate top-level test names`);
  if (!caseNames || caseNames.some(item => typeof item !== 'string' || !item) || new Set(caseNames).size !== caseNames.length) throw new Error(`${name}: missing or duplicate case names`);
  const testStrings = testNames as string[];
  const caseStrings = caseNames as string[];
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : undefined;
  if (!platform) throw new Error(`${name}: report platform missing`);
  const previous = current.suites?.[name];
  const casesByPlatform = { ...(previous?.casesByPlatform ?? {}), [platform]: [...caseStrings].sort() };
  const requiredCases = [...new Set([...Object.values(casesByPlatform).flat(), ...caseStrings])].sort();
  next.suites[name] = {
    minimumTests: testStrings.length,
    requiredTests: [...testStrings].sort(),
    requiredCases,
    casesByPlatform
  };
}
const output = `${JSON.stringify(next, null, 2)}\n`;
if (write) await fs.writeFile('scripts/lib/suite-inventory.json', output);
else if (JSON.stringify(current, null, 2) !== JSON.stringify(next, null, 2)) throw new Error('suite inventory drift: run the suites, inspect report changes, then use npm run update:suite-inventory');
console.log(`${write ? 'Wrote' : 'Verified'} exact inventories for ${MANDATORY_SUITE_NAMES.length} mandatory suites from source ${source.fingerprint}.`);
