import type { Vault } from '../core/vault.js';
import { MDBError } from '../core/types.js';
import { REGISTRY_ID, activeDomains, sanitizeDomainProposal, seedRegistry, suggestDomains, validateSlug, type DomainRegistry } from './domains.js';

const scope = { type: 'global' as const, area: 'profile' as const };
/** Registry lives as an ordinary revisioned profile document, protected by global profile ACL. */
export async function readDomainRegistry(vault: Vault): Promise<{ registry: DomainRegistry; revisionId?: string }> {
  const docs = await vault.listDocuments({ scopes: [scope] });
  const doc = docs.find(item => item.metadata.registry === REGISTRY_ID && item.status === 'active');
  const config = await vault.config(), limits = config.profile?.domains;
  if (limits?.autoApply !== undefined && typeof limits.autoApply !== 'boolean' || limits?.maxActive !== undefined && (!Number.isInteger(limits.maxActive) || limits.maxActive < 5 || limits.maxActive > 24) || limits?.maxPerDreamCycle !== undefined && (!Number.isInteger(limits.maxPerDreamCycle) || limits.maxPerDreamCycle < 1 || limits.maxPerDreamCycle > 3) || limits?.minEvidence !== undefined && (!Number.isInteger(limits.minEvidence) || limits.minEvidence < 2 || limits.minEvidence > 10)) throw new MDBError('INVALID_INPUT', 'Invalid profile domain configuration');
  if (!doc) { const registry = seedRegistry(); registry.autoApply = limits?.autoApply ?? true; return { registry }; }
  try {
    const parsed = JSON.parse(doc.body) as DomainRegistry;
    if (parsed.schema !== 1 || !Array.isArray(parsed.domains) || parsed.domains.length > 256 || parsed.autoApply !== undefined && typeof parsed.autoApply !== 'boolean') throw new Error('bad registry');
    const slugs = new Set<string>();
    for (const domain of parsed.domains) {
      if (!domain || typeof domain !== 'object' || validateSlug(domain.slug) !== domain.slug || slugs.has(domain.slug) || typeof domain.label !== 'string' || domain.label.length > 40 || typeof domain.description !== 'string' || domain.description.length > 120 || !Array.isArray(domain.keywords) || domain.keywords.length > 32 || domain.keywords.some(k => typeof k !== 'string' || k.length > 40) || !['seed', 'discovered', 'owner'].includes(domain.origin) || !['active', 'merged', 'retired'].includes(domain.status) || !Number.isFinite(Date.parse(domain.firstSeen)) || !Array.isArray(domain.evidence) || domain.evidence.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('bad domain record');
      slugs.add(domain.slug);
    }
    if (parsed.pendingDomainCandidates !== undefined && (!Array.isArray(parsed.pendingDomainCandidates) || parsed.pendingDomainCandidates.length > 50 || parsed.pendingDomainCandidates.some(candidate => !candidate || !candidate.proposal || validateSlug(candidate.proposal.slug) !== candidate.proposal.slug || typeof candidate.proposal.label !== 'string' || candidate.proposal.label.length > 40 || typeof candidate.proposal.description !== 'string' || candidate.proposal.description.length > 120 || !Array.isArray(candidate.proposal.keywords) || candidate.proposal.keywords.length < 1 || candidate.proposal.keywords.length > 12 || candidate.proposal.keywords.some(keyword => typeof keyword !== 'string' || keyword.length > 40) || !Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > 20 || candidate.evidence.some(id => typeof id !== 'string' || id.length > 128) || new Set(candidate.evidence).size !== candidate.evidence.length || !Number.isInteger(candidate.count) || candidate.count !== candidate.evidence.length || !Number.isFinite(Date.parse(candidate.firstSeen)) || !Number.isFinite(Date.parse(candidate.updatedAt)) || candidate.reason !== undefined && (typeof candidate.reason !== 'string' || candidate.reason.length > 240)))) throw new Error('bad pending domain candidates');
    if (!slugs.has('general') || parsed.domains.find(d => d.slug === 'general')?.status !== 'active' || activeDomains(parsed).length > Math.min(24, limits?.maxActive ?? 24)) throw new Error('bad registry invariant');
    for (const domain of parsed.domains) if (domain.status === 'merged' && (!domain.mergedInto || !slugs.has(domain.mergedInto) || domain.mergedInto === domain.slug || parsed.domains.find(target => target.slug === domain.mergedInto)?.status !== 'active')) throw new Error('bad merge target');
    parsed.autoApply = limits?.autoApply ?? parsed.autoApply ?? true;
    return { registry: parsed, revisionId: doc.revisionId };
  } catch { throw new MDBError('INVALID_INPUT', 'Stored profile domain registry is invalid'); }
}

export async function setDomainAutoApply(vault: Vault, enabled: boolean): Promise<void> {
  await vault.setConfig(config => { config.profile ??= {}; config.profile.domains ??= {}; config.profile.domains.autoApply = enabled; });
}
export async function writeDomainRegistry(vault: Vault, registry: DomainRegistry, expectedRevisionId?: string) {
  const persisted = { ...registry } as Partial<DomainRegistry>;
  delete persisted.autoApply;
  const previous = await vault.listDocuments({ scopes: [scope] });
  const current = previous.find(item => item.metadata.registry === REGISTRY_ID && item.status === 'active');
  if (current) {
    if (!expectedRevisionId || current.revisionId !== expectedRevisionId) throw new MDBError('CONFLICT', 'Domain registry changed; reload it before writing');
    return vault.patch({ objectId: current.id, expectedRevisionId, body: JSON.stringify(persisted) });
  }
  if (expectedRevisionId) throw new MDBError('CONFLICT', 'Domain registry no longer exists');
  return vault.put({ scope, kind: 'note', title: 'Profile domain registry', body: JSON.stringify(persisted), status: 'active', tags: ['profile-domains'], metadata: { registry: REGISTRY_ID } });
}

export async function verifyDomainEvidence(vault: Vault, evidenceIds: string[]): Promise<string[]> {
  const accepted = (await vault.listDocuments({ scopes: [scope] })).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted' && ['preference', 'working_style'].includes(String(doc.metadata.category)) && doc.metadata.sensitivity !== 'sensitive');
  const allowed = new Set(accepted.map(doc => doc.id));
  const unique = [...new Set(evidenceIds)];
  if (!unique.length || unique.some(id => !allowed.has(id))) throw new MDBError('INVALID_INPUT', 'Domain evidence must identify at least one accepted, non-sensitive preference or working_style insight');
  return unique;
}

/** Deterministic Dream-cycle catch-up. Explicit owner tags are never changed. */
export async function refreshAutomaticDomainTags(vault: Vault): Promise<{ proposed: number; applied: number }> {
  const { registry, revisionId } = await readDomainRegistry(vault);
  const marker = revisionId ?? 'seed';
  const docs = (await vault.listDocuments({ scopes: [scope] })).filter(doc => doc.kind === 'user_insight' && doc.status === 'accepted' && ['preference', 'working_style'].includes(String(doc.metadata.category)) && doc.metadata.sensitivity !== 'sensitive');
  let proposed = 0, applied = 0;
  for (const doc of docs) {
    if (doc.metadata.tagSource === 'owner' || doc.metadata.domainRegistryRevision === marker) continue;
    const domains = suggestDomains(doc.body, registry);
    const current = Array.isArray(doc.metadata.domains) ? doc.metadata.domains : ['general'];
    const discovered = domains.filter(slug => registry.domains.some(domain => domain.slug === slug && domain.origin === 'discovered'));
    const deterministicProposal = discovered.length > 0 && registry.autoApply;
    const changed = JSON.stringify(current) !== JSON.stringify(domains) && (registry.autoApply || discovered.length === 0);
    if (changed) proposed++;
    if (deterministicProposal && JSON.stringify(doc.metadata.proposedDomains) !== JSON.stringify(discovered)) {
      await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { proposedDomains: discovered, domainRegistryRevision: marker } });
    } else if (registry.autoApply && changed) {
      await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { domains, tagSource: 'classifier', domainRegistryRevision: marker } }); applied++;
    } else if (changed) {
      await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { proposedDomains: domains, domainRegistryRevision: marker } });
    }
  }
  return { proposed, applied };
}

export type DomainClassifier = (input: { registry: DomainRegistry; items: Array<{ id: string; text: string; currentDomain?: string }> }) => Promise<unknown>;
/** One bounded, isolated model pass. No provider or no global profile write access means no model-visible data and no mutations. */
export async function discoverPreferenceDomains(vault: Vault, classify?: DomainClassifier, options: { dryRun?: boolean; recheck?: boolean } = {}): Promise<{ status: 'unavailable' | 'complete'; classified: number; promoted: string[]; calls: number; suggestions?: Array<{ id: string; domain: string; proposed?: string }>; rejections?: Array<{ id: string; reason: string; attempts: number }> }> {
  if (!classify || !await vault.canAccess(scope, 'write')) return { status: 'unavailable', classified: 0, promoted: [], calls: 0 };
  const { registry, revisionId } = await readDomainRegistry(vault);
  const marker = revisionId ?? 'seed';
  const batch = (await vault.listDocuments({ scopes: [scope] })).filter(doc => {
    if (doc.kind !== 'user_insight' || doc.status !== 'accepted' || !['preference', 'working_style'].includes(String(doc.metadata.category)) || doc.metadata.sensitivity === 'sensitive' || doc.metadata.tagSource === 'owner') return false;
    if (options.recheck) return (doc.metadata.tagSource === 'model' || doc.metadata.tagSource === 'classifier') && Array.isArray(doc.metadata.domains) && (doc.metadata.domains as string[]).some(slug => registry.domains.some(domain => domain.slug === slug && domain.origin === 'discovered')) && (doc.metadata.domainConfirmedAt === undefined || doc.metadata.domainConfirmedRevision !== marker || JSON.stringify(doc.metadata.domainConfirmedDomains) !== JSON.stringify(doc.metadata.domains));
    return doc.metadata.domainClassifiedAt === undefined && Number(doc.metadata.domainClassificationAttempts ?? 0) < 3;
  }).slice(0, 10);
  if (!batch.length) return { status: 'complete', classified: 0, promoted: [], calls: 0 };
  const now = new Date().toISOString();
  const deterministic = options.recheck ? [] : batch.filter(doc => {
    const domains = suggestDomains(doc.body, registry);
    return domains[0] !== 'general' && domains.every(slug => registry.domains.find(domain => domain.slug === slug)?.origin !== 'discovered');
  });
  for (const doc of deterministic) await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { domains: suggestDomains(doc.body, registry), tagSource: 'model', domainClassifiedAt: now, domainRegistryRevision: marker } });
  const docs = options.recheck ? batch : batch.filter(doc => !deterministic.includes(doc));
  if (!docs.length) return { status: 'complete', classified: deterministic.length, promoted: [], calls: 0 };
  const unreviewed = docs.filter(doc => doc.metadata.reviewed !== true || typeof doc.metadata.approvedProposalId !== 'string');
  const approvalReason = 'Accepted item is missing explicit approval provenance; review it before domain discovery.';
  const unreviewedReasons = options.dryRun ? previewDomainRejections(unreviewed, approvalReason) : await recordDomainRejections(vault, unreviewed, approvalReason);
  const verifiableDocs = docs.filter(doc => !unreviewed.includes(doc));
  if (!verifiableDocs.length) return { status: 'complete', classified: deterministic.length, promoted: [], calls: 0, rejections: unreviewedReasons };
  const raw = await classify({ registry: structuredClone(registry), items: verifiableDocs.map(doc => ({ id: doc.id, text: doc.body.slice(0, 1000), ...(options.recheck ? { currentDomain: (doc.metadata.domains as string[] | undefined)?.find(slug => registry.domains.some(domain => domain.slug === slug && domain.origin === 'discovered')) } : {}) })) });
  let answers: unknown;
  try { answers = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { answers = undefined; }
  if (!Array.isArray(answers) && answers && typeof answers === 'object' && Array.isArray((answers as { items?: unknown }).items)) answers = (answers as { items: unknown[] }).items;
  if (!Array.isArray(answers) || answers.length !== verifiableDocs.length) {
    const reason = 'Model response must contain one classification per item in an items array.';
    const rejections = options.dryRun ? previewDomainRejections(verifiableDocs, reason) : await recordDomainRejections(vault, verifiableDocs, reason);
    return { status: 'complete', classified: 0, promoted: [], calls: 1, rejections: [...unreviewedReasons, ...rejections] };
  }
  const byId = new Map(verifiableDocs.map(doc => [doc.id, doc]));
  const accepted: Array<{ id: string; domain: string; proposal?: Record<string, unknown> }> = [];
  const rejected = new Map<string, string>();
  const seenAnswerIds = new Set<string>();
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) continue;
    const row = answer as Record<string, unknown>;
    if (typeof row.id !== 'string' || !byId.has(row.id)) continue;
    if (seenAnswerIds.has(row.id)) { rejected.set(row.id, 'Model returned this item more than once.'); for (let index = accepted.length - 1; index >= 0; index--) if (accepted[index]!.id === row.id) accepted.splice(index, 1); continue; }
    seenAnswerIds.add(row.id);
    if (Object.keys(row).some(key => !['id', 'domain', 'newDomain'].includes(key))) { rejected.set(row.id, 'Classification contained unsupported fields.'); continue; }
    if (!['none', ...activeDomains(registry).map(d => d.slug)].includes(String(row.domain))) { rejected.set(row.id, 'Classification named a domain that is not active.'); continue; }
    const proposal = row.newDomain && typeof row.newDomain === 'object' && !Array.isArray(row.newDomain) ? row.newDomain as Record<string, unknown> : undefined;
    if (row.newDomain !== undefined && (!proposal || Object.keys(proposal).some(key => !['slug', 'label', 'description', 'keywords'].includes(key)))) { rejected.set(row.id, 'New domain proposal was missing required fields or contained unsupported fields.'); continue; }
    if (proposal && (row.domain === 'none' || row.domain === 'general')) {
      const sanitized = sanitizeDomainProposal(proposal, [row.id], registry, new Date().toISOString());
      if (sanitized.mergeInto) accepted.push({ id: row.id, domain: sanitized.mergeInto });
      else if (sanitized.record) accepted.push({ id: row.id, domain: String(row.domain), proposal });
      else rejected.set(row.id, sanitized.reason ?? 'New domain proposal was rejected.');
    } else if (row.domain === 'none' && !proposal) {
      accepted.push({ id: row.id, domain: 'none' });
    } else accepted.push({ id: row.id, domain: String(row.domain) });
  }
  for (const doc of verifiableDocs) if (!accepted.some(row => row.id === doc.id) && !rejected.has(doc.id)) rejected.set(doc.id, 'Model omitted this item or returned a duplicate item id.');
  if (options.dryRun) return { status: 'complete', classified: accepted.filter(row => !rejected.has(row.id)).length, promoted: [], calls: 1, suggestions: accepted.map(row => ({ id: row.id, domain: row.domain, ...(row.proposal && typeof row.proposal.slug === 'string' ? { proposed: row.proposal.slug } : {}) })), rejections: [...unreviewedReasons, ...[...rejected].map(([id, reason]) => ({ id, reason, attempts: Number(byId.get(id)!.metadata.domainClassificationAttempts ?? 0) + 1 }))] };
  const suggestions = accepted.map(row => ({ id: row.id, domain: row.domain, ...(row.proposal && typeof row.proposal.slug === 'string' ? { proposed: row.proposal.slug } : {}) }));
  const config = await vault.config();
  if (config.profile?.domains?.minEvidence !== undefined && (!Number.isInteger(config.profile.domains.minEvidence) || config.profile.domains.minEvidence < 2 || config.profile.domains.minEvidence > 10)) throw new MDBError('INVALID_INPUT', 'profile.domains.minEvidence must be an integer in 2..10');
  const minEvidence = config.profile?.domains?.minEvidence ?? 2;
  const maxActive = Math.min(24, config.profile?.domains?.maxActive ?? 24);
  const maxPerDreamCycle = Math.min(3, config.profile?.domains?.maxPerDreamCycle ?? 3);
  const groups = new Map<string, { proposal: Record<string, unknown>; ids: string[] }>();
  for (const row of accepted) if (row.proposal && (row.domain === 'none' || row.domain === 'general')) {
    const sanitized = sanitizeDomainProposal(row.proposal, [row.id], registry, now);
    if (!sanitized.record) continue;
    const key = sanitized.record.slug;
    const previous = groups.get(key);
    if (previous) previous.ids.push(row.id); else groups.set(key, { proposal: row.proposal, ids: [row.id] });
  }
  // Merge proposed names whose keyword/description vocabularies overlap; the
  // most common name wins, with the shorter slug breaking ties.
  const clusters: Array<{ names: string[]; ids: string[] }> = [];
  for (const [slug, group] of groups) {
    const words = proposalWords(group.proposal);
    const cluster = clusters.find(item => item.names.some(name => { const other = groups.get(name)!; const theirs = proposalWords(other.proposal); return [...words].some(word => theirs.has(word)); }));
    if (cluster) { cluster.names.push(slug); cluster.ids.push(...group.ids); } else clusters.push({ names: [slug], ids: [...group.ids] });
  }
  const clustered = new Map<string, { proposal: Record<string, unknown>; ids: string[] }>();
  for (const cluster of clusters) {
    const name = [...cluster.names].sort((a, b) => groups.get(b)!.ids.length - groups.get(a)!.ids.length || a.length - b.length || a.localeCompare(b))[0]!;
    const selected = groups.get(name)!;
    clustered.set(name, { proposal: selected.proposal, ids: [...new Set(cluster.ids)] });
  }
  groups.clear(); for (const [slug, group] of clustered) groups.set(slug, group);
  const candidates = registry.pendingDomainCandidates ??= [];
  const promoted: string[] = [];
  const promotedEvidence = new Set<string>();
  const mergedSuggestions = new Map<string, string>();
  for (const [key, group] of groups) {
    const prior = candidates.find(candidate => candidate.proposal.slug === key || proposalWords(candidate.proposal).size > 0 && [...proposalWords(candidate.proposal)].some(word => proposalWords(group.proposal).has(word)));
    const ids = [...new Set([...(prior?.evidence ?? []), ...group.ids])].slice(-20);
    const proposal = prior?.proposal ?? group.proposal;
    const sanitized = sanitizeDomainProposal(proposal, ids, registry, now);
    if (sanitized.mergeInto) { for (const id of group.ids) mergedSuggestions.set(id, sanitized.mergeInto); continue; }
    if (!sanitized.record) { for (const id of group.ids) rejected.set(id, sanitized.reason ?? 'New domain proposal was rejected.'); continue; }
    if (ids.length < minEvidence || activeDomains(registry).length >= maxActive || registry.domains.filter(domain => domain.origin === 'discovered' && domain.cycleId === marker).length >= maxPerDreamCycle) {
      const reason = ids.length < minEvidence ? `waiting for ${minEvidence - ids.length} more accepted item${minEvidence - ids.length === 1 ? '' : 's'}` : activeDomains(registry).length >= maxActive ? 'active domain limit reached' : 'per-cycle domain limit reached';
      const entry = { proposal: sanitized.record, evidence: ids, count: ids.length, firstSeen: prior?.firstSeen ?? now, updatedAt: now, reason };
      if (prior) Object.assign(prior, entry);
      else if (candidates.length < 50) candidates.push(entry);
      else for (const id of group.ids) rejected.set(id, 'Pending domain candidate limit reached; item remains eligible for retry.');
      continue;
    }
    registry.domains.push({ ...sanitized.record, evidence: ids, cycleId: marker });
    candidates.splice(candidates.indexOf(prior!), prior ? 1 : 0);
    for (const id of ids) promotedEvidence.add(id);
    promoted.push(sanitized.record.slug);
  }
  let confirmationMarker = marker;
  if (promoted.length || candidates.length) {
    const saved = await writeDomainRegistry(vault, registry, revisionId);
    confirmationMarker = saved.revisionId;
  }
  const persistedRejections = await recordDomainRejections(vault, verifiableDocs.filter(doc => rejected.has(doc.id)), undefined, rejected);
  for (const row of accepted) {
    if (rejected.has(row.id)) continue;
    const doc = byId.get(row.id)!;
    if (doc.metadata.tagSource === 'owner') continue;
    const proposalKey = [...groups.values()].find(group => group.ids.includes(row.id));
    const promotedSlug = promoted.find(slug => registry.domains.find(domain => domain.slug === slug)?.evidence.includes(row.id));
    const domains = promotedSlug ? [promotedSlug] : mergedSuggestions.has(row.id) ? [mergedSuggestions.get(row.id)!] : row.domain !== 'none' && row.domain !== 'general' ? [row.domain] : ['general'];
    const modelConfirmedDiscovered = domains.some(slug => registry.domains.some(domain => domain.slug === slug && domain.origin === 'discovered'));
    await vault.patch({ objectId: row.id, expectedRevisionId: doc.revisionId, metadataPatch: { domains, tagSource: 'model', domainClassifiedAt: now, domainRegistryRevision: confirmationMarker, ...(options.recheck || modelConfirmedDiscovered ? { domainConfirmedAt: now, domainConfirmedRevision: confirmationMarker, domainConfirmedDomains: domains } : {}), domainClassificationAttempts: 0, domainRejectionReason: null } });
  }
  for (const id of promotedEvidence) if (!byId.has(id)) {
    const doc = await vault.get(id).catch(() => undefined);
    const slug = promoted.find(candidate => registry.domains.find(domain => domain.slug === candidate)?.evidence.includes(id));
    if (doc && slug && doc.status === 'accepted' && doc.metadata.tagSource !== 'owner') await vault.patch({ objectId: id, expectedRevisionId: doc.revisionId, metadataPatch: { domains: [slug], tagSource: 'model', domainClassifiedAt: now, domainRegistryRevision: confirmationMarker, domainConfirmedAt: now, domainConfirmedRevision: confirmationMarker, domainConfirmedDomains: [slug] } });
  }
  return { status: 'complete', classified: accepted.filter(row => !rejected.has(row.id)).length, promoted, calls: 1, suggestions, rejections: [...unreviewedReasons, ...persistedRejections] };
}

function proposalWords(proposal: Record<string, unknown>): Set<string> {
  const values = [...(Array.isArray(proposal.keywords) ? proposal.keywords : []), proposal.description].filter((value): value is string => typeof value === 'string');
  return new Set(values.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3));
}

function previewDomainRejections(docs: Array<{ id: string; metadata: Record<string, unknown> }>, reason: string) {
  return docs.map(doc => ({ id: doc.id, reason, attempts: Number(doc.metadata.domainClassificationAttempts ?? 0) + 1 }));
}

async function recordDomainRejections(vault: Vault, docs: Array<{ id: string; revisionId: string; metadata: Record<string, unknown> }>, fallback?: string, reasons = new Map<string, string>()) {
  const output: Array<{ id: string; reason: string; attempts: number }> = [];
  for (const doc of docs) {
    const reason = reasons.get(doc.id) ?? fallback ?? 'Proposal could not be verified.';
    const attempts = Number(doc.metadata.domainClassificationAttempts ?? 0) + 1;
    await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { domainClassificationAttempts: attempts, domainRejectionReason: reason.slice(0, 240) } });
    output.push({ id: doc.id, reason, attempts });
  }
  return output;
}
