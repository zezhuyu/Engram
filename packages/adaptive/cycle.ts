import type { ModelProvider } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { IntelligenceEngine } from '../intelligence/index.js';
import { estimateWindow } from './activity.js';
import { localParts } from './clock.js';
import { Governor, type Pressure } from './governor.js';
import { propagatePurges } from './invalidation.js';
import { PauseSignal, runDreamStage, runGlobalStage, runWorkspaceStage, type StageContext } from './stages.js';
import { policyVersion, sealSnapshot, viewAt } from './snapshot.js';
import type { AdaptiveStore } from './state.js';
import { PIPELINE_VERSION, type AdaptiveConfig, type Cycle, type CycleError, type CycleState } from './types.js';

export interface RunOptions { kind: 'scheduled' | 'manual'; cycleId?: string; now?: Date; idempotencyKey?: string; watermark?: number; signal?: AbortSignal; respectActivity?: boolean; stopAfter?: 'workspaces' | 'global'; instance?: string; leaseMs?: number }
export interface RunResult { cycle?: Cycle; ran: boolean; reason?: string }
const nowIso = () => new Date().toISOString();
const TERMINAL: CycleState[] = ['COMPLETED', 'INVALIDATED'];

/** Drives one cycle through the strict DAG: SEAL W -> workspace stages -> global profile roots -> Dream -> COMPLETE, resuming from the earliest incomplete stage on the same snapshot. */
export class CycleRunner {
  constructor(private readonly vault: Vault, private readonly provider: ModelProvider | undefined, private readonly store: AdaptiveStore) {}

  cycleId(opts: RunOptions, config: AdaptiveConfig, now: Date): string {
    if (opts.kind === 'manual') return `manual-${(opts.idempotencyKey ?? `${now.toISOString()}`).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    return `${localParts(now, config.timezone).date}@${config.timezone}`;
  }
  private setState(cycle: Cycle, state: CycleState, note?: string): void { if (cycle.state !== state) cycle.stateHistory.push({ state, at: nowIso(), ...(note ? { note } : {}) }); cycle.state = state; }
  private fail(category: CycleError['category'], message: string): CycleError { return { category, message: message.slice(0, 300), at: nowIso() }; }

  async run(opts: RunOptions): Promise<RunResult> {
    const config = await this.store.config(); const now = opts.now ?? new Date(); const instance = opts.instance ?? this.store.newInstance(); const leaseMs = opts.leaseMs ?? 120_000;
    let id = opts.cycleId ?? this.cycleId(opts, config, now); let cycle = await this.store.cycle(id);
    if (cycle?.state === 'COMPLETED') return { cycle, ran: false, reason: 'ALREADY_COMPLETED' };
    if (cycle?.state === 'INVALIDATED') { const n = (await this.store.cycles()).filter(c => c.id.startsWith(`${id}#r`)).length + 1; id = `${id}#r${n}`; cycle = await this.store.cycle(id); if (cycle?.state === 'COMPLETED') return { cycle, ran: false, reason: 'ALREADY_COMPLETED' }; }
    if (!(await this.store.acquireLease(id, leaseMs, instance))) return { ...(cycle ? { cycle } : {}), ran: false, reason: 'LEASE_HELD' };
    const controller = new AbortController(); if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    let stopWatch = () => undefined as void; let pressure: Extract<Pressure, { ok: false }> | undefined;
    try {
      if (!cycle) cycle = await this.create(id, opts, config, now);
      else if (cycle.state !== 'SNAPSHOTTING') { const reborn = await viewAt(this.vault, cycle.watermark); if (cycle.policyVersion !== await policyVersion(this.vault)) { return { cycle: await this.invalidate(cycle, 'access policy changed since the snapshot was sealed'), ran: true }; } void reborn; cycle.metrics.resumes++; }
      const { view: fullView, events } = await viewAt(this.vault, cycle.watermark); const sealed = await sealSnapshot(this.vault, cycle.watermark);
      const optedOut = new Set((await this.vault.listWorkspaces()).map(w => w.id).filter(id => config.workspaces.exclude.includes(id) || (config.workspaces.include !== null && !config.workspaces.include.includes(id))));
      const view = fullView.excludeWorkspaces(optedOut);
      if (sealed.manifestHash !== cycle.manifestHash) return { cycle: await this.invalidate(cycle, 'journal history changed under the sealed watermark (purge or rewrite); the manifest no longer matches'), ran: true };
      const engine = new IntelligenceEngine(this.vault, this.provider); (engine as unknown as { snapshots?: unknown }).snapshots = async (ref: { allowPost?: string[] }) => view.withAllowPost(ref.allowPost ?? []);
      const governor = new Governor(this.vault, config, { respectActivity: opts.respectActivity ?? opts.kind === 'scheduled', segmentStart: Date.now(), ownRanges: () => cycle!.ownSequenceRanges });
      stopWatch = governor.watch(controller, p => { pressure = p; });
      const cyc = cycle;
      const ctx: StageContext = {
        vault: this.vault, engine, provider: this.provider, store: this.store, config, cycle: cyc, view, events, signal: controller.signal, pressure: () => pressure,
        checkpoint: async () => { await this.store.saveCycle(cyc); await this.store.renewLease(instance, id, leaseMs); },
        own: async action => { const before = (await this.vault.events()).at(-1)?.sequence ?? 0; try { return await action(); } finally { const after = (await this.vault.events()).at(-1)?.sequence ?? 0; if (after > before) cyc.ownSequenceRanges.push([before + 1, after]); } },
        spendModelCall: (calls = 1) => { cyc.budgets.modelCallsUsed += calls; cyc.metrics.modelCalls = (cyc.metrics.modelCalls ?? 0) + calls; }
      };
      { const before = (await this.vault.events()).at(-1)?.sequence ?? 0; const invalidated = await propagatePurges(this.vault, this.store); const after = (await this.vault.events()).at(-1)?.sequence ?? 0; if (after > before) cyc.ownSequenceRanges.push([before + 1, after]); if (invalidated.length) (cyc.accessEvents ??= []).push(...invalidated.map(i => ({ at: nowIso(), note: `${i.action} ${i.kind} ${i.objectId}: ${i.because}` }))); }
      await this.drive(ctx, opts);
      return { cycle: cyc, ran: true };
    } catch (error) {
      if (error instanceof PauseSignal && cycle) { cycle.error = this.fail(error.reason === 'FOREGROUND_ACTIVITY' ? 'CANCELLED_FOR_ACTIVITY' : 'RESOURCE_PRESSURE', error.detail); if (error.reason === 'FOREGROUND_ACTIVITY') cycle.metrics.activityCancellations++; cycle.metrics.pauses++; this.setState(cycle, 'PAUSED', error.detail); await this.store.saveCycle(cycle); return { cycle, ran: true, reason: 'PAUSED' }; }
      if (cycle) { cycle.error = this.fail('INTERNAL', error instanceof Error ? error.message : String(error)); this.setState(cycle, 'RETRY_WAIT', 'unexpected error'); await this.store.saveCycle(cycle); return { cycle, ran: true, reason: 'ERROR' }; }
      throw error;
    } finally { stopWatch(); await this.store.releaseLease(instance); }
  }

  private async create(id: string, opts: RunOptions, config: AdaptiveConfig, now: Date): Promise<Cycle> {
    const sealed = await sealSnapshot(this.vault, opts.watermark); const cursors = await this.store.cursors();
    const cycle: Cycle = { id, kind: opts.kind, localDate: localParts(now, config.timezone).date, timezone: config.timezone, state: 'SNAPSHOTTING', stateHistory: [{ state: 'SNAPSHOTTING', at: nowIso() }], createdAt: nowIso(), updatedAt: nowIso(), watermark: sealed.watermark, manifestHash: sealed.manifestHash, liveObjects: sealed.liveObjects, policyVersion: sealed.policyVersion, pipelineVersion: PIPELINE_VERSION, ...(this.provider ? { modelProvider: this.provider.id } : {}), permittedDerived: [], ownSequenceRanges: [], workspaces: {}, global: { status: 'PENDING', extraction: 'NOT_STARTED', evidenceIds: [], accepted: [], pendingReview: [], rejected: [], promotions: [], preservedConflicts: [], attempts: 0 }, dream: { status: 'PENDING', proposals: [], attempts: 0 }, attempts: 0, budgets: { modelCallsUsed: 0, modelCallsMax: config.maxModelCallsPerCycle }, metrics: { pauses: 0, resumes: 0, activityCancellations: 0, stageMs: {} } };
    for (const w of await this.vault.listWorkspaces()) {
      if (!(await this.vault.canAccess({ type: 'workspace', workspaceId: w.id }, 'read'))) continue;
      if (config.workspaces.include && !config.workspaces.include.includes(w.id)) continue; if (config.workspaces.exclude.includes(w.id)) continue;
      cycle.workspaces[w.id] = { workspaceId: w.id, status: 'PENDING', fromSequenceExclusive: cursors.workspaces[w.id] ?? 0, toSequenceInclusive: sealed.watermark, insights: { status: 'NOT_STARTED', evidenceIds: [] }, accepted: [], pendingReview: [], rejected: [], attempts: 0 };
    }
    await this.store.saveCycle(cycle); return cycle;
  }
  private async invalidate(cycle: Cycle, reason: string): Promise<Cycle> { cycle.error = this.fail('POLICY_INVALIDATED', reason); this.setState(cycle, 'INVALIDATED', reason); (cycle.accessEvents ??= []).push({ at: nowIso(), note: reason }); await this.store.saveCycle(cycle); return cycle; }

  private async drive(ctx: StageContext, opts: RunOptions): Promise<void> {
    const { cycle } = ctx; const timed = async (name: string, fn: () => Promise<void>) => { const t = Date.now(); try { await fn(); } finally { cycle.metrics.stageMs[name] = (cycle.metrics.stageMs[name] ?? 0) + Date.now() - t; } };
    cycle.attempts++; delete cycle.error; cycle.budgets.modelCallsUsed = 0; /* the model-call budget bounds one run segment, so a budget pause can be resumed */ const cursors = await this.store.cursors();
    // Stage 1: every eligible workspace (summary + workspace-scoped insights). Sequential: concurrency 1 for heavy work.
    if (!['WORKSPACES_COMMITTED', 'GLOBAL_PROFILE_RUNNING', 'GLOBAL_PROFILE_COMMITTED', 'DREAM_RUNNING', 'COMMITTING'].includes(cycle.state) || Object.values(cycle.workspaces).some(w => w.status !== 'SUCCEEDED')) {
      this.setState(cycle, 'WORKSPACES_RUNNING'); await ctx.checkpoint();
      await timed('workspaces', async () => { for (const ws of Object.values(cycle.workspaces)) { if (ws.status === 'SUCCEEDED') continue; await runWorkspaceStage(ctx, ws.workspaceId, ws.fromSequenceExclusive); } });
      const all = Object.values(cycle.workspaces);
      if (all.some(w => w.status === 'FAILED')) { this.setState(cycle, 'RETRY_WAIT', 'a workspace stage failed; Dream and global consolidation do not start'); await ctx.checkpoint(); return; }
      if (all.some(w => w.status === 'BLOCKED')) { cycle.error = all.find(w => w.status === 'BLOCKED')!.error ?? this.fail('MODEL_UNAVAILABLE', 'blocked'); this.setState(cycle, 'BLOCKED', cycle.error.message); await ctx.checkpoint(); return; }
    }
    this.setState(cycle, 'WORKSPACES_COMMITTED'); await ctx.checkpoint();
    if (opts.stopAfter === 'workspaces') return;
    if (cycle.global.status !== 'SUCCEEDED') {
      if (await this.policyChanged(cycle)) { await this.invalidate(cycle, 'access policy changed before global consolidation'); return; }
      this.setState(cycle, 'GLOBAL_PROFILE_RUNNING'); await ctx.checkpoint(); await timed('global', () => runGlobalStage(ctx, cursors.global));
      if (cycle.global.status === 'FAILED') { this.setState(cycle, 'RETRY_WAIT', 'global consolidation failed; Dream does not start'); await ctx.checkpoint(); return; }
      if (cycle.global.status === 'BLOCKED') { cycle.error = cycle.global.error ?? this.fail('MODEL_UNAVAILABLE', 'blocked'); this.setState(cycle, 'BLOCKED', cycle.error.message); await ctx.checkpoint(); return; }
    }
    this.setState(cycle, 'GLOBAL_PROFILE_COMMITTED'); await ctx.checkpoint();
    if (opts.stopAfter === 'global') return;
    if (cycle.dream.status !== 'SUCCEEDED') {
      if (await this.policyChanged(cycle)) { await this.invalidate(cycle, 'access policy changed before dream'); return; }
      this.setState(cycle, 'DREAM_RUNNING'); await ctx.checkpoint(); await timed('dream', () => runDreamStage(ctx));
      if (cycle.dream.status === 'FAILED') { this.setState(cycle, 'RETRY_WAIT', 'dream failed; successful earlier stages are kept'); await ctx.checkpoint(); return; }
      if (cycle.dream.status === 'BLOCKED') { cycle.error = cycle.dream.error ?? this.fail('MODEL_UNAVAILABLE', 'blocked'); this.setState(cycle, 'BLOCKED', cycle.error.message); await ctx.checkpoint(); return; }
    }
    this.setState(cycle, 'COMMITTING'); await ctx.checkpoint();
    cycle.completedAt = nowIso(); const telemetry = await this.store.telemetry(); cycle.nextRun = estimateWindow(telemetry, ctx.config, new Date());
    this.setState(cycle, 'COMPLETED'); await this.store.saveCycle(cycle);
  }
  private async policyChanged(cycle: Cycle): Promise<boolean> { return cycle.policyVersion !== await policyVersion(this.vault); }
}
