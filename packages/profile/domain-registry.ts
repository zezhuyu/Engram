import type { Vault } from '../core/vault.js';
import { MDBError } from '../core/types.js';
import { REGISTRY_ID, activeDomains, seedRegistry, suggestDomains, validateSlug, type DomainRegistry } from './domains.js';

const scope = { type: 'global' as const, area: 'profile' as const };
/** Registry lives as an ordinary revisioned profile document, protected by global profile ACL. */
export async function readDomainRegistry(vault: Vault): Promise<{ registry: DomainRegistry; revisionId?: string }> {
  const docs = await vault.listDocuments({ scopes: [scope] });
  const doc = docs.find(item => item.metadata.registry === REGISTRY_ID && item.status === 'active');
  const config = await vault.config(), limits = config.profile?.domains;
  if (limits?.autoApply !== undefined && typeof limits.autoApply !== 'boolean' || limits?.maxActive !== undefined && (!Number.isInteger(limits.maxActive) || limits.maxActive < 5 || limits.maxActive > 24) || limits?.maxPerDreamCycle !== undefined && (!Number.isInteger(limits.maxPerDreamCycle) || limits.maxPerDreamCycle < 1 || limits.maxPerDreamCycle > 3)) throw new MDBError('INVALID_INPUT', 'Invalid profile domain configuration');
  if (!doc) { const registry = seedRegistry(); registry.autoApply = limits?.autoApply ?? true; return { registry }; }
  try {
    const parsed = JSON.parse(doc.body) as DomainRegistry;
    if (parsed.schema !== 1 || !Array.isArray(parsed.domains) || parsed.domains.length > 256 || parsed.autoApply !== undefined && typeof parsed.autoApply !== 'boolean') throw new Error('bad registry');
    const slugs = new Set<string>();
    for (const domain of parsed.domains) {
      if (!domain || typeof domain !== 'object' || validateSlug(domain.slug) !== domain.slug || slugs.has(domain.slug) || typeof domain.label !== 'string' || domain.label.length > 40 || typeof domain.description !== 'string' || domain.description.length > 120 || !Array.isArray(domain.keywords) || domain.keywords.length > 32 || domain.keywords.some(k => typeof k !== 'string' || k.length > 40) || !['seed', 'discovered', 'owner'].includes(domain.origin) || !['active', 'merged', 'retired'].includes(domain.status) || !Number.isFinite(Date.parse(domain.firstSeen)) || !Array.isArray(domain.evidence) || domain.evidence.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('bad domain record');
      slugs.add(domain.slug);
    }
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
    const changed = JSON.stringify(current) !== JSON.stringify(domains);
    if (changed) proposed++;
    if (registry.autoApply && changed) {
      await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { domains, tagSource: 'classifier', domainRegistryRevision: marker } }); applied++;
    } else if (changed) {
      await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { proposedDomains: domains, domainRegistryRevision: marker } });
    }
  }
  return { proposed, applied };
}
