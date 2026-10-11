import type { ModelProvider } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { estimateWindow, idleMinutes, isBackgroundEvent, lastForegroundAt, observe, type WindowEstimate } from './activity.js';
import { CycleRunner, type RunResult } from './cycle.js';
import { inWindow, localParts, parseHHMM, addDays } from './clock.js';
import { Governor } from './governor.js';
import type { AdaptiveStore } from './state.js';
import type { Cycle, ScheduleEvent } from './types.js';
import { randomUUID } from 'node:crypto';

export type Decision = { action: 'start' | 'resume'; reason: string; cycleId: string } | { action: 'wait' | 'skip'; reason: string };
export interface ScheduleStatus {
  enabled: boolean; paused: boolean; timezone: string; localNow: string; scheduledLocalTime: string; windowMode: WindowEstimate['mode']; windowReason: string; confidence: number; reliableDays: number;
  quietWindow: string; idleMinutes: number | null; lastCycle?: { id: string; state: string; watermark: number; localDate: string; error?: string }; currentStage?: string; backlogEvents: number; blockedReason?: string;
  duplicateGuard: string;
  /** Local time the next scheduled cycle may start, or why none is due. */
  nextDue: string; lastStarted?: string; lastCompleted?: string; lastOutcome?: string; activeLease?: { owner: string; cycleId: string; expiresAt: string }; deadLetters: number; providerReady: boolean; microEnabled: boolean;
}
const NEEDS_RETRY_DELAY_MS = 30 * 60 * 1000;
/** Pauses for activity or resource pressure are expected on a busy machine; only genuine stage failures count toward quarantine. */
const isPoison = (c: Pick<Cycle, 'attempts' | 'error' | 'state'>, limit: number): boolean => c.state !== 'COMPLETED' && c.state !== 'INVALIDATED' && c.attempts >= limit && c.error?.category !== 'CANCELLED_FOR_ACTIVITY' && c.error?.category !== 'RESOURCE_PRESSURE';

/** Decides when the daily cycle may start. Pure policy over durable state: starting is delegated to CycleRunner, which enforces single-flight via a lease. */
export class AdaptiveScheduler {
  constructor(private readonly vault: Vault, private readonly provider: ModelProvider | undefined, private readonly store: AdaptiveStore) {}
  private runner() { return new CycleRunner(this.vault, this.provider, this.store); }

  async decide(now: Date): Promise<{ decision: Decision; estimate: WindowEstimate; idle: number }> {
    const config = await this.store.config(); const telemetry = await observe(this.vault, this.store, config, now); const estimate = estimateWindow(telemetry, config, now);
    if (estimate.learned && JSON.stringify(estimate.learned) !== JSON.stringify(telemetry.learned)) { telemetry.learned = estimate.learned; await this.store.saveTelemetry(telemetry); }
    const lp = localParts(now, config.timezone); const idle = idleMinutes(await lastForegroundAt(this.vault, (await this.store.cycles())[0]?.ownSequenceRanges ?? []), now);
    const base = { estimate, idle };
    if (!config.enabled) return { decision: { action: 'skip', reason: 'DISABLED' }, ...base };
    if (config.paused) return { decision: { action: 'skip', reason: 'PAUSED' }, ...base };
    const cycles = await this.store.cycles(); const id = `${lp.date}@${config.timezone}`;
    // Exactly once per local date: a completed or running cycle for this date wins, whatever the time zone label (covers DST fall-back and zone changes).
    const today = cycles.filter(c => c.localDate === lp.date && c.kind === 'scheduled' && c.state !== 'INVALIDATED');
    if (today.some(c => c.state === 'COMPLETED')) return { decision: { action: 'skip', reason: 'ALREADY_COMPLETED_FOR_LOCAL_DATE' }, ...base };
    const lease = await this.store.lease(); if (lease && Date.parse(lease.expiresAt) > now.getTime()) return { decision: { action: 'skip', reason: 'ANOTHER_INSTANCE_RUNNING' }, ...base };
    const start = parseHHMM(estimate.startLocal), qe = parseHHMM(config.quietEnd), qs = parseHHMM(config.quietStart);
    const lastDone = cycles.filter(c => c.kind === 'scheduled' && c.state === 'COMPLETED').map(c => c.localDate).sort().at(-1);
    const catchUp = lastDone !== undefined && lastDone < addDays(lp.date, -1); // at most one missed cycle is run: cycles cover everything after the cursors
    const inQuiet = inWindow(lp.minutes, qs, qe) && (qs <= qe ? lp.minutes >= start : lp.minutes >= start || lp.minutes < qe);
    if (!inQuiet && !catchUp) return { decision: { action: 'wait', reason: `outside the learned quiet window (${estimate.startLocal}-${config.quietEnd} ${config.timezone})` }, ...base };
    if (idle < config.inactivityMinutes) return { decision: { action: 'wait', reason: `foreground activity ${idle.toFixed(0)} min ago; ${config.inactivityMinutes} min of inactivity required` }, ...base };
    const gov = await new Governor(this.vault, config, { respectActivity: false, segmentStart: 0, ownRanges: () => [] }).check(); if (!gov.ok) return { decision: { action: 'wait', reason: gov.detail }, ...base };
    const open = today[0]; // incomplete cycle for today: resume the same snapshot
    if (open && isPoison(open, config.deadLetterAfterAttempts)) return { decision: { action: 'skip', reason: `DEAD_LETTER: ${open.attempts} failed attempts for ${open.localDate}; quarantined until the next local date (or run a manual cycle)` }, ...base };
    if (open) { if ((open.state === 'BLOCKED' || open.state === 'RETRY_WAIT') && now.getTime() - Date.parse(open.updatedAt) < NEEDS_RETRY_DELAY_MS) return { decision: { action: 'wait', reason: `${open.state}: retry after ${(NEEDS_RETRY_DELAY_MS / 60000).toFixed(0)} min` }, ...base }; return { decision: { action: 'resume', reason: `resume ${open.state}`, cycleId: open.id }, ...base }; }
    return { decision: { action: 'start', reason: catchUp ? 'catch-up cycle after downtime' : 'quiet window reached', cycleId: id }, ...base };
  }
  /** Logs a skip/wait once per distinct reason, so a worker polling every few minutes does not flood the log. */
  private async noteSkip(reason: string, extra: Partial<ScheduleEvent> = {}): Promise<void> {
    const last = (await this.store.events(1))[0]; if (last?.type === 'dream_skipped' && last.reason === reason) return;
    await this.store.appendEvent({ type: 'dream_skipped', reason, trigger: 'daily', ...extra });
  }
  async tick(now = new Date(), options: { signal?: AbortSignal; instance?: string } = {}): Promise<{ decision: Decision; run?: RunResult }> {
    const { decision } = await this.decide(now);
    if (decision.action !== 'start' && decision.action !== 'resume') { await this.noteSkip(decision.reason); return { decision }; }
    const config = await this.store.config(); const runId = randomUUID(); const instance = options.instance ?? this.store.newInstance();
    const ids = { runId, scheduleId: `daily@${config.timezone}`, cycleId: decision.cycleId, trigger: 'daily' as const, instance };
    await this.store.appendEvent({ type: 'dream_scheduled', ...ids, reason: decision.reason });
    const startedAt = new Date(); const run = await this.runner().run({ kind: 'scheduled', now, ...(options.signal ? { signal: options.signal } : {}), instance });
    if (!run.ran) { await this.noteSkip(run.reason === 'LEASE_HELD' ? 'ANOTHER_INSTANCE_RUNNING' : (run.reason ?? 'NOT_RUN'), { ...ids }); return { decision, run }; }
    const cycle = run.cycle; const watermark = cycle?.watermark;
    await this.store.appendEvent({ type: 'dream_claimed', at: startedAt.toISOString(), ...ids }); await this.store.appendEvent({ type: 'dream_started', at: startedAt.toISOString(), ...ids, ...(watermark !== undefined ? { watermark } : {}) });
    const durationMs = Date.now() - startedAt.getTime(); const attempts = cycle?.attempts ?? 0;
    if (cycle?.state === 'COMPLETED') await this.store.appendEvent({ type: 'dream_completed', ...ids, ...(watermark !== undefined ? { watermark } : {}), durationMs, attempts, state: cycle.state });
    else if (cycle?.state === 'INVALIDATED') await this.store.appendEvent({ type: 'dream_retry', ...ids, state: cycle.state, reason: 'POLICY_INVALIDATED', durationMs, attempts });
    else if (cycle && isPoison(cycle, config.deadLetterAfterAttempts)) await this.store.appendEvent({ type: 'dream_dead_letter', ...ids, state: cycle?.state ?? 'UNKNOWN', ...(cycle?.error ? { reason: cycle.error.category } : {}), durationMs, attempts });
    else await this.store.appendEvent({ type: 'dream_retry', ...ids, state: cycle?.state ?? 'UNKNOWN', ...(cycle?.error ? { reason: cycle.error.category } : {}), durationMs, attempts });
    return { decision, run };
  }
  async status(now = new Date()): Promise<ScheduleStatus> {
    const config = await this.store.config(); const telemetry = await this.store.telemetry(); const estimate = estimateWindow(telemetry, config, now); const lp = localParts(now, config.timezone);
    const cycles = await this.store.cycles(); const last = cycles[0]; const cursors = await this.store.cursors(); const floor = Math.min(cursors.global, ...Object.values(cursors.workspaces), cursors.global);
    const backlog = (await this.vault.eventsSince(cursors.global)).filter(e => !isBackgroundEvent(e)).length; void floor;
    const idle = idleMinutes(await lastForegroundAt(this.vault, last?.ownSequenceRanges ?? []), now);
    const events = await this.store.events(200); const lastOf = (type: ScheduleEvent['type']) => events.findLast(e => e.type === type)?.at; const lease = await this.store.lease();
    const doneToday = cycles.some(c => c.kind === 'scheduled' && c.localDate === lp.date && c.state === 'COMPLETED'); const startMinutes = parseHHMM(estimate.startLocal);
    const nextDue = !config.enabled ? 'disabled' : config.paused ? 'paused' : doneToday ? `${addDays(lp.date, 1)} ${estimate.startLocal} ${config.timezone}` : lp.minutes < startMinutes ? `${lp.date} ${estimate.startLocal} ${config.timezone}` : `now (eligible once the quiet window and ${config.inactivityMinutes} min of inactivity hold)`;
    const deadLetters = cycles.filter(c => isPoison(c, config.deadLetterAfterAttempts)).length;
    return { enabled: config.enabled, paused: config.paused, timezone: config.timezone, localNow: `${lp.date} ${String(Math.floor(lp.minutes / 60)).padStart(2, '0')}:${String(lp.minutes % 60).padStart(2, '0')}`, scheduledLocalTime: estimate.startLocal, windowMode: estimate.mode, windowReason: estimate.reason, confidence: +estimate.confidence.toFixed(3), reliableDays: estimate.reliableDays, quietWindow: `${config.quietStart}-${config.quietEnd}`, idleMinutes: Number.isFinite(idle) ? Math.round(idle) : null, ...(last ? { lastCycle: { id: last.id, state: last.state, watermark: last.watermark, localDate: last.localDate, ...(last.error ? { error: `${last.error.category}: ${last.error.message}` } : {}) }, currentStage: stageOf(last), ...(['BLOCKED', 'PAUSED'].includes(last.state) && last.error ? { blockedReason: `${last.error.category}: ${last.error.message}` } : {}) } : {}), backlogEvents: backlog, duplicateGuard: 'one scheduled cycle per local date (lease-protected)', nextDue, ...(lastOf('dream_started') ? { lastStarted: lastOf('dream_started')! } : {}), ...(lastOf('dream_completed') ? { lastCompleted: lastOf('dream_completed')! } : {}), ...(last ? { lastOutcome: last.state } : {}), ...(lease && Date.parse(lease.expiresAt) > now.getTime() ? { activeLease: { owner: lease.owner, cycleId: lease.cycleId, expiresAt: lease.expiresAt } } : {}), deadLetters, providerReady: !!this.provider, microEnabled: config.micro.enabled };
  }
}
export const stageOf = (c: Cycle): string => c.state === 'COMPLETED' ? 'COMPLETED' : c.state;
