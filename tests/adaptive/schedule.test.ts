import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { recordCase } from '../helpers/report.js';
import { world, type World } from './helpers.js';
import { AdaptiveIntelligence, estimateWindow, touchActivity, type AdaptiveConfig, type Telemetry } from '../../packages/adaptive/index.js';
import { addDays, localParts } from '../../packages/adaptive/clock.js';
import { execute } from '../../packages/cli/index.js';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
async function sched(t: Parameters<typeof world>[0], config: Partial<AdaptiveConfig> = {}): Promise<World> { const w = await world(t, { config: { timezone: NY, ...config } }); await w.say('alpha', 'I prefer TypeScript for services [key:lang]'); return w; }
/** n fully covered days ending the day before `end`, quiet at `quiet` hour (activity 0) and busy (activity 40) in the other quiet-window hours. */
function history(end: string, days: number, opts: { covered?: number; busy?: Record<number, number> } = {}): Telemetry { const t: Telemetry = { days: {}, lastEventSequence: 0 }; for (let i = 1; i <= days; i++) { const d = addDays(end, -i); t.days[d] = { events: Array.from({ length: 24 }, (_, h) => opts.busy?.[h] ?? 0), covered: Array.from({ length: 24 }, (_, h) => h < (opts.covered ?? 24)) }; } return t; }

test('first run at 03:00 local: waits before it, starts at it, and runs exactly once for the local date', async t => {
  const w = await sched(t);
  assert.deepEqual((await w.ai.scheduler.decide(at('2027-01-15T07:59:00Z'))).decision.action, 'wait'); // 02:59 EST
  const tick = await w.ai.tick(at('2027-01-15T08:00:00Z')); assert.equal(tick.decision.action, 'start', JSON.stringify(tick.decision)); assert.equal(tick.run!.cycle!.state, 'COMPLETED', JSON.stringify(tick.run!.cycle!.error)); assert.equal(tick.run!.cycle!.localDate, '2027-01-15');
  const again = await w.ai.tick(at('2027-01-15T08:20:00Z')); assert.equal(again.decision.action, 'skip'); assert.equal((again.decision as { reason: string }).reason, 'ALREADY_COMPLETED_FOR_LOCAL_DATE'); assert.equal((await w.ai.cycles()).length, 1);
  assert.equal((await w.ai.status(at('2027-01-15T08:30:00Z'))).windowMode, 'DEFAULT');
  recordCase({ suite: 'adaptive', name: 'schedule-0300-first-run', status: 'PASS' });
});

test('learning needs 14 reliable days, uses only a 28-day window, ignores unreliable (disconnected) coverage, moves one hour at a time and applies hysteresis', async t => {
  const w = await sched(t); const cfg = await w.ai.store.config(); const now = at('2027-03-01T12:00:00Z'); const today = localParts(now, NY).date;
  const few = estimateWindow(history(today, 10, { busy: { 3: 40 } }), cfg, now); assert.equal(few.mode, 'DEFAULT'); assert.match(few.reason, /INSUFFICIENT_TELEMETRY: 10\/14/); assert.equal(few.startLocal, '03:00');
  const disconnected = estimateWindow(history(today, 28, { covered: 6, busy: { 3: 40 } }), cfg, now); assert.equal(disconnected.mode, 'DEFAULT', 'hours the scheduler was not running are unknown, not quiet');
  const stale = history(today, 14); const old: Telemetry = { days: {}, lastEventSequence: 0 }; for (const [d, v] of Object.entries(stale.days)) old.days[addDays(d, -40)] = v; assert.equal(estimateWindow(old, cfg, now).mode, 'DEFAULT', 'days older than the 28-day window do not count');
  const learned = history(today, 20, { busy: { 3: 40, 4: 40, 1: 10 } }); // 05:00 and 06:00 are quiet, 03:00-04:00 are busy
  const first = estimateWindow(learned, cfg, now); assert.equal(first.mode, 'ADAPTIVE'); assert.equal(first.startLocal, '04:00', 'moves only one hour toward the quiet window'); assert.ok(first.confidence > 0.6 && first.reliableDays === 20);
  learned.learned = first.learned; const next = estimateWindow(learned, cfg, at('2027-03-02T12:00:00Z')); assert.equal(next.startLocal, '04:00', 'hysteresis: no further move within 7 days'); const later = estimateWindow(learned, cfg, at('2027-03-10T12:00:00Z')); assert.equal(later.startLocal, '05:00', 'after a week it moves again, one hour');
  assert.equal(estimateWindow(learned, { ...cfg, mode: 'fixed', targetLocalTime: '01:15' }, now).startLocal, '01:15', 'manual fixed schedule overrides learning');
  recordCase({ suite: 'adaptive', name: 'adaptive-window-learning', status: 'PASS' });
});

test('DST: the spring-forward gap does not skip the day, and the fall-back repeated hour does not run twice', async t => {
  const spring = await sched(t, { targetLocalTime: '02:30' }); // 02:30 does not exist on 2027-03-14 in New York
  assert.equal((await spring.ai.scheduler.decide(at('2027-03-14T06:59:00Z'))).decision.action, 'wait'); const st = await spring.ai.tick(at('2027-03-14T07:00:00Z')); assert.equal(st.decision.action, 'start'); assert.equal(st.run!.cycle!.localDate, '2027-03-14');
  const fall = await sched(t, { targetLocalTime: '01:30' }); const first = await fall.ai.tick(at('2027-11-07T05:30:00Z')); assert.equal(first.decision.action, 'start'); // 01:30 EDT
  const second = await fall.ai.tick(at('2027-11-07T06:30:00Z')); assert.equal(second.decision.action, 'skip', '01:30 EST is the same local date: no second cycle'); assert.equal((await fall.ai.cycles()).filter(c => c.localDate === '2027-11-07').length, 1);
  recordCase({ suite: 'adaptive', name: 'dst-spring-fall', status: 'PASS' });
});

test('after downtime exactly one catch-up cycle runs in the next idle window, and a time-zone change cannot cause a second run for the same local date', async t => {
  const w = await sched(t); await w.ai.tick(at('2027-02-01T08:00:00Z')); await w.say('alpha', 'I prefer Go for tools [key:more]');
  const catchUp = await w.ai.tick(at('2027-02-04T19:00:00Z')); assert.equal(catchUp.decision.action, 'start'); assert.match((catchUp.decision as { reason: string }).reason, /catch-up/); assert.equal(catchUp.run!.cycle!.state, 'COMPLETED');
  assert.equal((await w.ai.tick(at('2027-02-04T20:00:00Z'))).decision.action, 'skip'); assert.deepEqual((await w.ai.cycles()).map(c => c.localDate).sort(), ['2027-02-01', '2027-02-04'], 'missed days are not replayed one by one');
  const z = await sched(t); await z.ai.tick(at('2027-01-15T08:00:00Z')); await z.ai.configure({ timezone: 'Europe/London', quietEnd: '09:00', targetLocalTime: '03:00' });
  assert.equal((await z.ai.tick(at('2027-01-15T08:30:00Z'))).decision.action, 'skip', 'same local date in the new zone: no duplicate'); assert.equal((await z.ai.cycles()).length, 1);
  recordCase({ suite: 'adaptive', name: 'catch-up-and-timezone-change', status: 'PASS' });
});

test('duplicate scheduler instances start exactly one cycle', async t => {
  const w = await sched(t); const other = new AdaptiveIntelligence(w.vault, w.provider); const now = at('2027-01-20T08:00:00Z');
  const results = await Promise.all([w.ai.tick(now), other.tick(now), w.ai.tick(now)]); const ran = results.filter(r => r.run?.ran); assert.equal(ran.length, 1, JSON.stringify(results.map(r => [r.decision.action, r.run?.reason])));
  assert.equal((await w.ai.cycles()).length, 1); assert.ok((await w.vault.listDocuments()).filter(d => d.kind === 'workspace_daily_summary').length <= 1, 'never one summary per instance'); assert.equal(ran[0]!.run!.cycle!.state, 'COMPLETED');
  recordCase({ suite: 'adaptive', name: 'duplicate-schedulers', status: 'PASS' });
});

test('requires 60 minutes of confirmed inactivity; telemetry holds counts only; disabled and paused states do not run', async t => {
  const w = await sched(t); const now = at('2027-01-25T08:00:00Z');
  await touchActivity(w.root, new Date(now.getTime() - 10 * 60000)); const busy = await w.ai.scheduler.decide(now); assert.equal(busy.decision.action, 'wait'); assert.match((busy.decision as { reason: string }).reason, /inactivity required/);
  await fs.rm(path.join(w.root, '.mdb/adaptive/activity.json')); assert.equal((await w.ai.scheduler.decide(new Date(now.getTime() + 61 * 60000))).decision.action, 'start', 'idle long enough (still inside the quiet window)');
  const telemetry = await fs.readFile(path.join(w.root, '.mdb/adaptive/telemetry.json'), 'utf8'); assert.ok(!/prefer|TypeScript|service/i.test(telemetry), 'telemetry never contains content'); assert.deepEqual(Object.keys(JSON.parse(telemetry)).sort(), ['days', 'lastEventSequence', 'lastTickAt'].sort().filter(k => k in JSON.parse(telemetry)).concat(Object.keys(JSON.parse(telemetry)).filter(k => k === 'learned')).sort());
  await w.ai.pause(); assert.equal((await w.ai.scheduler.decide(now)).decision.action, 'skip'); await w.ai.resume(); await w.ai.configure({ enabled: false }); assert.deepEqual((await w.ai.scheduler.decide(now)).decision, { action: 'skip', reason: 'DISABLED' });
  recordCase({ suite: 'adaptive', name: 'idle-gate-and-telemetry-privacy', status: 'PASS' });
});

test('CLI: schedule configure/status/pause and cycles list/show, run --snapshot now, workspace daily list/show', async t => {
  const w = await sched(t, { enabled: false }); const root = w.root; const j = (args: string[]) => execute([...args, '--root', root, '--json']) as Promise<any>;
  const cfg = await j(['intelligence', 'schedule', 'configure', '--enable', '--timezone', 'America/New_York', '--time', '03:30', '--mode', 'fixed']); assert.equal(cfg.enabled, true); assert.equal(cfg.targetLocalTime, '03:30');
  await assert.rejects(j(['intelligence', 'schedule', 'configure', '--timezone', 'Mars/Phobos']), /time zone/i); await assert.rejects(j(['intelligence', 'schedule', 'configure', '--time', '25:99']), /HH:MM/);
  const status = await j(['intelligence', 'schedule', 'status']); assert.equal(status.scheduledLocalTime, '03:30'); assert.equal(status.windowMode, 'FIXED'); assert.equal((await j(['intelligence', 'schedule', 'pause'])).paused, true); assert.equal((await j(['intelligence', 'schedule', 'resume'])).paused, false);
  const run = await j(['intelligence', 'run', '--snapshot', 'now', '--stage', 'daily', '--key', 'cli-1']); assert.equal(run.ran, true); assert.equal(run.state, 'BLOCKED', 'no provider is configured in this CLI context: reported as BLOCKED, not success'); assert.equal(run.cycle, 'manual-cli-1');
  const list = await j(['intelligence', 'cycles', 'list']); assert.equal(list[0].id, 'manual-cli-1'); const shown = await j(['intelligence', 'cycles', 'show', 'manual-cli-1']); assert.equal(shown.id, 'manual-cli-1'); assert.ok(shown.watermark > 0);
  const daily = await j(['workspace', 'daily', 'list', '--workspace', 'alpha']); assert.equal(daily.length, 1); const date = daily[0].date; const body = await j(['workspace', 'daily', 'show', '--workspace', 'alpha', '--date', date]); assert.ok(body[0].markdown.includes('## Executive summary'));
  assert.ok((await j(['workspace', 'changes', '--workspace', 'alpha', '--since', date])).summaries.length === 1);
  assert.ok(!JSON.stringify(shown).includes('TypeScript'), 'cycle records never contain raw private text');
  recordCase({ suite: 'adaptive', name: 'cli-surface', status: 'PASS' });
});
