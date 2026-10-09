import type { Document } from './types.js';

/**
 * How much a source can say about the USER (RFC §4). Contextual, not a numeric weight:
 *  explicit          current user-provided facts and corrections (explicit notes, direct corrections)
 *  user_conversation text the user themself wrote in a conversation (speaker=user)
 *  wiki_exposure     curated wiki and imported sources: shows exposure to a topic, never endorsement, preference or competence
 *  agent_observation what an agent or tool said or did; supporting only
 *  dream             hypotheses; never evidence about the user
 */
export type SourceClass = 'explicit' | 'user_conversation' | 'wiki_exposure' | 'agent_observation' | 'dream';
export const SOURCE_PRIORITY: Record<SourceClass, number> = { explicit: 0, user_conversation: 1, wiki_exposure: 2, agent_observation: 3, dream: 4 };
export function classifySource(doc: Pick<Document, 'kind' | 'scope' | 'metadata'>): SourceClass {
  const m = doc.metadata;
  if (doc.kind === 'discovery' || (doc.scope.type === 'global' && doc.scope.area === 'discoveries')) return 'dream';
  if (m.explicitPreference === true || m.evidenceClass === 'explicit' || (doc.kind === 'user_insight' && m.profileRole === 'explicit')) return 'explicit';
  if (m.speaker === 'user' || m.evidenceClass === 'user_authored') return 'user_conversation';
  if (m.speaker === 'assistant' || m.speaker === 'tool' || m.evidenceClass === 'agent_observation') return 'agent_observation';
  if (doc.kind === 'source' || doc.kind === 'wiki_page' || (doc.scope.type === 'global' && doc.scope.area === 'wiki')) return 'wiki_exposure';
  return 'agent_observation'; // unattributed material is never promoted to a statement by the user
}
