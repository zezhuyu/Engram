import { MDBError, type Document, type ModelProposal } from '../../core/types.js';
import { isSensitive } from '../critic.js';
import { domainOf, words } from './plan.js';
import { NOVELTY, SUBTYPES, type DiscoverySubtype, type DreamMode } from './types.js';
import type { ManifestEntry } from '../../search-files/manifest.js';

const fail = (message: string): never => { throw new MDBError('INVALID_MODEL_OUTPUT', message); };
const strings = (v: unknown, name: string, min: number, minLen: number): string[] => { if (!Array.isArray(v) || v.length < min || v.some(x => typeof x !== 'string' || x.trim().length < minLen || x.length > 600)) return fail(`${name} must be ${min}+ concrete strings`); return v as string[]; };
const entryLike = (d: Document): ManifestEntry => ({ id: d.id, rev: d.revisionId, first: 0, last: 0, scope: d.scope, sk: '', kind: d.kind, title: d.title, tags: d.tags, status: d.status, updated: d.updatedAt, at: d.createdAt, refs: [], ...(typeof d.metadata.domain === 'string' ? { dom: d.metadata.domain } : {}) });
export const docDomain = (d: Document): string => domainOf(entryLike(d));

const RELATION_WORD = /\b(?:connects?|links?|uses?|depends? on|enables?|supports?|implements?|integrates?|contradicts?|conflicts? with|is based on|is used by|feeds into|transfers? to)\b/i;
const bodyWords = (doc: Document): Set<string> => new Set(words(`${doc.title} ${doc.body}`));
function textStatesCrossRelation(a: Document, b: Document): boolean {
  const aw = bodyWords(a), bw = bodyWords(b);
  const at = new Set(words(a.title)), bt = new Set(words(b.title));
  const distinctive = (title: Set<string>, other: Set<string>) => [...title].filter(word => !other.has(word));
  const aMentionsB = distinctive(bt, at).some(word => aw.has(word));
  const bMentionsA = distinctive(at, bt).some(word => bw.has(word));
  return (aMentionsB && RELATION_WORD.test(a.body)) || (bMentionsA && RELATION_WORD.test(b.body));
}

/**
 * True when the supplied cross-domain material has no source-level bridge.
 * Shared vocabulary is a retrieval clue only: neither one shared token nor
 * several shared tokens constitute evidence of a relationship. Explicit
 * provides/consumes tags, cross-source links, or a source sentence that names
 * the other subject and states a relation are the bounded evidence signals.
 */
export function isLexicalOnlyCrossDomain(supplied: Document[]): boolean {
  const docs = supplied.filter(doc => doc.kind !== 'user_insight');
  if (docs.length < 2) return false;
  const domains = new Set(docs.map(docDomain));
  if (domains.size < 2) return false;
  const pairHasStructuredBridge = (a: Document, b: Document): boolean => {
    const values = (doc: Document, prefix: string) => new Set(doc.tags.filter(tag => tag.startsWith(prefix)).map(tag => tag.slice(prefix.length).toLowerCase()));
    const providesA = values(a, 'provides:'), consumesA = values(a, 'consumes:');
    const providesB = values(b, 'provides:'), consumesB = values(b, 'consumes:');
    const linked = (source: Document, target: Document) => source.links?.some(link => link.target === target.uri) ?? false;
    return [...providesA].some(value => consumesB.has(value)) || [...providesB].some(value => consumesA.has(value)) || linked(a, b) || linked(b, a);
  };
  let crossDomainPairs = 0, unsupportedPairs = 0;
  for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
    if (docDomain(docs[i]!) === docDomain(docs[j]!)) continue;
    crossDomainPairs++;
    if (!pairHasStructuredBridge(docs[i]!, docs[j]!) && !textStatesCrossRelation(docs[i]!, docs[j]!)) unsupportedPairs++;
  }
  return crossDomainPairs > 0 && unsupportedPairs === crossDomainPairs;
}

/** A deliberately narrow, source-auditable no-mechanism outcome for lexical-decoy pairs. */
export function isHonestNoMechanismProposal(output: Pick<ModelProposal, 'title' | 'body'>, normalized: Record<string, unknown>): boolean {
  const mechanism = typeof normalized.mechanism === 'string' ? normalized.mechanism.trim() : '';
  if (!/^no\s+(?:(?:shared|cross[- ]domain)\s+)?mechanism\s+(?:is\s+|has been\s+)?(?:established|shown|identified|supported)\b/i.test(mechanism)) return false;
  const hops = Array.isArray(normalized.hops) ? normalized.hops : [];
  if (!hops.length || hops.some(hop => typeof hop !== 'string'
    || !/\b(?:no|not|unresolved|conflict|disagree|unrelated|homonym|shared (?:name|term|word))\b/i.test(hop)
    || /\b(?:connects?|links?|transfers?|causes?|enables?|explains?|maps? to|leads? to)\b/i.test(hop))) return false;
  const text = [output.title, output.body, mechanism, ...hops,
    ...(Array.isArray(normalized.speculation) ? normalized.speculation : [])].join('\n');
  if (!/\b(?:no (?:defensible|supported|cross[- ]domain|shared) (?:connection|relationship|link|mechanism)|no evidence (?:of (?:a|any) )?(?:(?:cross[- ]domain|shared) )?(?:connection|relationship|link|mechanism)|does not establish (?:a|any) (?:connection|relationship|link|mechanism)|no evidence (?:establishes|supports|links)|remains? unresolved)\b/i.test(text)) return false;
  if (/\b(?:connects?|links?|transfers?|causes?|enables?|explains?|maps? to|leads? to|demonstrates?)\b/i.test(text)) return false;
  if (/\b(?:could|might|may)\s+(?:connect|link|transfer|cause|enable|explain)|\b(?:therefore|thus|so)\b/i.test(text)) return false;
  return true;
}

/** Structural validation of a discovery proposal against what the model was shown. Every field the critic or the lifecycle depends on is recomputed or range-checked here. */
export function checkDiscovery(mode: DreamMode, output: ModelProposal, supplied: Document[], goalUris: string[], requiredHintKinds: string[] = []): Record<string, unknown> {
  const m = output.metadata ?? {};
  const subtype = m.subtype as DiscoverySubtype; if (!SUBTYPES.includes(subtype)) fail('subtype must be composition, analogy, transfer, contradiction or opportunity');
  if (!NOVELTY.includes(m.novelty as never)) fail('novelty must be established, unclear or new_to_user');
  if (typeof m.reasoningSummary !== 'string' || m.reasoningSummary.length < 20 || m.reasoningSummary.length > 400) fail('reasoningSummary must be a 20-400 character justification');
  const limitations = strings(m.limitations, 'limitations', 1, 10), testPlan = strings(m.testPlan, 'testPlan', 1, 15), counterarguments = strings(m.counterarguments, 'counterarguments', 1, 10);
  if (typeof m.proposedValidation !== 'string' || m.proposedValidation.length < 20 || m.proposedValidation.length > 600) fail('proposedValidation must describe a concrete experiment');
  const byUri = new Map(supplied.map(d => [d.uri, d]));
  for (const ref of output.evidence) {
    const source = byUri.get(ref.uri);
    if (!source) throw new MDBError('INVALID_MODEL_OUTPUT', 'every evidence reference must identify a supplied source revision');
    if (source.revisionId !== ref.revisionId) throw new MDBError('INVALID_MODEL_OUTPUT', 'every evidence reference must identify a supplied source revision');
    if (typeof ref.span !== 'string' || ref.span.length === 0 || !source.body.includes(ref.span)) throw new MDBError('INVALID_MODEL_OUTPUT', `evidence span is not an exact substring of its cited source: ${ref.uri}`);
  }
  const cited = output.evidence.map(e => byUri.get(e.uri)).filter((d): d is Document => !!d);
  const domains = [...new Set(cited.filter(d => !goalUris.includes(d.uri)).map(docDomain))];
  if (cited.filter(d => !goalUris.includes(d.uri)).length < 2) fail('a discovery must combine at least two knowledge objects');
  if (domains.length < 2 && mode !== 'strategic') fail('a discovery must cross at least two domains');
  const extra: Record<string, unknown> = {};
  if (mode === 'deep') {
    // Deep discoveries must separate what the sources state from what is conjecture, and say what evidence is still missing.
    const facts = strings(m.facts, 'facts', 1, 10), speculation = strings(m.speculation, 'speculation', 1, 10), missingEvidence = strings(m.missingEvidence, 'missingEvidence', 1, 10);
    const hops = strings(m.hops, 'hops', subtype === 'contradiction' ? 1 : 2, 10);
    const corpus = cited.map(d => d.body);
    for (const fact of facts) if (!corpus.some(body => containment(fact, body) >= 0.6)) fail('every entry in facts must restate a cited source; move conjecture to speculation');
    if (requiredHintKinds.includes('contradiction')) {
      if (subtype !== 'contradiction') fail('a planner contradiction must remain an unresolved contradiction');
      const citedSources = [...new Set(output.evidence.map(ref => ref.uri))].map(uri => byUri.get(uri)).filter((doc): doc is Document => !!doc && !goalUris.includes(doc.uri));
      const represented = new Set(facts.flatMap(fact => {
        const match = citedSources.find(source => containment(fact, source.body) >= 0.6);
        return match ? [match.uri] : [];
      }));
      if (represented.size < 2) fail('an unresolved contradiction must separately state source-supported facts from both claims');
      const noMechanism = typeof m.mechanism === 'string' && /^(?:no|none)\s+(?:shared\s+)?mechanism\s+(?:is|has been)\s+(?:established|shown|identified)\b/i.test(m.mechanism.trim());
      if (!noMechanism) fail('a planner contradiction must not invent a resolving mechanism');
      const reconciliation = /\b(?:only if|provided that|as long as|unless|except(?:ion)?|reconcil(?:e|iation)|hinge(?:s)? on|resolve(?:d|s)? by|because of|caused by|therefore safe|safe if|can be made safe|context(?:ual)? differences? (?:could|may|might|can) explain|different (?:contexts|scopes|configurations|endpoint types) (?:could|may|might|can) explain|one source (?:may|might|could) refer to .* other|one source (?:may|might|could) refer(?:s)? to (?:a )?(?:specific|particular|different) (?:(?:type|kind) (?:of )?)?(?:scope|context|configuration|endpoint|cach(?:e|ing) mechanism|type|kind)|(?:it is )?(?:possible|plausible|uncertain) that (?:one|a) source (?:may|might|could )?refer(?:s)? to (?:a )?(?:specific|particular|different) (?:(?:type|kind) (?:of )?)?(?:scope|context|configuration|endpoint|cach(?:e|ing) mechanism|type|kind)|(?:it is )?(?:possible|uncertain) that (?:the )?(?:first|second|one) claim (?:is|may be|might be|could be) limited to|(?:it is )?uncertain whether (?:the )?(?:first|second|one) claim is limited to)\b/i;
      // Every model-authored field can carry a reconciliation, including fields
      // that are nominally counterarguments or validation suggestions.
      const candidateText = [output.title, output.body, ...facts, ...speculation, ...missingEvidence, ...hops, ...limitations, ...counterarguments, m.reasoningSummary, m.mechanism, m.proposedValidation, ...testPlan].join('\n');
      if (reconciliation.test(candidateText)) fail('a planner contradiction must remain unresolved and cannot add a condition, reconciliation, or causal explanation');
      if (!/\b(?:unresolved|not resolved|remain(?:s)? in conflict)\b/i.test(output.body)) fail('a contradiction body must explicitly preserve the unresolved conflict');
    }
    extra.facts = facts; extra.speculation = speculation; extra.missingEvidence = missingEvidence; extra.hops = hops;
  }
  if (mode === 'deep') { if (typeof m.mechanism !== 'string' || m.mechanism.length < 20) fail('a deep discovery needs a mechanism explaining why the domains connect'); if (!['complementary', 'distant'].includes(String(m.distance))) fail('a deep discovery needs a distance (complementary or distant)'); extra.mechanism = m.mechanism; extra.distance = m.distance; }
  if (mode === 'strategic') {
    const refs = strings(m.goalRefs, 'goalRefs', 1, 5); if (refs.some(r => !goalUris.includes(r))) fail('goalRefs must be goal objects that were supplied'); if (!output.evidence.some(e => refs.includes(e.uri))) fail('a strategic discovery must cite the goal it serves');
    extra.goalRefs = refs; extra.prerequisites = strings(m.prerequisites, 'prerequisites', 1, 5);
  }
  return { subtype, novelty: m.novelty, reasoningSummary: m.reasoningSummary, limitations, testPlan, counterarguments, proposedValidation: m.proposedValidation, domains, ...extra };
}

/** Share of the claim's distinctive words that appear in the source. */
export const containment = (claim: string, source: string): number => { const c = new Set(words(claim)), s = new Set(words(source)); if (!c.size) return 0; let n = 0; for (const w of c) if (s.has(w)) n++; return n / c.size; };
export interface CandidateScore { score: number; components: Record<string, number> }
/**
 * Deterministic comparison of sibling deep candidates built from the same cluster. Higher is better; it only chooses among candidates the structural check and the critic
 * already allowed, and never approves anything.
 */
export function scoreCandidate(output: ModelProposal, normalized: Record<string, unknown>, supplied: Document[]): CandidateScore {
  const lexicalDecoy = isLexicalOnlyCrossDomain(supplied);
  if (lexicalDecoy) {
    const honestNoMechanism = isHonestNoMechanismProposal(output, normalized);
    return { score: honestNoMechanism ? 1 : 0, components: { lexicalDecoy: 1, honestNoMechanism: honestNoMechanism ? 1 : 0 } };
  }
  const byUri = new Map(supplied.map(d => [d.uri, d])); const spans = output.evidence.filter(e => e.span);
  const grounded = output.evidence.length ? output.evidence.filter(e => { const d = byUri.get(e.uri); return !!d && !!e.span && d.body.includes(e.span); }).length / output.evidence.length : 0;
  const cited = [...new Set(output.evidence.map(e => e.uri))].length;
  const arr = (k: string) => (Array.isArray(normalized[k]) ? normalized[k] as string[] : []);
  // Mechanism fluency, length, and lexical overlap are not proof that a
  // cross-domain bridge is supported. Semantic quality remains for human
  // adjudication and must not influence this structural sibling ranking.
  const components = {
    grounding: grounded, breadth: Math.min(1, cited / 3),
    separation: Math.min(1, arr('facts').length) * 0.5 + Math.min(1, arr('speculation').length) * 0.5, falsifiability: Math.min(1, arr('testPlan').length / 2) * (/\b(measure|compare|observe|count|check|assert|record|time|log)\b/i.test(String(normalized.proposedValidation)) ? 1 : 0.5),
    candor: Math.min(1, arr('missingEvidence').length) * 0.5 + Math.min(1, arr('counterarguments').length) * 0.5
  };
  void spans;
  const weights: Record<string, number> = { grounding: 3, breadth: 1, separation: 2, falsifiability: 2, candor: 1.5 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return { score: Object.entries(components).reduce((n, [k, v]) => n + v * weights[k]!, 0) / total, components };
}
export const jaccard = (a: string, b: string): number => { const x = new Set(words(a)), y = new Set(words(b)); if (!x.size || !y.size) return 0; let i = 0; for (const w of x) if (y.has(w)) i++; return i / (x.size + y.size - i); };
const ABOUT_USER = /\b(?:the user|you|your)\b[^.\n]{0,60}\b(?:is|are|has|have|can|could|knows?|skilled|proficient|expert|prefers?|wants?|likes?|uses?)\b/i;
export interface DreamVerdict { outcome: 'pass' | 'reject' | 'review'; reasons: string[]; flags: string[]; novelty: (typeof NOVELTY)[number]; derivedFromPrivate: boolean }
export interface CriticInput { title: string; body: string; summary: string; mode: DreamMode; subtype: DiscoverySubtype; evidence: Document[]; existing: Document[]; nearby: Document[]; goalRefs: string[]; sourceKeys: string[]; metadata?: Record<string, unknown> }
const sourceKeysOf = (doc: Document): Set<string> => new Set(
  ((Array.isArray(doc.metadata.sourceRefs) ? doc.metadata.sourceRefs : doc.evidence) as Array<{ uri: string; revisionId: string }> | undefined ?? [])
    .map(ref => `${ref.uri.split('/').at(-1)}@${ref.revisionId}`),
);
/**
 * Deterministic critic for dream output. It never approves: pass means "reviewable". Order matters: the cheapest, most decisive rules run first and each
 * rejection carries a stable flag and a human reason so the rejected idea can be kept as a record and not re-proposed without new evidence.
 */
export function judgeDiscovery(i: CriticInput): DreamVerdict {
  const text = `${i.title}\n${i.body}\n${i.summary}`; const reject = (flag: string, reason: string, novelty: DreamVerdict['novelty'] = 'unclear'): DreamVerdict => ({ outcome: 'reject', reasons: [reason], flags: [flag], novelty, derivedFromPrivate: false });
  if (ABOUT_USER.test(text)) return reject('claims_about_user', 'A discovery is about the knowledge, not a statement of what the user is, knows, wants or can do; those come only from evidence-backed user insights.');
  const domains = new Set(i.evidence.map(docDomain)); if (domains.size < 2 && i.mode !== 'strategic') return reject('single_domain', 'The cited objects come from one domain, so nothing is being combined.');
  const bodyWords = words(`${i.title} ${i.body}`);
  for (const source of i.evidence) if (source.body.length > 40 && jaccard(i.body, source.body) >= 0.8) return reject('trivial_restatement', `Restates ${source.uri} instead of adding a connection.`, 'established');
  for (const old of i.existing) {
    const oldSources = sourceKeysOf(old);
    // A source set that is wholly contained in the earlier discovery has not
    // grown. Citation spans and wording are model-selected and must not make a
    // rejected idea look new. A new object or a new revision is new evidence.
    const noEvidenceGrowth = i.sourceKeys.length > 0 && i.sourceKeys.every(key => oldSources.has(key));
    // The same evidence can support a genuinely different kind of connection
    // (for example, a contradiction and a composition). Rewording the same
    // subtype is not a new idea, even when the model chooses different spans.
    const sameIdeaFamily = old.metadata.subtype === i.subtype;
    const sim = jaccard(`${i.title} ${i.body}`, `${old.title} ${old.body}`);
    const differentAngle = typeof old.metadata.candidateAngle === 'string'
      && typeof i.metadata?.candidateAngle === 'string'
      && old.metadata.candidateAngle !== i.metadata.candidateAngle;
    const siblingAngle = old.metadata.jobId === i.metadata?.jobId
      && differentAngle
      && typeof i.metadata?.candidateAngle === 'string'
      && old.metadata.candidateAngle !== i.metadata.candidateAngle;
    // Planner angle is a sibling exemption only within the same job. A later
    // job cannot evade rejection/dedup by assigning a fresh angle to the same
    // unchanged source revisions.
    if (old.status === 'rejected' && noEvidenceGrowth && sameIdeaFamily && !siblingAngle) return reject('repeat_of_rejected', `Already rejected (${old.uri}) and its evidence has not grown.`);
    if (old.status !== 'rejected' && old.status !== 'superseded' && noEvidenceGrowth && sameIdeaFamily && !siblingAngle) return reject('duplicate', `This evidence set has already produced a live discovery (${old.uri}); new evidence is required before another proposal.`);
    if (old.status !== 'rejected' && old.status !== 'superseded' && sim >= 0.7 && !siblingAngle) return reject('duplicate', `Near-duplicate of the existing discovery ${old.uri}.`);
  }
  const closest = Math.max(0, ...i.nearby.filter(d => !i.evidence.some(e => e.id === d.id)).map(d => jaccard(`${i.title} ${i.body}`, `${d.title} ${d.body}`)), ...i.evidence.map(d => jaccard(i.body, d.body)));
  const novelty: DreamVerdict['novelty'] = closest >= 0.55 ? 'established' : closest >= 0.3 ? 'unclear' : 'new_to_user';
  if (novelty === 'established' && !(i.mode === 'strategic' && i.goalRefs.length)) return reject('already_known', `Overlaps existing knowledge (similarity ${closest.toFixed(2)}) without serving a stated goal.`, 'established');
  if (bodyWords.length < 6) return reject('too_thin', 'Too little content to evaluate.');
  const privateSource = i.evidence.some(d => d.scope.type === 'workspace'); const workspaces = new Set(i.evidence.filter(d => d.scope.type === 'workspace').map(d => (d.scope as { workspaceId: string }).workspaceId));
  const reasons: string[] = []; const flags: string[] = [];
  if (privateSource) { flags.push('derived_from_private'); reasons.push('Built from private workspace material: kept private to you until you review it.'); }
  if (workspaces.size > 1) { flags.push('cross_workspace'); reasons.push('Combines more than one workspace.'); }
  if (i.mode === 'strategic') { flags.push('high_impact'); reasons.push('Goal-directed options are reviewed before they are acted on.'); }
  if (isSensitive(text)) { flags.push('sensitive'); reasons.push('Touches sensitive subject matter.'); }
  return { outcome: flags.length ? 'review' : 'pass', reasons: reasons.length ? reasons : ['Passed the deterministic checks; still a hypothesis awaiting review.'], flags, novelty, derivedFromPrivate: privateSource };
}
