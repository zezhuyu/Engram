import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { previewNextDreamRun, readDreamRunStatus } from '../../packages/adaptive/dream-status.js';
import { decideFromSnapshot } from '../../packages/adaptive/scheduler.js';
import type { AdaptiveConfig, Cycle, Telemetry } from '../../packages/adaptive/types.js';
import { world } from './helpers.js';

const at = (value: string) => new Date(value);
function cycle(state: string, localDate: string, createdAt: string, extra: Record<string, unknown> = {}): Cycle {
  return { id: 'cycle-' + state, kind: 'scheduled', localDate, timezone: 'UTC', state, stateHistory: [{ state: state as Cycle['state'], at: createdAt }], createdAt, updatedAt: createdAt,
    watermark: 0, manifestHash: 'hash', liveObjects: 12, policyVersion: 'p1', pipelineVersion: 'p1', permittedDerived: [], ownSequenceRanges: [], workspaces: {},
    global: { status: 'SUCCEEDED', extraction: 'NOT_NEEDED', evidenceIds: [], accepted: [], pendingReview: [], rejected: [], promotions: [], preservedConflicts: [], attempts: 0 },
    dream: { status: 'SUCCEEDED', proposals: [], attempts: 0 }, attempts: 0, budgets: { modelCallsUsed: 0, modelCallsMax: 2 }, metrics: { pauses: 0, resumes: 0, activityCancellations: 0, stageMs: {} }, ...extra } as Cycle;
}

test('Dream run status predicts fixed time from a read-only snapshot and derives previous-run details', async t => {
  const w = await world(t, { config: { enabled: true, timezone: 'UTC', mode: 'fixed', targetLocalTime: '03:00', quietStart: '00:00', quietEnd: '07:00' } });
  await w.ai.store.saveCycle(cycle('COMPLETED', '2027-01-15', '2027-01-15T03:00:00.000Z', { completedAt: '2027-01-15T03:20:00.000Z', modelProvider: 'scripted', error: { category: 'STAGE_FAILED', message: 'token=secret1234 at /Users/alice/private/file.txt\nretry', at: '2027-01-15T03:20:00.000Z' } }));
  const before = await fs.readFile(path.join(w.root, '.mdb/adaptive/telemetry.json'), 'utf8').catch(() => undefined);
  const result = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker: { loaded: true, running: true, pid: 123 }, now: at('2027-01-15T04:00:00.000Z') });
  assert.equal(result.lastRun?.status, 'completed'); assert.equal(result.lastRun?.provider, 'scripted'); assert.equal(result.lastRun?.documentsConsidered, 12); assert.equal(result.lastRun?.durationMs, 20 * 60_000); assert.doesNotMatch(result.lastRun?.failureReason ?? '', /secret1234|alice|\n/); assert.match(result.lastRun?.failureReason ?? '', /REDACTED/);
  assert.equal(result.nextRun.time, '2027-01-16T03:00:00.000Z'); assert.equal(result.nextRun.trigger, 'fixed time');
  assert.equal(await fs.readFile(path.join(w.root, '.mdb/adaptive/telemetry.json'), 'utf8').catch(() => undefined), before, 'dashboard preview does not write scheduler telemetry');
});

test('Dream status distinguishes absent and disabled schedules and a stopped worker', async t => {
  const w = await world(t);
  const file = path.join(w.root, '.mdb/adaptive/config.json');
  await fs.rm(file, { force: true });
  const missing = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker: { loaded: false, running: false, pid: null }, now: at('2027-01-15T01:00:00Z') });
  assert.equal(missing.nextRun.time, null); assert.match(missing.nextRun.whyLater, /No schedule configured/);
  await w.ai.configure({ enabled: false });
  const disabled = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker: { loaded: true, running: true, pid: 4 }, now: at('2027-01-15T01:00:00Z') });
  assert.equal(disabled.nextRun.time, null); assert.match(disabled.nextRun.whyLater, /scheduling is off/);
  await w.ai.configure({ enabled: true });
  const stopped = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker: { loaded: true, running: false, pid: null }, now: at('2027-01-15T01:00:00Z') });
  assert.equal(stopped.nextRun.time, null); assert.match(stopped.nextRun.whyLater, /Worker not running/);
});

test('next schedule respects quiet-window gates, completed-today guard, interrupted-cycle resume, and DST gap', async t => {
  const w = await world(t, { config: { enabled: true, timezone: 'UTC', mode: 'fixed', targetLocalTime: '02:00', quietStart: '23:00', quietEnd: '06:00' } });
  const worker = { loaded: true, running: true, pid: 1 };
  const quiet = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker, now: at('2027-01-15T12:00:00Z') });
  assert.equal(quiet.nextRun.time, '2027-01-15T23:00:00.000Z', 'the shared scheduler allows an overnight quiet window to begin at quietStart'); assert.match(quiet.nextRun.whyLater ?? '', /quiet window/);
  await w.ai.store.saveCycle(cycle('COMPLETED', '2027-01-15', '2027-01-15T02:00:00.000Z', { completedAt: '2027-01-15T02:10:00.000Z' }));
  const done = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker, now: at('2027-01-15T03:00:00Z') });
  assert.equal(done.nextRun.time, '2027-01-16T00:00:00.000Z', 'the shared overnight-window policy allows a run after midnight before the configured target');
  await fs.rm(path.join(w.root, '.mdb/adaptive/cycles/cycle-COMPLETED.json'), { force: true });
  await w.ai.store.saveCycle(cycle('RETRY_WAIT', '2027-01-15', '2027-01-15T02:00:00.000Z', { id: 'resume-me', updatedAt: '2027-01-15T02:15:00.000Z', stateHistory: [{ state: 'RETRY_WAIT', at: '2027-01-15T02:00:00.000Z' }] }));
  const interrupted = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker, now: at('2027-01-15T03:00:00Z') });
  assert.equal(interrupted.nextRun.time, '2027-01-15T03:00:00.000Z'); assert.equal(interrupted.nextRun.whyLater, null);
  await w.ai.configure({ timezone: 'America/New_York', targetLocalTime: '02:30', quietStart: '00:00', quietEnd: '07:00' });
  const dst = await readDreamRunStatus({ vault: w.vault, store: w.ai.store, worker, now: at('2027-03-14T06:00:00Z') });
  assert.equal(dst.nextRun.time, '2027-03-14T07:00:00.000Z', 'spring-forward missing 02:30 resolves at the first eligible instant, 03:00 local');
});

test('catch-up preview matches worker decisions for the real fixed New York schedule across DST and daily completion', async t => {
  const w = await world(t, { config: { enabled: true, timezone: 'America/New_York', mode: 'fixed', targetLocalTime: '03:30', quietStart: '01:00', quietEnd: '07:00', inactivityMinutes: 60, micro: { enabled: false } } });
  const config = await w.ai.store.config(), telemetry: Telemetry = await w.ai.store.telemetry();
  const lastRun = cycle('COMPLETED', '2026-03-06', '2026-03-06T08:20:00.000Z', { id: 'prior-completed', timezone: 'America/New_York' });
  const brute = (now: Date, cycles: Cycle[], idleMinutes: number): string | null => {
    for (let minute = 0; minute <= 8 * 24 * 60; minute++) {
      const candidate = new Date(now.getTime() + minute * 60_000);
      const decision = decideFromSnapshot({ config, telemetry, cycles, now: candidate, idle: idleMinutes + minute, resourcesAvailable: true });
      if (decision.action === 'start' || decision.action === 'resume') return candidate.toISOString();
    }
    return null;
  };
  const start = Date.parse('2026-03-07T05:00:00.000Z'); // midnight before the US spring-forward transition
  for (let offset = 0; offset <= 3 * 24 * 60; offset += 15) {
    const now = new Date(start + offset * 60_000), localDate = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    for (const completedToday of [false, true]) {
      const cycles = completedToday ? [cycle('COMPLETED', localDate, now.toISOString(), { id: `completed-${localDate}`, timezone: config.timezone }), lastRun] : [lastRun];
      const expected = brute(now, cycles, 60);
      const actual = previewNextDreamRun({ config, telemetry, cycles, now, idleMinutes: 60, resourcesAvailable: true });
      assert.equal(actual.time, expected, `${now.toISOString()} completedToday=${completedToday}`);
      assert.ok(actual.time === null || Date.parse(actual.time) >= now.getTime(), 'preview time must not precede now');
      if (actual.time) {
        const due = decideFromSnapshot({ config, telemetry, cycles, now: new Date(actual.time), idle: 60 + Math.round((Date.parse(actual.time) - now.getTime()) / 60_000), resourcesAvailable: true });
        assert.ok(due.action === 'start' || due.action === 'resume', 'preview instant must be accepted by the real decision function');
      }
    }
  }
  const probes: Array<[string, string, string]> = [
    ['Nov 9 20:41 NY missed-day case', '2026-11-10T01:41:00.000Z', '2026-11-10T08:30:00.000Z'],
    ['Nov 9 23:30 NY missed-day case', '2026-11-10T04:30:00.000Z', '2026-11-10T08:30:00.000Z'],
    ['Nov 10 00:30 NY catch-up', '2026-11-10T05:30:00.000Z', '2026-11-10T08:30:00.000Z'],
    ['Nov 10 02:00 NY catch-up', '2026-11-10T07:00:00.000Z', '2026-11-10T08:30:00.000Z'],
    ['Nov 10 03:45 NY catch-up', '2026-11-10T08:45:00.000Z', '2026-11-10T08:45:00.000Z'],
    ['Nov 10 08:00 NY catch-up', '2026-11-10T13:00:00.000Z', '2026-11-11T08:30:00.000Z'],
    ['Nov 8 noon NY already-completed day', '2026-11-08T17:00:00.000Z', '2026-11-09T08:30:00.000Z'],
  ];
  const novemberLast = cycle('COMPLETED', '2026-11-08', '2026-11-08T14:20:00.000Z', { id: 'november-completed', timezone: config.timezone });
  for (const [name, nowIso, expected] of probes) {
    const now = new Date(nowIso), preview = previewNextDreamRun({ config, telemetry, cycles: [novemberLast], now, idleMinutes: 60, resourcesAvailable: true });
    assert.equal(preview.time, expected, name);
    if (nowIso === '2026-11-10T01:41:00.000Z' || nowIso === '2026-11-10T04:30:00.000Z') {
      assert.equal(preview.trigger, 'fixed time');
      assert.match(preview.whyLater ?? '', /catch-up.*quiet.window/i, 'catch-up preview explains that it waits for its regular quiet-window start');
    }
    if (name === 'Nov 8 noon NY already-completed day') assert.equal(preview.trigger, 'fixed time', name);
  }
  const justMissedMidnight = new Date('2026-11-10T05:30:00.000Z');
  const inactivityGated = previewNextDreamRun({ config, telemetry, cycles: [novemberLast], now: justMissedMidnight, idleMinutes: 0, resourcesAvailable: true });
  assert.equal(inactivityGated.time, '2026-11-10T08:30:00.000Z', 'the worker waits for the scheduled time inside the quiet window, even after inactivity is satisfied');
  assert.equal(inactivityGated.trigger, 'fixed time');
  assert.match(inactivityGated.whyLater ?? '', /catch-up.*quiet.window/i);
  const resourceGated = previewNextDreamRun({ config, telemetry, cycles: [novemberLast], now: new Date('2026-11-10T08:30:00.000Z'), idleMinutes: 60, resourcesAvailable: false });
  assert.equal(resourceGated.time, null);
  assert.match(resourceGated.whyLater ?? '', /resource pressure/i);
  const allDay = { ...config, quietStart: '00:00', quietEnd: '23:59' };
  const allDayCatchUp = decideFromSnapshot({ config: allDay, telemetry, cycles: [novemberLast], now: new Date('2026-11-10T05:30:00.000Z'), idle: 60, resourcesAvailable: true });
  assert.equal(allDayCatchUp.action, 'start', 'the all-day quiet window preserves immediate catch-up eligibility');
});
