import type { Document, PutInput, Scope } from '../core/types.js';
import { isSensitive } from '../core/sensitivity.js';

export interface CriticResult { verdict: 'accept' | 'reject' | 'review_required'; rationale: string; flags: string[] }
const same = (a: Scope, b: Scope): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Keyword heuristic only: it can miss sensitive content. Sensitive inferred profile items always need explicit human confirmation. */
export { isSensitive } from '../core/sensitivity.js';
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
export function similarity(a: string, b: string): number {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return 0;
  let common = 0; for (const word of left) if (right.has(word)) common++;
  return common / (left.size + right.size - common);
}
const CERTAINTY = /\b(proven|proved|guaranteed|definitely works|conclusively|verified fact|established fact)\b/i;

/** Deterministic critic. Never calls a model and can only reject or require review; approval is always a human decision. */
export function criticize(input: PutInput, existing: Document[], peers: PutInput[]): CriticResult {
  const flags: string[] = [];
  const text = `${input.title}\n${input.body}`;
  const meta = input.metadata ?? {};
  if (input.kind === 'discovery' && CERTAINTY.test(input.body)) return { verdict: 'reject', rationale: 'Discovery presents speculation with unsupported certainty; hypotheses must not be stated as established fact.', flags: ['unsupported_certainty'] };
  if (input.kind === 'user_insight' && (meta.profileRole === 'inferred' || meta.insightSchema === 1)) {
    const key = typeof meta.preferenceKey === 'string' ? meta.preferenceKey : undefined;
    if (!key) flags.push('unkeyed');
    else if (meta.insightSchema !== 1) { // new-style insights are reconciled by the evidence rules in insights.ts
      const explicit = existing.find(doc => doc.status !== 'deleted' && doc.metadata.explicitPreference === true && doc.metadata.preferenceKey === key && same(doc.scope, input.scope));  // a workspace preference and a global one coexist: only the same scope conflicts
      if (explicit) {
        if (normalize(explicit.body) === normalize(input.body)) return { verdict: 'reject', rationale: `Restates the explicit preference ${explicit.uri}; no inferred item is needed.`, flags: ['redundant'] };
        return { verdict: 'reject', rationale: `Conflicts with explicit preference ${explicit.uri}@${explicit.revisionId}. Explicit statements take precedence; the user must change the explicit profile to alter it.`, flags: ['conflicts_explicit'] };
      }
    }
    if (isSensitive(text) || meta.sensitivity === 'sensitive') return { verdict: 'review_required', rationale: 'Inferred item touches sensitive personal information and needs explicit human confirmation.', flags: [...flags, 'sensitive'] };
    return { verdict: 'accept', rationale: 'No conflict with explicit preferences detected.', flags };
  }
  if (input.kind !== 'user_insight') {
    for (const doc of existing) if (doc.status !== 'deleted' && doc.kind === input.kind && same(doc.scope, input.scope) && similarity(text, `${doc.title}\n${doc.body}`) >= 0.85) return { verdict: 'reject', rationale: `Near-duplicate of existing ${doc.uri}; merge or relate instead of adding another object.`, flags: ['duplicate'] };
    for (const peer of peers) if (peer.kind === input.kind && same(peer.scope, input.scope) && similarity(text, `${peer.title}\n${peer.body}`) >= 0.85) return { verdict: 'reject', rationale: 'Near-duplicate of another queued proposal.', flags: ['duplicate'] };
  }
  return { verdict: 'accept', rationale: 'Deterministic checks passed; human review is still required.', flags };
}
