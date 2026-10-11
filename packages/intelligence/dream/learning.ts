import { promises as fs } from 'node:fs';
import { MDBError, type Document } from '../../core/types.js';
import type { Vault } from '../../core/vault.js';
import { safePath, withVaultLock } from '../../storage-local/index.js';
import { readableEntries } from '../corpus.js';
import { familyOf, readStats } from './lifecycle.js';

/**
 * Evidence-driven ranking feedback for Dream. The log is APPEND-ONLY and versioned (line number = version): ranking parameters are always derived from it,
 * so they can be re-evaluated as of any version, reset, or rebuilt after a discovery is deleted or becomes unreadable. Feedback only changes how future
 * candidate pairs are RANKED (a bounded multiplier in the planner); it never approves a hypothesis, never writes to PROFILE.md or any factual profile,
 * and feedback sourced from a model never counts.
 */
export type RankingLabel = 'useful' | 'not_useful' | 'duplicate' | 'incorrect' | 'needs_evidence';
export type FeedbackSource = 'human' | 'experiment' | 'model';
export interface FeedbackEvent {
  v: number; at: string; kind: 'feedback' | 'reset' | 'legacy'; discoveryId?: string; family?: string; label?: string; source?: FeedbackSource; actorId?: string; note?: string;
  /** kind 'legacy': counters carried over from the pre-log statistics file. */
  counts?: { validated: number; rejected: number; tested: number };
}
const LOG = '.mdb/intelligence/dream-feedback.jsonl';
/** Pseudo-observations per label. Validation by the user or an experiment is the strongest signal; duplicate only mildly lowers a family (redundant, not wrong). */
export const LABEL_WEIGHT: Record<string, { pos: number; neg: number }> = {
  validated: { pos: 2, neg: 0 }, useful: { pos: 1, neg: 0 }, rejected: { pos: 0, neg: 1 }, not_useful: { pos: 0, neg: 1 }, incorrect: { pos: 0, neg: 2 }, duplicate: { pos: 0, neg: 0.5 }, tested: { pos: 0, neg: 0 }, needs_evidence: { pos: 0, neg: 0 }
};
const COUNTED: FeedbackSource[] = ['human', 'experiment'];

async function readLines(vault: Pick<Vault, 'root'>): Promise<FeedbackEvent[]> {
  try { return (await fs.readFile(await safePath(vault.root, LOG), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as FeedbackEvent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new MDBError('INTERNAL', 'Dream feedback log is unreadable'); }
}
export const readFeedbackLog = readLines;

/** Appends one event durably (fsync) under the vault lock and returns its version. The first append also carries over the legacy per-family counters once. */
export async function appendFeedback(vault: Vault, event: Omit<FeedbackEvent, 'v' | 'at'>): Promise<number> {
  return withVaultLock(vault.root, async () => {
    const existing = await readLines(vault); const records: FeedbackEvent[] = []; let version = existing.length;
    if (!existing.length) { const legacy = await readStats(vault); for (const [family, counts] of Object.entries(legacy)) records.push({ v: ++version, at: new Date().toISOString(), kind: 'legacy', family, counts, source: 'human' }); }
    records.push({ v: ++version, at: new Date().toISOString(), ...event });
    const file = await safePath(vault.root, LOG); await fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    const handle = await fs.open(file, 'a', 0o600); try { await handle.writeFile(records.map(r => JSON.stringify(r) + '\n').join('')); await handle.sync(); } finally { await handle.close(); }
    return version;
  });
}

export interface FamilyParams { alpha: number; beta: number; observations: number; mean: number }
export interface LearnedParams { version: number; resetAtVersion: number; families: Record<string, FamilyParams>; counted: number; excluded: { model: number; unreadableOrDeleted: number; beforeReset: number } }
/**
 * Beta(1 + positive, 1 + negative) per family, derived from the log. Excludes model-sourced events, events about discoveries that no longer exist or are
 * not readable by the vault actor (deletion and privacy), and everything before the last reset. `asOfVersion` re-evaluates the parameters at an earlier version.
 */
export async function learnedParams(vault: Vault, options: { asOfVersion?: number } = {}): Promise<LearnedParams> {
  const events = (await readLines(vault)).filter(e => options.asOfVersion === undefined || e.v <= options.asOfVersion);
  const resetAt = events.filter(e => e.kind === 'reset').at(-1)?.v ?? 0;
  const readable = new Set((await readableEntries(vault, { kinds: ['discovery'] })).map(e => e.id));
  const families: Record<string, FamilyParams> = {}; const excluded = { model: 0, unreadableOrDeleted: 0, beforeReset: 0 }; let counted = 0;
  const bump = (family: string, pos: number, neg: number) => { const f = (families[family] ??= { alpha: 1, beta: 1, observations: 0, mean: 0.5 }); f.alpha += pos; f.beta += neg; f.observations += pos + neg; f.mean = f.alpha / (f.alpha + f.beta); };
  for (const e of events) {
    if (e.kind === 'reset') continue;
    if (e.v < resetAt) { excluded.beforeReset++; continue; }
    if (e.kind === 'legacy' && e.family && e.counts) { bump(e.family, e.counts.validated, e.counts.rejected); counted++; continue; }
    if (e.kind !== 'feedback' || !e.family || !e.label) continue;
    if (!e.source || !COUNTED.includes(e.source)) { excluded.model++; continue; }
    if (e.discoveryId && !readable.has(e.discoveryId)) { excluded.unreadableOrDeleted++; continue; }
    const w = LABEL_WEIGHT[e.label]; if (!w) continue; bump(e.family, w.pos, w.neg); counted++;
  }
  return { version: events.at(-1)?.v ?? 0, resetAtVersion: resetAt, families, counted, excluded };
}
/** Planner hook: the family's learned success rate in (0, 1); 0.5 when nothing is known. Falls back to the legacy counters when no log exists yet. */
export async function learnedSuccess(vault: Vault, legacy: Awaited<ReturnType<typeof readStats>>): Promise<(family: string) => number> {
  if (!(await readLines(vault)).length) return family => { const s = legacy[family]; return s ? (s.validated + 1) / (s.validated + s.rejected + 2) : 0.5; };
  const params = await learnedParams(vault); return family => params.families[family]?.mean ?? 0.5;
}

/** Records ranking feedback on a discovery as a new revision (its status is unchanged) and as a log event. */
export async function rateDiscovery(vault: Vault, id: string, input: { label: RankingLabel; note: string; source?: FeedbackSource }): Promise<{ document: Document; version: number }> {
  if (!(input.label in LABEL_WEIGHT) || ['validated', 'rejected', 'tested'].includes(input.label)) throw new MDBError('INVALID_INPUT', 'Label must be useful, not_useful, duplicate, incorrect or needs_evidence (use dream feedback for status changes)');
  if (!input.note?.trim()) throw new MDBError('INVALID_INPUT', 'Feedback needs a note');
  const doc = await vault.get(id); if (doc.kind !== 'discovery') throw new MDBError('INVALID_INPUT', 'Ranking feedback applies to discoveries');
  const history = Array.isArray(doc.metadata.feedback) ? doc.metadata.feedback as unknown[] : []; const source = input.source ?? 'human';
  const document = await vault.patch({ objectId: doc.id, expectedRevisionId: doc.revisionId, metadataPatch: { feedback: [...history, { label: input.label, note: input.note.slice(0, 500), at: new Date().toISOString(), source }] } });
  const version = await appendFeedback(vault, { kind: 'feedback', discoveryId: doc.id, family: familyOf(doc), label: input.label, source, actorId: vault.actor.actorId, note: input.note.slice(0, 200) });
  return { document, version };
}
/** Owner-only: ranking parameters restart from the prior. History stays in the log (and can be re-evaluated with asOfVersion). */
export async function resetLearning(vault: Vault, note: string): Promise<number> {
  if (!vault.actor.permissions.includes('*')) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'Resetting Dream ranking requires the trusted owner');
  if (!note?.trim()) throw new MDBError('INVALID_INPUT', 'A reset needs a reason');
  return appendFeedback(vault, { kind: 'reset', note: note.slice(0, 200), actorId: vault.actor.actorId, source: 'human' });
}
