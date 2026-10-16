export interface DreamCandidateStatus { status: string; flags?: string[] }

/** Only pending/approved candidates can count as usable output; rejected hypotheses are not results. */
export function isUsableDreamCandidate(candidate: DreamCandidateStatus): boolean {
  return candidate.status !== 'rejected' && !(candidate.flags ?? []).includes('not_selected');
}
