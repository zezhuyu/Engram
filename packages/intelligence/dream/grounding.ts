/**
 * Fact grounding for Dream discoveries. Replaces a purely lexical "shares >= 60% of its words with a cited source" test with a clause-level check that also refuses
 * claims the cited source CONTRADICTS (negation, antonyms, modals), restates in the present what the source marks as historical, drops a stated condition, or mixes a
 * supported proposition with an unsupported one. It is a deterministic guard, not entailment: a claim that passes still goes to the critic and the human reviewer.
 */
export interface GroundingSource { title?: string; body: string }
export type GroundingFailure = 'unsupported_proposition' | 'contradicted' | 'temporal_mismatch' | 'conditional_dropped' | 'conflicting_evidence';
export interface GroundingResult { ok: boolean; reason?: GroundingFailure; detail?: string }

const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were', 'will', 'which', 'their', 'there', 'about', 'into', 'also', 'than', 'then', 'these', 'those', 'user', 'what', 'when', 'where', 'while', 'such', 'each', 'every', 'some', 'other', 'being', 'does', 'only']);
const stem = (w: string): string => (w.length <= 5 ? w : w.replace(/ies$/, 'y').replace(/(?:ing|ed|es|s)$/, ''));
const expand = (text: string): string => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\bcan['’]?t\b/g, 'cannot').replace(/\bwon['’]?t\b/g, 'will not').replace(/(\w)n['’]t\b/g, '$1 not').replace(/\bno longer\b/g, 'nolonger');
const tokens = (text: string): string[] => expand(text).match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
const NEGATORS = new Set(['not', 'no', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor', 'cannot', 'unable', 'without', 'nolonger']);
// Explicit antonym pairs (either direction). Prefix pairs (x / unx, inx, nonx, disx, imx, irx) are detected generically below, only when both forms occur.
const ANTONYMS: Array<[string, string]> = [['safe', 'dangerous'], ['allow', 'forbid'], ['allow', 'prohibit'], ['allow', 'deny'], ['allow', 'disallow'], ['allowed', 'forbidden'], ['allowed', 'prohibited'], ['allowed', 'denied'], ['permitted', 'forbidden'], ['required', 'optional'], ['true', 'false'], ['increase', 'decrease'], ['increases', 'decreases'], ['faster', 'slower'], ['higher', 'lower'], ['more', 'fewer'], ['more', 'less'], ['enable', 'disable'], ['enabled', 'disabled'], ['always', 'never'], ['all', 'none'], ['public', 'private'], ['open', 'closed'], ['before', 'after'], ['accept', 'reject'], ['accepted', 'rejected'], ['pass', 'fail'], ['passes', 'fails'], ['present', 'absent'], ['strong', 'weak'], ['legal', 'illegal'], ['can', 'cannot'], ['must', 'forbidden'], ['leaks', 'protects'], ['encrypted', 'plaintext']];
const PREFIXES = ['un', 'in', 'im', 'ir', 'non', 'dis'];
const antonymPair = (a: string, b: string): boolean => {
  if (a === b) return false;
  for (const [x, y] of ANTONYMS) if ((a === x && b === y) || (a === y && b === x)) return true;
  for (const p of PREFIXES) if ((b === p + a && a.length >= 3) || (a === p + b && b.length >= 3)) return true;
  return false;
};
const HISTORIC = /\b(?:nolonger|used to|formerly|previously|deprecated|removed|retired|obsolete|discontinued|until\s+(?:v?\d|version|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}))\b/;
const CONDITION = /\b(?:only if|only when|if|unless|provided that|as long as|except|depending on|in case)\b/;
const ATTRIBUTION = /\b(?:says?|said|states?|stated|claims?|claimed|according to|reports?|argues?|asserts?)\b/;

const CONDITION_SPLIT = /\s(?:only if|only when|if|unless|provided that|as long as|except|depending on|in case)\s/i;
/** The main proposition of a clause without its condition ("safe only if responses are not authenticated" -> "safe"): negation inside a condition is a different proposition. */
const core = (text: string): string => { const m = CONDITION_SPLIT.exec(text); return m && m.index > 0 && contentTokens(text.slice(0, m.index)).length >= 1 ? text.slice(0, m.index) : text; };
const PAST = /\b(?:was|were|had|did|used to|formerly|previously|\w{5,}ed)\b/;
const contentTokens = (text: string): string[] => tokens(text).filter(w => w.length >= 4 && !STOP.has(w) && !NEGATORS.has(w)).map(stem);
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const clausesOf = (sentence: string): string[] => sentence.split(/[,;:]|\s(?:and|but|while|whereas|although|though|because|so|yet)\s/i).map(c => c.trim()).filter(Boolean);

interface SourceClause { text: string; sentence: string; set: Set<string> }
const clausesFromSource = (source: GroundingSource): SourceClause[] => {
  const out: SourceClause[] = [];
  const title = contentTokens(source.title ?? ''); // the title supplies the subject of every clause of the body, but never its polarity
  for (const sentence of sentences(source.body)) for (const clause of clausesOf(sentence)) out.push({ text: clause, sentence, set: new Set([...contentTokens(clause), ...title]) });
  if (!out.length && source.title) out.push({ text: source.title, sentence: source.title, set: new Set(title) });
  return out;
};
const containment = (factClause: string, clause: SourceClause): number => {
  const c = contentTokens(factClause); if (!c.length) return 0;
  const matched = new Set<number>(); c.forEach((w, i) => { if (clause.set.has(w)) matched.add(i); });
  for (let i = 0; i + 1 < c.length; i++) if (clause.set.has(c[i]! + c[i + 1]!)) { matched.add(i); matched.add(i + 1); } // "rate limit" vs "ratelimit"
  return matched.size / c.length;
};
/** Odd number of polarity flips between a fact clause and a source clause: negator parity xor antonym pairs (a double flip cancels: "not unsafe" == "safe"). */
export function polarityConflict(factClause: string, sourceClause: string): boolean {
  const f = tokens(factClause), s = tokens(sourceClause);
  const neg = (ts: string[]) => ts.filter(t => NEGATORS.has(t)).length % 2;
  let flips = neg(f) ^ neg(s);
  const fSet = new Set(f), sSet = new Set(s); let antonyms = 0;
  for (const a of fSet) { if (NEGATORS.has(a)) continue; for (const b of sSet) { if (NEGATORS.has(b)) continue; if (!sSet.has(a) && !fSet.has(b) && antonymPair(a, b)) antonyms++; } }
  flips ^= antonyms % 2 === 1 || antonyms > 1 ? 1 : 0; // any antonym pair flips once (several pairs in one clause are one contradiction)
  // "always"/"never" pairs are covered above; "can" vs "cannot" is covered by negator parity (cannot is a negator, can is not an antonym when negators already differ)
  return flips === 1;
}
const bestMatch = (factClause: string, clauses: SourceClause[]): { clause: SourceClause; score: number } | undefined => {
  let best: { clause: SourceClause; score: number } | undefined;
  for (const clause of clauses) { const score = containment(factClause, clause); if (!best || score > best.score) best = { clause, score }; }
  return best;
};
/** Among the best-scoring clauses (ties are common for short facts) prefer one whose polarity agrees; the fact is contradicted only if every best clause disagrees. */
const consistentTied = (fc: string, entries: SourceClause[][], score: number): { agrees: boolean; clause?: SourceClause } => {
  let first: SourceClause | undefined;
  for (const clauses of entries) for (const clause of clauses) {
    if (containment(fc, clause) < score - 1e-9) continue;
    first ??= clause; if (!polarityConflict(core(fc), core(clause.text))) return { agrees: true, clause };
  }
  return first ? { agrees: false, clause: first } : { agrees: true };
};
const factClauses = (fact: string): string[] => {
  const all = sentences(fact).flatMap(clausesOf); const kept = all.filter(c => contentTokens(c).length >= 2);
  return kept.length ? kept : [fact];
};

/** Does ONE source support the fact without contradicting it? (used to decide which claim of a planner contradiction a fact restates) */
export function sourceSupportsFact(fact: string, source: GroundingSource): boolean {
  const clauses = clausesFromSource(source);
  return factClauses(fact).every(fc => { const m = bestMatch(fc, clauses); return !!m && m.score >= 0.6 && consistentTied(fc, [clauses], m.score).agrees; });
}

export function assessFactGrounding(fact: string, sources: GroundingSource[], options: { contradictionMode?: boolean } = {}): GroundingResult {
  const perSource = sources.map(source => ({ source, clauses: clausesFromSource(source) }));
  for (const fc of factClauses(fact)) {
    let best: { clause: SourceClause; score: number; idx: number } | undefined;
    perSource.forEach((entry, idx) => { const m = bestMatch(fc, entry.clauses); if (m && (!best || m.score > best.score)) best = { ...m, idx }; });
    if (!best || best.score < 0.6) return { ok: false, reason: 'unsupported_proposition', detail: fc.slice(0, 120) };
    const tied = consistentTied(fc, perSource.map(e => e.clauses), best.score);
    if (!tied.agrees) return { ok: false, reason: 'contradicted', detail: `${fc.slice(0, 80)} <> ${(tied.clause ?? best.clause).text.slice(0, 80)}` };
    const factText = expand(fc), sourceSentence = expand(best.clause.sentence);
    if (!PAST.test(factText) && !HISTORIC.test(factText)) for (const entry of perSource) for (const clause of entry.clauses) if (containment(fc, clause) >= 0.6 && HISTORIC.test(expand(clause.text))) return { ok: false, reason: 'temporal_mismatch', detail: clause.sentence.slice(0, 120) };
    if (CONDITION.test(sourceSentence) && !CONDITION.test(expand(fact)) && !/\b(?:when|conditional|depend\w*|may|might|could)\b/.test(factText)) return { ok: false, reason: 'conditional_dropped', detail: best.clause.sentence.slice(0, 120) };
    if (!options.contradictionMode && !ATTRIBUTION.test(factText)) {
      for (let i = 0; i < perSource.length; i++) {
        if (i === best.idx) continue;
        const m = bestMatch(fc, perSource[i]!.clauses);
        if (m && m.score >= 0.4 && polarityConflict(core(fc), core(m.clause.text))) return { ok: false, reason: 'conflicting_evidence', detail: `${fc.slice(0, 80)} <> ${m.clause.text.slice(0, 80)}` };
      }
    }
  }
  return { ok: true };
}
