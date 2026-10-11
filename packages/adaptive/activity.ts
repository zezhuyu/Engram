import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommitEvent } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { atomicWrite, safePath } from '../storage-local/index.js';
import { addDays, formatHHMM, inWindow, localParts, parseHHMM } from './clock.js';
import type { AdaptiveStore } from './state.js';
import type { AdaptiveConfig, DayTelemetry, Telemetry } from './types.js';

const ACTIVITY = '.mdb/adaptive/activity.json';
/** Journal records written by the background pipeline itself (idempotency keys with these prefixes; `rejected:` marks the rejected-hypothesis records Dream itself commits, which must never cancel the run that wrote them) are never user activity. */
export const isBackgroundEvent = (e: Pick<CommitEvent, 'idempotencyKey'>): boolean => !!e.idempotencyKey && (e.idempotencyKey.startsWith('adaptive:') || e.idempotencyKey.startsWith('proposal:') || e.idempotencyKey.startsWith('rejected:'));
const inRanges = (sequence: number, ranges: Array<[number, number]>): boolean => ranges.some(([a, b]) => sequence >= a && sequence <= b);

/**
 * Foreground activity marker. It lives OUTSIDE the vault (a vault is never modified by being used): `$ENGRAM_STATE_DIR`, else `$XDG_STATE_HOME/engram`, else `~/.local/state/engram`,
 * in `activity/<sha256 of the vault's real path>.json`. It is written only for vaults that have an enabled schedule (the marker exists so the nightly Dream waits while someone works)
 * and only by commands that are not read-only; the CLI never calls it for search, grep, get, list, context or query. Best effort and throttled; it can never fail the caller.
 */
const stateDir = (): string => process.env.ENGRAM_STATE_DIR ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'engram');
async function activityFile(root: string): Promise<string> { const real = await fs.realpath(root).catch(() => path.resolve(root)); return path.join(stateDir(), 'activity', `${createHash('sha256').update(real).digest('hex').slice(0, 32)}.json`); }
async function scheduleEnabled(root: string): Promise<boolean> { try { return (JSON.parse(await fs.readFile(await safePath(root, '.mdb/adaptive/config.json'), 'utf8')) as { enabled?: boolean }).enabled === true; } catch { return false; } }
export async function touchActivity(root: string, now = new Date()): Promise<void> {
  try {
    if (!(await scheduleEnabled(root))) return;
    const file = await activityFile(root); const stat = await fs.stat(file).catch(() => undefined); if (stat && now.getTime() - stat.mtimeMs < 2000) return;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; await fs.writeFile(temporary, JSON.stringify({ at: now.toISOString() }), { mode: 0o600 }); await fs.rename(temporary, file);
  } catch { /* activity tracking is advisory */ }
}
async function touched(root: string): Promise<number> {
  const read = async (file: string): Promise<number> => { try { return Date.parse((JSON.parse(await fs.readFile(file, 'utf8')) as { at: string }).at) || 0; } catch { return 0; } };
  return Math.max(await read(await activityFile(root)), await read(await safePath(root, ACTIVITY).catch(() => '')).catch(() => 0)); // the legacy in-vault marker written by older versions is still honored
}
/** Most recent foreground activity: an explicit touch or a non-background journal commit, ignoring sequence ranges the running cycle committed itself. */
export async function lastForegroundAt(vault: Vault, ownRanges: Array<[number, number]> = []): Promise<number> {
  let latest = await touched(vault.root); const events = await vault.events();
  for (let i = events.length - 1; i >= 0 && i > events.length - 400; i--) { const e = events[i]!; if (isBackgroundEvent(e) || inRanges(e.sequence, ownRanges)) continue; latest = Math.max(latest, Date.parse(e.timestamp) || 0); break; }
  return latest;
}
export const idleMinutes = (lastForeground: number, now: Date): number => lastForeground ? Math.max(0, (now.getTime() - lastForeground) / 60000) : Number.POSITIVE_INFINITY;

const emptyDay = (): DayTelemetry => ({ events: Array<number>(24).fill(0), covered: Array<boolean>(24).fill(false) });
/**
 * Records activity metadata only (counts of journal commits per local hour, plus which hours the scheduler was actually running). No content is read.
 * An hour with zero commits is only evidence of inactivity if it is marked covered: hours when the scheduler was not running are unknown, not quiet.
 */
export async function observe(vault: Vault, store: AdaptiveStore, config: AdaptiveConfig, now: Date): Promise<Telemetry> {
  const t = await store.telemetry();
  for (const e of await vault.eventsSince(t.lastEventSequence)) {
    if (e.sequence <= t.lastEventSequence) continue; t.lastEventSequence = e.sequence; if (isBackgroundEvent(e)) continue;
    const lp = localParts(new Date(e.timestamp), config.timezone); (t.days[lp.date] ??= emptyDay()).events[lp.hour]! += 1;
  }
  const lp = localParts(now, config.timezone); const today = (t.days[lp.date] ??= emptyDay());
  const previous = t.lastTickAt ? new Date(t.lastTickAt) : undefined;
  if (previous && now.getTime() - previous.getTime() <= 90 * 60000 && now > previous) { // continuous coverage: every hour spanned since the last tick
    for (let at = previous.getTime(); at <= now.getTime(); at += 30 * 60000) { const p = localParts(new Date(at), config.timezone); (t.days[p.date] ??= emptyDay()).covered[p.hour] = true; }
  }
  today.covered[lp.hour] = true; t.lastTickAt = now.toISOString();
  const cutoff = addDays(lp.date, -config.telemetryRetentionDays); for (const d of Object.keys(t.days)) if (d < cutoff) delete t.days[d];
  await store.saveTelemetry(t); return t;
}

export interface WindowEstimate { startLocal: string; mode: 'FIXED' | 'DEFAULT' | 'ADAPTIVE'; confidence: number; reliableDays: number; reason: string; learned?: { startLocal: string; changedOn: string; score: number } }
const RELIABLE_HOURS = 18;
/** Conservative quiet-window learning: needs minHistoryDays reliable days, uses a rolling window, moves at most one hour at a time, and requires a clear improvement. */
export function estimateWindow(t: Telemetry, config: AdaptiveConfig, now: Date): WindowEstimate {
  const target = config.targetLocalTime; const today = localParts(now, config.timezone).date;
  if (config.mode === 'fixed') return { startLocal: target, mode: 'FIXED', confidence: 1, reliableDays: 0, reason: 'manual fixed schedule' };
  const dates = Array.from({ length: config.historyWindowDays }, (_, i) => addDays(today, -(i + 1)));
  const reliable = dates.filter(d => (t.days[d]?.covered.filter(Boolean).length ?? 0) >= RELIABLE_HOURS);
  const confidence = Math.min(1, reliable.length / config.historyWindowDays);
  if (reliable.length < config.minHistoryDays) return { startLocal: target, mode: 'DEFAULT', confidence, reliableDays: reliable.length, reason: `INSUFFICIENT_TELEMETRY: ${reliable.length}/${config.minHistoryDays} reliable days` };
  const mean = Array<number>(24).fill(0), samples = Array<number>(24).fill(0);
  for (const d of reliable) for (let h = 0; h < 24; h++) if (t.days[d]!.covered[h]) { mean[h]! += t.days[d]!.events[h]!; samples[h]! += 1; }
  const hourly = mean.map((v, h) => samples[h]! ? v / samples[h]! : Number.POSITIVE_INFINITY);
  const qs = Math.floor(parseHHMM(config.quietStart) / 60), qe = parseHHMM(config.quietEnd) / 60; const span = Math.max(1, Math.round(config.expectedDurationHours));
  const hours: number[] = []; for (let h = qs; (h % 24) !== qe % 24 || hours.length === 0; h++) { hours.push(h % 24); if (hours.length >= 24) break; }
  const score = (start: number) => { let s = 0; for (let i = 0; i < span; i++) { const h = (start + i) % 24; if (!hours.includes(h)) return Number.POSITIVE_INFINITY; s += hourly[h]!; } return s / span; };
  const candidates = hours.map(h => ({ h, s: score(h) })).filter(c => Number.isFinite(c.s)).sort((a, b) => a.s - b.s || a.h - b.h);
  if (!candidates.length) return { startLocal: target, mode: 'DEFAULT', confidence, reliableDays: reliable.length, reason: 'no eligible quiet window with sufficient samples' };
  const current = t.learned ? Math.floor(parseHHMM(t.learned.startLocal) / 60) : Math.floor(parseHHMM(target) / 60); const currentScore = score(current); const best = candidates[0]!;
  const daysSinceChange = t.learned ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.learned.changedOn}T00:00:00Z`)) / 86400000 : Number.POSITIVE_INFINITY;
  let start = current, learned = t.learned;
  if (best.h !== current && (!Number.isFinite(currentScore) || best.s < currentScore * 0.75) && daysSinceChange >= 7) { start = (current + (((best.h - current + 24) % 24) <= 12 ? 1 : 23)) % 24; learned = { startLocal: formatHHMM(start * 60), changedOn: today, score: best.s }; }
  else if (!t.learned) learned = { startLocal: formatHHMM(current * 60), changedOn: today, score: Number.isFinite(currentScore) ? currentScore : best.s };
  return { startLocal: formatHHMM(start * 60), mode: 'ADAPTIVE', confidence, reliableDays: reliable.length, reason: start === current ? 'kept current window (hysteresis)' : 'moved one hour toward a quieter window', ...(learned ? { learned } : {}) };
}
export { inWindow };
