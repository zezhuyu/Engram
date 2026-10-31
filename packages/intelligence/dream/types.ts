import type { ManifestEntry } from '../../search-files/manifest.js';

export type DreamMode = 'micro' | 'deep' | 'strategic';
export type Distance = 'near' | 'complementary' | 'distant';
export type DiscoverySubtype = 'composition' | 'analogy' | 'transfer' | 'contradiction' | 'opportunity';
export const SUBTYPES: DiscoverySubtype[] = ['composition', 'analogy', 'transfer', 'contradiction', 'opportunity'];
export const NOVELTY = ['established', 'unclear', 'new_to_user'] as const;
export const PROMPT_VERSION = 'dream-prompts-5';
/** Perspectives a deep dream asks sibling candidates to take, so the comparison is between genuinely different connections and not paraphrases. */
export const DEEP_ANGLES = [{ id: 'mechanism', ask: 'Propose a testable, conditional MECHANISM transfer. State what each source separately says, then label the possible connection as a hypothesis. Never claim the mechanism is shared, implemented, or proven.' }, { id: 'composition', ask: 'Propose a testable, conditional COMPOSITION: state what each source separately says, then label the possible combination as a hypothesis. Do not claim the integration exists or is proven.' }, { id: 'tension', ask: 'Find a TENSION: state both source claims and the gap or constraint between them; preserve unresolved disagreement without inventing its cause.' }] as const;
export const SCHEMA_VERSION = 2;

/** Why two or more objects were put in front of the model together. Produced deterministically, before any model call. */
export interface Hint { kind: DiscoverySubtype; via: string; why: string; ids: string[]; domains: string[]; distance: Distance; score: number }
export interface Cluster { id: string; ids: string[]; goalIds: string[]; hints: Hint[] }
export interface Budgets { maxObjects: number; maxClusters: number; maxPerCluster: number }
export interface TraceCandidate { id: string; domain: string; distance: Distance; via: string }
/** What a plan did, kept with the job so a run can be audited and the three modes can be shown to differ. */
export interface Trace {
  mode: DreamMode; algorithm: string; seeds: string[]; poolSize: number; domainsInPool: number;
  candidates: TraceCandidate[]; clusters: Array<{ id: string; ids: string[]; domains: string[]; hints: Array<{ kind: DiscoverySubtype; via: string; distance: Distance }> }>;
  budget: Budgets & { usedObjects: number }; skipped: Array<{ reason: string; detail?: string }>; domainsCovered: string[]; goalRefs?: string[]; gaps?: Array<{ goal: string; terms: string[] }>;
  stoppedBy?: 'duration' | 'cancelled';
  semanticAssociations?: number;
  /** Per-seed durable retry outcomes for incremental micro runs. */
  retryableSeeds?: string[];
  exhaustedSeeds?: string[];
}
export interface Graph { out(e: ManifestEntry): ManifestEntry[]; in(e: ManifestEntry): ManifestEntry[]; semantic?(e: ManifestEntry): ManifestEntry[] }
export interface PlanContext {
  pool: ManifestEntry[]; graph: Graph; budgets: Budgets; rng: () => number;
  /** Bounded, currently authorized lexical terms from recent source bodies; never persisted or sent unless the source is selected. */
  bodyTerms?: Map<string, string[]>;
  /** smoothed validated/rejected rate (0..1) for a hint family, learned from feedback; 0.5 when unknown */
  success: (key: string) => number;
  /** true when this exact evidence set was already rejected without new evidence, or already covered by a live discovery */
  suppressed: (ids: string[]) => boolean;
  semanticAssociationCount?: number;
}
