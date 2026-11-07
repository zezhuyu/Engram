export interface DreamCandidateStatus { status: string; flags?: string[] }

/** Only pending/approved candidates can count as usable output; rejected hypotheses are not results. */
export function isUsableDreamCandidate(candidate: DreamCandidateStatus): boolean {
  return candidate.status !== 'rejected' && !(candidate.flags ?? []).includes('not_selected');
}

export interface DreamScenarioQuality {
  quality: number;
  dimensions: Record<string, boolean>;
}

export type DreamExpectedOutcome = 'candidate' | 'abstention';
export type DreamScenarioOutcome = 'candidate_produced' | 'candidate_missing' | 'justified_abstention' | 'unexpected_candidate' | 'incomplete';

/**
 * Score whether the run produced the scenario's declared kind of output.
 * An abstention only qualifies when the provider actually ran, the job
 * completed, no proposal was persisted, and the trace records a valid explicit
 * abstention/decoy suppression. A rejected or malformed proposal is not an
 * abstention and cannot pass this check.
 */
export function dreamScenarioOutcome(input: {
  expected: DreamExpectedOutcome;
  jobStatus: unknown;
  providerCalls: unknown;
  candidateCount: unknown;
  usableCandidateCount: unknown;
  skippedReasons: unknown;
}): DreamScenarioOutcome {
  if (input.jobStatus !== 'complete' || !Number.isInteger(input.providerCalls) || Number(input.providerCalls) < 1
    || !Number.isInteger(input.candidateCount) || Number(input.candidateCount) < 0
    || !Number.isInteger(input.usableCandidateCount) || Number(input.usableCandidateCount) < 0
    || !Array.isArray(input.skippedReasons) || input.skippedReasons.some(reason => typeof reason !== 'string')) return 'incomplete';
  if (input.expected === 'candidate') return Number(input.usableCandidateCount) > 0 ? 'candidate_produced' : 'candidate_missing';
  if (input.expected !== 'abstention') return 'incomplete';
  if (Number(input.candidateCount) > 0 || Number(input.usableCandidateCount) > 0) return 'unexpected_candidate';
  return (input.skippedReasons as string[]).some(reason => reason === 'model_abstained' || reason === 'lexical_decoy_suppressed')
    ? 'justified_abstention' : 'incomplete';
}

export type DreamNegativeControlOutcome = 'justified_abstention' | 'rejected_unsupported_candidates' | 'usable_candidate_leak' | 'incomplete';

/** Classify negative controls without treating a valid abstention as malformed generation. */
export function dreamNegativeControlOutcome(input: {
  jobStatus: unknown;
  providerCalls: unknown;
  minimumProviderCalls: number;
  expectedUsableCandidates: number;
  usableCandidates: number;
  unsupportedCandidates: number;
}): DreamNegativeControlOutcome {
  if (input.jobStatus !== 'complete' || !Number.isInteger(input.providerCalls)
    || Number(input.providerCalls) < input.minimumProviderCalls) return 'incomplete';
  if (input.usableCandidates > input.expectedUsableCandidates) return 'usable_candidate_leak';
  if (input.expectedUsableCandidates === 0 && input.usableCandidates === 0) {
    return input.unsupportedCandidates === 0 ? 'justified_abstention' : 'rejected_unsupported_candidates';
  }
  return input.usableCandidates === input.expectedUsableCandidates ? 'justified_abstention' : 'incomplete';
}

export function dreamNegativeControlsPass(
  results: Array<{ id?: unknown; run?: unknown; status?: unknown; providerCalls?: unknown; usableCandidates?: unknown; unsupportedCandidates?: unknown }>,
  expectedIds: string[],
  expectedRuns: number,
): boolean {
  if (!Number.isInteger(expectedRuns) || expectedRuns < 1 || expectedIds.length === 0) return false;
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length || results.length !== expected.size * expectedRuns) return false;
  const observed = new Set<string>();
  for (const result of results) {
    if (typeof result.id !== 'string' || !expected.has(result.id)
      || !Number.isInteger(result.run) || Number(result.run) < 1 || Number(result.run) > expectedRuns
      || result.status !== 'PASS' || !Number.isInteger(result.providerCalls) || Number(result.providerCalls) < 1
      || result.usableCandidates !== 0 || !Number.isInteger(result.unsupportedCandidates) || result.unsupportedCandidates !== 0) return false;
    const key = `${result.id}\0${result.run}`;
    if (observed.has(key)) return false;
    observed.add(key);
  }
  return observed.size === expected.size * expectedRuns;
}

/** Acceptance-facing heuristic guard. Semantic adjudication remains a separate required gate. */
export function dreamHeuristicQualityPass(input: {
  runs: number;
  minimumRuns: number;
  minimumScenarioQuality: number;
  scenarios: DreamScenarioQuality[];
  meanQualityPerModePass: boolean;
  minimumCitationIntegrity: number;
  minimumEvidenceGrounding: number;
  criticAdversarialRejectionRecall: number;
  minimumCriticRejectionRecall: number;
  criticSupportedAcceptanceRate: number;
  minimumCriticSupportedAcceptanceRate: number;
}): boolean {
  return Number.isFinite(input.runs) && input.runs >= input.minimumRuns
    && input.scenarios.length > 0
    && input.meanQualityPerModePass
    && input.minimumCitationIntegrity >= input.minimumEvidenceGrounding
    && input.criticAdversarialRejectionRecall >= input.minimumCriticRejectionRecall
    && input.criticSupportedAcceptanceRate >= input.minimumCriticSupportedAcceptanceRate
    && input.scenarios.every(row => Number.isFinite(row.quality)
      && row.quality >= input.minimumScenarioQuality
      && row.dimensions.contradictionHandling === true
      && row.dimensions.unattributedUniversalClaimAbsent === true);
}

const TRACE_STOP = new Set(['about', 'after', 'again', 'also', 'among', 'because', 'could', 'from', 'into', 'might', 'should', 'that', 'their', 'these', 'this', 'through', 'under', 'where', 'which', 'while', 'with', 'would', 'hypothesis', 'speculative', 'possibly']);
const claimTokens = (value: string): string[] => [...new Set((value.toLocaleLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) ?? []).filter(token => !TRACE_STOP.has(token)))];

const stem = (word: string): string => {
  if (word.endsWith('ing') && word.length > 5) {
    const base = word.slice(0, -3);
    return base.endsWith('ch') || base.endsWith('sh') || base.endsWith('x') ? `${base}e` : base;
  }
  if (word.endsWith('tion') && word.length > 7) return `${word.slice(0, -4)}t`;
  if (word.endsWith('s') && word.length > 4) return word.slice(0, -1);
  return word;
};

/** Conservative lexical rubric for the labeled contradictory-cache case; not semantic adjudication. */
export function dreamContradictionHandled(body: string): boolean {
  const sentences = body.split(/(?<=[.!?\n])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  const claims = sentences.flatMap(sentence => sentence.split(/[,;]\s*/).map(claim => claim.trim()));
  const namesConflict = /\b(?:conflict|contradict(?:s|ed|ory)?|disagree(?:s|d)?)\b/i.test(body);
  // The evaluator's narrow rubric requires two separately represented, opposed
  // cache claims. A nearby negation or the word "cannot" must not stand in for
  // an unresolved status, and synonyms such as "risky" are not silently
  // promoted to the labeled unsafe-cache claim.
  const hasCache = (sentence: string) => /\bcach(?:e|es|ed|ing)\b/i.test(sentence);
  const safeClaim = claims.some(claim => hasCache(claim) && /\b(?:safe|secure)\b/i.test(claim) && !/\b(?:unsafe|insecure)\b/i.test(claim));
  const unsafeClaim = claims.some(claim => hasCache(claim) && (/\b(?:unsafe|insecure|leak(?:s|ed|ing)?|expos(?:e|es|ed|ing))\b/i.test(claim)
    || /\b(?:must|should|may|can|could|will|shall)\s+not\s+(?:be\s+)?cach(?:e|ed|ing)\b|\bnever\s+cach(?:e|ed|ing)\b/i.test(claim)));
  const explicitlyUnresolved = sentences.some(sentence =>
    /\b(?:remains?|stays?|is|are)\s+(?:unresolved|uncertain|unclear)\b/i.test(sentence)
    || /\b(?:uncertain|unclear)\s+(?:which|whether|how)\b/i.test(sentence),
  );
  const negatedUnresolved = /\b(?:not|never|no longer)\s+(?:remain(?:s)?\s+)?(?:unresolved|uncertain|unclear)\b|\bresolved\b/i.test(body);
  return namesConflict && safeClaim && unsafeClaim && explicitlyUnresolved && !negatedUnresolved;
}

const UNIVERSAL_CLAIM = /(always safe|never leaks?|verified fact|proven that|guaranteed)/i;
const ATTRIBUTION = /(claim|claims|says|said|states|stated|asserts?|according|source|note|page|finding|quote|"|\u201c|\*)/i;

/**
 * This is a narrow rubric guard, not semantic adjudication. Universal language
 * quoted or explicitly labeled as source evidence is reported content; it is
 * not the candidate asserting that the universal is true.
 */
export function dreamHasUnsupportedUniversalClaim(body: string): boolean {
  return body.split(/(?<=[.!?\n])\s+/).some(sentence => UNIVERSAL_CLAIM.test(sentence)
    && !ATTRIBUTION.test(sentence)
    && !/^\s*fact\s*\d*\s*:/i.test(sentence));
}

export function dreamTextMatchesTerms(value: string, required: string[]): boolean {
  const words = new Set(claimTokens(value).flatMap(token => [token, stem(token)]));
  const matches = required.filter(term => {
    const normalized = claimTokens(term).map(stem);
    return normalized.length > 0 && normalized.every(word => words.has(word));
  }).length;
  return required.length > 0 && (matches === required.length || required.length > 1 && matches >= Math.ceil(required.length / 2));
}

/** Lexical warning for factual metadata restatements; it does not establish semantic entailment. */
export function dreamMetadataClaimsTraceable(metadata: Record<string, unknown>, sources: string[], minimumOverlap = 0.5): boolean {
  // Mechanisms and hops are inferential by contract. Only `facts` are presented
  // as source facts, so lexical overlap must not reject a novel hypothesis.
  const corpus = new Set(sources.flatMap(claimTokens).map(stem));
  const value = metadata.facts;
  const claims = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  for (const claim of claims) {
    const tokens = claimTokens(claim).map(stem);
    if (tokens.length && tokens.filter(token => corpus.has(token)).length / tokens.length < minimumOverlap) return false;
  }
  return true;
}

/**
 * Fraction of rubric dimensions a scenario satisfied. A scenario that produced no candidate scores exactly 0: a dimension that is vacuously true
 * without a proposal (for example contradiction handling outside the contradiction scenario) must never earn credit for missing output.
 */
export function dreamDimensionQuality(dimensions: Record<string, boolean>, proposalPresent: boolean): number {
  const names = Object.keys(dimensions);
  if (!proposalPresent || !names.length) return 0;
  return names.filter(name => dimensions[name] === true).length / names.length;
}
