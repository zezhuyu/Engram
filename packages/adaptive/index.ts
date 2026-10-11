import type { ModelProvider } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { loadDocuments, readableEntries } from '../intelligence/corpus.js';
import { isBackgroundEvent } from './activity.js';
import { CycleRunner, type RunOptions, type RunResult } from './cycle.js';
import { AdaptiveScheduler, type ScheduleStatus } from './scheduler.js';
import { AdaptiveStore } from './state.js';
import { MicroTrigger, runWorker, serviceDefinition, type WorkerOptions, type WorkerSummary } from './worker.js';
import type { AdaptiveConfig, Cycle } from './types.js';
import { isValidTimeZone, parseHHMM } from './clock.js';

export { touchActivity } from './activity.js';
export * from './types.js';
export { AdaptiveStore } from './state.js';
export { AdaptiveScheduler } from './scheduler.js';
export { CycleRunner } from './cycle.js';
export { MicroTrigger, runWorker, serviceDefinition } from './worker.js';
export { sealSnapshot, viewAt, SnapshotView } from './snapshot.js';
export { estimateWindow, observe } from './activity.js';
export { localParts } from './clock.js';

/** Public SDK/CLI facade for adaptive background intelligence. Owner-only: the cycle reads and writes across authorized scopes as the trusted owner. */
export class AdaptiveIntelligence {
  readonly store: AdaptiveStore; readonly scheduler: AdaptiveScheduler; private readonly runner: CycleRunner;
  constructor(private readonly vault: Vault, private readonly provider?: ModelProvider) {
    if (!vault.actor.permissions.includes('*')) throw new Error('Adaptive intelligence requires the trusted vault owner');
    this.store = new AdaptiveStore(vault.root); this.scheduler = new AdaptiveScheduler(vault, provider, this.store); this.runner = new CycleRunner(vault, provider, this.store);
  }
  status(now?: Date): Promise<ScheduleStatus> { return this.scheduler.status(now); }
  async configure(patch: Partial<AdaptiveConfig>): Promise<AdaptiveConfig> {
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw new Error(`Unknown IANA time zone: ${patch.timezone}`);
    for (const key of ['targetLocalTime', 'quietStart', 'quietEnd'] as const) if (patch[key] !== undefined) parseHHMM(patch[key]!);
    if (patch.mode !== undefined && !['adaptive', 'fixed'].includes(patch.mode)) throw new Error('mode must be adaptive or fixed');
    if (patch.autoAccept !== undefined && !['none', 'low-risk'].includes(patch.autoAccept)) throw new Error('autoAccept must be none or low-risk');
    return this.store.setConfig(patch);
  }
  pause(): Promise<AdaptiveConfig> { return this.store.setConfig({ paused: true }); }
  resume(): Promise<AdaptiveConfig> { return this.store.setConfig({ paused: false }); }
  tick(now?: Date, options?: { signal?: AbortSignal; instance?: string }) { return this.scheduler.tick(now, options); }
  /** Long-running loop: the same bounded tick (daily cycle + opt-in micro trigger) on an interval, until aborted. */
  worker(options: WorkerOptions = {}): Promise<WorkerSummary> { return runWorker(this.scheduler, new MicroTrigger(this.vault, this.provider, this.store), this.store, options); }
  microTick(now = new Date(), signal?: AbortSignal): Promise<string> { return new MicroTrigger(this.vault, this.provider, this.store).tick(now, signal); }
  events(limit?: number) { return this.store.events(limit); }
  serviceDefinition(kind: 'launchd' | 'systemd', params: Parameters<typeof serviceDefinition>[1]) { return serviceDefinition(kind, params); }
  /** Manual or scheduled run of the daily DAG against an explicitly sealed snapshot. Manual runs are idempotent per idempotencyKey. */
  runCycle(options: RunOptions): Promise<RunResult> { return this.runner.run(options); }
  resumeCycle(id: string, options: Omit<RunOptions, 'kind' | 'cycleId'> = {}): Promise<RunResult> { return this.runner.run({ ...options, kind: id.startsWith('manual-') ? 'manual' : 'scheduled', cycleId: id }); }
  cycles(): Promise<Cycle[]> { return this.store.cycles(); }
  cycle(id: string): Promise<Cycle | undefined> { return this.store.cycle(id); }

  async dailyList(workspaceId: string, range: { from?: string; to?: string } = {}): Promise<Array<{ id: string; date: string; status: string; cycleId: string; revisionId: string; from: number; to: number }>> {
    const docs = await loadDocuments(this.vault, await readableEntries(this.vault, { kinds: ['workspace_daily_summary'], scope: { type: 'workspace', workspaceId } }));
    return docs.filter(d => d.status !== 'deleted' && (!range.from || String(d.metadata.local_date) >= range.from) && (!range.to || String(d.metadata.local_date) <= range.to))
      .map(d => ({ id: d.id, date: String(d.metadata.local_date), status: String(d.metadata.status), cycleId: String(d.metadata.cycle_id), revisionId: d.revisionId, from: Number(d.metadata.from_committed_sequence_exclusive), to: Number(d.metadata.to_committed_sequence_inclusive) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.from - b.from);
  }
  async dailyShow(workspaceId: string, date: string): Promise<Array<{ markdown: string; metadata: Record<string, unknown>; revisionId: string; uri: string }>> {
    const docs = await loadDocuments(this.vault, await readableEntries(this.vault, { kinds: ['workspace_daily_summary'], scope: { type: 'workspace', workspaceId } }));
    return docs.filter(d => d.status !== 'deleted' && d.metadata.local_date === date).sort((a, b) => Number(a.metadata.from_committed_sequence_exclusive) - Number(b.metadata.from_committed_sequence_exclusive)).map(d => ({ markdown: d.body, metadata: d.metadata, revisionId: d.revisionId, uri: d.uri }));
  }
  /** Summarized history since a local date, plus how many committed journal records in this workspace are not yet summarized. */
  async changesSince(workspaceId: string, date: string): Promise<{ summaries: Awaited<ReturnType<AdaptiveIntelligence['dailyList']>>; unsummarizedEvents: number }> {
    const cursor = (await this.store.cursors()).workspaces[workspaceId] ?? 0;
    const pending = (await this.vault.eventsSince(cursor)).filter(e => e.scope.type === 'workspace' && e.scope.workspaceId === workspaceId && !isBackgroundEvent(e) && e.operation !== 'purge').length;
    return { summaries: await this.dailyList(workspaceId, { from: date }), unsummarizedEvents: pending };
  }
}
