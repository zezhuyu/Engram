import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MANDATORY_SUITE_NAMES } from './suite-inventory.js';
import { effectiveSuiteStatus, sourceEvidenceMatches, suiteReportConsistent, type SuiteInventory, type TrustedProvenance } from './release-policy.js';
import { loadSuiteReport, type SuiteReport } from './suite.js';

export type PlatformEvidenceStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'INCOMPLETE';
export interface PlatformSuiteResult { suite: string; status: PlatformEvidenceStatus; detail: string }
export interface PlatformEvidenceResult { platform: string; status: PlatformEvidenceStatus; suites: PlatformSuiteResult[]; source: 'current run' | 'imported reports' | 'missing' }
export interface PlatformEvidenceContext { inventories: Record<string, SuiteInventory | undefined>; trusted: TrustedProvenance }
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** Load reports exported by a platform CI job. Reports are evidence only for this exact clean source identity. */
export async function loadPlatformEvidence(dir: string, platform: string, ctx: PlatformEvidenceContext): Promise<PlatformEvidenceResult> {
  if (!/^[a-z0-9_-]+$/.test(platform)) return { platform, status: 'FAIL', suites: [], source: 'imported reports' };
  try {
    const rootStat = await fs.lstat(dir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { platform, status: 'FAIL', suites: [], source: 'imported reports' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { platform, status: 'NOT_RUN', suites: [], source: 'missing' };
    return { platform, status: 'FAIL', suites: [], source: 'imported reports' };
  }
  const platformDir = path.join(dir, platform);
  try {
    const stat = await fs.lstat(platformDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { platform, status: 'FAIL', suites: [], source: 'imported reports' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { platform, status: 'NOT_RUN', suites: [], source: 'missing' };
    return { platform, status: 'FAIL', suites: [], source: 'imported reports' };
  }
  const suites: PlatformSuiteResult[] = [];
  for (const name of MANDATORY_SUITE_NAMES) {
    const suiteDir = path.join(platformDir, name);
    const reportPath = path.join(suiteDir, 'report.json');
    try {
      const dirStat = await fs.lstat(suiteDir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) { suites.push({ suite: name, status: 'FAIL', detail: 'suite directory is not a real directory' }); continue; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { suites.push({ suite: name, status: 'NOT_RUN', detail: 'report missing' }); continue; }
      suites.push({ suite: name, status: 'FAIL', detail: 'suite directory cannot be inspected' }); continue;
    }
    let reportStat;
    try { reportStat = await fs.lstat(reportPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { suites.push({ suite: name, status: 'NOT_RUN', detail: 'report missing' }); continue; }
      suites.push({ suite: name, status: 'FAIL', detail: 'report cannot be inspected' }); continue;
    }
    if (!reportStat.isFile() || reportStat.isSymbolicLink() || reportStat.size > MAX_REPORT_BYTES) { suites.push({ suite: name, status: 'FAIL', detail: 'report is symlinked, not regular, or exceeds 8 MiB' }); continue; }
    try {
      const report = await loadSuiteReport(reportPath);
      const inventory = ctx.inventories[name];
      if (report && 'manifestPath' in (report.evidenceSource as object)) {
        const manifestPath = path.join(suiteDir, 'source-evidence.json');
        const manifestStat = await fs.lstat(manifestPath);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_REPORT_BYTES) throw new Error('unsafe source manifest');
      }
      if (!report || !inventory || report.suite !== name || report.environment?.platform !== platform
        || report.git_commit !== ctx.trusted.commit || report.evidenceSource?.fingerprint !== ctx.trusted.fingerprint
        || report.treeState !== 'clean' || report.exitCode !== 0
        || report.tests.some(test => test.status === 'FAIL') || report.caseFailures.length > 0
        || report.caseDetails.some(test => test.status === 'FAIL')
        || !sourceEvidenceMatches(report, ctx.trusted.files, ctx.trusted)
        || !suiteReportConsistent(report, inventory, false, undefined, true)) {
        suites.push({ suite: name, status: 'FAIL', detail: 'report invalid, untrusted, inconsistent, or failing' });
        continue;
      }
      const status = effectiveSuiteStatus(report, inventory, { currentFiles: ctx.trusted.files, trusted: ctx.trusted });
      suites.push({ suite: name, status: status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status === 'NOT_RUN' ? 'NOT_RUN' : 'INCOMPLETE', detail: status === 'PASS' ? 'effective PASS' : `effective ${status}` });
    } catch {
      suites.push({ suite: name, status: 'FAIL', detail: 'report could not be safely loaded' });
    }
  }
  const status: PlatformEvidenceStatus = suites.some(item => item.status === 'FAIL') ? 'FAIL'
    : suites.some(item => item.status === 'NOT_RUN') ? 'NOT_RUN'
      : suites.every(item => item.status === 'PASS') ? 'PASS' : 'INCOMPLETE';
  return { platform, status, suites, source: status === 'NOT_RUN' && suites.every(item => item.status === 'NOT_RUN') ? 'missing' : 'imported reports' };
}

export function aggregatePlatformEvidence(results: PlatformEvidenceResult[]): PlatformEvidenceStatus {
  if (new Set(results.map(result => result.platform)).size !== results.length) return 'FAIL';
  if (results.some(result => result.status === 'FAIL')) return 'FAIL';
  if (results.some(result => result.status === 'NOT_RUN')) return 'NOT_RUN';
  if (results.every(result => result.status === 'PASS')) return 'PASS';
  return 'INCOMPLETE';
}

export function currentPlatformEvidence(platform: string, suites: Record<string, SuiteReport | undefined>, ctx: PlatformEvidenceContext): PlatformEvidenceResult {
  const results = MANDATORY_SUITE_NAMES.map(name => {
    const report = suites[name]; const inventory = ctx.inventories[name];
    if (report && (report.suite !== name || report.environment?.platform !== platform || report.treeState !== 'clean'
      || report.exitCode !== 0 || !sourceEvidenceMatches(report, ctx.trusted.files, ctx.trusted)
      || !suiteReportConsistent(report, inventory, false, undefined, true))) {
      return { suite: name, status: 'FAIL' as const, detail: 'current report invalid, untrusted, inconsistent, or for another platform' };
    }
    const status = effectiveSuiteStatus(report, inventory, { currentFiles: ctx.trusted.files, trusted: ctx.trusted });
    return { suite: name, status: status === 'PASS' ? 'PASS' as const : status === 'FAIL' ? 'FAIL' as const : status === 'NOT_RUN' ? 'NOT_RUN' as const : 'INCOMPLETE' as const, detail: `current run effective ${status}` };
  });
  return { platform, status: aggregatePlatformEvidence([{ platform, status: results.some(r => r.status === 'FAIL') ? 'FAIL' : results.some(r => r.status === 'NOT_RUN') ? 'NOT_RUN' : results.every(r => r.status === 'PASS') ? 'PASS' : 'INCOMPLETE', suites: results, source: 'current run' }]), suites: results, source: 'current run' };
}
