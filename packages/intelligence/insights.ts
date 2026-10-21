import { MDBError, type Document, type Evidence, type PutInput, type Scope } from '../core/types.js';
import { objectIdFromUri, type Vault } from '../core/vault.js';
import { classifySource, SOURCE_PRIORITY, type SourceClass } from '../core/evidence.js';
import { guarded } from '../search-files/navigation.js';
import { loadDocuments, readableEntries, scopeEqual } from './corpus.js';

export const CATEGORIES = ['preference', 'goal', 'interest', 'capability', 'working_style', 'knowledge_gap'] as const;
export type InsightCategory = (typeof CATEGORIES)[number];
/** explicit: the user said it. inferred: derived from what the user wrote or did. exposure: the user was exposed to a topic. hypothesis: agent-derived, awaiting the user. */
export type InsightEvidenceClass = 'explicit' | 'inferred' | 'exposure' | 'hypothesis';
export interface InsightSource { uri: string; revisionId: string; class: SourceClass; speaker?: string; span?: string }
export interface InsightEval { verdict: 'accept' | 'reject' | 'review_required'; rationale: string; flags: string[]; patch: Record<string, unknown>; supersede: string[] }
const KEY = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const FREE_TEXT_CORRECTION = /\b(?:actually|correction|i meant|i was wrong|i changed my mind|from now on|going forward|no longer|not anymore|instead of|rather than)\b/i;
const NO_INSIGHT_CLAIM = /^\s*(?:no\s+(?:(?:enduring|lasting|user)\s+)*(?:insight|preference|proposal)|no\s+insight\s+(?:is\s+)?proposed|no\s+proposal\b)/i;
const MULTIPLE_INSIGHTS = /\b(?:and|;)\s+(?:the\s+user\s+)?(?:prefers?|likes?|wants?|needs?|can|is\s+interested|has\s+experience|plans?|aims?)\b/i;
const USER_OPTOUT = /\bforget\s+this\b|\b(?:do not|don't|never)\s+(?:(?:want|wish)\s+(?:you\s+to\s+)?)?(?:save|store|remember|retain|infer|derive)\s+(?:it|this(?:\s+conversation)?|that|anything|anywhere|a\s+(?:lasting|long[- ]term)\s+(?:preference|memory))\b/i;
const BROAD_USER_OPTOUT = /\bforget\s+this\b|\b(?:do not|don't|never)\s+(?:(?:want|wish)\s+(?:you\s+to\s+)?)?(?:save|store|remember|retain|infer|derive)\s+(?:anything|everything|this(?:\s+conversation)?|it\s+anywhere|it\s+at\s+all|a\s+(?:lasting|long[- ]term)\s+(?:preference|memory)|anywhere)\b|\b(?:do not|don't|never)\s+want\s+(?:a\s+)?(?:lasting|long[- ]term)\s+(?:preference|memory)\s+(?:inferred|derived|remembered|stored)\b/i;
const HYPOTHETICAL = /\b(?:hypothetically|say\s+(?:if\s+)?i\s+(?:had|were|was|could)|if\s+i\s+(?:had|were|was|could))\b/i;
const TEMPORARY = /\b(?:this\s+once|just\s+this\s+time|only\s+this\s+time|for\s+now|temporarily|one[- ]time|this\s+time\s+only|in\s+a\s+hurry)\b/i;
const NO_PERSONAL_STANCE = /\b(?:i\s+(?:do not|don't|have no|haven't (?:formed|made))\s+(?:(?:have|any|a)\s+)*(?:preference|view|opinion)|i\s+have\s+no\s+(?:view|opinion)|no\s+(?:personal\s+)?preference\s+(?:about|on|for)|not\s+decided\s+whether\s+i\s+prefer|undecided\s+whether\s+i\s+prefer|i\s+haven't\b[^.!?\n]{0,80}\b(?:formed|made)\s+(?:an?\s+)?(?:preference|view|opinion))\b/i;
const TOPIC_EXPOSURE = /\b(?:read|heard|saw|watched|skimmed|came across|learned about|looked at)\b.{0,120}\b(?:article|talk|video|post|paper|about|on)\b/i;
const THIRD_PARTY_ONLY = /\b(?:vendor|teammate|colleague|coworker|friend|customer|client|manager|partner|someone else)\b.{0,240}\b(?:nothing to do with my|not my (?:own )?(?:preference|habit|choice)|does not reflect my|doesn't reflect my)\b/i;
const STOP_TERMS = new Set(['user', 'prefers', 'prefer', 'likes', 'wants', 'needs', 'using', 'rather', 'instead', 'changed', 'actually', 'explicitly', 'earlier', 'having', 'would', 'should', 'could', 'from', 'with', 'that', 'this', 'their', 'about', 'when', 'then', 'only', 'also', 'than', 'the', 'a', 'an', 'and', 'or', 'but', 'are', 'is', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did', 'of', 'to', 'in', 'on', 'as', 'by', 'at', 'me', 'my', 'i', 'we', 'our', 'be', 'been', 'being', 'assistant']);
const salientTerms = (text: string): Set<string> => new Set(normalize(text).split(' ').filter(word => word.length >= 4 && !STOP_TERMS.has(word)));
const markerTargetsClaim = (body: string, marker: RegExp, key: string, claim: string): boolean => {
  const claimTerms = normalize(`${key.replace(/[-_.]/g, ' ')} ${claim}`).split(' ').filter(word => word.length >= 3 && !STOP_TERMS.has(word));
  return body.split(/(?<=[.!?;])\s+|\n+/).some(part => marker.test(part) && normalize(part).split(' ').some(term => term.length >= 3 && claimTerms.includes(term)));
};
const optedOut = (body: string, key: string, claim: string): boolean => BROAD_USER_OPTOUT.test(body) || markerTargetsClaim(body, USER_OPTOUT, key, claim);
const correctionApplies = (text: string, key: string, claim: string): boolean => {
  const marker = FREE_TEXT_CORRECTION.exec(text); if (!marker || marker.index === undefined) return false;
  const tail = normalize(text.slice(marker.index, marker.index + 240));
  const terms = normalize(`${key.replace(/[-_.]/g, ' ')} ${claim}`).split(' ').filter(word => word.length >= 4 && !['user', 'prefers', 'prefer', 'likes', 'wants', 'needs', 'changed', 'actually', 'rather', 'instead'].includes(word));
  return terms.some(term => tail.includes(term));
};
export const normalize = (text: string): string => text.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
const spanFound = (body: string, span: string): boolean => {
  if (span.length < 4) return false;
  // Exact substring matching still accepts a quote cut off mid-word (for
  // example, "request" from "requests"). Require word boundaries at both
  // ends while preserving punctuation and casing inside the cited phrase.
  const word = /[\p{L}\p{N}_]/u;
  let from = 0;
  while (true) {
    const at = body.indexOf(span, from);
    if (at < 0) return false;
    const before = at > 0 ? body[at - 1] : undefined;
    const after = body[at + span.length];
    if ((!before || !word.test(before)) && (!after || !word.test(after))) return true;
    from = at + 1;
  }
};
/** Repair only a model-added sentence terminator when the remaining quote is an exact, word-bounded source span. */
export function repairTerminalCitationPunctuation(body: string, span: string): string {
  if (spanFound(body, span)) return span;
  const repaired = span.replace(/[.!?]+$/u, '');
  return repaired.length >= 4 && spanFound(body, repaired) ? repaired : span;
}
const reject = (rationale: string, ...flags: string[]): InsightEval => ({ verdict: 'reject', rationale, flags, patch: {}, supersede: [] });
/** Where an insight applies: its scopeLabel, or the storage scope for legacy objects. */
export const applicability = (d: Pick<Document, 'scope' | 'metadata'>): string => (typeof d.metadata.scopeLabel === 'string' ? d.metadata.scopeLabel : d.scope.type === 'global' ? 'global' : d.scope.workspaceId);
export const isInsight = (doc: Pick<Document, 'kind' | 'metadata'>): boolean => doc.kind === 'user_insight' && doc.metadata.insightSchema === 1;

/**
 * Deterministic evidence rules for a proposed user insight. The model's own claims about its evidence are never trusted:
 * source classes, speakers, the evidence class and the confidence label are recomputed here from the cited objects.
 */
export async function evaluateInsight(vault: Vault, input: PutInput): Promise<InsightEval> {
  const meta = input.metadata ?? {};
  const category = String(meta.category ?? '');
  if (!CATEGORIES.includes(category as InsightCategory)) return reject('Insight needs a valid category.', 'invalid_category');
  const key = typeof meta.preferenceKey === 'string' ? meta.preferenceKey : '';
  if (!KEY.test(key)) return reject('Insight needs a preferenceKey (lowercase slug) so it can be reconciled with later statements.', 'missing_preference_key');
  const claim = input.body.trim(); if (!claim || claim.length > 500) return reject('The claim must be one concise statement.', 'invalid_claim');
  if (NO_INSIGHT_CLAIM.test(claim)) return reject('The model abstained; an abstention must not be stored as a user insight.', 'model_abstained');
  const compoundMarker = MULTIPLE_INSIGHTS.exec(claim);
  const compoundTail = compoundMarker ? claim.slice((compoundMarker.index ?? 0) + compoundMarker[0].length) : '';
  const leftTopics = compoundMarker ? normalize(claim.slice(0, compoundMarker.index)).split(' ').filter(word => word.length >= 4 && !STOP_TERMS.has(word)) : [];
  const rightTopics = compoundMarker ? new Set(normalize(compoundTail).split(' ').filter(word => word.length >= 4 && !STOP_TERMS.has(word))) : new Set<string>();
  const sameDomainCapability = category === 'capability' && leftTopics.some(word => rightTopics.has(word));
  if (compoundMarker && !/\b(?:it|them|this|that)\b/i.test(compoundTail) && !sameDomainCapability) return reject('A user insight must express exactly one independently reviewable preference, goal, interest, capability or working style.', 'multiple_insights');

  const sources: InsightSource[] = []; const docs: Document[] = [];
  for (const ref of input.evidence ?? []) {
    let doc: Document; try { doc = await vault.get(objectIdFromUri(ref.uri), ref.revisionId); } catch { return reject('Evidence is not an accessible object.', 'evidence_unavailable'); }
    const cls = classifySource(doc);
    if (cls === 'dream') return reject('Dream hypotheses are never evidence about the user.', 'dream_not_evidence');
    if (cls !== 'explicit') {
      if (!ref.span) return reject('Each non-explicit source must carry a verbatim span.', 'span_missing');
      if (!spanFound(doc.body, ref.span)) return reject('A cited span does not occur in its source.', 'span_not_in_source');
    } else if (ref.span && !spanFound(doc.body, ref.span)) return reject('A cited span does not occur in its source.', 'span_not_in_source');
    const citedText = ref.span ?? doc.body;
    if ((cls === 'user_conversation' || cls === 'explicit') && optedOut(doc.body, key, claim)) return reject('The user explicitly asked not to retain this information.', 'user_opt_out');
    if ((cls === 'user_conversation' || cls === 'explicit') && markerTargetsClaim(doc.body, TEMPORARY, key, claim)) return reject('The cited instruction is explicitly temporary rather than an enduring user preference.', 'temporary_evidence');
    if ((cls === 'user_conversation' || cls === 'explicit') && markerTargetsClaim(doc.body, HYPOTHETICAL, key, claim) && !/\b(?:want|would like|plan|intend|goal)\b/i.test(citedText)) return reject('The cited information is conditional or hypothetical rather than a stated user goal.', 'hypothetical_evidence');
    if (category === 'interest' && (cls === 'user_conversation' || cls === 'explicit') && markerTargetsClaim(doc.body, TOPIC_EXPOSURE, key, claim)) return reject('The source records exposure to this topic without stating personal interest.', 'exposure_not_interest');
    if (category === 'interest' && (cls === 'user_conversation' || cls === 'explicit') && TOPIC_EXPOSURE.test(doc.body) && NO_PERSONAL_STANCE.test(doc.body)) return reject('The source records topic exposure alongside an explicit lack of personal interest or stance.', 'exposure_without_interest');
    if ((cls === 'user_conversation' || cls === 'explicit') && (NO_PERSONAL_STANCE.test(citedText) || THIRD_PARTY_ONLY.test(citedText) || THIRD_PARTY_ONLY.test(doc.body))) return reject('The cited words express no personal stance or describe another person, so they cannot support this user insight.', 'negative_or_attributed_evidence');
    sources.push({ uri: doc.uri, revisionId: doc.revisionId, class: cls, ...(typeof doc.metadata.speaker === 'string' ? { speaker: doc.metadata.speaker } : {}), ...(ref.span ? { span: ref.span } : {}) });
    docs.push(doc);
  }
  const has = (c: SourceClass) => sources.some(s => s.class === c);
  // A correction marker in user-authored source text is evidence in its own right. This deliberately does not infer a correction
  // from assistant prose or a model flag; the proposal must still pass the normal review step before it can supersede anything.
  const freeTextCorrection = docs.some((doc, i) => sources[i]?.class === 'user_conversation' && correctionApplies(doc.body, key, claim));
  const userBased = has('explicit') || has('user_conversation');
  let evidenceClass: InsightEvidenceClass; let verdict: InsightEval['verdict'] = 'accept'; const flags: string[] = []; let rationale = 'Evidence rules satisfied.';
  if (userBased) evidenceClass = has('explicit') || meta.explicitStatement === true || freeTextCorrection ? 'explicit' : 'inferred';
  else if (has('wiki_exposure') && !has('agent_observation')) {
    if (category !== 'interest') return reject('Wiki or imported sources only show exposure to a topic; they cannot support a preference, goal, capability or working style.', 'exposure_not_preference');
    evidenceClass = 'exposure'; flags.push('exposure_only'); rationale = 'Exposure only: recorded as an interest, not as an endorsement.';
  } else { evidenceClass = 'hypothesis'; verdict = 'review_required'; flags.push('needs_user_validation'); rationale = 'Only agent-derived evidence: needs the user to confirm before it counts.'; }
  if (typeof meta.evidenceClass === 'string' && ['explicit', 'inferred'].includes(meta.evidenceClass) && rank(meta.evidenceClass as InsightEvidenceClass) < rank(evidenceClass)) return reject(`Declared evidence class ${meta.evidenceClass} is stronger than the sources support (${evidenceClass}).`, 'overclaimed_evidence_class');

  const distinctUser = new Set(sources.filter(s => s.class === 'user_conversation' || s.class === 'explicit').map(s => s.uri)).size;
  const confidenceLabel = evidenceClass === 'explicit' ? 'high' : evidenceClass === 'inferred' && distinctUser >= 2 ? 'medium' : 'low';
  // Extraction confidence estimates how well this candidate is supported by independent user-authored evidence. Factual certainty
  // states whether the user said it directly; it is not a claim that a reported preference is objectively true.
  const extractionConfidence = evidenceClass === 'explicit' ? 0.95 : evidenceClass === 'inferred' ? (distinctUser >= 3 ? 0.8 : distinctUser === 2 ? 0.7 : 0.5) : evidenceClass === 'exposure' ? 0.35 : 0.2;
  const factualCertainty = evidenceClass === 'explicit' ? 'user_reported' : evidenceClass === 'inferred' ? 'unverified_inference' : evidenceClass === 'exposure' ? 'exposure_only' : 'unverified_hypothesis';
  if (typeof meta.confidenceLabel === 'string' && meta.confidenceLabel !== confidenceLabel) flags.push('confidence_set_by_evidence');

  // Reconcile with what is already known in the SAME scope. A workspace-specific preference coexists with a global one.
  const supersede: string[] = [];
  const label = typeof meta.scopeLabel === 'string' ? meta.scopeLabel : input.scope.type === 'global' ? 'global' : input.scope.workspaceId;
  // Explicit preferences may be direct notes rather than normalized user_insight objects; they still outrank inferred proposals.
  const allInsights = (await loadDocuments(vault, await readableEntries(vault))).filter(doc => doc.kind === 'user_insight' || doc.metadata.explicitPreference === true);
  const claimTerms = salientTerms(claim); const correctionText = docs.filter((doc, i) => sources[i]?.class === 'user_conversation').map(doc => doc.body).join('\n');
  const correctionTerms = salientTerms(correctionText);
  const existing = allInsights.filter(d => {
    if (applicability(d) !== label || ['superseded', 'rejected', 'deleted'].includes(d.status) || !(d.kind === 'user_insight' || d.metadata.explicitPreference === true)) return false;
    if (d.metadata.preferenceKey === key) return true;
    if (evidenceClass !== 'explicit' || !freeTextCorrection || classifySource(d) === 'explicit') return false;
    const oldTerms = salientTerms(d.body); let overlap = 0;
    for (const word of oldTerms) if (claimTerms.has(word) && correctionTerms.has(word)) overlap++;
    return overlap >= 2;
  });
  for (const old of existing) {
    const oldClass = classifySource(old);
    if (normalize(old.body) === normalize(claim)) return reject('Already recorded.', 'redundant');
    const oldIsUserStatement = oldClass === 'explicit' || old.metadata.evidenceClass === 'explicit' || old.metadata.explicitPreference === true;
    if (evidenceClass === 'explicit') { supersede.push(old.id); flags.push('supersedes_earlier'); continue; }
    if (oldIsUserStatement) return reject('Conflicts with a statement by the user, which takes precedence over inference, exposure and agent conclusions.', 'conflicts_user_statement');
    if (evidenceClass === 'hypothesis' && old.metadata.evidenceClass === 'inferred') return reject('An agent-derived hypothesis cannot override an insight derived from the user\'s own words.', 'agent_conflicts_user');
    verdict = 'review_required'; flags.push('conflicts_existing'); supersede.push(old.id); rationale = 'Conflicts with an earlier inferred insight; both are kept until you decide.';
  }
  return { verdict, rationale, flags, supersede, patch: { insightSchema: 1, category, preferenceKey: key, evidenceClass, confidenceLabel, extractionConfidence, factualCertainty, ...(freeTextCorrection ? { correctionDetected: true, correctionDetection: 'user_text_rule_v1' } : {}), sources, scopeLabel: label, validFrom: new Date().toISOString().slice(0, 10), visibility: 'user_private', sensitivity: meta.sensitivity === 'sensitive' ? 'sensitive' : 'none' } };
}
const rank = (c: InsightEvidenceClass): number => ({ explicit: 0, inferred: 1, exposure: 2, hypothesis: 3 })[c];

/** Commits an approved insight as an accepted object and supersedes the ones it replaces. Old revisions and superseded objects stay readable. */
export async function commitInsight(vault: Vault, input: PutInput, proposalId: string, reason: string | undefined, supersede: string[]): Promise<Document> {
  const doc = await vault.put({ ...input, status: 'accepted', idempotencyKey: `proposal:${proposalId}`, metadata: { ...input.metadata, reviewed: true, reviewReason: reason ?? 'Explicit approval', approvedProposalId: proposalId, ...(supersede.length ? { supersedes: supersede } : {}) } });
  for (const id of supersede) { try { const old = await vault.get(id); if (old.status !== 'superseded') await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, status: 'superseded', metadataPatch: { supersededBy: doc.uri, supersededByRevision: doc.revisionId, supersededReason: input.metadata?.evidenceClass === 'explicit' ? 'replaced by a newer statement from the user' : 'replaced after review' } }); } catch { /* already changed or no longer writable: the new object still stands */ } }
  return doc;
}

/** A direct statement or correction by the user. Accepted immediately; every earlier insight or explicit note on the same subject and scope is superseded, with its history intact. */
export async function correctInsight(vault: Vault, input: { scope: Scope; preferenceKey: string; claim: string; category: InsightCategory; reason?: string; source?: { uri: string; revisionId: string; span?: string }; sensitive?: boolean }): Promise<Document> {
  if (!KEY.test(input.preferenceKey)) throw new MDBError('INVALID_INPUT', 'preferenceKey must be a lowercase slug');
  if (!CATEGORIES.includes(input.category)) throw new MDBError('INVALID_INPUT', 'Invalid category');
  const claim = input.claim.trim(); if (!claim || claim.length > 500) throw new MDBError('INVALID_INPUT', 'The claim must be one concise statement');
  const sources: InsightSource[] = []; const evidence: Evidence[] = [];
  if (input.source) {
    const doc = await vault.get(objectIdFromUri(input.source.uri), input.source.revisionId); const cls = classifySource(doc);
    if (cls !== 'explicit' && cls !== 'user_conversation') throw new MDBError('INVALID_INPUT', 'A correction can only cite something the user wrote');
    if (input.source.span && !spanFound(doc.body, input.source.span)) throw new MDBError('INVALID_INPUT', 'The cited span does not occur in the source');
    evidence.push({ uri: doc.uri, revisionId: doc.revisionId, ...(input.source.span ? { span: input.source.span } : {}) }); sources.push({ uri: doc.uri, revisionId: doc.revisionId, class: cls, ...(input.source.span ? { span: input.source.span } : {}) });
  }
  const label = input.scope.type === 'global' ? 'global' : input.scope.workspaceId; void scopeEqual;
  const earlier = (await loadDocuments(vault, await readableEntries(vault, { pk: input.preferenceKey }))).filter(d => applicability(d) === label && !['superseded', 'rejected', 'deleted'].includes(d.status) && (d.kind === 'user_insight' || d.metadata.explicitPreference === true) && normalize(d.body) !== normalize(claim));
  const doc = await vault.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: claim.slice(0, 120), body: claim, status: 'accepted', evidence, tags: ['insight', input.category], metadata: { insightSchema: 1, category: input.category, preferenceKey: input.preferenceKey, evidenceClass: 'explicit', confidenceLabel: 'high', extractionConfidence: 0.95, factualCertainty: 'user_reported', sources, scopeLabel: label, validFrom: new Date().toISOString().slice(0, 10), visibility: 'user_private', sensitivity: input.sensitive ? 'sensitive' : 'none', origin: 'user_statement', reviewed: true, reviewReason: input.reason ?? 'Stated or corrected by the user', ...(earlier.length ? { supersedes: earlier.map(d => d.id) } : {}) } });
  for (const old of earlier) await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, status: 'superseded', metadataPatch: { supersededBy: doc.uri, supersededByRevision: doc.revisionId, supersededReason: input.reason ?? 'corrected by the user' } });
  await projectProfile(vault).catch(() => undefined);
  return doc;
}

const clean = (t: string) => t.replace(/[\r\n]+/g, ' ').slice(0, 300);
/**
 * Regenerates the readable projections from the accepted insight objects: root PROFILE.md (what the user stated), root USER_INSIGHT.md (inferred
 * and exposure items) and each workspace's PROFILE.md. They are derived views: authored text outside the generated block is untouched, output is
 * deterministic (no timestamps), sensitive items are counted but never listed, and every line links the insight object whose revisions hold the history.
 */
export async function projectProfile(owner: Vault): Promise<{ global: number; workspaces: number }> {
  if (!owner.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Projection requires the trusted owner');
  const entries = await readableEntries(owner, { kinds: ['user_insight'] });
  const docs = (await loadDocuments(owner, entries)).filter(d => isInsight(d) && d.status === 'accepted');
  const line = (d: Document) => `- **${d.metadata.category}** — ${clean(d.body)} _(extraction confidence ${typeof d.metadata.extractionConfidence === 'number' ? d.metadata.extractionConfidence.toFixed(2) : d.metadata.confidenceLabel}, factual certainty ${String(d.metadata.factualCertainty ?? d.metadata.evidenceClass)}, since ${d.metadata.validFrom})_ [history](${d.uri})`;
  const order = (a: Document, b: Document) => String(a.metadata.category).localeCompare(String(b.metadata.category)) || a.body.localeCompare(b.body) || a.id.localeCompare(b.id);
  const render = (list: Document[], hiddenLabel: string) => { const shown = list.filter(d => d.metadata.sensitivity !== 'sensitive').sort(order); const hidden = list.length - shown.length; return [...(shown.length ? shown.map(line) : ['_No accepted items._']), ...(hidden ? [`_${hidden} sensitive item(s) not listed ${hiddenLabel}._`] : [])]; };
  // Everything is projected into the two root files (workspace-applicable items in their own sections), never into workspace directories that agents with workspace access can read.
  const labels = [...new Set(docs.map(applicability))].filter(l => l !== 'global').sort();
  const section = (list: Document[]) => { const labelsOut: string[] = []; for (const label of ['global', ...labels]) { const part = list.filter(d => applicability(d) === label); if (!part.length && label !== 'global') continue; labelsOut.push(`### ${label === 'global' ? 'Global' : `Workspace: ${clean(label)}`}`, ...render(part, 'here')); } return labelsOut; };
  await guarded(owner.root, 'PROFILE.md', 'PROFILE', section(docs.filter(d => d.metadata.evidenceClass === 'explicit')));
  await guarded(owner.root, 'USER_INSIGHT.md', 'USER_INSIGHT', section(docs.filter(d => d.metadata.evidenceClass !== 'explicit')));
  const global = docs.filter(d => applicability(d) === 'global'); const workspaces = labels.length;
  void SOURCE_PRIORITY;
  return { global: global.length, workspaces };
}
