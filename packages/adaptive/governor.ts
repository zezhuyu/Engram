import os from 'node:os';
import type { Vault } from '../core/vault.js';
import { lastForegroundAt } from './activity.js';
import type { AdaptiveConfig } from './types.js';

export type Pressure = { ok: true } | { ok: false; reason: 'FOREGROUND_ACTIVITY' | 'RESOURCE_PRESSURE'; detail: string };
/**
 * Cooperative resource governor. Background work asks it at checkpoints (before retrieval batches, model calls and commits) and, while a model call is in flight,
 * a poll aborts the call as soon as foreground activity or resource pressure appears. It never kills anything itself.
 */
export class Governor {
  constructor(private readonly vault: Vault, private readonly config: AdaptiveConfig, private readonly options: { respectActivity: boolean; segmentStart: number; ownRanges: () => Array<[number, number]>; load?: () => number; rss?: () => number }) {}
  async check(): Promise<Pressure> {
    const load = (this.options.load ?? (() => os.loadavg()[0] ?? 0))(); if (load > this.config.resources.maxLoadAverage) return { ok: false, reason: 'RESOURCE_PRESSURE', detail: `load average ${load.toFixed(2)} > ${this.config.resources.maxLoadAverage}` };
    const rss = (this.options.rss ?? (() => process.memoryUsage().rss / 2 ** 20))(); if (rss > this.config.resources.maxRssMiB) return { ok: false, reason: 'RESOURCE_PRESSURE', detail: `rss ${rss.toFixed(0)} MiB > ${this.config.resources.maxRssMiB}` };
    if (this.options.respectActivity) { const at = await lastForegroundAt(this.vault, this.options.ownRanges()); if (at > this.options.segmentStart) return { ok: false, reason: 'FOREGROUND_ACTIVITY', detail: `foreground activity at ${new Date(at).toISOString()}` }; }
    return { ok: true };
  }
  /** Aborts `controller` when the governor says stop. Returns a stop function. */
  watch(controller: AbortController, onPressure: (p: Extract<Pressure, { ok: false }>) => void): () => void {
    let running = false; const timer = setInterval(async () => { if (running || controller.signal.aborted) return; running = true; try { const p = await this.check(); if (!p.ok) { onPressure(p); controller.abort(); } } catch { /* a failed probe never aborts work */ } finally { running = false; } }, this.config.resources.activityPollMs); timer.unref();
    return () => clearInterval(timer);
  }
}
