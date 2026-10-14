import { randomUUID } from 'node:crypto';
import type { ModelProvider } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { IntelligenceEngine } from '../intelligence/index.js';
import { manifestFor } from '../search-files/manifest.js';
import { isBackgroundEvent } from './activity.js';
import { localParts } from './clock.js';
import type { AdaptiveStore } from './state.js';
import type { AdaptiveScheduler } from './scheduler.js';

export interface WorkerOptions {
  intervalMs?: number; signal?: AbortSignal; instance?: string;
  /** Injectable for tests; production uses wall-clock time and real timers. */
  now?: () => Date; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; maxTicks?: number;
  onTick?: (summary: WorkerTick) => void;
}
export interface WorkerTick { at: string; daily: string; micro: string; error?: string }
export interface WorkerSummary { ticks: number; errors: number; started: number; stopped: 'aborted' | 'max-ticks' }

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => { if (signal?.aborted) return resolve(); const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms); const onAbort = () => { clearTimeout(timer); resolve(); }; signal?.addEventListener('abort', onAbort, { once: true }); });

/**
 * Debounced micro-Dream: after accepted source / insight / wiki changes go quiet, run ONE bounded micro job over that journal range.
 * Opt-in (config.micro.enabled). Discoveries and the pipeline's own commits never trigger it, so it cannot recurse; a running daily cycle has priority.
 */
export class MicroTrigger {
  constructor(private readonly vault: Vault, private readonly provider: ModelProvider | undefined, private readonly store: AdaptiveStore) {}
  async tick(now: Date, signal?: AbortSignal): Promise<string> {
    const config = await this.store.config(); if (!config.micro.enabled || config.paused) return 'disabled';
    const cursors = await this.store.cursors(); const head = (await this.vault.eventsSince(0)).at(-1)?.sequence ?? 0;
    if (cursors.micro === undefined) { await this.store.advanceCursors(c => { c.micro = head; }); return 'initialized'; } // never backfill history on enable
    const pending = (await this.vault.eventsSince(cursors.micro)).filter(e => !isBackgroundEvent(e) && e.operation !== 'purge');
    if (!pending.length) return 'idle';
    const lastAt = Math.max(...pending.map(e => Date.parse(e.timestamp) || 0)); const waitMs = config.micro.debounceMinutes * 60_000 - (now.getTime() - lastAt);
    if (waitMs > 0) return `debouncing ${Math.ceil(waitMs / 60000)} min`;
    const manifest = await manifestFor(this.vault); await manifest.sync();
    const relevant = pending.filter(e => { const entry = manifest.entries.get(e.objectId); return entry && config.micro.kinds.includes(entry.kind) && entry.status !== 'deleted' && entry.status !== 'tombstone'; });
    const to = pending.at(-1)!.sequence, from = cursors.micro;
    if (!relevant.length) { await this.store.advanceCursors(c => { c.micro = to; }); return 'no relevant change'; }
    // every event of this tick carries the tick's own clock: the daily cap below compares these timestamps with `now`, so both must come from the same clock (they only differ when `now` is injected)
    const ids = { scheduleId: 'micro', trigger: 'micro' as const, fromSequence: from, toSequence: to, at: now.toISOString() };
    const today = localParts(now, config.timezone).date;
    const ranToday = (await this.store.events(500)).filter(e => e.type === 'dream_started' && e.trigger === 'micro' && localParts(new Date(e.at), config.timezone).date === today).length;
    const skip = async (reason: string): Promise<string> => { const last = (await this.store.events(1))[0]; if (!(last?.type === 'dream_skipped' && last.reason === reason && last.trigger === 'micro')) await this.store.appendEvent({ type: 'dream_skipped', reason, ...ids }); return reason; };
    if (ranToday >= config.micro.maxPerDay) return skip('DAILY_CAP');
    if (!this.provider) return skip('MODEL_UNAVAILABLE');
    const lease = await this.store.lease(); if (lease && Date.parse(lease.expiresAt) > now.getTime()) return skip('DAILY_CYCLE_RUNNING');
    const engine = new IntelligenceEngine(this.vault, this.provider); const runId = randomUUID(); const startedAt = Date.now();
    const job = await engine.enqueue('dream', { mode: 'micro', trigger: 'micro', range: [from, to] }); // identical range => the same job, never a second one
    await this.store.appendEvent({ type: 'dream_scheduled', runId, ...ids }); await this.store.appendEvent({ type: 'dream_claimed', runId, ...ids }); await this.store.appendEvent({ type: 'dream_started', runId, ...ids });
    await engine.run({ jobId: job.id, limit: 1, ...(signal ? { signal } : {}) });
    const after = (await engine.jobs()).find(j => j.id === job.id); const durationMs = Date.now() - startedAt;
    // The outcome event is written BEFORE the cursor moves: a crash between the two replays the (idempotent) range and logs the completion again, never loses it.
    if (after?.status === 'complete') { await this.store.appendEvent({ type: 'dream_completed', runId, ...ids, durationMs, attempts: after.attempts, state: 'complete' }); await this.store.advanceCursors(c => { c.micro = to; }); return 'completed'; }
    if (after?.status === 'dead_letter') { await this.store.appendEvent({ type: 'dream_dead_letter', runId, ...ids, durationMs, attempts: after.attempts, ...(after.error ? { reason: 'JOB_FAILED' } : {}) }); await this.store.advanceCursors(c => { c.micro = to; }); return 'dead-lettered'; }
    await this.store.appendEvent({ type: 'dream_retry', runId, ...ids, durationMs, attempts: after?.attempts ?? 0, state: after?.status ?? 'unknown', reason: after?.status === 'blocked' ? 'MODEL_UNAVAILABLE' : 'JOB_NOT_COMPLETE' });
    return `retry (${after?.status ?? 'unknown'})`;
  }
}

/**
 * Long-running service loop over the same bounded `tick` that cron/launchd/systemd would call. Stateless between iterations (every decision reads durable
 * state), so a restart, a second worker or a crash never double-runs a cycle: the vault lease and the once-per-local-date rule decide.
 */
export async function runWorker(scheduler: AdaptiveScheduler, micro: MicroTrigger, store: AdaptiveStore, options: WorkerOptions = {}): Promise<WorkerSummary> {
  const now = options.now ?? (() => new Date()); const sleep = options.sleep ?? realSleep; const instance = options.instance ?? store.newInstance();
  const base = Math.max(1000, options.intervalMs ?? 300_000); const summary: WorkerSummary = { ticks: 0, errors: 0, started: 0, stopped: 'aborted' }; let backoff = 0;
  while (!options.signal?.aborted) {
    const at = now(); const tick: WorkerTick = { at: at.toISOString(), daily: 'skipped', micro: 'skipped' };
    try {
      const result = await scheduler.tick(at, { ...(options.signal ? { signal: options.signal } : {}), instance }); tick.daily = result.run?.ran ? `ran ${result.run.cycle?.state ?? ''}`.trim() : `${result.decision.action}: ${result.decision.reason}`; if (result.run?.ran) summary.started++;
      tick.micro = await micro.tick(at, options.signal); backoff = 0;
    } catch (error) { summary.errors++; tick.error = (error as Error).message.slice(0, 200); backoff = Math.min(backoff ? backoff * 2 : base, 30 * 60_000); }
    summary.ticks++; options.onTick?.(tick);
    if (options.maxTicks !== undefined && summary.ticks >= options.maxTicks) { summary.stopped = 'max-ticks'; break; }
    const jitter = 1 + (Math.random() - 0.5) * 0.2; await sleep(Math.round((backoff || base) * jitter), options.signal);
  }
  return summary;
}

/** Unit/plist text for the user to install explicitly. Nothing here registers a service. */
export function serviceDefinition(kind: 'launchd' | 'systemd', params: { node: string; script: string; root: string; intervalSeconds: number; /** launchd label (default dev.engram.intelligence-worker) */ label?: string; /** launchd stdout/stderr file (default: none; keep it OUTSIDE the vault) */ logPath?: string }): { filename: string; install: string; content: string } {
  const args = [params.node, params.script, '--root', params.root, 'intelligence', 'schedule', 'worker', '--interval-s', String(params.intervalSeconds)];
  if (kind === 'launchd') {
    const label = params.label ?? 'dev.engram.intelligence-worker'; if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('launchd label may only contain letters, digits, dot, underscore and dash'); const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { filename: `${label}.plist`, install: `cp ${label}.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/${label}.plist   # remove: launchctl unload ~/Library/LaunchAgents/${label}.plist && rm ~/Library/LaunchAgents/${label}.plist`,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n${params.logPath ? `  <key>StandardOutPath</key><string>${xml(params.logPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(params.logPath)}</string>\n` : ''}  <key>LowPriorityIO</key><true/>\n  <key>Nice</key><integer>10</integer>\n</dict></plist>\n` };
  }
  const quote = (v: string) => /[\s"'\\$]/.test(v) ? `"${v.replace(/(["\\$])/g, '\\$1')}"` : v;
  return { filename: 'engram-intelligence-worker.service', install: 'mkdir -p ~/.config/systemd/user && cp engram-intelligence-worker.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now engram-intelligence-worker   # remove: systemctl --user disable --now engram-intelligence-worker',
    content: `[Unit]\nDescription=Engram background intelligence worker (opt-in daily Dream and learning)\n\n[Service]\nType=simple\nExecStart=${args.map(quote).join(' ')}\nRestart=on-failure\nRestartSec=60\nNice=10\nIOSchedulingClass=idle\n\n[Install]\nWantedBy=default.target\n` };
}
