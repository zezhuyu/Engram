import { MDBError, type Document, type Evidence, type PutInput, type Scope } from '../core/types.js';
import { objectIdFromUri, type Vault } from '../core/vault.js';
import { classifySource, SOURCE_PRIORITY, type SourceClass } from '../core/evidence.js';
import { guarded } from '../search-files/navigation.js';
import { isValidTimeZone, systemTimeZone } from '../adaptive/clock.js';
import { insightActiveAt, parseTimeLimit, type TimeLimit } from './temporal.js';
import { loadDocuments, readableEntries, scopeEqual } from './corpus.js';

export const CATEGORIES = ['preference', 'goal', 'interest', 'capability', 'working_style', 'knowledge_gap'] as const;
export type InsightCategory = (typeof CATEGORIES)[number];
/** explicit: the user said it. inferred: derived from what the user wrote or did. exposure: the user was exposed to a topic. hypothesis: agent-derived, awaiting the user. */
export type InsightEvidenceClass = 'explicit' | 'inferred' | 'exposure' | 'hypothesis';
export interface InsightSource { uri: string; revisionId: string; class: SourceClass; speaker?: string; span?: string }
export interface InsightEval { verdict: 'accept' | 'reject' | 'review_required'; rationale: string; flags: string[]; patch: Record<string, unknown>; supersede: string[] }
const KEY = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const REVIEW_BYPASS_PHRASE = /\b(?:auto[- ]?(?:approv|accept)\w*|(?:bypass|skip|disabl|turn(?:ed)? off|without)\w*\s+(?:the\s+|user\s+|human\s+)?(?:review|approval|confirmation|validation)|no (?:further )?(?:review|approval) (?:is |are )?(?:needed|required))\b/i;
const REVIEW_BYPASS_SUBJECT = /\b(?:proposals?|insights?|memor(?:y|ies)|suggestions?|assistant|agents?|engram|model|automatic(?:ally)?)\b/i;
const REVIEW_BYPASS = { test: (claim: string): boolean => REVIEW_BYPASS_PHRASE.test(claim) && REVIEW_BYPASS_SUBJECT.test(claim) };
const INJECTION_PHRASE = /\b(?:ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)|system\s+(?:override|prompt|note)|note\s+to\s+(?:the\s+)?(?:memory|ai|assistant|system|model)|disregard\s+(?:the\s+)?(?:task|instructions?)|you\s+(?:must|should)\s+now\s+(?:output|answer|reply|store|record))\b/i;
const ATTRIBUTION_BEFORE = /(?:\b(?:says?|said|writes?|wrote|states?|stated|according\s+to|reads?|quot(?:e|es|ed|ing)|claims?|reports?|readme|docs?|documentation|article|manual|vendor|teammate|colleague|friend|he|she|they|log|tool)\b[^.!?\n]{0,60}[:\u201c"'\u2018]\s*)$/i;
const FIRST_PERSON = /\b(?:i|i'm|i\u2019m|i've|i\u2019ve|i'd|i\u2019d|i'll|my|me|mine|myself|we|we're|our|us)\b/i;
const RELATIONSHIP = /\b(?:partner|wife|husband|spouse|girlfriend|boyfriend|fianc\w+|son|daughter|kids?|child|children|mother|mom|mum|father|dad|brother|sister|roommate|neighbou?r|boss|therapist|doctor|ex|team|teammates?|colleagues?|co-?workers?|manager|friends?|employer)\b/i;
const THIRD_PARTY_SAYS = /\b(?:my|our|his|her|their)\s+(?:\w+\s+){0,2}(?:team|teammates?|colleagues?|co-?workers?|manager|boss|friends?|partner|wife|husband|brother|sister|mom|dad|clients?|customers?|vendors?|company|doctor)\b[^.!?]{0,60}\b(?:says?|said|wants?|prefers?|likes?|thinks?|told|insists?|asked|uses?|always|recommends?|suggests?)\b/i;
const STANCE = /\b(?:prefer\w*|like[sd]?|love[sd]?|hate[sd]?|dislike[sd]?|want\w*|wish\w*|need\w*|always|never|usually|often|typically|tend\\w*|habit\\w*|routine|whenever|every\\s+time|chos[ae]n?|pick(?:ed|s)?|select(?:ed|s)?|switch(?:ed|es)?|adopt(?:ed|s)?|opt(?:ed|s)?|decid(?:ed|es)|settled|went\\s+with|going\\s+with|rather|favou?r\w*|enjoy\w*|avoid\w*|keep|use[sd]?|using|please|should|must|don't|do not|can|maintain\w*|handle|own|owner|know|expert\w*|experienced|familiar|skilled|learn\w*|interested|curious|focus\w*|plan\w*|aim\w*|goal|intend\w*|going\s+forward|from\s+now\s+on|make|show|run|list|explain|write|format|before|after|first|instead|only|require\w*|reduce|improve|migrate|ship|build|finish|become|answer\w*|repl(?:y|ies)|respond\w*|speak|translate|summari[sz]e)\b/i;
const SENSITIVE_TRAIT = /\b(?:relig\w*|muslim|christian|catholic|jewish|hindu|buddhis\w*|atheis\w*|pray\w*|faith|gay|lesbian|bisexual|transgender|queer|sexual\s+orientation|orientation|depress\w*|anxi\w*|bipolar|adhd|autis\w*|disorder|diagnos\w*|illness|disease|diabet\w*|cancer|hiv|disabilit\w*|pregnan\w*|ethnic\w*|race|racial|political\s+(?:party|affiliation)|union\s+member\w*|immigration\s+status|criminal\s+record)\b/i;
const CAPABILITY_CUE = /\b(?:can|could|able|maintain\w*|handle[sd]?|own(?:s|er)?|know(?:s)?|expert\w*|experienced?|familiar|skill(?:ed|s)?|fluent|certified|proficient|comfortable|years\s+of|debug\w*|write|wrote|build|built|develop\w*|manage[sd]?|lead|led|speak|teach\w*|review\w*|operate[sd]?|run(?:s|ning)?|design\w*|deploy\w*|specializ\w*|work(?:s|ed|ing)?\s+(?:on|with|as))\b/i;
const GAP_CUE = /\b(?:don't|do not|doesn't|dont|never|not\s+(?:sure|good|familiar|comfortable)|unfamiliar|confus\w*|struggl\w*|weak|new\s+to|learn\w*|understand\w*|lack\w*|unsure|no\s+idea|trouble|difficult\w*|hard\s+to|anxiety|disorder|diagnos\w*)\b/i;
/** A user instruction addressed to the assistant ("From now on, please answer in British English"): the user's own words even without a first-person pronoun. Must open the sentence or contain "please", so a third-party statement ("The vendor always wants...") does not qualify. */
const DIRECTIVE_START = /^(?:please|from now on|going forward|always|never|don't|do not|make sure|when you|whenever you|before you|after you|keep|use|show|start|end|answer|reply|write|explain|list|run|give|avoid|format|call|name)\b/i;
const isDirective = (sentence: string): boolean => DIRECTIVE_START.test(sentence.replace(/^[^\p{L}]+/u, '')) || /\bplease\b/i.test(sentence);
const sentenceAround = (body: string, index: number, length: number): string => {
  const start = Math.max(body.lastIndexOf('.', index - 1), body.lastIndexOf('!', index - 1), body.lastIndexOf('?', index - 1), body.lastIndexOf('\n', index - 1)) + 1;
  const ends = [body.indexOf('.', index + length), body.indexOf('!', index + length), body.indexOf('?', index + length), body.indexOf('\n', index + length)].filter(n => n >= 0);
  return body.slice(start, ends.length ? Math.min(...ends) + 1 : body.length).trim();
};
/** The clause of the user's sentence that contains the cited span: bounded by commas, semicolons, colons and conjunctions OUTSIDE the span, so a stance cue elsewhere in the sentence cannot vouch for an event clause. */
const clauseAround = (body: string, index: number, length: number): string => {
  const sentence = sentenceAround(body, index, length); const at = sentence.indexOf(body.slice(index, index + length));
  if (at < 0) return sentence;
  const boundary = /[,;:]|\s(?:and|but|so|because|while|though|although|then)\s/gi;
  const before = sentence.slice(0, at), after = sentence.slice(at + length);
  let start = 0; for (const m of before.matchAll(boundary)) start = (m.index ?? 0) + m[0].length;
  const next = after.search(boundary); const end = next < 0 ? sentence.length : at + length + next;
  return sentence.slice(start, end);
};
/**
 * Provenance check for one cited span. True only when a trusted-attributed user (or explicit-note) source contains the span as the user's own first-person words:
 * not quoted, not attributed to someone or something else, and not carrying instruction-like text. The model's own `explicitStatement` declaration is never consulted.
 */
export function isVerifiedUserSpan(doc: Pick<Document, 'body' | 'metadata' | 'kind' | 'scope'>, span: string | undefined): boolean {
  const cls = classifySource(doc);
  if (cls !== 'explicit' && !(cls === 'user_conversation' && (doc.metadata.speaker === 'user' || doc.kind === 'chat_conversation'))) return false;
  const text = span ?? doc.body; const at = span ? doc.body.indexOf(span) : 0; if (at < 0) return false;
  if (doc.kind === 'chat_conversation') {
    const turns = Array.isArray(doc.metadata.turns) ? doc.metadata.turns as Array<{ role?: string; start?: number; end?: number; dreamDerived?: boolean }> : [];
    if (!turns.some(turn => turn.role === 'user' && turn.dreamDerived !== true && Number.isInteger(turn.start) && Number.isInteger(turn.end) && at >= turn.start! && at + text.length <= turn.end!)) return false;
  }
  const sentence = span ? sentenceAround(doc.body, at, span.length) : doc.body;
  if (INJECTION_PHRASE.test(doc.body) || INJECTION_PHRASE.test(sentence) || INJECTION_PHRASE.test(text)) return false; // instruction-like text anywhere in the source taints the whole message
  if (!FIRST_PERSON.test(sentence) && !FIRST_PERSON.test(text) && !isDirective(sentence)) return false;
  if (/^\s*(?:from|subject|sent|to|cc|date):\s/im.test(doc.body) || /forwarded message|original message|begin forwarded/i.test(doc.body)) return false; // pasted email or forwarded text
  if (THIRD_PARTY_SAYS.test(sentence)) return false; // "my manager says I should ...": someone else's statement
  if (span) {
    const lineStart = doc.body.lastIndexOf('\n', at - 1) + 1; const line = doc.body.slice(lineStart, doc.body.indexOf('\n', at) < 0 ? undefined : doc.body.indexOf('\n', at));
    if (/^\s*>/.test(line)) return false; // Markdown blockquote
    const beforeAll = doc.body.slice(0, at);
    if ((beforeAll.match(/```/g) ?? []).length % 2 === 1) return false; // inside a code fence
    const lineBefore = doc.body.slice(lineStart, at); if ((lineBefore.match(/`/g) ?? []).length % 2 === 1) return false; // inside inline code
    const prev = doc.body.slice(0, at).replace(/\s+$/, '').slice(-1), nextText = doc.body.slice(at + span.length).replace(/^[\s.,;:!?]+/, '');
    if (/["\u201c\u2018'`\u00ab]/.test(prev) && /^["\u201d\u2019'`\u00bb]/.test(nextText)) return false; // wrapped in quotation marks of any kind
    const before = doc.body.slice(Math.max(0, at - 90), at);
    if (ATTRIBUTION_BEFORE.test(before)) return false;
    const quotesBefore = (doc.body.slice(0, at).match(/[\u201c"]/g) ?? []).length - (doc.body.slice(0, at).match(/\u201d/g) ?? []).length;
    if (quotesBefore % 2 === 1) return false; // inside a double-quoted passage
  }
  return true;
}
const FREE_TEXT_CORRECTION = /\b(?:actually|correction|i meant|i was wrong|i changed my (?:mind|preference)|from now on|going forward|no longer|not anymore|instead of|rather than|in place of|i would rather|i\s+now\s+(?:prefer|like|want|need)|but\s+i\s+(?:now\s+)?(?:prefer|like|want|need)|i\s+(?:do\s+not|don't)\s+(?:prefer|like|want|need)|stop\s+using|switch(?:ed)?\b.{0,100}\bto|move\b.{0,100}\bfrom\b|my new preference|previously preferred|(?:do\s+not|don't)\s+keep|replace\b.{0,120}\bwith)\b/i;
const NO_INSIGHT_CLAIM = /^\s*(?:no\s+(?:(?:enduring|lasting|user)\s+)*(?:insight|preference|proposal)|no\s+insight\s+(?:is\s+)?proposed|no\s+proposal\b)/i;
const MULTIPLE_INSIGHTS = /\b(?:and|;)\s+(?:the\s+user\s+)?(?:prefers?|likes?|wants?|needs?|can|is\s+interested|has\s+experience|plans?|aims?)\b/i;
const USER_OPTOUT = /\bforget\s+this\b|\b(?:do not|don't|never)\s+(?:(?:want|wish)\s+(?:you\s+to\s+)?)?(?:save|store|remember|retain|infer|derive)\s+(?:it|this(?:\s+conversation)?|that|anything|anywhere|a\s+(?:lasting|long[- ]term)\s+(?:preference|memory))\b/i;
const BROAD_USER_OPTOUT = /\bforget\s+this\b|\b(?:do not|don't|never)\s+(?:(?:want|wish)\s+(?:you\s+to\s+)?)?(?:save|store|remember|retain|infer|derive)\s+(?:anything|everything|this(?:\s+conversation)?|it\s+anywhere|it\s+at\s+all|a\s+(?:lasting|long[- ]term)\s+(?:preference|memory)|anywhere)\b|\b(?:do not|don't|never)\s+want\s+(?:a\s+)?(?:lasting|long[- ]term)\s+(?:preference|memory)\s+(?:inferred|derived|remembered|stored)\b/i;
const HYPOTHETICAL = /\b(?:hypothetically|say\s+(?:if\s+)?i\s+(?:had|were|was|could)|if\s+i\s+(?:had|were|was|could))\b/i;
const TEMPORARY_SINGLE = /\b(?:this\s+(?:one\s+)?(?:answer|reply|response|message|task)|just\s+for\s+this)\b/i;
const TEMPORARY_WINDOW = /\b(?:this\s+(?:week|weekend|morning|afternoon|evening|sprint|demo|session|chat|conversation)|just\s+for\s+(?:today|now|tonight)|just\s+today|today\s+only|for\s+(?:today|tonight|now|the\s+(?:next|rest\s+of)\s+\w+|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|an?|couple\s+of)\s+(?:minute|hour|day|week)s?)|tonight|until\s+\S+|till\s+\S+|through\s+(?:\w+day|tomorrow|\d{4})|by\s+(?:the\s+)?end\s+of\s+\w+)\b/i;
const TEMPORARY = /\b(?:this\s+once|just\s+this\s+time|only\s+this\s+time|for\s+now|temporarily|one[- ]time|this\s+time\s+only|in\s+a\s+hurry)\b/i;
const NO_PERSONAL_STANCE = /\b(?:i\s+(?:do not|don't|have no|haven't (?:formed|made))\s+(?:(?:have|any|a)\s+)*(?:preference|view|opinion)|i\s+have\s+no\s+(?:view|opinion)|no\s+(?:personal\s+)?preference\s+(?:about|on|for)|not\s+decided\s+whether\s+i\s+prefer|undecided\s+whether\s+i\s+prefer|i\s+haven't\b[^.!?\n]{0,80}\b(?:formed|made)\s+(?:an?\s+)?(?:preference|view|opinion))\b/i;
const TOPIC_EXPOSURE = /\b(?:read|heard|saw|watched|skimmed|came across|learned about|looked at)\b.{0,120}\b(?:article|talk|video|post|paper|about|on)\b/i;
const THIRD_PARTY_ONLY = /\b(?:vendor|teammate|colleague|coworker|friend|customer|client|manager|partner|someone else)\b.{0,240}\b(?:nothing to do with my|not my (?:own )?(?:preference|habit|choice)|does not reflect my|doesn't reflect my)\b/i;
const STOP_TERMS = new Set(['user', 'prefers', 'prefer', 'likes', 'wants', 'needs', 'using', 'rather', 'instead', 'changed', 'actually', 'explicitly', 'earlier', 'having', 'would', 'should', 'could', 'from', 'with', 'that', 'this', 'their', 'about', 'when', 'then', 'only', 'also', 'than', 'the', 'a', 'an', 'and', 'or', 'but', 'are', 'is', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did', 'of', 'to', 'in', 'on', 'as', 'by', 'at', 'me', 'my', 'i', 'we', 'our', 'be', 'been', 'being', 'assistant']);
const salientTerms = (text: string): Set<string> => new Set(normalize(text).split(' ').filter(word => word.length >= 4 && !STOP_TERMS.has(word)));
const correctionTerms = (text: string): Set<string> => new Set(normalize(text).split(' ').map(word => word === 'js' ? 'javascript' : /^(?:tests?|testing)$/.test(word) ? 'test' : word).filter(word => word.length >= 4 && !STOP_TERMS.has(word)));
/** Conservative cross-key identity for the well-defined answer-length preference family. */
const preferenceFamily = (category: string, key: string, claim: string): string | undefined => {
  if (!['preference', 'working_style'].includes(category)) return undefined;
  const text = normalize(`${key.replace(/[-_.]/g, ' ')} ${claim}`);
  if (/\b(?:answer|answers|response|responses|reply|replies)\b/.test(text)
    && /\b(?:short|brief|concise|long|detailed|detail|thorough|verbose|length)\b/.test(text)) return 'response-length';
  if (/\b(?:feedback|review)\b/.test(text)
    && /\b(?:short|brief|concise|long|detailed|detail|thorough|comprehensive|verbose)\b/.test(text)) return 'feedback-detail';
  return undefined;
};
const markerTargetsClaim = (body: string, marker: RegExp, key: string, claim: string): boolean => {
  const claimTerms = normalize(`${key.replace(/[-_.]/g, ' ')} ${claim}`).split(' ').filter(word => word.length >= 3 && !STOP_TERMS.has(word));
  // Word-form tolerant overlap ("terse"/"tersely", "answer"/"answers"): words of five or more letters match on their first five letters.
  const same = (a: string, b: string): boolean => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
  return body.split(/(?<=[.!?;])\s+|\n+/).some(part => marker.test(part) && normalize(part).split(' ').some(term => term.length >= 3 && claimTerms.some(c => same(term, c))));
};
const optedOut = (body: string, key: string, claim: string): boolean => BROAD_USER_OPTOUT.test(body) || markerTargetsClaim(body, USER_OPTOUT, key, claim);
const correctionApplies = (text: string, key: string, claim: string): boolean => {
  const marker = FREE_TEXT_CORRECTION.exec(text); if (!marker || marker.index === undefined) return false;
  const tail = normalize(text.slice(marker.index, marker.index + 240));
  const terms = correctionTerms(`${key.replace(/[-_.]/g, ' ')} ${claim}`);
  const tailTerms = correctionTerms(tail);
  return [...terms].some(term => tailTerms.has(term));
};
/** Shared deterministic cue matcher for extraction fallback and correction evaluation. */
export const explicitCorrectionApplies = correctionApplies;
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
export async function evaluateInsight(vault: Vault, input: PutInput, options: { now?: Date } = {}): Promise<InsightEval> {
  const now = options.now ?? new Date(); let timeLimit: TimeLimit | undefined;
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
      if (doc.kind === 'chat_conversation' && !isVerifiedUserSpan(doc, ref.span)) return reject('A cited chat span must come from a user-authored turn.', 'non_user_chat_evidence');
    } else if (ref.span && !spanFound(doc.body, ref.span)) return reject('A cited span does not occur in its source.', 'span_not_in_source');
    const citedText = ref.span ?? doc.body;
    if ((cls === 'user_conversation' || cls === 'explicit') && optedOut(doc.body, key, claim)) return reject('The user explicitly asked not to retain this information.', 'user_opt_out');
    if ((cls === 'user_conversation' || cls === 'explicit') && (markerTargetsClaim(doc.body, TEMPORARY, key, claim) || (category !== 'goal' && markerTargetsClaim(doc.body, TEMPORARY_SINGLE, key, claim)))) return reject('The cited instruction is explicitly temporary rather than an enduring user preference.', 'temporary_evidence');
    if ((cls === 'user_conversation' || cls === 'explicit') && category !== 'goal' && markerTargetsClaim(doc.body, TEMPORARY_WINDOW, key, claim)) {
      // A time-limited instruction is kept for exactly its window (never as a standing preference) when the window can be computed from the user's own words.
      const zone = [doc.metadata.timeZone, process.env.MDB_USER_TIMEZONE].find((z): z is string => typeof z === 'string' && isValidTimeZone(z)) ?? systemTimeZone();
      const written = new Date(String(doc.metadata.eventTime ?? doc.createdAt));
      const part = doc.body.split(/(?<=[.!?;])\s+|\n+/).find(piece => TEMPORARY_WINDOW.test(piece)) ?? doc.body;
      const parsed = Number.isNaN(written.getTime()) ? undefined : parseTimeLimit(part, written, zone);
      if (!parsed) return reject('The cited instruction is limited in time but its window cannot be determined, so it is not kept as a preference.', 'temporary_evidence');
      timeLimit = parsed;
    }
    if ((cls === 'user_conversation' || cls === 'explicit') && markerTargetsClaim(doc.body, HYPOTHETICAL, key, claim) && !/\b(?:want|would like|plan|intend|goal)\b/i.test(citedText)) return reject('The cited information is conditional or hypothetical rather than a stated user goal.', 'hypothetical_evidence');
    if (category === 'interest' && (cls === 'user_conversation' || cls === 'explicit') && markerTargetsClaim(doc.body, TOPIC_EXPOSURE, key, claim)) return reject('The source records exposure to this topic without stating personal interest.', 'exposure_not_interest');
    if (category === 'interest' && (cls === 'user_conversation' || cls === 'explicit') && TOPIC_EXPOSURE.test(doc.body) && NO_PERSONAL_STANCE.test(doc.body)) return reject('The source records topic exposure alongside an explicit lack of personal interest or stance.', 'exposure_without_interest');
    if ((cls === 'user_conversation' || cls === 'explicit') && (NO_PERSONAL_STANCE.test(citedText) || THIRD_PARTY_ONLY.test(citedText) || THIRD_PARTY_ONLY.test(doc.body))) return reject('The cited words express no personal stance or describe another person, so they cannot support this user insight.', 'negative_or_attributed_evidence');
    sources.push({ uri: doc.uri, revisionId: doc.revisionId, class: cls, ...(typeof doc.metadata.speaker === 'string' ? { speaker: doc.metadata.speaker } : {}), ...(ref.span ? { span: ref.span } : {}) });
    docs.push(doc);
  }
  const has = (c: SourceClass) => sources.some(s => s.class === c);
  // Provenance and remediation guards for what may become long-term memory about the user. They never consult the model's own declarations.
  const cited = input.evidence ?? [];
  const spans = docs.map((d, i) => ({ doc: d, span: cited[i]?.span, cls: sources[i]!.class }));
  let verifiedUser = spans.length > 0 && spans.every(x => isVerifiedUserSpan(x.doc, x.span));
  const sensitiveTrait = SENSITIVE_TRAIT.test(claim);
  const traitStatedByUser = verifiedUser && spans.some(x => SENSITIVE_TRAIT.test(x.span ? sentenceAround(x.doc.body, Math.max(0, x.doc.body.indexOf(x.span)), x.span.length) : x.doc.body));
  if (sensitiveTrait && !traitStatedByUser) return reject('A sensitive personal trait can only be recorded from the user\u2019s own first-person statement, never inferred from indirect cues, agents or imported sources.', 'sensitive_inference');
  const userWords = spans.filter(x => x.cls === 'user_conversation');
  const cueFor = category === 'capability' ? CAPABILITY_CUE : category === 'knowledge_gap' ? GAP_CUE : STANCE;
  const noStanceCue = !(sensitiveTrait && traitStatedByUser) && userWords.length > 0 && !userWords.some(x => cueFor.test(x.span ? clauseAround(x.doc.body, Math.max(0, x.doc.body.indexOf(x.span)), x.span.length) : x.doc.body) || cueFor.test(x.span ?? ''));
  const thirdPartyMentioned = RELATIONSHIP.test(claim) || spans.some(x => RELATIONSHIP.test(x.span ?? ''));
  if (thirdPartyMentioned) verifiedUser = false;
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
  // A preference about the review process itself (auto-approval, skipping review, ...) is a security setting. It can only come from the user's own words, never from
  // an agent log, an imported page or an inference: a non-explicit source must not even produce a candidate that asks the reviewer to loosen the gate.
  if (!verifiedUser && REVIEW_BYPASS.test(claim)) return reject('A claim about bypassing or loosening review cannot come from an agent, an imported source or an inference.', 'review_bypass_claim');
  if (typeof meta.evidenceClass === 'string' && ['explicit', 'inferred'].includes(meta.evidenceClass) && rank(meta.evidenceClass as InsightEvidenceClass) < rank(evidenceClass)) return reject(`Declared evidence class ${meta.evidenceClass} is stronger than the sources support (${evidenceClass}).`, 'overclaimed_evidence_class');

  const distinctUser = new Set(sources.filter(s => s.class === 'user_conversation' || s.class === 'explicit').map(s => s.uri)).size;
  const confidenceLabel = evidenceClass === 'explicit' ? 'high' : evidenceClass === 'inferred' && distinctUser >= 2 ? 'medium' : 'low';
  // Extraction confidence estimates how well this candidate is supported by independent user-authored evidence. Factual certainty
  // states whether the user said it directly; it is not a claim that a reported preference is objectively true.
  const extractionConfidence = evidenceClass === 'explicit' ? 0.95 : evidenceClass === 'inferred' ? (distinctUser >= 3 ? 0.8 : distinctUser === 2 ? 0.7 : 0.5) : evidenceClass === 'exposure' ? 0.35 : 0.2;
  const factualCertainty = evidenceClass === 'explicit' ? 'user_reported' : evidenceClass === 'inferred' ? 'unverified_inference' : evidenceClass === 'exposure' ? 'exposure_only' : 'unverified_hypothesis';
  if (typeof meta.confidenceLabel === 'string' && meta.confidenceLabel !== confidenceLabel) flags.push('confidence_set_by_evidence');
  if (thirdPartyMentioned) { flags.push('third_party_mentioned'); verdict = 'review_required'; rationale = 'The claim mentions another person; confirm it describes the user\u2019s own enduring preference before keeping it.'; }
  if (sensitiveTrait) { flags.push('sensitive_trait'); verdict = 'review_required'; rationale = 'A sensitive personal trait stated by the user: keep only if you confirm it.'; }

  // Reconcile with what is already known in the SAME scope. A workspace-specific preference coexists with a global one.
  const supersede: string[] = [];
  const label = typeof meta.scopeLabel === 'string' ? meta.scopeLabel : input.scope.type === 'global' ? 'global' : input.scope.workspaceId;
  // Explicit preferences may be direct notes rather than normalized user_insight objects; they still outrank inferred proposals.
  const allInsights = (await loadDocuments(vault, await readableEntries(vault))).filter(doc => doc.kind === 'user_insight' || doc.metadata.explicitPreference === true);
  const claimTerms = salientTerms(claim); const correctionText = docs.filter((doc, i) => sources[i]?.class === 'user_conversation').map(doc => doc.body).join('\n');
  const correctionTerms = salientTerms(correctionText);
  const incomingFamily = preferenceFamily(category, key, claim);
  const existing = allInsights.filter(d => {
    if (applicability(d) !== label || ['superseded', 'rejected', 'deleted'].includes(d.status) || !(d.kind === 'user_insight' || d.metadata.explicitPreference === true) || !insightActiveAt(d.metadata, now)) return false;
    if (d.metadata.preferenceKey === key && (d.metadata.category === category || d.metadata.explicitPreference === true)) return true;
    const existingFamily = preferenceFamily(String(d.metadata.category ?? ''), String(d.metadata.preferenceKey ?? ''), d.body);
    if (evidenceClass === 'explicit' && freeTextCorrection && incomingFamily && incomingFamily === existingFamily && d.metadata.category === category) return true;
    if (evidenceClass !== 'explicit' || !freeTextCorrection || classifySource(d) === 'explicit') return false;
    const oldTerms = salientTerms(d.body); let overlap = 0;
    for (const word of oldTerms) if (claimTerms.has(word) && correctionTerms.has(word)) overlap++;
    return overlap >= 2;
  });
  // A time-limited instruction never supersedes (or conflicts with) a standing preference: both are kept, and while the window is open the time-limited one takes precedence at read time.
  for (const old of timeLimit ? existing.filter(d => normalize(d.body) === normalize(claim)) : existing) {
    const oldClass = classifySource(old);
    if (normalize(old.body) === normalize(claim)) return reject('Already recorded.', 'redundant');
    const oldIsUserStatement = oldClass === 'explicit' || old.metadata.evidenceClass === 'explicit' || old.metadata.explicitPreference === true;
    if (evidenceClass === 'explicit') { supersede.push(old.id); flags.push('supersedes_earlier'); continue; }
    if (oldIsUserStatement) return reject('Conflicts with a statement by the user, which takes precedence over inference, exposure and agent conclusions.', 'conflicts_user_statement');
    if (evidenceClass === 'hypothesis' && old.metadata.evidenceClass === 'inferred') return reject('An agent-derived hypothesis cannot override an insight derived from the user\'s own words.', 'agent_conflicts_user');
    verdict = 'review_required'; flags.push('conflicts_existing'); supersede.push(old.id); rationale = 'Conflicts with an earlier inferred insight; both are kept until you decide.';
  }
  if (timeLimit && Date.parse(timeLimit.until) < now.getTime()) return reject('The time-limited instruction has already expired, so nothing is kept.', 'expired_instruction');
  if (timeLimit) { flags.push('time_limited'); if (verdict === 'accept') verdict = 'review_required'; rationale = `Time-limited instruction (${timeLimit.phrase}): kept only until ${timeLimit.until} (${timeLimit.timeZone}); it does not change the standing preference.`; }
  if (noStanceCue) return reject('The cited words describe an event or a passing fact; they state no enduring preference, goal, capability or working style.', 'no_stance_cue');
  // One preference identity must not live under two categories: a same-key insight with another category is surfaced for review, never merged or superseded automatically.
  const categoryClash = allInsights.filter(d => d.kind === 'user_insight' && applicability(d) === label && !['superseded', 'rejected', 'deleted'].includes(d.status) && d.metadata.preferenceKey === key && String(d.metadata.category ?? '') !== category);
  if (categoryClash.length) { flags.push('category_mismatch'); if (verdict === 'accept') { verdict = 'review_required'; rationale = `The key "${key}" already exists as ${[...new Set(categoryClash.map(d => String(d.metadata.category)))].join('/')}; review which category is right. Nothing was merged.`; } }
  return { verdict, rationale, flags, supersede, patch: { insightSchema: 1, category, preferenceKey: key, evidenceClass, userStatementVerified: verifiedUser, ...(timeLimit ? { validUntil: timeLimit.until, temporalKind: 'time_limited', temporalPhrase: timeLimit.phrase, timeZone: timeLimit.timeZone } : {}), confidenceLabel, extractionConfidence, factualCertainty, ...(freeTextCorrection ? { correctionDetected: true, correctionDetection: 'user_text_rule_v1' } : {}), sources, scopeLabel: label, validFrom: new Date().toISOString().slice(0, 10), visibility: 'user_private', sensitivity: meta.sensitivity === 'sensitive' || sensitiveTrait ? 'sensitive' : 'none' } };
}
const rank = (c: InsightEvidenceClass): number => ({ explicit: 0, inferred: 1, exposure: 2, hypothesis: 3 })[c];

/** Commits an approved insight as an accepted object and supersedes the ones it replaces. Old revisions and superseded objects stay readable. */
export async function commitInsight(vault: Vault, input: PutInput, proposalId: string, reason: string | undefined, supersede: string[]): Promise<Document> {
  const doc = await vault.put({ ...input, status: 'accepted', idempotencyKey: `proposal:${proposalId}`, metadata: { ...input.metadata, reviewed: true, reviewReason: reason ?? 'Explicit approval', approvedProposalId: proposalId, ...(supersede.length ? { supersedes: supersede } : {}) } });
  for (const id of supersede) { try { const old = await vault.get(id); if (old.status !== 'superseded') await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, status: 'superseded', metadataPatch: { supersededBy: doc.uri, supersededByRevision: doc.revisionId, supersededReason: input.metadata?.evidenceClass === 'explicit' ? 'replaced by a newer statement from the user' : 'replaced after review' } }); } catch { /* already changed or no longer writable: the new object still stands */ } }
  return doc;
}

/** A direct statement or correction by the user. Accepted immediately; every earlier insight or explicit note on the same subject and scope is superseded, with its history intact. */
export async function correctInsight(vault: Vault, input: { scope: Scope; storageScope?: Scope; preferenceKey: string; claim: string; category: InsightCategory; reason?: string; source?: { uri: string; revisionId: string; span?: string }; sensitive?: boolean; idempotencyKey?: string }): Promise<Document> {
  if (!KEY.test(input.preferenceKey)) throw new MDBError('INVALID_INPUT', 'preferenceKey must be a lowercase slug');
  if (!CATEGORIES.includes(input.category)) throw new MDBError('INVALID_INPUT', 'Invalid category');
  const claim = input.claim.trim(); if (!claim || claim.length > 500) throw new MDBError('INVALID_INPUT', 'The claim must be one concise statement');
  const sources: InsightSource[] = []; const evidence: Evidence[] = [];
  if (input.source) {
    const doc = await vault.get(objectIdFromUri(input.source.uri), input.source.revisionId); const cls = classifySource(doc);
    if (cls !== 'explicit' && cls !== 'user_conversation') throw new MDBError('INVALID_INPUT', 'A correction can only cite something the user wrote');
    if (input.source.span && !spanFound(doc.body, input.source.span)) throw new MDBError('INVALID_INPUT', 'The cited span does not occur in the source');
    if (doc.kind === 'chat_conversation' && !isVerifiedUserSpan(doc, input.source.span)) throw new MDBError('INVALID_INPUT', 'A chat preference must cite a verified user-authored span');
    evidence.push({ uri: doc.uri, revisionId: doc.revisionId, ...(input.source.span ? { span: input.source.span } : {}) }); sources.push({ uri: doc.uri, revisionId: doc.revisionId, class: cls, ...(input.source.span ? { span: input.source.span } : {}) });
  }
  const label = input.scope.type === 'global' ? 'global' : input.scope.workspaceId; void scopeEqual;
  const earlier = (await loadDocuments(vault, await readableEntries(vault, { pk: input.preferenceKey }))).filter(d => applicability(d) === label && !['superseded', 'rejected', 'deleted'].includes(d.status) && (d.kind === 'user_insight' || d.metadata.explicitPreference === true) && normalize(d.body) !== normalize(claim));
  const doc = await vault.put({ scope: input.storageScope ?? { type: 'global', area: 'profile' }, kind: 'user_insight', title: claim.slice(0, 120), body: claim, status: 'accepted', evidence, tags: ['insight', input.category], metadata: { actorId: vault.actor.actorId, insightSchema: 1, category: input.category, preferenceKey: input.preferenceKey, evidenceClass: 'explicit', confidenceLabel: 'high', extractionConfidence: 0.95, factualCertainty: 'user_reported', sources, scopeLabel: label, validFrom: new Date().toISOString().slice(0, 10), visibility: 'user_private', sensitivity: input.sensitive ? 'sensitive' : 'none', origin: 'user_statement', reviewed: true, reviewReason: input.reason ?? 'Stated or corrected by the user', ...(earlier.length ? { supersedes: earlier.map(d => d.id) } : {}) }, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
  for (const old of earlier) await vault.patch({ objectId: old.id, expectedRevisionId: old.revisionId, status: 'superseded', metadataPatch: { supersededBy: doc.uri, supersededByRevision: doc.revisionId, supersededReason: input.reason ?? 'corrected by the user' } });
  await projectProfile(vault).catch(() => undefined);
  return doc;
}

const clean = (t: string) => t.replace(/[\r\n]+/g, ' ').slice(0, 300);
/** Shared deterministic profile markdown renderer used by persisted views and filtered replica snapshots. */
export function renderProfileProjection(docs: Document[], options: { readableWorkspaceLabels?: ReadonlySet<string>; omitSensitiveCounts?: boolean } = {}): { profile: string; userInsight: string } {
  const visible = docs.filter(d => { const label = applicability(d); return label === 'global' || !options.readableWorkspaceLabels || options.readableWorkspaceLabels.has(label); });
  const line = (d: Document) => `- **${d.metadata.category}** — ${clean(d.body)} _(extraction confidence ${typeof d.metadata.extractionConfidence === 'number' ? d.metadata.extractionConfidence.toFixed(2) : d.metadata.confidenceLabel}, factual certainty ${String(d.metadata.factualCertainty ?? d.metadata.evidenceClass)}, since ${d.metadata.validFrom}${typeof d.metadata.validUntil === 'string' ? `, only until ${d.metadata.validUntil}` : ''})_ [history](${d.uri})`;
  const order = (a: Document, b: Document) => String(a.metadata.category).localeCompare(String(b.metadata.category)) || a.body.localeCompare(b.body) || a.id.localeCompare(b.id);
  const render = (list: Document[]) => { const shown = list.filter(d => d.metadata.sensitivity !== 'sensitive').sort(order); const hidden = list.length - shown.length; return [...(shown.length ? shown.map(line) : ['_No accepted items._']), ...(hidden && !options.omitSensitiveCounts ? [`_${hidden} sensitive item(s) not listed here._`] : [])]; };
  const labels = [...new Set(visible.map(applicability))].filter(label => label !== 'global').sort();
  const section = (list: Document[]) => { const output: string[] = []; for (const label of ['global', ...labels]) { const part = list.filter(d => applicability(d) === label); if (!part.length && label !== 'global') continue; output.push(`### ${label === 'global' ? 'Global' : `Workspace: ${clean(label)}`}`, ...render(part)); } return output.join('\n'); };
  return { profile: section(visible.filter(d => d.metadata.evidenceClass === 'explicit')), userInsight: section(visible.filter(d => d.metadata.evidenceClass !== 'explicit')) };
}
/**
 * Regenerates the readable projections from the accepted insight objects: root PROFILE.md (what the user stated), root USER_INSIGHT.md (inferred
 * and exposure items) and each workspace's PROFILE.md. They are derived views: authored text outside the generated block is untouched, output is
 * deterministic (no timestamps), sensitive items are counted but never listed, and every line links the insight object whose revisions hold the history.
 */
export async function projectProfile(owner: Vault, options: { now?: Date } = {}): Promise<{ global: number; workspaces: number }> {
  const profileScope = { type: 'global' as const, area: 'profile' as const };
  if (!(await owner.canAccess(profileScope, 'read')) || !(await owner.canAccess(profileScope, 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Projection requires global profile read and write access');
  const entries = await readableEntries(owner, { kinds: ['user_insight'] });
  const accepted = (await loadDocuments(owner, entries)).filter(d => isInsight(d) && d.status === 'accepted' && insightActiveAt(d.metadata, options.now)); // an expired time-limited instruction is not a profile fact
  // Supersession is committed as a new immutable insight before the old object
  // status is patched. If a process stops between those writes, the durable
  // relation on the newer object still determines the current projection.
  const byId = new Map(accepted.map(doc => [doc.id, doc]));
  const supersededIds = new Set(accepted.flatMap(doc => Array.isArray(doc.metadata.supersedes) ? doc.metadata.supersedes.filter((id): id is string => typeof id === 'string') : []));
  for (const id of supersededIds) {
    const old = byId.get(id); if (!old || ['superseded', 'rejected', 'deleted'].includes(old.status)) continue;
    const replacement = accepted.find(doc => Array.isArray(doc.metadata.supersedes) && doc.metadata.supersedes.includes(id) && applicability(doc) === applicability(old));
    if (!replacement || !await owner.canAccess(old.scope, 'write')) continue;
    try { await owner.patch({ objectId: old.id, expectedRevisionId: old.revisionId, status: 'superseded', metadataPatch: { supersededBy: replacement.uri, supersededByRevision: replacement.revisionId, supersededReason: 'reconciled from the accepted correction after interruption' } }); } catch { /* the durable supersedes relation still hides the old value from this projection */ }
  }
  const docs = accepted.filter(d => !supersededIds.has(d.id));
  // Everything is projected into the two root files (workspace-applicable items in their own sections), never into workspace directories that agents with workspace access can read.
  const labels = [...new Set(docs.map(applicability))].filter(l => l !== 'global').sort();
  const rendered = renderProfileProjection(docs);
  await guarded(owner.root, 'PROFILE.md', 'PROFILE', rendered.profile.split('\n'));
  await guarded(owner.root, 'USER_INSIGHT.md', 'USER_INSIGHT', rendered.userInsight.split('\n'));
  const global = docs.filter(d => applicability(d) === 'global'); const workspaces = labels.length;
  void SOURCE_PRIORITY;
  return { global: global.length, workspaces };
}

export interface ClaimShape { claim: string; category: string; scopeLabel?: string; evidence: Array<{ uri: string; revisionId: string; span?: string }> }
const NEGATION = /\b(?:not|never|no|don't|dont|doesn't|doesnt|won't|wont|cannot|can't|cant|without|avoid|stop)\b/gi;
const salient = (text: string): Set<string> => new Set(normalize(text).split(/\s+/).filter(word => word.length > 3));
/**
 * True only when `fragment` is a strict partial restatement of `full` made from the same statement: same category and scope, every cited span of the
 * fragment lies inside a span the fuller claim cites from the same revision, the same polarity, and the fragment's salient words are a strict subset of the full claim's.
 * Anything else (different sentence, other revision, opposite polarity, other category) is left alone, so unrelated or contradictory facts are never merged.
 */
export function isFragmentOfClaim(fragment: ClaimShape, full: ClaimShape): boolean {
  if (fragment.category !== full.category || (fragment.scopeLabel ?? '') !== (full.scopeLabel ?? '')) return false;
  if ((fragment.claim.match(NEGATION) ?? []).length !== (full.claim.match(NEGATION) ?? []).length) return false;
  if (!fragment.evidence.length || !full.evidence.length) return false;
  for (const ref of fragment.evidence) {
    const span = ref.span ? normalize(ref.span) : '';
    if (!span) return false;
    const covered = full.evidence.some(other => other.uri === ref.uri && other.revisionId === ref.revisionId && !!other.span && normalize(other.span).includes(span));
    if (!covered) return false;
  }
  const small = salient(fragment.claim), large = salient(full.claim);
  if (!small.size || small.size >= large.size) return false;
  for (const word of small) if (!large.has(word)) return false;
  return true;
}

export { insightActiveAt } from './temporal.js';
