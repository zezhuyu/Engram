import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const GENERIC_SKIP_REASON = 'Observed skipped test in current-source reviewed report.';
export type SkipClass = 'real-model' | 'real-host' | 'gnu-tools' | 'platform-specific';
export interface SkipClassification {
  suite: string;
  test: string;
  platforms: string[];
  class: SkipClass;
  prerequisite: string;
  reason: string;
  requiredByProfiles: string[];
  reviewedBy: string;
  reviewedAt: string;
  policyVersion: string;
}

const registryUrl = new URL('./skip-classifications.json', import.meta.url);
let registryText: string;
try { registryText = readFileSync(registryUrl, 'utf8'); }
catch { registryText = readFileSync(path.resolve('scripts/lib/skip-classifications.json'), 'utf8'); }
const data = JSON.parse(registryText) as { version?: number; entries?: SkipClassification[] };
if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('invalid skip classification registry');
const byId = new Map<string, SkipClassification>();
for (const entry of data.entries) {
  const id = skipClassificationId(entry.suite, entry.test);
  if (byId.has(id) || !entry.suite || !entry.test || !Array.isArray(entry.platforms) || !entry.platforms.length
    || !['real-model', 'real-host', 'gnu-tools', 'platform-specific'].includes(entry.class)
    || !entry.prerequisite.trim() || entry.reason.trim().length < 40 || entry.reason === GENERIC_SKIP_REASON
    || !Array.isArray(entry.requiredByProfiles) || !entry.requiredByProfiles.length
    || !entry.reviewedBy.trim() || !entry.reviewedAt || !entry.policyVersion) throw new Error(`invalid skip classification: ${id}`);
  byId.set(id, entry);
}

export function skipClassificationId(suite: string, test: string): string { return `${suite}/${test}`; }
export function getSkipClassification(id: string): SkipClassification | undefined { return byId.get(id); }
export function allSkipClassifications(): SkipClassification[] { return [...byId.values()]; }
export function skipClassificationHash(value: SkipClassification): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
