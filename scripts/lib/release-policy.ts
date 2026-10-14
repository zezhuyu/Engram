/**
 * Release policy. Passing the automated gates is necessary, never sufficient, for GA:
 *   1. automated gate results   (areas and mandatory v1 gates computed from machine-readable suite reports)
 *   2. production evidence      (things no automated suite can show: physical power loss, real TLS, live services, real-user feedback, ...)
 *   3. approved scope exclusions (owner-written, each with approvedBy, reason and date; anything else is ignored)
 *   4. final eligibility        (NOT_RELEASABLE | BETA | GA_ELIGIBLE; GA_ELIGIBLE still needs the owner's explicit release decision)
 * Until every production-evidence item is PASS or carries a valid exclusion, the release is BETA.
 */
export type EvidenceStatus = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NOT_RUN';
export interface ProductionEvidence { id: string; title: string; status: EvidenceStatus; detail: string; source: string }
/** Historical scores count for this checkout only when every required source is bound to the passing run. */
export function modelEvidenceMatches(record: { status?: string; evidenceSource?: { files?: Record<string, string> } } | undefined, current: Record<string, string>): boolean {
  return record?.status === 'PASS' && Object.keys(current).length > 0 && Object.entries(current).every(([file, hash]) => record.evidenceSource?.files?.[file] === hash);
}
export interface Exclusion { id: string; approvedBy: string; reason: string; approvedAt: string }
export type ReleaseLevel = 'NOT_RELEASABLE' | 'BETA' | 'GA_ELIGIBLE';
export interface PolicyInput { storageVerdict: string; openAreas: string[]; openGates: string[]; failedGates: string[]; evidence: ProductionEvidence[]; exclusions: unknown }
export interface PolicyResult {
  level: ReleaseLevel; automatedGatesPass: boolean; failedGates: string[]; openAreas: string[]; openGates: string[];
  incompleteEvidence: ProductionEvidence[]; validExclusions: Exclusion[]; ignoredExclusions: Array<{ entry: unknown; problem: string }>; excludedEvidence: string[]; blockers: string[]; summary: string;
}

/** Evidence the release depends on. Each item is PASS only with an evidence file whose own status is PASS (or the computed physical-host facts); otherwise NOT_RUN. */
export const PRODUCTION_EVIDENCE: Array<{ id: string; title: string; file?: string }> = [
  { id: 'PHYSICAL_POWER_LOSS', title: 'Physical power removal / volatile device-cache loss', file: 'verification/production/physical-power-loss.json' },
  { id: 'TRANSPORT_TLS', title: 'Remote capture over verified TLS (not only a private-network transport)' },
  { id: 'REMOTE_SERVER_RESTART', title: 'Server restart during a physical-host outage, with deduplicated recovery' },
  { id: 'LIVE_OBJECT_STORE', title: 'Real S3-compatible object store (not S3Mock)', file: 'verification/production/live-object-store.json' },
  { id: 'LIVE_INTEGRATIONS', title: 'Live Slack / web integrations', file: 'verification/production/live-integrations.json' },
  { id: 'STANDALONE_INSTALL', title: 'Standalone install from a distribution in a clean environment', file: 'verification/production/standalone-install.json' },
  { id: 'REAL_USER_FEEDBACK', title: 'Dream learning measured on real or human-reviewed feedback', file: 'verification/production/real-user-feedback.json' },
  { id: 'COLD_CACHE_BENCHMARK', title: 'Cold OS-cache benchmark runs', file: 'verification/production/cold-cache-benchmark.json' },
  { id: 'REBOOT_PERSISTENCE', title: 'Scheduler service survives login/reboot', file: 'verification/production/reboot-persistence.json' },
];

export interface PhysicalHostsReport { physicalHostVerified?: boolean; transport?: string; tlsVerified?: boolean; notRunOptional?: string[] }

/** `readJson` returns undefined for a missing or unreadable file. Only a recorded `status: "PASS"` counts. */
export function collectProductionEvidence(readJson: (file: string) => unknown, physical: PhysicalHostsReport | undefined): ProductionEvidence[] {
  return PRODUCTION_EVIDENCE.map(({ id, title, file }) => {
    if (id === 'TRANSPORT_TLS') {
      const ok = physical?.physicalHostVerified === true && physical.tlsVerified === true;
      return { id, title, status: ok ? 'PASS' : physical?.physicalHostVerified ? 'INCOMPLETE' : 'NOT_RUN', source: 'verification/memory/physical-hosts.json',
        detail: ok ? 'Physical hosts verified with TLS.' : physical?.physicalHostVerified ? `Physical hosts verified over ${physical.transport ?? 'an unknown transport'}; TLS was NOT tested.` : 'No physical-host evidence.' };
    }
    if (id === 'REMOTE_SERVER_RESTART') {
      const ok = physical?.physicalHostVerified === true && !(physical.notRunOptional ?? []).some(x => x.includes('server-restart-during-outage'));
      return { id, title, status: ok ? 'PASS' : physical?.physicalHostVerified ? 'INCOMPLETE' : 'NOT_RUN', source: 'verification/memory/physical-hosts.json', detail: ok ? 'Restart step passed in the merged physical report.' : 'The merged physical report lists the restart step as NOT_RUN, or no physical report exists.' };
    }
    const recorded = file ? readJson(file) as { status?: string; detail?: string } | undefined : undefined;
    const status: EvidenceStatus = recorded?.status === 'PASS' ? 'PASS' : recorded?.status === 'FAIL' ? 'FAIL' : recorded?.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'NOT_RUN';
    return { id, title, status, source: file ?? '-', detail: recorded?.detail ?? (recorded ? `Recorded status ${recorded.status ?? 'missing'}.` : `No evidence file ${file}.`) };
  });
}

/** An exclusion counts only if it names a known evidence item and records who approved it, why and when. */
export function validateExclusions(raw: unknown, knownIds: string[]): { valid: Exclusion[]; ignored: Array<{ entry: unknown; problem: string }> } {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { exclusions?: unknown }).exclusions) ? (raw as { exclusions: unknown[] }).exclusions : [];
  const valid: Exclusion[] = []; const ignored: Array<{ entry: unknown; problem: string }> = [];
  for (const entry of entries) {
    const e = entry as Partial<Exclusion> | null; const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    if (!e || typeof e !== 'object') ignored.push({ entry, problem: 'not an object' });
    else if (!text(e.id) || !knownIds.includes(e.id)) ignored.push({ entry, problem: 'unknown evidence id' });
    else if (!text(e.approvedBy)) ignored.push({ entry, problem: 'approvedBy is required' });
    else if (!text(e.reason)) ignored.push({ entry, problem: 'reason is required' });
    else if (!text(e.approvedAt) || !Number.isFinite(Date.parse(e.approvedAt))) ignored.push({ entry, problem: 'approvedAt must be a valid date' });
    else valid.push({ id: e.id, approvedBy: e.approvedBy, reason: e.reason, approvedAt: e.approvedAt });
  }
  return { valid, ignored };
}

export function classifyRelease(input: PolicyInput): PolicyResult {
  const { valid, ignored } = validateExclusions(input.exclusions, input.evidence.map(e => e.id));
  const excludedIds = new Set(valid.map(e => e.id));
  const incomplete = input.evidence.filter(e => e.status !== 'PASS' && !excludedIds.has(e.id));
  const failedEvidence = incomplete.filter(e => e.status === 'FAIL');
  const automatedGatesPass = input.storageVerdict === 'PASS' && !input.openAreas.length && !input.openGates.length && !input.failedGates.length;
  const hardFail = input.storageVerdict !== 'PASS' || input.failedGates.length > 0 || failedEvidence.length > 0;
  const blockers = [...input.failedGates.map(g => `gate ${g} FAIL`), ...input.openAreas.map(a => `area ${a} not PASS`), ...input.openGates.map(g => `mandatory gate ${g} not PASS`), ...incomplete.map(e => `production evidence ${e.id} ${e.status}`)];
  const level: ReleaseLevel = hardFail ? 'NOT_RELEASABLE' : automatedGatesPass && !incomplete.length ? 'GA_ELIGIBLE' : 'BETA';
  const summary = level === 'GA_ELIGIBLE' ? 'GA-eligible: every automated gate passes and every production-evidence item is PASS or has a valid owner-approved exclusion. This is eligibility only; the release decision belongs to the owner.'
    : level === 'BETA' ? `BETA: ${blockers.length} open item(s) block GA. Passing the automated gates does not imply GA readiness.` : `NOT RELEASABLE: ${blockers.filter(b => /FAIL/.test(b) || /^area STORAGE/.test(b)).join('; ') || 'storage is not PASS'}.`;
  return { level, automatedGatesPass, failedGates: input.failedGates, openAreas: input.openAreas, openGates: input.openGates, incompleteEvidence: incomplete, validExclusions: valid, ignoredExclusions: ignored, excludedEvidence: [...excludedIds], blockers, summary };
}
