import { promises as fs } from 'node:fs';
import { parseStrictJson } from './lib/strict-json.js';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { gitCommit, loadSuiteReport } from './lib/suite.js';
import { buildSuiteInventoryForReport, MANDATORY_SUITE_NAMES, type InventoryReport } from './lib/suite-inventory.js';
import { sourceEvidenceMatches, type SuiteInventory } from './lib/release-policy.js';

type InventoryFile = { version: number; suites: Record<string, SuiteInventory> };
process.env.GIT_OPTIONAL_LOCKS = '0';
const write = process.argv.includes('--write');
const current = parseStrictJson(await fs.readFile('scripts/lib/suite-inventory.json', 'utf8'), 'suite inventory') as InventoryFile;
const source = await currentSourceEvidence();
const provenance = { fingerprint: source.fingerprint, commit: gitCommit() };
const next: InventoryFile = { version: 1, suites: {} };
for (const name of MANDATORY_SUITE_NAMES) {
  const report = await loadSuiteReport(`verification/${name}/report.json`) as InventoryReport | undefined;
  if (!report) throw new Error(`${name}: update requires a current-source report`);
  if (!sourceEvidenceMatches(report, source.files, provenance)) throw new Error(`${name}: update requires a current-source report bound to current source and commit`);
  try { next.suites[name] = buildSuiteInventoryForReport(report, current.suites?.[name]); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
if (process.exitCode) throw new Error('suite inventory update refused because skipped tests are unclassified');
const output = `${JSON.stringify(next, null, 2)}\n`;
if (write) await fs.writeFile('scripts/lib/suite-inventory.json', output);
else if (JSON.stringify(current, null, 2) !== JSON.stringify(next, null, 2)) throw new Error('suite inventory drift: run the suites, inspect report changes, then use npm run update:suite-inventory');
console.log(`${write ? 'Wrote' : 'Verified'} exact inventories for ${MANDATORY_SUITE_NAMES.length} mandatory suites from source ${source.fingerprint}.`);
