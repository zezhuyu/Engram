import { MDBError } from '../core/types.js';

export const PROFILE_DOMAINS = ['coding', 'investing', 'media', 'career', 'general'] as const;
export type ProfileDomain = string;
export type DomainOrigin = 'seed' | 'discovered' | 'owner';
export type DomainStatus = 'active' | 'merged' | 'retired';
export interface DomainRecord {
  slug: string; label: string; description: string; keywords: string[]; origin: DomainOrigin;
  firstSeen: string; evidence: string[]; status: DomainStatus; mergedInto?: string; cycleId?: string;
}
export interface PendingDomainCandidate { proposal: { slug: string; label: string; description: string; keywords: string[] }; evidence: string[]; count: number; firstSeen: string; updatedAt: string; reason?: string }
export interface DomainRegistry { schema: 1; domains: DomainRecord[]; autoApply: boolean; pendingDomainCandidates?: PendingDomainCandidate[] }
const SEED_KEYWORDS: Record<string, string[]> = {
  coding: ['code', 'coding', 'program', 'software', 'repo', 'repository', 'test', 'typescript', 'python', 'rust', 'git', 'pull request', 'debug', 'refactor', 'agent', 'claude', 'codex', 'markdown', 'instructions', 'engram', 'mdb', 'memory database', 'profile'],
  investing: ['stock', 'invest', 'investment', 'portfolio', 'equity', 'shares', 'risk tolerance', 'position sizing', 'leverage', 'rebalance', 'valuation', 'growth'],
  media: ['music', 'video', 'episode', 'character', 'film', 'movie', 'media', 'subtitle', 'lyrics', 'song', 'podcast', 'cinematic'],
  career: ['job', 'career', 'resume', 'résumé', 'interview', 'employer', 'application', 'recruit'],
  general: [],
};
export const REGISTRY_ID = 'profile-domain-registry';
export function seedRegistry(now = new Date().toISOString()): DomainRegistry {
  return { schema: 1, autoApply: true, domains: PROFILE_DOMAINS.map(slug => ({ slug, label: slug[0]!.toUpperCase() + slug.slice(1), description: slug === 'general' ? 'Applies to every project.' : `Preferences related to ${slug}.`, keywords: SEED_KEYWORDS[slug] ?? [], origin: 'seed', firstSeen: now, evidence: [], status: 'active' })) };
}
export function validateSlug(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,23}$/.test(value)) throw new MDBError('INVALID_INPUT', 'domain slug must match [a-z][a-z0-9-]{1,23}');
  return value;
}
export function validateDomains(value: unknown, allowed: readonly string[] = PROFILE_DOMAINS): ProfileDomain[] {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !allowed.includes(item))) throw new MDBError('INVALID_INPUT', `domains must be a non-empty list from ${allowed.join(', ')}`);
  if (value.length > 3) throw new MDBError('INVALID_INPUT', 'an item may have at most 3 domains');
  return [...new Set(value as string[])].sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b));
}
export function parseDomains(value: string, allowed: readonly string[] = PROFILE_DOMAINS): ProfileDomain[] { return validateDomains(value.split(',').map(x => x.trim()).filter(Boolean), allowed); }
export function activeDomains(registry: DomainRegistry): DomainRecord[] { return registry.domains.filter(d => d.status === 'active'); }
const DOMAIN_KEYWORD_STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'always', 'area', 'based', 'being', 'both', 'could', 'does', 'each', 'from', 'have', 'into', 'more', 'most', 'other', 'over', 'same', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'using', 'very', 'with', 'would', 'your', 'the', 'and', 'for', 'from', 'with', 'into', 'using']);
/** Filter model keywords to distinctive terms that do not overlap other domains. */
export function normalizeDiscoveredKeywords(value: unknown, ownSlug: string, registry: DomainRegistry): string[] {
  if (!Array.isArray(value)) return [];
  const otherTerms = new Set(activeDomains(registry).filter(domain => domain.slug !== ownSlug).flatMap(domain => domain.keywords.map(normalizeKeyword)));
  const unique = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const keyword = normalizeKeyword(raw);
    const tokens = keyword.split(' ').filter(token => !DOMAIN_KEYWORD_STOP_WORDS.has(token));
    const specific = tokens.join(' ');
    if (!specific || tokens.some(token => token.length === 1 || /^\d+$/.test(token))) continue;
    if (specific !== ownSlug && (otherTerms.has(specific) || tokens.some(token => otherTerms.has(token)))) continue;
    unique.add(specific);
  }
  return [...unique].sort((a, b) => specificity(b) - specificity(a) || b.length - a.length || a.localeCompare(b)).slice(0, 6);
}
function normalizeKeyword(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }
function specificity(value: string): number { return value.split(' ').length * 10 + Math.min(value.length, 30); }
/** Conservative keyword classifier. General is used only when none of the registered domain terms match. */
export function suggestDomains(claim: string, registry: DomainRegistry = seedRegistry()): ProfileDomain[] {
  const text = claim.toLowerCase();
  const scores = activeDomains(registry).filter(domain => domain.slug !== 'general').map(domain => ({ domain, hits: new Set(domain.keywords.filter(keyword => {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
  }).map(normalizeKeyword)).size }));
  const legacyMatches = scores.filter(({ domain, hits }) => domain.origin !== 'discovered' && hits > 0).map(({ domain }) => domain.slug);
  const discoveredMatches = scores.filter(({ domain, hits }) => domain.origin === 'discovered' && hits >= 2)
    .filter(candidate => !scores.some(other => other.domain.slug !== candidate.domain.slug && other.hits > candidate.hits))
    .map(({ domain }) => domain.slug);
  const result = [...new Set([...legacyMatches, ...discoveredMatches])].slice(0, 3);
  return result.length ? result : ['general'];
}
export function normalizedDomains(value: unknown, allowed?: readonly string[]): ProfileDomain[] {
  if (value === undefined) return ['general'];
  if (!allowed) {
    if (!Array.isArray(value) || !value.length || value.length > 3 || value.some(item => typeof item !== 'string' || (item !== 'general' && !/^[a-z][a-z0-9-]{1,23}$/.test(item)))) return ['general'];
    return [...new Set(value as string[])];
  }
  try { return validateDomains(value, allowed); } catch { return ['general']; }
}
export function sanitizeDomainProposal(input: unknown, evidence: string[], registry: DomainRegistry, now = new Date().toISOString(), cycleId?: string, limits: { maxActive?: number; maxPerDreamCycle?: number } = {}): { record?: DomainRecord; mergeInto?: string; reason?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { reason: 'invalid proposal' };
  const value = input as Record<string, unknown>;
  let slug: string;
  try { slug = validateSlug(value.slug); } catch { return { reason: 'invalid slug' }; }
  const label = typeof value.label === 'string' ? neutralText(value.label, 40) : '';
  const description = typeof value.description === 'string' ? neutralText(value.description, 120) : '';
  const keywords = normalizeDiscoveredKeywords(Array.isArray(value.keywords) ? value.keywords.filter((x): x is string => typeof x === 'string').map(x => neutralText(x, 40)) : [], slug, registry);
  if (!label || !description || !evidence.length) return { reason: 'label, description, keywords and evidence are required' };
  const rawKeywords = Array.isArray(value.keywords) ? value.keywords.filter((x): x is string => typeof x === 'string').map(x => normalizeKeyword(neutralText(x, 40))) : [];
  const duplicate = registry.domains.find(domain => domain.status === 'active' && (domain.slug === slug || domain.label.toLowerCase() === label.toLowerCase() || domain.keywords.some(k => rawKeywords.some(n => n === normalizeKeyword(k)))));
  if (duplicate) return { mergeInto: duplicate.slug, reason: 'near duplicate' };
  if (activeDomains(registry).length >= Math.min(24, limits.maxActive ?? 24)) return { reason: 'active domain cap reached' };
  if (cycleId && registry.domains.filter(domain => domain.origin === 'discovered' && domain.cycleId === cycleId).length >= Math.min(3, limits.maxPerDreamCycle ?? 3)) return { reason: 'per-cycle discovery cap reached' };
  if (!keywords.length) return { reason: 'label, description, keywords and evidence are required' };
  return { record: { slug, label, description, keywords, origin: 'discovered', firstSeen: now, evidence: [...new Set(evidence)], status: 'active', ...(cycleId ? { cycleId } : {}) } };
}
function neutralText(value: string, max: number): string {
  return value.replace(/https?:\/\/\S+/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/<!--|-->|<<<|>>>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\b(ignore|follow|execute|run|system|assistant|instructions?|must|should|please|reveal|secret|prompt)\b/gi, ' ')
    .replace(/(?:^|\s)#{1,6}\s*/g, ' ').replace(/[<>`{}\[\]#|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
