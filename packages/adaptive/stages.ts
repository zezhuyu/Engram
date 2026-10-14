import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommitEvent, ModelProvider, Scope } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { MDBError } from '../core/types.js';
import type { IntelligenceEngine, Proposal } from '../intelligence/index.js';
import { loadDocuments, readableEntries } from '../intelligence/corpus.js';
import { applicability, isInsight, normalize, projectProfile } from '../intelligence/insights.js';
import { PROMPT_VERSION } from '../intelligence/dream/types.js';
import { buildChangeManifest, renderDailySummary } from './summary.js';
import type { Pressure } from './governor.js';
import type { SnapshotView } from './snapshot.js';
import type { AdaptiveStore } from './state.js';
import { SUMMARY_GENERATOR_VERSION, type AdaptiveConfig, type CycleError, type Cycle, type OutputRef, type WorkspaceRecord } from './types.js';

/** Raised at cooperative checkpoints; the runner turns it into PAUSED and later resumes the same snapshot. */
export class PauseSignal extends Error { constructor(readonly reason: 'FOREGROUND_ACTIVITY' | 'RESOURCE_PRESSURE', readonly detail: string) { super(detail); } }
export class StageBlocked extends Error { constructor(readonly error: CycleError) { super(error.message); } }
export interface StageContext {
  vault: Vault; engine: IntelligenceEngine; provider: ModelProvider | undefined; store: AdaptiveStore; config: AdaptiveConfig; cycle: Cycle;
  view: SnapshotView; events: CommitEvent[]; signal: AbortSignal; pressure: () => Pressure | undefined;
  checkpoint: () => Promise<void>; own: <T>(action: () => Promise<T>) => Promise<T>; spendModelCall: (calls?: number) => void;
}
const now = () => new Date().toISOString();
const err = (category: CycleError['category'], message: string): CycleError => ({ category, message: message.slice(0, 300), at: now() });
const wsScope = (workspaceId: string): Scope => ({ type: 'workspace', workspaceId });
/** Checked before retrieval batches, model calls and commits. */
export async function checkpoint(ctx: StageContext): Promise<void> {
  const p = ctx.pressure(); if (ctx.signal.aborted || p) { const pr = p ?? { ok: false as const, reason: 'FOREGROUND_ACTIVITY' as const, detail: 'cancelled' }; throw new PauseSignal((pr as Extract<Pressure, { ok: false }>).reason, (pr as Extract<Pressure, { ok: false }>).detail); }
}
/**
 * Low risk = the user said it explicitly, the critic accepts it, it is not sensitive, and nothing needs a human: no flags, OR the one flag `supersedes_earlier` on a proposal where the validator itself found
 * a correction marker in the user's own words (`correctionDetected`, a deterministic rule on the cited user text, not a model claim). Without that, a stated correction would leave the old preference in force
 * until someone approved by hand. A supersession without a detected correction (a model merely asserting "explicit") still waits for review.
 */
const lowRisk = (p: Proposal) => p.status === 'pending' && p.critic?.verdict === 'accept'
  && (!(p.flags?.length) || (p.flags!.length === 1 && p.flags![0] === 'supersedes_earlier' && p.input.metadata?.correctionDetected === true))
  && p.input.metadata?.evidenceClass === 'explicit' && p.input.metadata?.sensitivity !== 'sensitive';

/** Runs one model-backed engine job against the sealed snapshot and returns the proposals it created. */
async function runEngineJob(ctx: StageContext, kind: 'profile' | 'dream', input: Record<string, unknown>): Promise<{ status: string; error?: string; proposals: Proposal[]; trace?: unknown; /** a profile batch that stopped early (call budget, a failed later call): its validated proposals exist, but the evidence is not fully processed */ incomplete?: string; /** the batch stopped because its call budget ran out (resumable), not because something failed */ budgetExhausted?: boolean }> {
  if (!ctx.provider) throw new StageBlocked(err('MODEL_UNAVAILABLE', 'No model provider is configured; model-assisted stages cannot run'));
  if (ctx.cycle.budgets.modelCallsUsed >= ctx.cycle.budgets.modelCallsMax) throw new PauseSignal('RESOURCE_PRESSURE', 'cycle model-call budget exhausted');
  await checkpoint(ctx);
  const remaining = Math.max(1, ctx.cycle.budgets.modelCallsMax - ctx.cycle.budgets.modelCallsUsed); // a profile batch may never spend more provider calls than the cycle has left
  const job = await ctx.engine.enqueue(kind, { ...input, callBudget: remaining } as never);
  await ctx.engine.retryNow(job.id, { force: true }); // the cycle lease guarantees no other worker owns this job
  await ctx.own(() => ctx.engine.run({ job: kind, jobId: job.id, limit: 1, signal: ctx.signal } as never));
  const done = (await ctx.engine.jobs()).find(j => j.id === job.id);
  if (!done) throw new Error('engine job disappeared');
  // Charge only measured invocations; a Dream job without candidate clusters makes no provider calls.
  const used = done.telemetry?.modelCalls ?? 0; if (used > 0) ctx.spendModelCall(used);
  if (done.status === 'pending' && ctx.signal.aborted) await checkpoint(ctx);
  // Proposals are tied to their job (metadata.jobId, or the job's recorded result), so a resumed cycle finds them again after a crash instead of re-running the model.
  const proposals = (await ctx.engine.proposals()).filter(p => p.input.metadata?.jobId === job.id || p.id === done.result);
  const incomplete = done.telemetry?.complete === false ? (done.telemetry.partialReason ?? done.telemetry.terminal ?? 'incomplete') : undefined;
  return { status: done.status, ...(done.error ? { error: done.error } : {}), proposals, ...(done.trace ? { trace: done.trace } : {}), ...(incomplete ? { incomplete, budgetExhausted: done.telemetry?.terminal === 'budget_exhausted' } : {}) };
}
async function settleProposals(ctx: StageContext, proposals: Proposal[], kind: string, stage: 'WORKSPACE_INSIGHT' | 'GLOBAL_INSIGHT', into: { accepted: OutputRef[]; pendingReview: string[]; rejected: string[] }): Promise<void> {
  for (const p of proposals.filter(x => x.input.kind === kind)) {
    let current = p;
    if (ctx.config.autoAccept === 'low-risk' && lowRisk(p)) { await checkpoint(ctx); try { current = await ctx.own(() => ctx.engine.review(p.id, true, 'adaptive cycle: auto-accepted low-risk explicit statement')); } catch { current = p; } }
    if (current.status === 'approved' && current.objectId) { const doc = await ctx.vault.get(current.objectId); const ref = { objectId: doc.id, revisionId: doc.revisionId, proposalId: p.id }; into.accepted.push(ref); ctx.cycle.permittedDerived.push({ ...ref, stage }); }
    else if (current.status === 'rejected') into.rejected.push(p.id); else into.pendingReview.push(p.id);
  }
}

export async function runWorkspaceStage(ctx: StageContext, workspaceId: string, cursor: number): Promise<WorkspaceRecord> {
  const { cycle, view, vault } = ctx;
  const rec: WorkspaceRecord = cycle.workspaces[workspaceId] ??= { workspaceId, status: 'PENDING', fromSequenceExclusive: cursor, toSequenceInclusive: view.watermark, insights: { status: 'NOT_STARTED', evidenceIds: [] }, accepted: [], pendingReview: [], rejected: [], attempts: 0 };
  if (rec.status === 'SUCCEEDED') return rec;
  rec.attempts++; rec.status = 'RUNNING'; delete rec.error; await ctx.checkpoint();
  try {
    await checkpoint(ctx);
    const manifest = await buildChangeManifest(vault, view, ctx.events, workspaceId, rec.fromSequenceExclusive, cycle.localDate, cycle.timezone, ctx.config.baselineMaxItems);
    rec.manifestHash = manifest.hash; rec.changes = { added: manifest.entries.filter(e => e.status === 'added').length, modified: manifest.entries.filter(e => e.status === 'modified').length, deleted: manifest.entries.filter(e => e.status === 'deleted').length, restored: manifest.entries.filter(e => e.status === 'restored').length, documents: manifest.entries.length };
    if (!manifest.entries.length) { rec.outcome = 'NO_ELIGIBLE_CHANGES'; rec.insights.status = 'NOT_NEEDED'; rec.status = 'SUCCEEDED'; await ctx.store.advanceCursors(c => { c.workspaces[workspaceId] = Math.max(c.workspaces[workspaceId] ?? 0, view.watermark); }); await ctx.checkpoint(); return rec; }
    rec.outcome = manifest.baseline ? 'INITIAL_BASELINE' : 'SUMMARIZED';
    rec.idempotencyKey = `adaptive:ws-summary:${workspaceId}:${cycle.id}:${rec.fromSequenceExclusive}:${view.watermark}:${manifest.hash.slice(0, 16)}:${SUMMARY_GENERATOR_VERSION}`;
    if (!rec.summary) {
      await checkpoint(ctx); const rendered = renderDailySummary(manifest, cycle.localDate);
      const doc = await ctx.own(() => vault.put({ scope: wsScope(workspaceId), kind: 'workspace_daily_summary', title: `Workspace Daily Summary — ${cycle.localDate}`, body: rendered.markdown, tags: ['daily-summary', `date:${cycle.localDate}`], evidence: rendered.evidence, idempotencyKey: rec.idempotencyKey!, metadata: { workspace_id: workspaceId, local_date: cycle.localDate, cycle_id: cycle.id, status: rendered.status, ...(manifest.baseline ? { baseline: 'INITIAL_BASELINE' } : {}), from_committed_sequence_exclusive: rec.fromSequenceExclusive, to_committed_sequence_inclusive: view.watermark, source_manifest_hash: manifest.hash, generator_version: SUMMARY_GENERATOR_VERSION, source_revisions: manifest.entries.map(e => ({ objectId: e.objectId, revisionIds: e.revisions, sequences: e.sequences, status: e.status })) } }));
      rec.summary = { objectId: doc.id, revisionId: doc.revisionId }; cycle.permittedDerived.push({ ...rec.summary, stage: 'WORKSPACE_SUMMARY' }); await ctx.checkpoint();
    }
    const evidence = manifest.entries.filter(e => e.source === 'user-authored' && ['observation', 'note'].includes(e.kind) && e.status !== 'deleted').slice(-20);
    rec.insights.evidenceIds = evidence.map(e => e.objectId);
    if (!evidence.length) rec.insights.status = 'NOT_NEEDED';
    else if (rec.insights.status !== 'COMPLETED') {
      // Extraction runs once per exact scope (workspace or one of its collections): the profile job matches its evidence by scope.
      const byScope = new Map<string, { scope: Scope; ids: string[] }>();
      for (const e of evidence) { const scope = view.entries().find(o => o.id === e.objectId)?.scope ?? wsScope(workspaceId); const key = JSON.stringify(scope); (byScope.get(key) ?? byScope.set(key, { scope, ids: [] }).get(key)!).ids.push(e.objectId); }
      const done = new Set(rec.insights.jobKey ? rec.insights.jobKey.split(',') : []);
      for (const [key, group] of byScope) {
        const tag = createHash('sha256').update(key).digest('hex').slice(0, 8); if (done.has(tag)) continue;
        const run = await runEngineJob(ctx, 'profile', { scope: group.scope, objectIds: group.ids, instruction: `adaptive:${cycle.id}:${workspaceId}:${tag}:profile`, snapshot: { cycleId: cycle.id, watermark: view.watermark } });
        if (run.status === 'blocked') throw new StageBlocked(err('MODEL_UNAVAILABLE', run.error ?? 'profile extraction blocked'));
        if (run.status !== 'complete') throw new Error(`profile extraction ${run.status}: ${run.error ?? ''}`);
        await settleProposals(ctx, run.proposals, 'user_insight', 'WORKSPACE_INSIGHT', rec);
        if (run.incomplete) { if (run.budgetExhausted) throw new PauseSignal('RESOURCE_PRESSURE', 'profile batch model-call budget exhausted: validated proposals kept, the cursor did not move, resume continues'); throw new Error(`profile extraction incomplete (${run.incomplete}): validated proposals were kept, the workspace cursor did not move, the next run continues without repeating them`); }
        done.add(tag); rec.insights.jobKey = [...done].join(','); await ctx.checkpoint();
      }
      rec.insights.status = 'COMPLETED';
    }
    rec.status = 'SUCCEEDED'; await ctx.store.advanceCursors(c => { c.workspaces[workspaceId] = Math.max(c.workspaces[workspaceId] ?? 0, view.watermark); }); await ctx.checkpoint(); return rec;
  } catch (error) {
    if (error instanceof PauseSignal) { rec.status = 'PAUSED'; await ctx.checkpoint(); throw error; }
    if (error instanceof StageBlocked) { rec.status = 'BLOCKED'; rec.insights.status = rec.insights.evidenceIds.length ? 'BLOCKED' : rec.insights.status; rec.error = error.error; await ctx.checkpoint(); return rec; }
    rec.status = 'FAILED'; rec.insights.status = rec.insights.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED'; rec.error = err('STAGE_FAILED', error instanceof Error ? error.message : String(error)); await ctx.checkpoint(); return rec;
  }
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function rootHash(root: string, name: string): Promise<string> { try { return sha(await fs.readFile(path.join(root, name))); } catch { return 'absent'; } }
/** Derived outputs are only inputs while their own evidence still resolves; purged or revoked evidence removes them and any root projection built on them is refreshed. */
export async function verifyDerived(ctx: StageContext): Promise<number> {
  let removed = 0; const keep: Cycle['permittedDerived'] = [];
  for (const out of ctx.cycle.permittedDerived) {
    const doc = await ctx.vault.get(out.objectId, out.revisionId).catch(() => undefined); let ok = !!doc && doc.status !== 'deleted';
    if (ok) for (const e of doc!.evidence ?? []) { if (!(await ctx.vault.get(e.uri.split('/').at(-1)!, e.revisionId).then(() => true, () => false))) { ok = false; break; } }
    if (ok) keep.push(out); else removed++;
  }
  if (removed) { ctx.cycle.permittedDerived = keep; ctx.cycle.accessEvents = [...(ctx.cycle.accessEvents ?? []), { at: now(), note: `${removed} derived output(s) invalidated: evidence purged, deleted or no longer authorized` }]; }
  return removed;
}

export async function runGlobalStage(ctx: StageContext, globalCursor: number): Promise<void> {
  const { cycle, vault, view } = ctx; const rec = cycle.global;
  if (rec.status === 'SUCCEEDED') return;
  rec.attempts++; rec.status = 'RUNNING'; delete rec.error; await ctx.checkpoint();
  try {
    await checkpoint(ctx); const invalidated = await verifyDerived(ctx);
    // 1. extraction over frozen original user-authored GLOBAL evidence at or before W
    const evidence = view.entries().filter(o => o.scope.type === 'global' && o.scope.area !== 'discoveries' && o.sequence > globalCursor).map(o => o.id);
    const authored: string[] = []; for (const id of evidence.slice(-60)) { const d = await view.read(vault, id); if (d && d.kind !== 'user_insight' && d.kind !== 'profile' && (d.metadata.speaker === 'user' || d.metadata.evidenceClass === 'explicit')) authored.push(id); }
    rec.evidenceIds = authored.slice(-20);
    if (!rec.evidenceIds.length) rec.extraction = 'NOT_NEEDED';
    else if (rec.extraction !== 'COMPLETED') {
      const run = await runEngineJob(ctx, 'profile', { scope: { type: 'global', area: 'profile' }, objectIds: rec.evidenceIds, instruction: `adaptive:${cycle.id}:global:profile`, snapshot: { cycleId: cycle.id, watermark: view.watermark } });
      if (run.status === 'blocked') throw new StageBlocked(err('MODEL_UNAVAILABLE', run.error ?? 'global extraction blocked'));
      if (run.status !== 'complete') throw new Error(`global extraction ${run.status}: ${run.error ?? ''}`);
      await settleProposals(ctx, run.proposals, 'user_insight', 'GLOBAL_INSIGHT', rec);
      if (run.incomplete) { if (run.budgetExhausted) throw new PauseSignal('RESOURCE_PRESSURE', 'global profile batch model-call budget exhausted: validated proposals kept, the cursor did not move, resume continues'); throw new Error(`global extraction incomplete (${run.incomplete}): validated proposals were kept and the cursor did not move`); }
      rec.extraction = 'COMPLETED';
    }
    // 2. cross-context promotion: only identical, non-sensitive, authorized preferences supported in at least two workspaces; conflicts stay scoped
    await checkpoint(ctx);
    const insightDocs = (await loadDocuments(vault, await readableEntries(vault, { kinds: ['user_insight'] }))).filter(d => isInsight(d) && d.status === 'accepted' && d.metadata.sensitivity !== 'sensitive' && (view.has(d.id) || cycle.permittedDerived.some(o => o.objectId === d.id)));
    const groups = new Map<string, typeof insightDocs>(); for (const d of insightDocs) { const k = `${String(d.metadata.category)}|${String(d.metadata.preferenceKey)}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(d); }
    const existingGlobal = new Set(insightDocs.filter(d => applicability(d) === 'global').map(d => String(d.metadata.preferenceKey)));
    for (const [key, docs] of groups) {
      const scoped = docs.filter(d => applicability(d) !== 'global'); const labels = [...new Set(scoped.map(applicability))]; const pk = String(scoped[0]?.metadata.preferenceKey ?? '');
      if (labels.length < 2 || existingGlobal.has(pk) || rec.promotions.some(p => p.preferenceKey === pk)) continue;
      const claims = new Set(scoped.map(d => normalize(d.body)));
      if (claims.size > 1) { rec.preservedConflicts.push(pk); rec.promotions.push({ preferenceKey: pk, workspaces: labels, status: 'SKIPPED_CONFLICT' }); continue; }
      let allowed = true; for (const label of labels) if (!(await vault.canAccess(wsScope(label), 'read'))) allowed = false;
      if (!allowed) { rec.promotions.push({ preferenceKey: pk, workspaces: labels, status: 'SKIPPED_UNAUTHORIZED' }); continue; }
      const sample = scoped[0]!; const proposal = await ctx.own(() => ctx.engine.propose({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: sample.title, body: sample.body, status: 'candidate', evidence: scoped.slice(0, 40).map(d => ({ uri: d.uri, revisionId: d.revisionId })), metadata: { insightSchema: 1, category: sample.metadata.category, preferenceKey: pk, sensitivity: 'none', scopeLabel: 'global', evidenceClass: 'inferred', explicitStatement: false, promotedFromWorkspaces: labels, promotion: 'cross-context', cycleId: cycle.id, modelProvider: 'adaptive-promotion', confidenceMethod: 'rule-cross-context' } }));
      rec.promotions.push({ preferenceKey: pk, workspaces: labels, status: 'PROPOSED', proposalId: proposal.id }); rec.pendingReview.push(proposal.id);
    }
    // 3. root Markdown projection (deterministic, idempotent) and an output manifest, even when nothing changed
    await checkpoint(ctx);
    if (vault.actor.permissions.includes('*')) await ctx.own(() => projectProfile(vault));
    const accepted = (await loadDocuments(vault, await readableEntries(vault, { kinds: ['user_insight'] }))).filter(d => isInsight(d) && d.status === 'accepted').map(d => ({ objectId: d.id, revisionId: d.revisionId }));
    rec.roots = { PROFILE: await rootHash(vault.root, 'PROFILE.md'), USER_INSIGHT: await rootHash(vault.root, 'USER_INSIGHT.md'), acceptedInsightRevisions: accepted.sort((a, b) => a.objectId.localeCompare(b.objectId)) };
    void invalidated;
    rec.status = 'SUCCEEDED'; await ctx.store.advanceCursors(c => { c.global = Math.max(c.global, view.watermark); }); await ctx.checkpoint();
  } catch (error) {
    if (error instanceof PauseSignal) { rec.status = 'PAUSED'; await ctx.checkpoint(); throw error; }
    if (error instanceof StageBlocked) { rec.status = 'BLOCKED'; rec.extraction = rec.evidenceIds.length ? 'BLOCKED' : rec.extraction; rec.error = error.error; await ctx.checkpoint(); return; }
    rec.status = 'FAILED'; rec.error = err('STAGE_FAILED', error instanceof Error ? error.message : String(error)); await ctx.checkpoint();
  }
}

export async function runDreamStage(ctx: StageContext): Promise<void> {
  const { cycle, view, vault } = ctx; const rec = cycle.dream;
  if (rec.status === 'SUCCEEDED') return;
  rec.attempts++; rec.status = 'RUNNING'; delete rec.error; await ctx.checkpoint();
  // Dream is an explicit opt-in. When it is off the stage is an honest skip: reporting it as MODEL_UNAVAILABLE blocked every daily cycle of a vault that only wants profile extraction, forever.
  if (!(await vault.config()).dream.enabled) { rec.proposals = []; rec.skipped = 'Dream is not enabled (explicit opt-in); profile and summary stages ran normally'; rec.status = 'SUCCEEDED'; await ctx.checkpoint(); return; }
  try {
    await checkpoint(ctx); await verifyDerived(ctx);
    const permitted = cycle.permittedDerived.map(o => ({ objectId: o.objectId, revisionId: o.revisionId, proposalId: o.proposalId }));
    rec.corpusVisibility = { watermark: view.watermark, eligibleObjects: view.size, eligibleScopes: view.scopes(), policyVersion: cycle.policyVersion, retrievalVersion: `dream/${PROMPT_VERSION}+lexical-graph`, permittedDerived: permitted };
    const run = await runEngineJob(ctx, 'dream', { mode: ctx.config.dreamMode, instruction: `adaptive:${cycle.id}:dream`, snapshot: { cycleId: cycle.id, watermark: view.watermark, allowPost: permitted.map(o => o.objectId) } });
    if (run.budgetExhausted) throw new PauseSignal('RESOURCE_PRESSURE', 'Dream exhausted the cycle model-call budget');
    if (run.status === 'blocked') throw new StageBlocked(err('MODEL_UNAVAILABLE', run.error ?? 'dream blocked'));
    if (run.status !== 'complete') throw new Error(`dream ${run.status}: ${run.error ?? ''}`);
    rec.proposals = run.proposals.filter(p => p.input.kind === 'discovery').map(p => ({ proposalId: p.id, status: p.status, evidence: (p.input.evidence ?? []).map(e => ({ uri: e.uri, revisionId: e.revisionId })) }));
    if (run.trace) rec.trace = run.trace; rec.status = 'SUCCEEDED'; await ctx.checkpoint();
  } catch (error) {
    if (error instanceof PauseSignal) { rec.status = 'PAUSED'; await ctx.checkpoint(); throw error; }
    if (error instanceof StageBlocked) { rec.status = 'BLOCKED'; rec.error = error.error; await ctx.checkpoint(); return; }
    if (error instanceof MDBError && error.code === 'CAPABILITY_UNAVAILABLE') { rec.status = 'BLOCKED'; rec.error = err('MODEL_UNAVAILABLE', error.message); await ctx.checkpoint(); return; }
    rec.status = 'FAILED'; rec.error = err('STAGE_FAILED', error instanceof Error ? error.message : String(error)); await ctx.checkpoint();
  }
}
