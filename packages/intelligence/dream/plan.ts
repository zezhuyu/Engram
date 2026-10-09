import type { ManifestEntry } from '../../search-files/manifest.js';
import type { Budgets, Cluster, Distance, Hint, PlanContext, Trace, TraceCandidate } from './types.js';

export const KNOWLEDGE_KINDS = ['wiki_page', 'insight', 'finding', 'procedure', 'analysis', 'note', 'reflection', 'decision', 'fact', 'source', 'working_memory'];
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were', 'will', 'which', 'their', 'there', 'about', 'would', 'could', 'should', 'into', 'also', 'than', 'then', 'when', 'what', 'these', 'those', 'user', 'page', 'notes', 'note', 'about', 'using', 'used', 'over', 'under']);
export const domainOf = (e: ManifestEntry): string => e.dom ?? e.tags.find(t => t.startsWith('domain:'))?.slice(7) ?? e.tags.find(t => !t.includes(':')) ?? e.kind;
export const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) ?? []).filter(w => !STOP.has(w));
/** Shared vocabulary of an object: its plain tags and the distinctive words of its title. Bodies are only read for the few objects that reach the model. */
export const conceptsOf = (e: ManifestEntry): Set<string> => new Set([...e.tags.filter(t => !t.includes(':')).map(t => t.toLowerCase()), ...words(e.title)]);
const tagValues = (e: ManifestEntry, prefix: string) => e.tags.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length).toLowerCase());
export const provides = (e: ManifestEntry) => new Set(tagValues(e, 'provides:')); export const consumes = (e: ManifestEntry) => new Set(tagValues(e, 'consumes:'));
const intersect = <T>(a: Set<T>, b: Set<T>) => [...a].filter(x => b.has(x));
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
export function rngFrom(seed: string): () => number { let s = hash(seed); return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const newest = (a: ManifestEntry, b: ManifestEntry) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1);
const pairKey = (a: string, b: string) => [a, b].sort().join('|');

export function emptyTrace(mode: Trace['mode'], algorithm: string, ctx: PlanContext, seeds: string[] = []): Trace {
  return { mode, algorithm, seeds, poolSize: ctx.pool.length, domainsInPool: new Set(ctx.pool.map(domainOf)).size, candidates: [], clusters: [], budget: { ...ctx.budgets, usedObjects: 0 }, skipped: [], domainsCovered: [], semanticAssociations: ctx.semanticAssociationCount ?? 0 };
}
function finish(trace: Trace, clusters: Cluster[], ctx: PlanContext, byId: Map<string, ManifestEntry>): { clusters: Cluster[]; trace: Trace } {
  const used = new Set<string>();
  for (const c of clusters) { for (const id of c.ids) used.add(id); trace.clusters.push({ id: c.id, ids: c.ids, domains: [...new Set(c.ids.map(id => domainOf(byId.get(id)!)))], hints: c.hints.map(h => ({ kind: h.kind, via: h.via, distance: h.distance })) }); }
  trace.budget.usedObjects = used.size; trace.domainsCovered = [...new Set([...used].map(id => domainOf(byId.get(id)!)))].sort(); void ctx;
  return { clusters, trace };
}
const hintFor = (a: ManifestEntry, b: ManifestEntry, via: string, distance: Distance, score: number): Hint => {
  const pa = provides(a), cb = consumes(b), pb = provides(b), ca = consumes(a);
  const link = [...intersect(pa, cb), ...intersect(pb, ca)][0];
  const kind: Hint['kind'] = link ? 'composition' : via === 'contradiction' ? 'contradiction' : a.kind === 'procedure' || b.kind === 'procedure' ? 'transfer' : distance === 'distant' ? 'analogy' : 'composition';
  return { kind, via, why: link ? `${link} is provided by one and consumed by the other` : via === 'contradiction' ? 'the two disagree or are marked as contradicting' : `they share "${via.replace(/^[a-z-]+:/, '')}" across ${domainOf(a)} and ${domainOf(b)}`, ids: [a.id, b.id], domains: [domainOf(a), domainOf(b)], distance, score };
};

/**
 * MICRO: local neighbourhood of what just changed. Starting from the changed objects only, take direct graph neighbours and same-domain objects that share
 * vocabulary (near), then a few objects from OTHER domains that share vocabulary or a provides/consumes link (complementary). Small, cheap, no global sampling.
 */
export function planMicro(ctx: PlanContext, seeds: ManifestEntry[]): { clusters: Cluster[]; trace: Trace } {
  const trace = emptyTrace('micro', 'local-neighbourhood', ctx, seeds.map(s => s.id)); const byId = new Map(ctx.pool.map(e => [e.id, e])); const clusters: Cluster[] = [];
  for (const seed of seeds.slice(0, ctx.budgets.maxClusters)) {
    const sc = conceptsOf(seed), sd = domainOf(seed);
    const graphNear = [...ctx.graph.out(seed), ...ctx.graph.in(seed)].filter(e => e.id !== seed.id && byId.has(e.id));
    const semanticNear = (ctx.graph.semantic?.(seed) ?? []).filter(e => e.id !== seed.id && byId.has(e.id) && domainOf(e) !== sd);
    const sameDomain = ctx.pool.filter(e => e.id !== seed.id && domainOf(e) === sd && intersect(sc, conceptsOf(e)).length).sort((a, b) => intersect(sc, conceptsOf(b)).length - intersect(sc, conceptsOf(a)).length || newest(a, b));
    const near = [...new Map([...graphNear, ...sameDomain].map(e => [e.id, e])).values()].slice(0, 3);
    const complementary = ctx.pool.filter(e => e.id !== seed.id && domainOf(e) !== sd).map(e => ({ e, shared: intersect(sc, conceptsOf(e)), pc: intersect(provides(seed), consumes(e)).length + intersect(provides(e), consumes(seed)).length })).filter(x => x.shared.length || x.pc).sort((a, b) => b.pc - a.pc || b.shared.length - a.shared.length || newest(a.e, b.e)).slice(0, 2);
    if (!complementary.length && !semanticNear.length) { trace.skipped.push({ reason: 'single_domain', detail: seed.id }); continue; }
    const hints = [...complementary.map(x => hintFor(seed, x.e, x.pc ? `provides-consumes:${[...intersect(provides(seed), consumes(x.e)), ...intersect(provides(x.e), consumes(seed))][0]}` : `shared:${x.shared[0]}`, 'complementary', 1 + x.pc)), ...semanticNear.filter(e => !complementary.some(x => x.e.id === e.id)).slice(0, 2).map(e => hintFor(seed, e, 'semantic-association', 'complementary', 0.8))];
    const ids = [seed.id, ...complementary.map(x => x.e.id), ...semanticNear.map(e => e.id), ...near.map(e => e.id)].slice(0, ctx.budgets.maxPerCluster);
    for (const id of ids) trace.candidates.push({ id, domain: domainOf(byId.get(id)!), distance: id === seed.id ? 'near' : complementary.some(x => x.e.id === id) || semanticNear.some(e => e.id === id) ? 'complementary' : 'near', via: id === seed.id ? 'seed' : hints.find(h => h.ids.includes(id))?.via ?? (ctx.graph.semantic?.(seed)?.some(e => e.id === id) ? 'semantic-association' : graphNear.some(e => e.id === id) ? 'graph' : 'same-domain') } satisfies TraceCandidate);
    if (ctx.suppressed(ids)) { trace.skipped.push({ reason: 'suppressed', detail: seed.id }); continue; }
    clusters.push({ id: `micro-${seed.id.slice(-8)}`, ids, goalIds: [], hints });
  }
  return finish(trace, clusters, ctx, byId);
}

/**
 * DEEP: far-neighbour sampling across the whole authorized pool. Builds an inverted vocabulary index and looks for rare words shared by DIFFERENT domains,
 * provides/consumes matches, explicit contradictions and multi-hop graph paths that cross domains, then keeps only pairs that are not direct neighbours
 * (those belong to micro). Ranked by rarity and by what validated or failed before; old and new material are both sampled.
 */
export function planDeep(ctx: PlanContext, cursor: number): { clusters: Cluster[]; trace: Trace } {
  const trace = emptyTrace('deep', 'cross-domain-far-sampling', ctx); const byId = new Map(ctx.pool.map(e => [e.id, e])); const pairs = new Map<string, Hint & { a: ManifestEntry; b: ManifestEntry }>();
  const direct = new Set<string>(); for (const e of ctx.pool) for (const n of [...ctx.graph.out(e), ...ctx.graph.in(e)]) direct.add(pairKey(e.id, n.id));
  const consider = (a: ManifestEntry, b: ManifestEntry, via: string, distance: Distance, weight: number) => {
    if (a.id === b.id || domainOf(a) === domainOf(b)) return;
    const key = pairKey(a.id, b.id); if (via !== 'contradiction' && !via.startsWith('provides-consumes') && direct.has(key)) return; // direct neighbours are micro territory
    const family = `deep|${[domainOf(a), domainOf(b)].sort().join('+')}`; const age = (a.last > cursor ? 1 : 0) + (b.last > cursor ? 1 : 0); // one old and one new object is the most interesting mix
    const score = weight * (0.5 + ctx.success(family)) * (age === 1 ? 1.25 : 1);
    const hint = hintFor(a, b, via, distance, score); if (!pairs.has(key) || pairs.get(key)!.score < score) pairs.set(key, { ...hint, a, b });
  };
  const index = new Map<string, ManifestEntry[]>(); for (const e of ctx.pool) for (const c of conceptsOf(e)) (index.get(c) ?? index.set(c, []).get(c)!).push(e);
  const bridges = [...index.entries()].filter(([, list]) => new Set(list.map(domainOf)).size >= 2).sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
  for (const [term, list] of bridges.slice(0, 40)) {
    const byDomain = new Map<string, ManifestEntry[]>(); for (const e of list) (byDomain.get(domainOf(e)) ?? byDomain.set(domainOf(e), []).get(domainOf(e))!).push(e);
    const reps = [...byDomain.values()].map(group => group.sort((x, y) => (ctx.rng() < 0.5 ? 1 : -1) * (x.id < y.id ? 1 : -1))[0]!);
    for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) consider(reps[i]!, reps[j]!, `bridge:${term}`, list.length <= 3 ? 'distant' : 'complementary', 1 / Math.sqrt(list.length));
  }
  for (const a of ctx.pool) for (const b of ctx.pool) if (a.id < b.id && (intersect(provides(a), consumes(b)).length || intersect(provides(b), consumes(a)).length)) consider(a, b, `provides-consumes:${[...intersect(provides(a), consumes(b)), ...intersect(provides(b), consumes(a))][0]}`, 'complementary', 1.4);
  for (const e of ctx.pool) for (const ref of e.refs) if (ref[0] === 'contradicts') for (const n of ctx.graph.out(e)) consider(e, n, 'contradiction', 'distant', 1.1);
  const starts = ctx.pool.filter(e => e.last > cursor).concat(ctx.pool.filter(e => e.last <= cursor)).slice(0, 30);
  for (const start of starts) { // two- and three-hop paths that end in another domain
    let frontier = [start]; const seen = new Set([start.id]);
    for (let depth = 1; depth <= 3; depth++) { const next: ManifestEntry[] = []; for (const f of frontier) for (const n of [...ctx.graph.out(f), ...ctx.graph.in(f)]) if (!seen.has(n.id)) { seen.add(n.id); next.push(n); if (depth >= 2) consider(start, n, `path:${depth}`, 'distant', 0.9 / depth); } frontier = next; }
  }
  const ranked = [...pairs.values()].filter(p => !ctx.suppressed(p.ids)).sort((x, y) => y.score - x.score || x.via.localeCompare(y.via) || pairKey(x.a.id, x.b.id).localeCompare(pairKey(y.a.id, y.b.id)));
  trace.seeds = [...new Set(ranked.slice(0, 20).flatMap(p => p.ids))].slice(0, 10);
  const clusters: Cluster[] = []; const usedDomainPairs = new Set<string>(); const usedIds = new Set<string>();
  for (const p of ranked) {
    if (clusters.length >= ctx.budgets.maxClusters) break;
    const dp = [...p.domains].sort().join('+'); if (usedDomainPairs.has(dp)) { trace.skipped.push({ reason: 'domain_pair_already_covered', detail: dp }); continue; }
    const ids = [p.a.id, p.b.id]; const third = ranked.find(q => q !== p && q.ids.some(id => ids.includes(id)) && q.ids.some(id => !ids.includes(id) && !usedIds.has(id) && !p.domains.includes(domainOf(byId.get(id)!))));
    if (third) ids.push(third.ids.find(id => !ids.includes(id))!);
    if (new Set([...usedIds, ...ids]).size > ctx.budgets.maxObjects) { trace.skipped.push({ reason: 'object_budget', detail: dp }); continue; }
    usedDomainPairs.add(dp); for (const id of ids) usedIds.add(id);
    for (const id of ids) trace.candidates.push({ id, domain: domainOf(byId.get(id)!), distance: p.distance, via: p.via });
    clusters.push({ id: `deep-${clusters.length + 1}-${pairKey(p.a.id, p.b.id).slice(-10)}`, ids, goalIds: [], hints: [p, ...(third ? [third] : [])].map(({ a: _a, b: _b, ...h }) => h) });
  }
  return finish(trace, clusters, ctx, byId);
}

export interface GoalRef { entry: ManifestEntry; terms: string[] }
/**
 * STRATEGIC: goal-directed. For each accepted goal, find what the vault already knows that bears on it (capabilities and competing possibilities from
 * different domains) and which of the goal's own terms nothing covers (gaps). A goal with no supporting knowledge produces a gap report, never a model call.
 */
export function planStrategic(ctx: PlanContext, goals: GoalRef[]): { clusters: Cluster[]; trace: Trace } {
  const trace = emptyTrace('strategic', 'goal-directed-gap-analysis', ctx, goals.map(g => g.entry.id)); const byId = new Map([...ctx.pool, ...goals.map(g => g.entry)].map(e => [e.id, e])); const clusters: Cluster[] = [];
  trace.goalRefs = goals.map(g => g.entry.id); trace.gaps = [];
  for (const goal of goals.slice(0, ctx.budgets.maxClusters)) {
    const terms = goal.terms.filter(t => t.length >= 4);
    const scored = ctx.pool.map(e => { const c = conceptsOf(e); return { e, hit: terms.filter(t => c.has(t) || [...c].some(x => x.startsWith(t.slice(0, 5)))) }; }).filter(x => x.hit.length).sort((a, b) => b.hit.length - a.hit.length || newest(a.e, b.e));
    const covered = new Set(scored.flatMap(x => x.hit)); const gaps = terms.filter(t => !covered.has(t));
    if (gaps.length) trace.gaps.push({ goal: goal.entry.id, terms: gaps });
    if (!scored.length) { trace.skipped.push({ reason: 'no_supporting_knowledge', detail: goal.entry.id }); continue; }
    const picked: ManifestEntry[] = []; const doms = new Set<string>(); // diversity first: one capability per domain, then the strongest remaining
    for (const x of scored) if (!doms.has(domainOf(x.e)) && picked.length < ctx.budgets.maxPerCluster - 1) { picked.push(x.e); doms.add(domainOf(x.e)); }
    for (const x of scored) if (picked.length < ctx.budgets.maxPerCluster - 1 && !picked.includes(x.e)) picked.push(x.e);
    const ids = [goal.entry.id, ...picked.map(e => e.id)]; if (ctx.suppressed(ids)) { trace.skipped.push({ reason: 'suppressed', detail: goal.entry.id }); continue; }
    for (const e of picked) trace.candidates.push({ id: e.id, domain: domainOf(e), distance: domainOf(e) === domainOf(goal.entry) ? 'near' : 'complementary', via: `goal:${scored.find(x => x.e === e)!.hit[0]}` });
    clusters.push({ id: `strategic-${goal.entry.id.slice(-8)}`, ids, goalIds: [goal.entry.id], hints: [{ kind: 'opportunity', via: `goal:${[...covered][0] ?? 'none'}`, why: `the goal is covered by ${doms.size} domain(s)${gaps.length ? `; nothing covers: ${gaps.slice(0, 4).join(', ')}` : ''}`, ids, domains: [...doms], distance: 'complementary', score: 1 + scored.length }] });
  }
  return finish(trace, clusters, ctx, byId);
}
export const budgetsFor = (mode: 'micro' | 'deep' | 'strategic', cfg: { maxCandidates?: number; maxProposalsPerRun?: number } = {}): Budgets => {
  const cap = Math.max(1, cfg.maxProposalsPerRun ?? 3);
  return mode === 'micro' ? { maxObjects: 8, maxClusters: Math.min(3, cap), maxPerCluster: 8 } : mode === 'deep' ? { maxObjects: Math.min(24, cfg.maxCandidates ?? 24), maxClusters: Math.min(5, cap), maxPerCluster: 4 } : { maxObjects: 18, maxClusters: Math.min(3, cap), maxPerCluster: 6 };
};
