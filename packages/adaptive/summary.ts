import { createHash } from 'node:crypto';
import type { CommitEvent, Document } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { isBackgroundEvent } from './activity.js';
import { localParts } from './clock.js';
import type { SnapshotView } from './snapshot.js';
import { SUMMARY_GENERATOR_VERSION } from './types.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'restored';
export interface ChangeEntry {
  objectId: string; uri: string; kind: string; title: string; status: ChangeStatus; addedThenDeleted: boolean;
  sequences: number[]; revisions: string[]; baseRevisionId?: string; finalRevisionId: string; diff: { linesAdded: number; linesRemoved: number };
  source: 'user-authored' | 'agent-generated' | 'tool-observed' | 'unattributed'; excerpt: string; at: string;
}
export interface ChangeManifest { workspaceId: string; fromExclusive: number; toInclusive: number; baseline: boolean; entries: ChangeEntry[]; preexistingObjects: number; truncated: number; hash: string }
const SUMMARY_KIND = 'workspace_daily_summary';
const FINDING_KINDS = new Set(['finding', 'insight', 'analysis', 'reflection', 'working_memory', 'procedure', 'note', 'wiki_page']);
const lines = (text: string) => new Set(text.split('\n').map(l => l.trim()).filter(Boolean));
const sourceOf = (d: Document): ChangeEntry['source'] => d.metadata.speaker === 'user' ? 'user-authored' : d.metadata.speaker === 'assistant' ? 'agent-generated' : d.kind === 'observation' && d.metadata.eventType === 'tool.result' ? 'tool-observed' : 'unattributed';
const excerpt = (text: string, n = 180) => text.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Describes what actually changed in one workspace over the committed-sequence interval (fromExclusive, W]. It is derived only from journal records and the exact revisions
 * they name, never from live heads, wall-clock filters or updated_at. On the first run (cursor 0) only the cycle's local day is described as change; older content is counted.
 */
export async function buildChangeManifest(vault: Vault, view: SnapshotView, events: CommitEvent[], workspaceId: string, fromExclusive: number, localDate: string, timezone: string, baselineMaxItems: number): Promise<ChangeManifest> {
  const mine = events.filter(e => e.scope.type === 'workspace' && e.scope.workspaceId === workspaceId && e.sequence > fromExclusive && e.sequence <= view.watermark && !isBackgroundEvent(e) && e.operation !== 'purge');
  const baseline = fromExclusive === 0; const inRange = baseline ? mine.filter(e => localParts(new Date(e.timestamp), timezone).date === localDate) : mine;
  const preexisting = baseline ? new Set(mine.filter(e => !inRange.includes(e)).map(e => e.objectId)).size : 0;
  const byObject = new Map<string, CommitEvent[]>(); for (const e of inRange) (byObject.get(e.objectId) ?? byObject.set(e.objectId, []).get(e.objectId)!).push(e);
  const entries: ChangeEntry[] = [];
  for (const [objectId, list] of byObject) {
    list.sort((a, b) => a.sequence - b.sequence); const first = list[0]!, last = list.at(-1)!;
    const final = await vault.get(objectId, last.revisionId).catch(() => undefined); if (!final || final.kind === SUMMARY_KIND) continue; // history artifacts are never their own evidence
    const base = first.previousRevisionId ? await vault.get(objectId, first.previousRevisionId).catch(() => undefined) : undefined;
    const added = !first.previousRevisionId && first.operation !== 'restore'; const deleted = last.operation === 'delete'; const restored = list.some(e => e.operation === 'restore');
    const status: ChangeStatus = deleted ? 'deleted' : added ? 'added' : restored ? 'restored' : 'modified';
    const prev = lines(base?.body ?? ''), now = lines(deleted ? '' : final.body);
    const diff = { linesAdded: [...now].filter(l => !prev.has(l)).length, linesRemoved: [...prev].filter(l => !now.has(l)).length };
    entries.push({ objectId, uri: final.uri, kind: final.kind, title: final.title, status, addedThenDeleted: added && deleted, sequences: list.map(e => e.sequence), revisions: list.map(e => e.revisionId), ...(first.previousRevisionId ? { baseRevisionId: first.previousRevisionId } : {}), finalRevisionId: last.revisionId, diff, source: sourceOf(final), excerpt: deleted ? '' : excerpt(final.body), at: last.timestamp });
  }
  entries.sort((a, b) => a.sequences[0]! - b.sequences[0]! || a.objectId.localeCompare(b.objectId));
  const truncated = baseline && entries.length > baselineMaxItems ? entries.length - baselineMaxItems : 0; const shown = truncated ? entries.slice(0, baselineMaxItems) : entries;
  const hash = createHash('sha256').update(JSON.stringify({ workspaceId, fromExclusive, to: view.watermark, e: entries.map(e => [e.objectId, e.revisions, e.sequences, e.status]) })).digest('hex');
  return { workspaceId, fromExclusive, toInclusive: view.watermark, baseline, entries: shown, preexistingObjects: preexisting, truncated, hash };
}

const ref = (e: ChangeEntry) => `${e.uri}@${e.finalRevisionId} (journal ${e.sequences[0]}${e.sequences.length > 1 ? `–${e.sequences.at(-1)}` : ''})`;
const bullets = (items: string[], none = '- None evidenced.') => items.length ? items.join('\n') : none;
/** Deterministic, evidence-linked Markdown. Every statement is a restatement of a committed record with its reference; sections without evidence say so. */
export function renderDailySummary(manifest: ChangeManifest, localDate: string): { markdown: string; status: 'COMPLETE' | 'PARTIAL'; evidence: Array<{ uri: string; revisionId: string }> } {
  const e = manifest.entries; const count = (s: ChangeStatus) => e.filter(x => x.status === s).length;
  const decisions = e.filter(x => x.kind === 'decision' && x.status !== 'deleted'), findings = e.filter(x => FINDING_KINDS.has(x.kind) && x.status !== 'deleted' && x.kind !== 'decision');
  const userNotes = e.filter(x => x.source === 'user-authored' && x.status !== 'deleted').slice(0, 10);
  const progress = e.filter(x => (x.kind === 'task' || x.kind === 'reflection') && x.status !== 'deleted'); const issues = e.filter(x => ['issue', 'blocker', 'risk'].includes(x.kind) && x.status !== 'deleted');
  const md = [
    `# Workspace Daily Summary — ${localDate}`, '',
    '## Executive summary', manifest.baseline ? `Initial baseline (INITIAL_BASELINE): ${manifest.preexistingObjects} object(s) in this workspace pre-date today and are counted, not described. Today's committed changes: ${e.length}${manifest.truncated ? ` (${manifest.truncated} more omitted by the baseline limit)` : ''}.` : `${e.length} object(s) changed between journal sequence ${manifest.fromExclusive} (exclusive) and ${manifest.toInclusive} (inclusive): ${count('added')} added, ${count('modified')} modified, ${count('deleted')} deleted, ${count('restored')} restored.`, '',
    '## Changes made (added / modified / deleted)', bullets(e.map(x => `- **${x.status}** ${x.title} (${x.kind}) — +${x.diff.linesAdded}/-${x.diff.linesRemoved} lines${x.addedThenDeleted ? ', added and deleted in this interval' : ''}; ${x.revisions.length} revision(s); ${ref(x)}`)), '',
    '## Findings and evidence', bullets(findings.map(x => `- ${x.title}: "${x.excerpt}" — ${x.source}; ${ref(x)}`)), '',
    '## Decisions and rationale', bullets(decisions.map(x => `- ${x.title}: "${x.excerpt}" — ${x.source}; ${ref(x)}`)), '',
    '## Notes and observations', bullets(userNotes.map(x => `- (user-authored) "${x.excerpt}" — ${ref(x)}`)), '',
    '## Progress and completed work', bullets(progress.map(x => `- ${x.title} — ${x.source}; ${ref(x)}`)), '',
    '## Open issues, blockers, risks', bullets(issues.map(x => `- ${x.title}: "${x.excerpt}" — ${ref(x)}`)), '',
    '## Follow-ups / next steps', '- None evidenced. (Owners and due dates are only reported when a source states them.)', '',
    '## References (source IDs, exact revisions, journal sequences)', bullets(e.map(x => `- ${x.objectId} @ ${x.finalRevisionId}; sequences ${x.sequences.join(', ')}; revisions ${x.revisions.join(', ')}`)), '',
    '## Confidence / unknowns / pending review', `- Generated deterministically (${SUMMARY_GENERATOR_VERSION}) from committed journal records and their exact revisions; no model interpretation was applied, so conclusions, causes and test results are Unknown unless quoted above.`, '- User-authored notes, agent-generated text and tool observations are labelled; a label is the source of the record, not a verification.', '- Pending insight proposals for this workspace are reported in the cycle record, not here.', ''
  ].join('\n');
  const evidence = [...new Map(e.filter(x => x.status !== 'deleted').slice(0, 40).map(x => [x.objectId, { uri: x.uri, revisionId: x.finalRevisionId }])).values()];
  return { markdown: md, status: manifest.truncated ? 'PARTIAL' : 'COMPLETE', evidence };
}
