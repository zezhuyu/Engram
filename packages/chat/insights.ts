import { MDBError, type Evidence, type Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { evaluateInsight } from '../intelligence/insights.js';
import type { IntelligenceEngine, Proposal } from '../intelligence/index.js';
import { isSensitive } from '../core/sensitivity.js';
import { looksSecret } from '../memory/redact.js';
import { CHAT_PROVIDERS, type ChatProjectRegistry } from './projects.js';

const GLOBAL_PROFILE: Scope = { type: 'global', area: 'profile' };

export interface CrossProjectChatEvidence {
  objectId: string;
  revisionId: string;
  /** Exact user-authored source text. The complete proposed claim must occur in this span. */
  span: string;
}

export interface CrossProjectChatInsightInput {
  category: 'preference' | 'goal' | 'interest' | 'capability' | 'working_style' | 'knowledge_gap';
  preferenceKey: string;
  claim: string;
  evidence: CrossProjectChatEvidence[];
}

/**
 * Creates a user-directed, review-only cross-project insight proposal.
 * This deliberately does not invoke a model: each source must repeat the
 * complete claim verbatim, and every source is re-read through the current
 * actor's Vault ACL before it can be cited.
 */
export async function proposeCrossProjectChatInsight(
  vault: Vault,
  projects: ChatProjectRegistry,
  intelligence: IntelligenceEngine,
  input: CrossProjectChatInsightInput,
): Promise<Proposal> {
  if (!input || typeof input.claim !== 'string' || input.claim.trim() !== input.claim || input.claim.length < 4 || input.claim.length > 500
    || !Array.isArray(input.evidence) || input.evidence.length < 2 || input.evidence.length > 10) {
    throw new MDBError('INVALID_INPUT', 'A cross-project proposal needs a concise claim and 2-10 exact source spans');
  }

  const normalizedClaim = input.claim.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  const identities = new Set<string>();
  const evidence: Evidence[] = [];
  for (const reference of input.evidence) {
    if (!reference || typeof reference.objectId !== 'string' || typeof reference.revisionId !== 'string'
      || typeof reference.span !== 'string' || reference.span.length < 4 || reference.span.length > 2000) {
      throw new MDBError('INVALID_INPUT', 'Invalid cross-project evidence reference');
    }
    // Read both the selected revision and current head. A deleted, revised, or
    // newly inaccessible source cannot continue supporting a fresh proposal.
    const current = await vault.get(reference.objectId);
    const selected = await vault.get(reference.objectId, reference.revisionId);
    if (current.kind !== 'chat_message' || current.status !== 'active' || selected.revisionId !== current.revisionId
      || current.scope.type !== 'workspace' || current.metadata.role !== 'user' || current.metadata.speaker !== 'user'
      || current.metadata.projectMembership !== 'member' || current.metadata.routingReason !== 'project_binding'
      || typeof current.metadata.provider !== 'string' || typeof current.metadata.sourceAccountId !== 'string'
      || typeof current.metadata.externalProjectId !== 'string' || !current.metadata.externalProjectId) {
      throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Evidence must be a current, authorized user message from a linked project');
    }
    // Re-check the current source account and binding. A revoked source account
    // or unlinked project must not authorize new aggregate proposals.
    if (!(CHAT_PROVIDERS as readonly string[]).includes(current.metadata.provider)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Evidence provider is unavailable');
    const route = await projects.resolveProject({
      provider: current.metadata.provider as (typeof CHAT_PROVIDERS)[number],
      sourceAccountId: current.metadata.sourceAccountId,
      externalProjectId: current.metadata.externalProjectId,
      membership: 'member',
    });
    if (route.status !== 'routed' || route.reason !== 'project_binding') {
      throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Evidence project is no longer actively linked');
    }
    if (!current.body.includes(reference.span)) {
      throw new MDBError('INVALID_INPUT', 'Each evidence span must occur verbatim in its current source message');
    }
    const exactSpan = reference.span.replace(/\s+/gu, ' ').trim();
    if (!exactSpan.toLocaleLowerCase().includes(normalizedClaim)) {
      throw new MDBError('INVALID_INPUT', 'Each selected user source must contain the complete claim verbatim');
    }
    if (looksSecret(exactSpan) || isSensitive(exactSpan) || current.metadata.sensitivity === 'sensitive') {
      throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Sensitive or credential-bearing chat evidence cannot be aggregated');
    }
    identities.add(`${current.metadata.provider}\0${current.metadata.sourceAccountId}\0${current.metadata.externalProjectId}`);
    evidence.push({ uri: current.uri, revisionId: current.revisionId, span: reference.span });
  }
  if (identities.size < 2) throw new MDBError('INVALID_INPUT', 'Evidence must come from at least two distinct provider account/project bindings');
  if (!(await vault.canAccess(GLOBAL_PROFILE, 'write'))) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Global profile proposal permission is required');

  const proposalInput = {
    scope: GLOBAL_PROFILE,
    kind: 'user_insight',
    title: input.claim.slice(0, 120),
    body: input.claim,
    evidence,
    status: 'candidate',
    tags: ['insight', input.category, 'cross-project-chat'],
    metadata: {
      insightSchema: 1,
      category: input.category,
      preferenceKey: input.preferenceKey,
      scopeLabel: 'global',
      crossProjectChat: true,
      extractionMethod: 'user-selected-verbatim-repetition',
      evidenceClass: 'inferred',
    },
  };
  const evaluation = await evaluateInsight(vault, proposalInput);
  if (evaluation.verdict === 'reject') throw new MDBError('INVALID_INPUT', `Cross-project insight rejected: ${evaluation.rationale}`);
  // No proposal is promoted here. The ordinary IntelligenceEngine review path
  // revalidates current ACLs and evidence and requires an explicit approval.
  return intelligence.propose(proposalInput);
}

