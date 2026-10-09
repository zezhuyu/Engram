import { MDBError, type Document, type ModelProposal } from '../../core/types.js';
import { isSensitive } from '../critic.js';
import { domainOf, words } from './plan.js';
import { NOVELTY, SUBTYPES, type DiscoverySubtype, type DreamMode } from './types.js';
import type { ManifestEntry } from '../../search-files/manifest.js';

const fail = (message: string): never => { throw new MDBError('INVALID_MODEL_OUTPUT', message); };
const strings = (v: unknown, name: string, min: number, minLen: number): string[] => { if (!Array.isArray(v) || v.length < min || v.some(x => typeof x !== 'string' || x.trim().length < minLen || x.length > 600)) return fail(`${name} must be ${min}+ concrete strings`); return v as string[]; };
const entryLike = (d: Document): ManifestEntry => ({ id: d.id, rev: d.revisionId, first: 0, last: 0, scope: d.scope, sk: '', kind: d.kind, title: d.title, tags: d.tags, status: d.status, updated: d.updatedAt, at: d.createdAt, refs: [], ...(typeof d.metadata.domain === 'string' ? { dom: d.metadata.domain } : {}) });
export const docDomain = (d: Document): string => domainOf(entryLike(d));

/** Structural validation of a discovery proposal against what the model was shown. Every field the critic or the lifecycle depends on is recomputed or range-checked here. */
export function checkDiscovery(mode: DreamMode, output: ModelProposal, supplied: Document[], goalUris: string[]): Record<string, unknown> {
  const m = output.metadata ?? {};
  const subtype = m.subtype as DiscoverySubtype; if (!SUBTYPES.includes(subtype)) fail('subtype must be composition, analogy, transfer, contradiction or opportunity');
  if (!NOVELTY.includes(m.novelty as never)) fail('novelty must be established, unclear or new_to_user');
  if (typeof m.reasoningSummary !== 'string' || m.reasoningSummary.length < 20 || m.reasoningSummary.length > 400) fail('reasoningSummary must be a 20-400 character justification');
  const limitations = strings(m.limitations, 'limitations', 1, 10), testPlan = strings(m.testPlan, 'testPlan', 1, 15), counterarguments = strings(m.counterarguments, 'counterarguments', 1, 10);
  if (typeof m.proposedValidation !== 'string' || m.proposedValidation.length < 20 || m.proposedValidation.length > 600) fail('proposedValidation must describe a concrete experiment');
  const byUri = new Map(supplied.map(d => [d.uri, d])); const cited = output.evidence.map(e => byUri.get(e.uri)).filter((d): d is Document => !!d);
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
  const byUri = new Map(supplied.map(d => [d.uri, d])); const spans = output.evidence.filter(e => e.span);
  const grounded = output.evidence.length ? output.evidence.filter(e => { const d = byUri.get(e.uri); return !!d && !!e.span && d.body.includes(e.span); }).length / output.evidence.length : 0;
  const cited = [...new Set(output.evidence.map(e => e.uri))].length;
  const arr = (k: string) => (Array.isArray(normalized[k]) ? normalized[k] as string[] : []);
  const mechanism = typeof normalized.mechanism === 'string' ? normalized.mechanism : '';
  const touched = new Set(supplied.filter(d => containment(mechanism, d.body) > 0.15).map(d => d.id)).size;
  const closest = Math.max(0, ...supplied.map(d => jaccard(output.body, d.body)));
  const components = {
    grounding: grounded, breadth: Math.min(1, cited / 3), mechanism: Math.min(1, touched / 2) * Math.min(1, mechanism.length / 80),
    separation: Math.min(1, arr('facts').length) * 0.5 + Math.min(1, arr('speculation').length) * 0.5, falsifiability: Math.min(1, arr('testPlan').length / 2) * (/(measure|compare|observe|count|check|assert|record|time|log)/i.test(String(normalized.proposedValidation)) ? 1 : 0.5),
    candor: Math.min(1, arr('missingEvidence').length) * 0.5 + Math.min(1, arr('counterarguments').length) * 0.5, novelty: 1 - closest, multiHop: Math.min(1, arr('hops').length / 2)
  };
  void spans;
  const weights: Record<string, number> = { grounding: 3, breadth: 1, mechanism: 2, separation: 2, falsifiability: 2, candor: 1.5, novelty: 1.5, multiHop: 1.5 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return { score: Object.entries(components).reduce((n, [k, v]) => n + v * weights[k]!, 0) / total, components };
}
export const jaccard = (a: string, b: string): number => { const x = new Set(words(a)), y = new Set(words(b)); if (!x.size || !y.size) return 0; let i = 0; for (const w of x) if (y.has(w)) i++; return i / (x.size + y.size - i); };
const ABOUT_USER = /\b(?:the user|you|your)\b[^.\n]{0,60}\b(?:is|are|has|have|can|could|knows?|skilled|proficient|expert|prefers?|wants?|likes?|uses?)\b/i;
export interface DreamVerdict { outcome: 'pass' | 'reject' | 'review'; reasons: string[]; flags: string[]; novelty: (typeof NOVELTY)[number]; derivedFromPrivate: boolean }
export interface CriticInput { title: string; body: string; summary: string; mode: DreamMode; subtype: DiscoverySubtype; evidence: Document[]; existing: Document[]; nearby: Document[]; goalRefs: string[]; sourceKeys: string[] }
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
    const same = i.sourceKeys.length > 0 && i.sourceKeys.every(k => ((Array.isArray(old.metadata.sourceRefs) ? old.metadata.sourceRefs : []) as Array<{ uri: string; revisionId: string }>).some(r => `${r.uri.split('/').at(-1)}@${r.revisionId}` === k));
    const sim = jaccard(`${i.title} ${i.body}`, `${old.title} ${old.body}`);
    if (old.status === 'rejected' && (same || sim >= 0.7) && same) return reject('repeat_of_rejected', `Already rejected (${old.uri}) and nothing new has been added to its evidence since.`);
    if (old.status !== 'rejected' && old.status !== 'superseded' && (sim >= 0.7 || same)) return reject('duplicate', `Near-duplicate of the existing discovery ${old.uri}.`);
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
