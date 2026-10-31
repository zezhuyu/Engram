import { promises as fs } from 'node:fs';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { loadSuiteReport } from './lib/suite.js';
import { MANDATORY_SUITE_NAMES, inventoryDrift, type InventoryReport } from './lib/suite-inventory.js';
import { sourceEvidenceMatches, suiteReportConsistent, type SuiteInventory } from './lib/release-policy.js';

type InventoryFile = { version: number; suites: Record<string, SuiteInventory> };
const inventory = JSON.parse(await fs.readFile('scripts/lib/suite-inventory.json', 'utf8')) as InventoryFile;
const source = await currentSourceEvidence();
const errors: string[] = [];
if (inventory.version !== 1) errors.push(`unsupported inventory version: ${inventory.version}`);
const names = Object.keys(inventory.suites ?? {}).sort();
if (JSON.stringify(names) !== JSON.stringify([...MANDATORY_SUITE_NAMES].sort())) errors.push(`suite set drift: expected ${MANDATORY_SUITE_NAMES.join(', ')}, found ${names.join(', ')}`);
for (const name of MANDATORY_SUITE_NAMES) {
  const report = await loadSuiteReport(`verification/${name}/report.json`) as InventoryReport | undefined;
  const expected = inventory.suites?.[name];
  const drift = inventoryDrift(report, expected);
  if (report && !sourceEvidenceMatches(report, source.files)) drift.push('report source does not match the current source fingerprint');
  if (report && expected && !suiteReportConsistent(report, expected)) drift.push('release policy rejects suite report/inventory consistency');
  if (drift.length) errors.push(`${name}: ${drift.join('; ')}`);
}
if (errors.length) {
  console.error('Mandatory suite inventory drift detected:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Mandatory suite inventory is exact for ${MANDATORY_SUITE_NAMES.length} suites on source ${source.fingerprint}.`);
}
