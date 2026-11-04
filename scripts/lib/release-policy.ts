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
export function modelEvidenceMatches(record: { status?: string; evidenceSource?: { files?: Record<string, string> }; fingerprint?: string; source?: { fingerprint?: string }; git_commit?: string; commit?: string } | undefined, current: Record<string, string>, trusted?: Pick<TrustedProvenance, 'fingerprint' | 'commit'>): boolean {
  return record?.status === 'PASS' && sourceEvidenceMatches(record, current, trusted);
}

export function currentQualityStatus(base: string | undefined, record: { status?: string; runAt?: string; evidenceSource?: { files?: Record<string, string> }; fingerprint?: string; source?: { fingerprint?: string }; git_commit?: string; commit?: string } | undefined, current: Record<string, string>, now = Date.now(), trusted?: Pick<TrustedProvenance, 'fingerprint' | 'commit'>): string {
  const at = typeof record?.runAt === 'string' ? Date.parse(record.runAt) : NaN;
  const age = now - at;
  const currentEvidence = Number.isFinite(at) && age >= 0 && age <= 30 * 24 * 3600_000 && sourceEvidenceMatches(record, current, trusted);
  if (currentEvidence && record?.status === 'FAIL') return 'FAIL';
  if (base === 'PASS' && currentEvidence && record?.status === 'PASS' && modelEvidenceMatches(record, current, trusted)) return 'PASS';
  return base === 'PASS' ? 'INCOMPLETE' : base ?? 'NOT_RUN';
}

export interface CurrentQualityRecord {
  status?: string;
  runAt?: string;
  provider?: string;
  model?: string | null;
  semanticGrounding?: string;
  humanAdjudication?: string;
  rawResponses?: string;
  evidenceSource?: { fingerprint?: string };
  metrics?: { modes?: Record<string, { meanQuality?: number }> };
}

/** Report the current evaluation itself instead of inheriting a stale base-gate narrative. */
export function currentQualityDetail(file: string, base: string, status: string, record: CurrentQualityRecord | undefined): string {
  if (!record) return `Current-source quality evidence ${file}: ${status} (base ${base}); evaluation is missing.`;
  const modes = Object.entries(record.metrics?.modes ?? {})
    .map(([mode, result]) => `${mode}=${typeof result.meanQuality === 'number' && Number.isFinite(result.meanQuality) ? result.meanQuality.toFixed(3) : 'unreported'}`)
    .join(', ');
  const identity = [record.provider, record.model].filter((part): part is string => typeof part === 'string' && part.length > 0).join('/');
  return [
    `Current-source quality evidence ${file}: ${status} (base ${base}; evaluation ${record.status ?? 'unreported'}).`,
    record.runAt ? `Run ${record.runAt}.` : 'Run timestamp missing.',
    identity ? `Provider/model ${identity}.` : 'Provider/model unreported.',
    record.evidenceSource?.fingerprint ? `Source ${record.evidenceSource.fingerprint}.` : 'Source fingerprint unreported.',
    modes ? `Mode means: ${modes}.` : '',
    `Semantic grounding ${record.semanticGrounding ?? 'unreported'}; human adjudication ${record.humanAdjudication ?? 'unreported'}.`,
    record.rawResponses ? `Raw responses ${record.rawResponses}.` : 'Raw-response path unreported.',
  ].filter(Boolean).join(' ');
}

/** Evidence is current only when it binds every source required by the consumer to the exact current bytes. */
export interface TrustedProvenance { fingerprint: string; commit: string; files: Record<string, string> }
/** Report provenance is admissible only for a clean checkout or an attested archive tree. */
export function releaseTreeStateValid(state: unknown): boolean { return state === 'clean' || state === 'no-git'; }
export function sourceEvidenceMatches(record: { evidenceSource?: { files?: Record<string, string>; fingerprint?: string }; fingerprint?: string; source?: { fingerprint?: string }; git_commit?: string; commit?: string } | undefined, current: Record<string, string>, trusted?: Pick<TrustedProvenance, 'fingerprint' | 'commit'>): boolean {
  const files = record?.evidenceSource?.files;
  const fingerprints = [record?.fingerprint, record?.source?.fingerprint, record?.evidenceSource?.fingerprint].filter((value): value is string => value !== undefined);
  const commits = [record?.git_commit, record?.commit].filter((value): value is string => value !== undefined);
  return Object.keys(current).length > 0 && !!files && Object.keys(files).length === Object.keys(current).length && Object.entries(current).every(([file, hash]) => files[file] === hash)
    && (!trusted || (fingerprints.length > 0 && fingerprints.every(value => value === trusted.fingerprint) && commits.length > 0 && commits.every(value => value === trusted.commit)));
}
export interface DurabilityEvidence {
  status?: string; run_at?: string; observedAt?: string; acceptedImplementationCommit?: string;
  evidenceSource?: { fingerprint?: string; files?: Record<string, string> };
  fingerprint?: string; source?: { fingerprint?: string }; git_commit?: string; commit?: string;
  results?: { isolated_linux_vm_power_cut?: { status?: string; points?: Array<{ acknowledgedSurvived?: boolean; verify?: boolean; repeatedRecoveryStable?: boolean }> }; actual_kernel_fsync_eio?: { status?: string; nodeReceived?: string; postErrorRecoveryVerify?: boolean } };
}
export function durabilityEvidenceStatus(record: DurabilityEvidence | undefined, provenance: TrustedProvenance, now = Date.now()): 'PASS' | 'FAIL' | 'NOT_RUN' {
  if (!record) return 'NOT_RUN';
  if (record.status === 'FAIL' || record.results?.isolated_linux_vm_power_cut?.status === 'FAIL' || record.results?.actual_kernel_fsync_eio?.status === 'FAIL') return 'FAIL';
  if (record.status !== 'PASS') return 'NOT_RUN';
  const at = Date.parse(record.run_at ?? record.observedAt ?? '');
  const age = now - at;
  const fresh = Number.isFinite(at) && age >= 0 && age < 30 * 24 * 3600_000;
  const power = record.results?.isolated_linux_vm_power_cut;
  const eio = record.results?.actual_kernel_fsync_eio;
  const pointsPass = power?.status === 'PASS' && Array.isArray(power.points) && power.points.length >= 3 && power.points.every(point => point.acknowledgedSurvived === true && point.verify === true && point.repeatedRecoveryStable === true);
  const eioPass = eio?.status === 'PASS' && eio.nodeReceived === 'EIO' && eio.postErrorRecoveryVerify === true;
  const commits = [record.git_commit, record.commit].filter((value): value is string => value !== undefined);
  const commitMatches = record.acceptedImplementationCommit === provenance.commit && commits.length > 0 && commits.every(value => value === provenance.commit);
  return fresh && pointsPass && eioPass && commitMatches && sourceEvidenceMatches(record, provenance.files, provenance) ? 'PASS' : 'NOT_RUN';
}
export const RELEASE_POLICY_VERSION = 'engram-release-policy/2';
export interface Exclusion {
  id: string; approvedBy: string; reason: string; approvedAt: string; expiresAt: string;
  sourceFingerprint: string; git_commit: string; profile: 'ga'; policyVersion: string; nonce: string; signature: string;
}
export type ReleaseLevel = 'NOT_RELEASABLE' | 'BETA' | 'GA_ELIGIBLE';
export type ReleaseProfileName = 'core-beta' | 'full-intelligence-beta' | 'ga';
export interface ProfileRequirements { areas: string[]; requiredGateIds: string[]; requiredMandatoryIds: string[] }
const CORE_GATE_IDS = ['S1','S2','S3','S4','S5','S6','S7','S8','S9','M1','Q1','X1','PLATFORM','P-1k','P-10k','P-100k','QB-1k','QB-10k','QB-100k','PB-keyword p95','PB-grep p95','PB-durable write p95','INVENTORY'];
const CORE_MANDATORY_IDS = ['REMOTE_CAPTURE','AGENT_IDENTITY','RELEASE_CAPABILITIES'];
const INTELLIGENCE_GATE_IDS = ['I1','U1','W1','D1'];
const INTELLIGENCE_MANDATORY_IDS = ['PREFERENCES','DREAM_ENGINE','DREAM_SCHEDULER','DREAM_LEARNING','ADAPTIVE_SCHEDULER','WORKSPACE_DAILY_SUMMARY','WORKSPACE_SCOPED_INSIGHT','GLOBAL_PROFILE_CONSOLIDATION'];
export const PROFILE_REQUIREMENTS: Record<ReleaseProfileName, ProfileRequirements> = {
  'core-beta': { areas: ['STORAGE','MEMORY','QUERY','UNIX','PLATFORM','PERFORMANCE'], requiredGateIds: [...CORE_GATE_IDS], requiredMandatoryIds: [...CORE_MANDATORY_IDS] },
  'full-intelligence-beta': { areas: ['STORAGE','MEMORY','USER_INTELLIGENCE','WIKI','DREAM','QUERY','UNIX','INTELLIGENCE','PERFORMANCE','PLATFORM'], requiredGateIds: [...CORE_GATE_IDS, ...INTELLIGENCE_GATE_IDS], requiredMandatoryIds: [...CORE_MANDATORY_IDS, ...INTELLIGENCE_MANDATORY_IDS] },
  'ga': { areas: ['STORAGE','MEMORY','USER_INTELLIGENCE','WIKI','DREAM','QUERY','UNIX','INTELLIGENCE','PERFORMANCE','PLATFORM'], requiredGateIds: [...CORE_GATE_IDS, ...INTELLIGENCE_GATE_IDS], requiredMandatoryIds: [...CORE_MANDATORY_IDS, ...INTELLIGENCE_MANDATORY_IDS, 'PRODUCTION:PHYSICAL_POWER_LOSS','PRODUCTION:TRANSPORT_TLS','PRODUCTION:REMOTE_SERVER_RESTART','PRODUCTION:LIVE_OBJECT_STORE','PRODUCTION:LIVE_INTEGRATIONS','PRODUCTION:MCP_HTTP_SERVICE','PRODUCTION:OPENAI_MCP_TUNNEL','PRODUCTION:CHATGPT_HOSTED_MCP','PRODUCTION:CLAUDE_HOSTED_MCP','PRODUCTION:STANDALONE_INSTALL','PRODUCTION:REAL_USER_FEEDBACK','PRODUCTION:COLD_CACHE_BENCHMARK','PRODUCTION:REBOOT_PERSISTENCE'] },
};
export function requiredGateStatuses(profile: ReleaseProfileName, statuses: Record<string, string | undefined>): Array<{ id: string; status: string }> {
  const requirements = PROFILE_REQUIREMENTS[profile];
  return [...requirements.requiredGateIds, ...requirements.requiredMandatoryIds].map(id => ({ id, status: statuses[id] ?? 'NOT_RUN' }));
}
export interface PolicyInput {
  storageVerdict: string; openAreas: string[]; openGates: string[]; failedGates: string[]; evidence: ProductionEvidence[]; exclusions: unknown;
  profile?: ReleaseProfileName;
  requiredAreas?: Array<{ id: string; status: string }>;
  requiredGates?: Array<{ id: string; status: string }>;
  disabledFeatures?: string[];
  disabledFeaturesAttestation?: unknown;
  sourceFingerprint?: string;
  sourceCommit?: string;
}
export interface PolicyResult {
  level: ReleaseLevel; automatedGatesPass: boolean; failedGates: string[]; openAreas: string[]; openGates: string[];
  incompleteEvidence: ProductionEvidence[]; validExclusions: Exclusion[]; ignoredExclusions: Array<{ entry: unknown; problem: string }>; excludedEvidence: string[]; blockers: string[]; summary: string;
  profile?: ReleaseProfileName;
}

export interface ReleaseAuthorization {
  schemaVersion: 1;
  purpose: 'engram-release';
  sourceFingerprint: string;
  ref: string;
  commit: string;
  profile: ReleaseProfileName;
  releaseLevel: 'BETA' | 'GA_ELIGIBLE';
  approvedBy: string;
  approvedAt: string;
  signature: string;
}

/** Owner authorization is a detached, source/tag-bound signature; editable workflow inputs are not authority. */
export function verifyReleaseAuthorization(
  value: unknown,
  expected: { sourceFingerprint: string; ref: string; commit: string; profile: ReleaseProfileName; releaseLevel: 'BETA' | 'GA_ELIGIBLE' },
  publicKey: string | undefined,
  now = Date.now(),
): value is ReleaseAuthorization {
  const record = value as Partial<ReleaseAuthorization> | undefined;
  const at = typeof record?.approvedAt === 'string' ? Date.parse(record.approvedAt) : NaN;
  const age = now - at;
  return record?.schemaVersion === 1 && record.purpose === 'engram-release'
    && typeof record.approvedBy === 'string' && record.approvedBy.trim().length > 0
    && record.sourceFingerprint === expected.sourceFingerprint && record.ref === expected.ref
    && record.commit === expected.commit && record.profile === expected.profile && record.releaseLevel === expected.releaseLevel
    && Number.isFinite(at) && age >= -5 * 60_000 && age <= 7 * 24 * 3600_000
    && trustedSignature(record, publicKey, 'signature');
}

export interface SuiteEvidenceLike { suite?: string; treeState?: string; status?: string; exitCode?: number | null; counts?: { pass?: number; fail?: number; skipped?: number; total?: number }; tests?: Array<{ name?: string; status?: string; message?: string; detail?: string }>; cases?: number; caseDetails?: Array<{ name?: string; status?: string }>; caseFailures?: unknown[]; environment?: Record<string, unknown> }
export interface SuiteInventory { minimumTests: number; requiredTests: string[]; requiredCases: string[]; casesByPlatform?: Record<string, string[]>; allowedSkippedTests?: Record<string, Array<{ name: string; classificationId: string; classificationHash: string }>> }
/** A suite-level PASS cannot erase an individual skipped mandatory test. */
export function suiteEvidenceStatus(report: SuiteEvidenceLike | undefined): string {
  if (!report) return 'NOT_RUN';
  if (report.status === 'PASS' && report.tests?.some(test => test.status === 'SKIPPED')) return 'SKIPPED';
  return report.status ?? 'NOT_RUN';
}
export function suiteReportConsistent(report: SuiteEvidenceLike | undefined, inventory: SuiteInventory | undefined, allowPending = process.env.MDB_ALLOW_PENDING_SKIP_CLASSIFICATIONS === '1', profile?: ReleaseProfileName, requireTrustedTree = false): boolean {
  // Arithmetic consistency alone cannot establish suite completeness: an
  // attacker (or accidental partial run) can shrink tests and totals together.
  if (!inventory || !Number.isInteger(inventory.minimumTests) || inventory.minimumTests < 1
    || !Array.isArray(inventory.requiredTests) || !Array.isArray(inventory.requiredCases)
    || inventory.requiredTests.length === 0) return false;
  if (!report || requireTrustedTree && !['clean', 'no-git'].includes(String(report.treeState)) || report.treeState === 'dirty' || !Array.isArray(report.tests) || !Array.isArray(report.caseDetails) || !Array.isArray(report.caseFailures) || !report.counts) return false;
  const counts = report.counts;
  const actual = { pass: report.tests.filter(t => t.status === 'PASS').length, fail: report.tests.filter(t => t.status === 'FAIL').length, skipped: report.tests.filter(t => t.status === 'SKIPPED').length, total: report.tests.length };
  if (Object.keys(actual).some(k => counts[k as keyof typeof actual] !== actual[k as keyof typeof actual]) || report.cases !== report.caseDetails.length) return false;
  if (report.caseFailures.length !== report.caseDetails.filter(c => c.status === 'FAIL').length) return false;
  if (report.tests.some(t => !['PASS', 'FAIL', 'SKIPPED'].includes(String(t.status))) || report.caseDetails.some(c => !['PASS', 'FAIL'].includes(String(c.status)))) return false;
  const testNames = report.tests.map(t => typeof t.name === 'string' ? t.name : '');
  const caseNames = report.caseDetails.map(c => typeof c.name === 'string' ? c.name : '');
  if (testNames.some(n => typeof n !== 'string' || !n) || new Set(testNames).size !== testNames.length || caseNames.some(n => typeof n !== 'string' || !n) || new Set(caseNames).size !== caseNames.length) return false;
  const validCaseNames = caseNames;
  // The test list is an exact, reviewed inventory. A renamed, omitted, or newly
  // added mandatory test must invalidate evidence until the inventory is updated.
  if (report.tests.length !== inventory.minimumTests || !sameStrings(testNames, inventory.requiredTests)) return false;
  const platform = typeof report.environment?.platform === 'string' ? report.environment.platform : undefined;
  const allowedSkipped = platform ? inventory.allowedSkippedTests?.[platform] ?? [] : [];
  if (!Array.isArray(allowedSkipped)) return false;
  const allowedSkippedNames = new Set<string>();
  for (const item of allowedSkipped) {
    if (!item || typeof item.name !== 'string' || !item.name || typeof item.classificationId !== 'string' || !item.classificationId || typeof item.classificationHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.classificationHash)) return false;
    const classification = getSkipClassification(item.classificationId);
    if (!classification || !classification.platforms.includes(platform ?? '') || skipClassificationHash(classification) !== item.classificationHash || classification.test !== item.name || ('suite' in report && report.suite !== classification.suite) || !classification.reason.trim() || classification.reason === GENERIC_SKIP_REASON || classification.reason.length < 40) return false;
    if (classification.policyVersion !== RELEASE_POLICY_VERSION || classification.reviewedBy === 'pending-owner-review' && !allowPending) return false;
    if (profile && !classification.requiredByProfiles.includes(profile)) return false;
    allowedSkippedNames.add(item.name);
  }
  if (report.tests.some(t => t.status === 'SKIPPED' && !allowedSkippedNames.has(String(t.name)))) return false;
  if (allowedSkipped.some(item => !report.tests?.some(t => t.name === item.name && t.status === 'SKIPPED'))) return false;
  const expectedCases = platform && inventory.casesByPlatform?.[platform];
  if (inventory.casesByPlatform && (!platform || !expectedCases || !sameStrings(validCaseNames, expectedCases))) return false;
  if (!inventory.casesByPlatform && (inventory.requiredCases.some(n => !validCaseNames.includes(n)) || validCaseNames.some(n => !inventory.requiredCases.includes(n)))) return false;
  if (report.status === 'PASS') return report.exitCode === 0 && actual.fail === 0 && actual.skipped === 0 && report.caseFailures.length === 0 && actual.total > 0;
  if (report.status === 'FAIL') return report.exitCode !== 0 || actual.fail > 0 || report.caseFailures.length > 0;
  if (report.status === 'SKIPPED') return report.exitCode === 0 && actual.total > 0;
  return report.status === 'NOT_RUN' && actual.total === 0;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || actual.length !== expected.length) return false;
  const right = new Set(expected);
  return actual.every(value => right.has(value));
}

export function performanceSourceMatches(binding: { fingerprint?: string; fullSourceFileCount?: number; files?: Record<string, string>; workingTreeSourceFingerprint?: string; git_commit?: string; commit?: string } | undefined, current: { fingerprint: string; files: Record<string, string> }, required: string[], trusted?: Pick<TrustedProvenance, 'fingerprint' | 'commit'>): boolean {
  if (!binding || binding.fingerprint !== current.fingerprint || binding.workingTreeSourceFingerprint !== current.fingerprint || binding.fullSourceFileCount !== Object.keys(current.files).length) return false;
  if (trusted && (binding.fingerprint !== trusted.fingerprint || [binding.git_commit, binding.commit].filter(value => value !== undefined).length === 0 || [binding.git_commit, binding.commit].filter(value => value !== undefined).some(value => value !== trusted.commit))) return false;
  if (!binding.files || required.some(file => binding.files?.[file] !== current.files[file])) return false;
  return true;
}

export interface PerformanceMeasurement { p50Ms?: number; p95Ms?: number; p99Ms?: number; samples?: number }
/** Require actual finite distributions, a declared corpus/measurement count, and a recent timestamp. */
export function performanceMeasurementValid(input: { timestamp?: string; corpusDocuments?: number; measurementCount?: number; measured?: PerformanceMeasurement; thresholdMs?: number } | undefined, expectedCorpus: number, maxAgeMs = 30 * 24 * 3600_000, now = Date.now()): boolean {
  const at = typeof input?.timestamp === 'string' ? Date.parse(input.timestamp) : NaN;
  const age = now - at;
  const m = input?.measured;
  return Number.isFinite(at) && age >= 0 && age <= maxAgeMs
    && input?.corpusDocuments === expectedCorpus && Number.isInteger(input.measurementCount) && input.measurementCount! > 0
    && Number.isInteger(m?.samples) && m!.samples! > 0
    && [m?.p50Ms, m?.p95Ms, m?.p99Ms, input?.thresholdMs].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    && m!.p50Ms! <= m!.p95Ms! && m!.p95Ms! <= m!.p99Ms!;
}

/** Evidence the release depends on. Each item is PASS only with an evidence file whose own status is PASS (or the computed physical-host facts); otherwise NOT_RUN. */
export const PRODUCTION_EVIDENCE: Array<{ id: string; title: string; file?: string }> = [
  { id: 'PHYSICAL_POWER_LOSS', title: 'Physical power removal / volatile device-cache loss', file: 'verification/production/physical-power-loss.json' },
  { id: 'TRANSPORT_TLS', title: 'Remote capture over verified TLS (not only a private-network transport)' },
  { id: 'REMOTE_SERVER_RESTART', title: 'Server restart during a physical-host outage, with deduplicated recovery' },
  { id: 'LIVE_OBJECT_STORE', title: 'Real S3-compatible object store (not S3Mock)', file: 'verification/production/live-object-store.json' },
  { id: 'LIVE_INTEGRATIONS', title: 'Live Slack / web integrations', file: 'verification/production/live-integrations.json' },
  { id: 'MCP_HTTP_SERVICE', title: 'Private HTTP MCP authentication, ACL and revision operations', file: 'verification/remote-clients/http-service.json' },
  { id: 'OPENAI_MCP_TUNNEL', title: 'Dedicated Engram OpenAI outbound tunnel transport', file: 'verification/remote-clients/openai-tunnel.json' },
  { id: 'CHATGPT_HOSTED_MCP', title: 'Actual ChatGPT hosted MCP discovery, reads and supported writes', file: 'verification/remote-clients/chatgpt-hosted.json' },
  { id: 'CLAUDE_HOSTED_MCP', title: 'Actual Claude.ai hosted MCP discovery, reads and supported writes', file: 'verification/remote-clients/claude-hosted.json' },
  { id: 'STANDALONE_INSTALL', title: 'Standalone install from a distribution in a clean environment', file: 'verification/production/standalone-install.json' },
  { id: 'REAL_USER_FEEDBACK', title: 'Dream learning measured on real or human-reviewed feedback', file: 'verification/production/real-user-feedback.json' },
  { id: 'COLD_CACHE_BENCHMARK', title: 'Cold OS-cache benchmark runs', file: 'verification/production/cold-cache-benchmark.json' },
  { id: 'REBOOT_PERSISTENCE', title: 'Scheduler service survives login/reboot', file: 'verification/production/reboot-persistence.json' },
];

export interface PhysicalHostsReport { physicalHostVerified?: boolean; transport?: string; tlsVerified?: boolean; notRunOptional?: string[] }

type Signed = { signature?: string; attestationSignature?: string };
function freshAttestation(value: unknown, maxAgeMs = 7 * 24 * 3600_000): boolean {
  const at = (value as { observedAt?: string } | undefined)?.observedAt; const timestamp = typeof at === 'string' ? Date.parse(at) : NaN; const age = Date.now() - timestamp;
  return Number.isFinite(timestamp) && age >= -5 * 60_000 && age <= maxAgeMs;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'signature' && k !== 'attestationSignature').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function trustedSignature(value: unknown, publicKey?: string, field: 'signature' | 'attestationSignature' = 'attestationSignature'): boolean {
  const signature = (value as Signed | undefined)?.[field];
  if (!publicKey || !signature || !/^[A-Za-z0-9+/]+=*$/.test(signature)) return false;
  try { return verifySignature(null, Buffer.from(canonical(value)), createPublicKey(publicKey), Buffer.from(signature, 'base64')); } catch { return false; }
}

/** Layers are independent: a local or HTTPS probe cannot certify a hosted product. */
export function mcpEvidenceComplete(id: string, value: unknown): boolean {
  const r = value as { evidenceType?: string; layer?: string; product?: string; observedAt?: string; evidence?: string[]; evidenceHashes?: Record<string, string>; checks?: Record<string, boolean> } | undefined;
  const observed = r?.observedAt ? Date.parse(r.observedAt) : NaN;
  if (!r || !Number.isFinite(observed) || observed > Date.now() + 5 * 60_000 || Date.now() - observed > 7 * 24 * 3600_000 || !Array.isArray(r.evidence) || !r.evidence.length || !r.evidence.every(x => typeof x === 'string' && x.trim().length > 0 && /^[a-f0-9]{64}$/.test(r.evidenceHashes?.[x] ?? ''))) return false;
  const common = ['discovery', 'authorizedRead', 'rejectedAccess', 'clientIsolation'];
  const requirements = id === 'MCP_HTTP_SERVICE' ? ['loopbackHttp', ...common, 'versionedWrite']
    : id === 'OPENAI_MCP_TUNNEL' ? ['outboundOnly', 'dedicatedEngramProfile', 'agentSlackUnchanged', 'upstreamHttp', 'oauthDiscovery', 'tokenForwarding', ...common]
      : ['actualHostedInvocation', ...common, 'versionedWrite'];
  const layer = id === 'MCP_HTTP_SERVICE' ? 'http-service' : id === 'OPENAI_MCP_TUNNEL' ? 'openai-tunnel' : 'hosted-client';
  const product = id === 'CHATGPT_HOSTED_MCP' ? 'chatgpt' : id === 'CLAUDE_HOSTED_MCP' ? 'claude.ai' : undefined;
  const type = id === 'MCP_HTTP_SERVICE' ? 'http-service' : id === 'OPENAI_MCP_TUNNEL' ? 'openai-mcp-tunnel' : id === 'CHATGPT_HOSTED_MCP' ? 'chatgpt-hosted-mcp' : 'claude-hosted-mcp';
  return r.evidenceType === type && r.layer === layer && (!product || r.product === product) && requirements.every(check => r.checks?.[check] === true);
}

function evidenceBytesMatch(record: unknown, root: string): boolean {
  const r = record as { evidence?: string[]; evidenceHashes?: Record<string, string> } | undefined;
  if (!Array.isArray(r?.evidence) || !r.evidenceHashes) return false;
  try {
    const base = realpathSync(root);
    return r.evidence.every(name => {
      if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) return false;
      const file = path.resolve(base, name); const rel = path.relative(base, file);
      if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || lstatSync(file).isSymbolicLink()) return false;
      const actual = realpathSync(file); const actualRel = path.relative(base, actual);
      if (actualRel.startsWith(`..${path.sep}`) || path.isAbsolute(actualRel)) return false;
      return createHash('sha256').update(readFileSync(actual)).digest('hex') === r.evidenceHashes?.[name];
    });
  } catch { return false; }
}

/** `readJson` returns undefined for a missing or unreadable file. Only a recorded `status: "PASS"` counts. */
export function collectProductionEvidence(readJson: (file: string) => unknown, physical: PhysicalHostsReport | undefined, root = process.cwd(), currentFiles?: Record<string, string>, trustedPublicKey?: string, trusted?: Pick<TrustedProvenance, 'fingerprint' | 'commit'>): ProductionEvidence[] {
  return PRODUCTION_EVIDENCE.map(({ id, title, file }) => {
    if (id === 'TRANSPORT_TLS') {
      const ok = physical?.physicalHostVerified === true && physical.tlsVerified === true && freshAttestation(physical) && evidenceBytesMatch(physical, root) && sourceEvidenceMatches(physical as never, currentFiles ?? {}, trusted) && trustedSignature(physical, trustedPublicKey);
      return { id, title, status: ok ? 'PASS' : physical?.physicalHostVerified ? 'INCOMPLETE' : 'NOT_RUN', source: 'verification/memory/physical-hosts.json',
        detail: ok ? 'Physical hosts verified with TLS.' : physical?.physicalHostVerified ? `Physical hosts verified over ${physical.transport ?? 'an unknown transport'}; TLS was NOT tested.` : 'No physical-host evidence.' };
    }
    if (id === 'REMOTE_SERVER_RESTART') {
      const restart = (physical as (PhysicalHostsReport & { restartDuringOutage?: { status?: string; observedAt?: string; evidence?: string[]; evidenceHashes?: Record<string, string> } }) | undefined)?.restartDuringOutage;
      const ok = physical?.physicalHostVerified === true && restart?.status === 'PASS' && freshAttestation(restart) && Array.isArray(restart.evidence) && restart.evidence.length > 0 && evidenceBytesMatch(restart, root) && trustedSignature(restart, trustedPublicKey) && sourceEvidenceMatches(restart as never, currentFiles ?? {}, trusted);
      return { id, title, status: ok ? 'PASS' : physical?.physicalHostVerified ? 'INCOMPLETE' : 'NOT_RUN', source: 'verification/memory/physical-hosts.json', detail: ok ? 'Physical outage restart has an explicit PASS and hash-verified evidence.' : 'Physical-host evidence does not contain an explicit, hash-verified server-restart-during-outage PASS.' };
    }
    const recorded = file ? readJson(file) as { status?: string; detail?: string; evidenceType?: string } | undefined : undefined;
    const mcp = ['MCP_HTTP_SERVICE', 'OPENAI_MCP_TUNNEL', 'CHATGPT_HOSTED_MCP', 'CLAUDE_HOSTED_MCP'].includes(id);
    const signedAttestationRequired = id !== 'MCP_HTTP_SERVICE';
    const validSource = sourceEvidenceMatches(recorded as never, currentFiles ?? {}, trusted);
    const validMcp = !mcp || mcpEvidenceComplete(id, recorded) && evidenceBytesMatch(recorded, root) && validSource && (!signedAttestationRequired || trustedSignature(recorded, trustedPublicKey));
    const typed = recorded?.evidenceType === id.toLowerCase().replaceAll('_', '-');
    const validRecord = mcp ? validMcp : typed && freshAttestation(recorded) && validSource && evidenceBytesMatch(recorded, root) && (!signedAttestationRequired || trustedSignature(recorded, trustedPublicKey));
    const status: EvidenceStatus = recorded?.status === 'PASS' ? !validRecord ? 'INCOMPLETE' : 'PASS' : recorded?.status === 'FAIL' ? 'FAIL' : recorded?.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'NOT_RUN';
    return { id, title, status, source: file ?? '-', detail: mcp && recorded?.status === 'PASS' && !validMcp ? 'Recorded PASS lacks fresh, hash-verified evidence for this MCP layer.' : recorded?.detail ?? (recorded ? `Recorded status ${recorded.status ?? 'missing'}.` : `No evidence file ${file}.`) };
  });
}

/** An exclusion counts only if it names a known evidence item and records who approved it, why and when. */
export interface TrustedExclusionContext { fingerprint: string; commit: string; profile: ReleaseProfileName; policyVersion: string }
export function validateExclusions(raw: unknown, knownIds: string[], trustedPublicKey: string | undefined, trusted: TrustedExclusionContext, now = Date.now()): { valid: Exclusion[]; ignored: Array<{ entry: unknown; problem: string }> } {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { exclusions?: unknown }).exclusions) ? (raw as { exclusions: unknown[] }).exclusions : [];
  const valid: Exclusion[] = []; const ignored: Array<{ entry: unknown; problem: string }> = [];
  const idCounts = new Map<string, number>(); const nonceCounts = new Map<string, number>();
  for (const entry of entries) if (entry && typeof entry === 'object') {
    const value = entry as Partial<Exclusion>;
    if (typeof value.id === 'string') idCounts.set(value.id, (idCounts.get(value.id) ?? 0) + 1);
    if (typeof value.nonce === 'string') nonceCounts.set(value.nonce, (nonceCounts.get(value.nonce) ?? 0) + 1);
  }
  for (const entry of entries) {
    try {
      const e = entry as Partial<Exclusion> | null; const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
      if (!e || typeof e !== 'object' || Array.isArray(e)) ignored.push({ entry, problem: 'not an object' });
      else if (!text(e.id) || !knownIds.includes(e.id)) ignored.push({ entry, problem: 'unknown evidence id' });
      else if ((idCounts.get(e.id) ?? 0) > 1) ignored.push({ entry, problem: 'duplicate exclusion id' });
      else if (!text(e.nonce)) ignored.push({ entry, problem: 'nonce is required' });
      else if ((nonceCounts.get(e.nonce) ?? 0) > 1) ignored.push({ entry, problem: 'duplicate exclusion nonce' });
      else if (!text(e.approvedBy) || !text(e.reason)) ignored.push({ entry, problem: 'approvedBy and reason are required' });
      else if (!/^[a-f0-9]{64}$/.test(e.sourceFingerprint ?? '') || !/^[a-f0-9]{40,64}$/.test(e.git_commit ?? '')) ignored.push({ entry, problem: 'source fingerprint or commit is malformed' });
      else if (!text(e.approvedAt) || !Number.isFinite(Date.parse(e.approvedAt)) || new Date(Date.parse(e.approvedAt)).toISOString() !== e.approvedAt || Date.parse(e.approvedAt) > now || !text(e.expiresAt) || !Number.isFinite(Date.parse(e.expiresAt)) || new Date(Date.parse(e.expiresAt)).toISOString() !== e.expiresAt || Date.parse(e.expiresAt) < now || Date.parse(e.expiresAt) < Date.parse(e.approvedAt) || Date.parse(e.expiresAt) - Date.parse(e.approvedAt) > 90 * 24 * 3600_000) ignored.push({ entry, problem: 'approval or expiry timestamp is invalid or outside the 90-day window' });
      else if (e.sourceFingerprint !== trusted.fingerprint || e.git_commit !== trusted.commit || e.profile !== trusted.profile || e.profile !== 'ga' || e.policyVersion !== trusted.policyVersion || trusted.policyVersion !== RELEASE_POLICY_VERSION) ignored.push({ entry, problem: 'exclusion provenance or policy version does not match the evaluated GA source' });
      else if (!trustedSignature(e, trustedPublicKey, 'signature')) ignored.push({ entry, problem: 'owner approval signature is missing or invalid' });
      else { valid.push(e as Exclusion); }
    } catch { ignored.push({ entry, problem: 'exclusion validation failed closed' }); }
  }
  return { valid, ignored };
}

const CORE_DISABLED_FEATURES = ['adaptive-intelligence', 'dream', 'preferences', 'wiki'];
export function coreFeatureProfileValid(input: PolicyInput, trustedPublicKey?: string): boolean {
  if (input.profile !== 'core-beta') return true;
  const record = input.disabledFeaturesAttestation as { profile?: string; sourceFingerprint?: string; disabledFeatures?: string[]; artifacts?: Record<string, string>; observedAt?: string; git_commit?: string; commit?: string } | undefined;
  return record?.profile === 'core-beta'
    && !!input.sourceFingerprint && record.sourceFingerprint === input.sourceFingerprint
    && !!input.sourceCommit && (record.git_commit ?? record.commit) === input.sourceCommit
    && freshAttestation(record)
    && sameStrings(record.disabledFeatures ?? [], CORE_DISABLED_FEATURES)
    && !!record.artifacts && Object.keys(record.artifacts).length > 0
    && Object.values(record.artifacts).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    && trustedSignature(record, trustedPublicKey);
}

export function releaseCapabilitiesValid(value: unknown, profile: ReleaseProfileName, fingerprint: string, commit: string, trustedPublicKey?: string): boolean {
  const record = value as { profile?: string; sourceFingerprint?: string; fingerprint?: string; source?: { fingerprint?: string }; disabledFeatures?: string[]; artifacts?: Record<string, string>; observedAt?: string; git_commit?: string; commit?: string } | undefined;
  const commits = [record?.git_commit, record?.commit].filter((value): value is string => value !== undefined);
  const fingerprints = [record?.sourceFingerprint, record?.fingerprint, record?.source?.fingerprint].filter((value): value is string => value !== undefined);
  if (!record || record.profile !== profile || fingerprints.length === 0 || fingerprints.some(value => value !== fingerprint) || commits.length === 0 || commits.some(value => value !== commit) || !freshAttestation(record)) return false;
  if (!Array.isArray(record.disabledFeatures) || record.disabledFeatures.some(name => typeof name !== 'string' || !name.trim())) return false;
  if (!record.artifacts || Object.keys(record.artifacts).length === 0 || Object.values(record.artifacts).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return false;
  if (profile === 'core-beta' && !coreFeatureProfileValid({ profile, sourceFingerprint: fingerprint, sourceCommit: commit, storageVerdict: '', openAreas: [], openGates: [], failedGates: [], evidence: [], exclusions: [], disabledFeaturesAttestation: value }, trustedPublicKey)) return false;
  return trustedSignature(record, trustedPublicKey);
}

export function classifyRelease(input: PolicyInput, trustedPublicKey?: string): PolicyResult {
  const profile = input.profile ?? 'ga';
  const trusted = { fingerprint: input.sourceFingerprint ?? '', commit: input.sourceCommit ?? '', profile, policyVersion: RELEASE_POLICY_VERSION };
  const { valid, ignored } = profile === 'ga'
    ? validateExclusions(input.exclusions, input.evidence.map(e => e.id), trustedPublicKey, trusted)
    : { valid: [] as Exclusion[], ignored: [] as Array<{ entry: unknown; problem: string }> };
  const excludedIds = new Set(valid.map(e => e.id));
  const incomplete = input.evidence.filter(e => e.status !== 'PASS' && !excludedIds.has(e.id));
  const failedEvidence = incomplete.filter(e => e.status === 'FAIL');
  const requiredAreaProblems = (input.requiredAreas ?? []).filter(a => a.status !== 'PASS');
  const requiredGateProblems = (input.requiredGates ?? []).filter(g => g.status !== 'PASS');
  const featureProfileValid = coreFeatureProfileValid(input, trustedPublicKey);
  const automatedGatesPass = input.storageVerdict === 'PASS' && !input.openAreas.length && !input.openGates.length && !input.failedGates.length && !requiredAreaProblems.length && !requiredGateProblems.length && featureProfileValid;
  const hardFail = input.storageVerdict !== 'PASS' || input.failedGates.length > 0 || failedEvidence.length > 0 || input.openAreas.length > 0 || input.openGates.length > 0 || requiredAreaProblems.length > 0 || requiredGateProblems.length > 0 || !featureProfileValid || (profile === 'ga' && incomplete.length > 0);
  const blockers = [...input.failedGates.map(g => `gate ${g} FAIL`), ...input.openAreas.map(a => `area ${a} not PASS`), ...input.openGates.map(g => `mandatory gate ${g} not PASS`), ...requiredAreaProblems.map(a => `profile ${profile} requires area ${a.id} PASS (got ${a.status})`), ...requiredGateProblems.map(g => `profile ${profile} requires gate ${g.id} PASS (got ${g.status})`), ...(!featureProfileValid ? ['profile core-beta requires a trusted, current-source signed disabled capability attestation with artifact hashes'] : []), ...incomplete.map(e => `production evidence ${e.id} ${e.status}`)];
  const level: ReleaseLevel = hardFail ? 'NOT_RELEASABLE' : automatedGatesPass && !incomplete.length ? 'GA_ELIGIBLE' : 'BETA';
  const summary = level === 'GA_ELIGIBLE' ? 'GA-eligible: every automated gate passes and every production-evidence item is PASS or has a valid owner-approved exclusion. This is eligibility only; the release decision belongs to the owner.'
    : level === 'BETA' ? `BETA: ${blockers.length} open item(s) block GA. Passing the automated gates does not imply GA readiness.` : `NOT RELEASABLE: ${blockers.filter(b => /FAIL/.test(b) || /^area STORAGE/.test(b)).join('; ') || 'storage is not PASS'}.`;
  return { level, profile, automatedGatesPass, failedGates: input.failedGates, openAreas: input.openAreas, openGates: input.openGates, incompleteEvidence: incomplete, validExclusions: valid, ignoredExclusions: ignored, excludedEvidence: [...excludedIds], blockers, summary };
}
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getSkipClassification, skipClassificationHash, GENERIC_SKIP_REASON } from './skip-classifications.js';
