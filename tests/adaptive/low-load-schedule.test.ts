import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { estimateWindow } from '../../packages/adaptive/activity.js';
import { defaultConfig, AdaptiveStore } from '../../packages/adaptive/state.js';
import { decideFromSnapshot } from '../../packages/adaptive/scheduler.js';
import { addDays } from '../../packages/adaptive/clock.js';
import type { AdaptiveConfig, Cycle, Telemetry } from '../../packages/adaptive/types.js';
import { world } from './helpers.js';

const now = new Date('2027-03-01T04:30:00.000Z');
const history = (config: AdaptiveConfig, events: number[], loads: number[] = []): Telemetry => {
  const today = '2027-03-01'; const days: Telemetry['days'] = {};
  for (let i = 1; i <= config.minHistoryDays; i++) { const date = addDays(today, -i); days[date] = { events: [...events], covered: Array(24).fill(true), load: Array.from({ length: 24 }, (_, h) => ({ samples: 1, meanPerCore: loads[h] ?? 0 })) }; }
  return { days, lastEventSequence: 0 };
};

test('first runs use configured default while reliable telemetry is insufficient', () => {
  const config = { ...defaultConfig(), timezone: 'UTC' }; const result = estimateWindow({ days: {}, lastEventSequence: 0 }, config, now);
  assert.equal(result.mode, 'DEFAULT'); assert.equal(result.startLocal, '03:00');
});

test('STRICT absolutely quiet window is preferred over relative scoring', () => {
  const config = { ...defaultConfig(), timezone: 'UTC', expectedDurationHours: 1 };
  const events = Array(24).fill(4); events[5] = 0; const result = estimateWindow(history(config, events), config, now);
  assert.match(result.reason, /^STRICT:/); assert.equal(result.startLocal, '04:00', 'moves one hour toward the absolutely quiet period');
});

test('RELATIVE_LOW_LOAD selects least activity, load breaks activity ties, and target breaks full ties', () => {
  const config = { ...defaultConfig(), timezone: 'UTC', expectedDurationHours: 1 };
  const busy = Array(24).fill(4); busy[2] = 1; busy[4] = 1; busy[3] = 2;
  const loads = Array(24).fill(0.2); loads[2] = 0.4; loads[4] = 0.1;
  const relative = estimateWindow(history(config, busy, loads), config, now);
  assert.match(relative.reason, /^RELATIVE_LOW_LOAD:/); assert.equal(relative.startLocal, '04:00', 'lower load resolves equal activity');
  const tied = estimateWindow(history(config, Array(24).fill(1), Array(24).fill(0.2)), config, now);
  assert.equal(tied.startLocal, '03:00', 'full ties retain configured target');
});

test('relative learning preserves minHistoryDays, 25 percent improvement and seven-day hysteresis', () => {
  const config = { ...defaultConfig(), timezone: 'UTC', expectedDurationHours: 1 };
  const short = history(config, Array(24).fill(1)); short.days = Object.fromEntries(Object.entries(short.days).slice(0, config.minHistoryDays - 1));
  assert.equal(estimateWindow(short, config, now).mode, 'DEFAULT');
  const t = history(config, Array(24).fill(10)); for (const day of Object.values(t.days)) day.events[5] = 1;
  t.learned = { startLocal: '03:00', changedOn: '2027-02-28', score: 10 };
  assert.equal(estimateWindow(t, config, now).startLocal, '03:00', 'requires a week since the prior change');
  t.learned.changedOn = '2027-02-20'; assert.equal(estimateWindow(t, config, now).startLocal, '04:00', 'moves only one hour after a clear improvement');
});

test('old telemetry without load aggregates remains readable', async t => {
  const w = await world(t); const store = new AdaptiveStore(w.root);
  await fs.writeFile(path.join(w.root, '.mdb/adaptive/telemetry.json'), JSON.stringify({ days: { '2027-02-28': { events: Array(24).fill(0), covered: Array(24).fill(true) } }, lastEventSequence: 0 }));
  const legacy = await store.telemetry(); assert.equal(legacy.days['2027-02-28']!.load, undefined);
  const estimate = estimateWindow(legacy, { ...defaultConfig(), timezone: 'UTC' }, now); assert.equal(estimate.mode, 'DEFAULT');
});

test('lowLoadStart config validates thresholds and exposes defaults in status', async t => {
  const w = await world(t); const config = await w.ai.store.config();
  assert.deepEqual(config.lowLoadStart, { enabled: true, afterMinutesInWindow: 90, relaxedInactivityMinutes: 10, maxLoadPerCore: 0.5 });
  await assert.rejects(w.ai.configure({ lowLoadStart: { maxLoadPerCore: -1 } } as never), /lowLoadStart/);
  const status = await w.ai.status(now); assert.ok(['strict', 'relaxed'].includes(status.gate)); assert.equal(typeof status.loadPerCoreNow, 'number'); assert.deepEqual(status.lowLoadStart, config.lowLoadStart);
});

const decision = (config: AdaptiveConfig, at: string, idle: number, loadPerCore: number, resourcesAvailable = true, cycles: Cycle[] = []) => decideFromSnapshot({ config, telemetry: { days: {}, lastEventSequence: 0 }, cycles, now: new Date(at), idle, loadPerCore, resourcesAvailable });
const gateConfig = (): AdaptiveConfig => ({ ...defaultConfig(), enabled: true, timezone: 'UTC', targetLocalTime: '03:00', quietStart: '00:00', quietEnd: '07:00', inactivityMinutes: 60 });

test('relaxed gate does not start before afterMinutesInWindow', () => {
  const c = decision(gateConfig(), '2027-03-01T04:29:00Z', 20, 0.1); assert.equal(c.action, 'wait');
});

test('relaxed gate does not start under high load or recent foreground activity', () => {
  assert.equal(decision(gateConfig(), '2027-03-01T04:30:00Z', 20, 0.8).action, 'wait');
  assert.equal(decision(gateConfig(), '2027-03-01T04:30:00Z', 5, 0.1).action, 'wait');
});

test('relaxed gate starts only when low-load, idle, resources and quiet-window conditions hold', () => {
  const result = decision(gateConfig(), '2027-03-01T04:30:00Z', 20, 0.1);
  assert.equal(result.action, 'start'); assert.match(result.reason, /low-load start/);
  assert.equal(decision(gateConfig(), '2027-03-01T04:30:00Z', 20, 0.1, false).action, 'wait');
  assert.equal(decision(gateConfig(), '2027-03-01T07:00:00Z', 20, 0.1).action, 'wait');
});

test('relaxed gate cannot repeat a local date already completed', () => {
  const complete = { localDate: '2027-03-01', kind: 'scheduled', state: 'COMPLETED' } as Cycle;
  const result = decision(gateConfig(), '2027-03-01T04:30:00Z', 20, 0.1, true, [complete]);
  assert.equal(result.action, 'skip'); assert.match(result.reason, /ALREADY_COMPLETED/);
});
