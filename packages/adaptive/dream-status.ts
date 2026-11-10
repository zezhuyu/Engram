import { promises as fs } from 'node:fs';
import path from 'node:path';
import { estimateWindow, idleMinutes, lastForegroundAt } from './activity.js';
import { Governor } from './governor.js';
import { localParts, parseHHMM } from './clock.js';
import { decideFromSnapshot } from './scheduler.js';
import { redactText } from '../memory/redact.js';
import type { AdaptiveStore } from './state.js';
import type { AdaptiveConfig, Cycle, Telemetry } from './types.js';
import type { Vault } from '../core/vault.js';

export interface DreamWorkerState { loaded: boolean; running: boolean; pid: number | null }
export interface DreamRunStatus {
  lastRun: null | { id: string; kind: string; startedAt: string; finishedAt: string | null; timezone: string; durationMs: number | null; status: string; provider: string | null; documentsConsidered: number; proposalsCreated: number; insightsAccepted: number; failureReason: string | null };
  currentRun: null | { id: string; state: string; startedAt: string; timezone: string };
  runs: Array<{ id: string; kind: string; startedAt: string; finishedAt: string | null; timezone: string; durationMs: number | null; status: string }>;
  nextRun: { time: string; timezone: string; trigger: 'fixed time' | 'adaptive time' | 'waiting for idle window' | 'waiting for quiet window'; whyLater: string | null } | { time: null; timezone: string; trigger: null; whyLater: string };
  scheduler: { enabled: boolean; configured: boolean; worker: DreamWorkerState; summary: string };
}

export const DREAM_PREVIEW_HORIZON_MINUTES = 8 * 24 * 60;

/** Return the first minute at which the worker's pure policy permits a scheduled cycle.
 * The preview assumes the machine is idle from `now` onward; it cannot predict future
 * resource pressure, so callers should gate on a current governor failure separately.
 */
export function previewNextDreamRun(input: { config: AdaptiveConfig; telemetry: Telemetry; cycles: Cycle[]; lease?: { expiresAt: string }; now: Date; idleMinutes: number; resourcesAvailable?: boolean; resourceReason?: string }): DreamRunStatus['nextRun'] {
  const { config, telemetry, cycles, now } = input;
  let due: Date | undefined;
  let blockingReason = '';
  let dueReason = '';
  for (let minute = 0; minute <= DREAM_PREVIEW_HORIZON_MINUTES; minute++) {
    const candidate = new Date(now.getTime() + minute * 60_000);
    const decision = decideFromSnapshot({ config, telemetry, cycles, ...(input.lease ? { lease: input.lease } : {}), now: candidate,
      idle: input.idleMinutes + minute, ...(input.resourcesAvailable !== undefined ? { resourcesAvailable: input.resourcesAvailable } : {}), ...(input.resourceReason ? { resourceReason: input.resourceReason } : {}) });
    if (decision.action === 'start' || decision.action === 'resume') { due = candidate; dueReason = decision.reason; break; }
    blockingReason = decision.reason;
    if (decision.reason === 'DISABLED' || decision.reason === 'PAUSED') break;
  }
  if (!due) {
    const reason = blockingReason.includes('quiet window') ? 'Waiting for the quiet window; no eligible time is predictable within eight days'
      : blockingReason.includes('inactivity') ? 'Waiting for inactivity; no eligible time is predictable within eight days'
        : blockingReason.includes('resource') ? 'Resource pressure currently prevents a reliable next-run estimate'
          : 'No eligible run time is predictable within eight days';
    return { time: null, timezone: config.timezone, trigger: null, whyLater: reason };
  }
  const dueIsNow = due.getTime() === now.getTime();
  const localMinute = localParts(due, config.timezone).minutes;
  const estimate = estimateWindow(telemetry, config, due);
  const catchUp = dueReason === 'catch-up cycle after downtime';
  const trigger: 'fixed time' | 'adaptive time' | 'waiting for idle window' | 'waiting for quiet window' =
    blockingReason.includes('inactivity') ? 'waiting for idle window'
      : catchUp ? 'fixed time'
        : dueReason.startsWith('resume ') ? (config.mode === 'fixed' ? 'fixed time' : 'adaptive time')
          : blockingReason.includes('quiet window') && localMinute !== parseHHMM(estimate.startLocal) ? 'waiting for quiet window'
            : config.mode === 'fixed' ? 'fixed time' : 'adaptive time';
  const whyLater = dueIsNow ? null : blockingReason.includes('inactivity') ? `Waiting for ${config.inactivityMinutes} minutes of inactivity${catchUp ? '; catch-up still waits for its next eligible quiet-window time' : ''}`
    : catchUp ? 'Catch-up after downtime waits for its next eligible quiet-window time'
      : blockingReason.includes('quiet window') ? `Waiting for the quiet window (${estimate.startLocal} ${config.timezone})`
        : null;
  return { time: due.toISOString(), timezone: config.timezone, trigger, whyLater };
}

const terminal = new Set(['COMPLETED', 'FAILED', 'INVALIDATED']);
const inProgress = new Set(['SNAPSHOTTING', 'WORKSPACES_RUNNING', 'GLOBAL_PROFILE_RUNNING', 'DREAM_RUNNING', 'COMMITTING']);
function started(c: Cycle): string { return c.stateHistory.find(entry => !['WAITING', 'ELIGIBLE'].includes(entry.state))?.at ?? c.createdAt; }
function finished(c: Cycle): string | null { return c.completedAt ?? (!inProgress.has(c.state) ? c.stateHistory.at(-1)?.at ?? c.updatedAt : null); }
function statusOf(c: Cycle): string {
  if (c.state === 'COMPLETED') return c.dream.skipped ? 'skipped' : 'completed';
  if (c.state === 'FAILED' || c.dream.status === 'FAILED') return 'failed';
  if (c.state === 'INVALIDATED') return 'interrupted';
  if (terminal.has(c.state)) return 'failed';
  return 'interrupted';
}
function safeFailure(c: Cycle): string | null {
  const value = c.dream.error?.message ?? c.error?.message;
  return value ? redactText(value).replace(/(?:\/[^\s:]+){2,}/g, '[path]').replace(/[\r\n\t]+/g, ' ').slice(0, 240) : null;
}
function runView(c: Cycle) {
  const start = started(c), end = finished(c);
  return { id: c.id, kind: c.kind, startedAt: start, finishedAt: end, timezone: c.timezone, durationMs: end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null, status: statusOf(c) };
}

/** Read-only schedule preview that searches the same pure decision function used by AdaptiveScheduler.decide. */
export async function readDreamRunStatus(input: { vault: Vault; store: AdaptiveStore; worker: DreamWorkerState; now?: Date }): Promise<DreamRunStatus> {
  const now = input.now ?? new Date();
  const [config, telemetry, cycles, lease, configFile] = await Promise.all([
    input.store.config(), input.store.telemetry(), input.store.cycles(), input.store.lease(),
    fs.stat(path.join(input.vault.root, '.mdb/adaptive/config.json')).catch(() => undefined),
  ]);
  const lastActivity = await lastForegroundAt(input.vault, cycles[0]?.ownSequenceRanges ?? []);
  const active = cycles.find(c => inProgress.has(c.state));
  const ordered = [...cycles].sort((a, b) => Date.parse(started(b)) - Date.parse(started(a)));
  const previous = ordered.find(c => !inProgress.has(c.state));
  const lastRun = previous ? { ...runView(previous), provider: previous.modelProvider ?? null, documentsConsidered: previous.liveObjects,
    proposalsCreated: previous.dream.proposals.length, insightsAccepted: previous.global.accepted.length + Object.values(previous.workspaces).reduce((sum, record) => sum + record.accepted.length, 0), failureReason: safeFailure(previous) } : null;
  const currentRun = active ? { id: active.id, state: active.state, startedAt: started(active), timezone: active.timezone } : null;
  const worker = input.worker;
  const configured = !!configFile;
  let nextRun: DreamRunStatus['nextRun'];
  const none = (whyLater: string): DreamRunStatus['nextRun'] => ({ time: null, timezone: config.timezone, trigger: null, whyLater });
  if (!configured) nextRun = none('No schedule configured');
  else if (!config.enabled || config.paused) nextRun = none('Dream scheduling is off (enable in Settings)');
  else if (!worker.running) nextRun = none('Worker not running');
  else if (active) nextRun = none('A Dream cycle is already running');
  else {
    const resources = await new Governor(input.vault, config, { respectActivity: false, segmentStart: 0, ownRanges: () => [] }).check();
    if (!resources.ok) {
      nextRun = none('Resource pressure currently prevents a reliable next-run estimate');
      return { lastRun, currentRun, runs: ordered.slice(0, 5).map(c => ({ ...runView(c) })), nextRun, scheduler: { enabled: config.enabled && !config.paused, configured, worker, summary: worker.running ? 'Running' : worker.loaded ? 'Loaded, not running' : 'Not running' } };
    }
    const idle = idleMinutes(lastActivity, now);
    nextRun = previewNextDreamRun({ config, telemetry, cycles, ...(lease ? { lease } : {}), now, idleMinutes: idle, resourcesAvailable: true });
  }
  return { lastRun, currentRun, runs: ordered.slice(0, 5).map(c => ({ ...runView(c) })), nextRun,
    scheduler: { enabled: config.enabled && !config.paused, configured, worker, summary: !config.enabled || config.paused ? 'Disabled' : worker.running ? 'Running' : worker.loaded ? 'Loaded, not running' : 'Not running' } };
}
