import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCase } from '../helpers/report.js';
import { buildPack } from '../dream/pack.js';
import { world } from './helpers.js';
import { MicroTrigger, runWorker } from '../../packages/adaptive/index.js';
import { execute } from '../../packages/cli/index.js';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
/** A fake clock whose sleep advances time instead of waiting. */
const clock = (start: string, stepMs: number) => { let t = at(start).getTime(); return { now: () => new Date(t), sleep: async () => { t += stepMs; } }; };
const types = (events: Array<{ type: string }>) => events.map(e => e.type);

test('worker: wakes on an interval, runs the daily cycle exactly once at the scheduled local time, logs the lifecycle, and reports status', async t => {
  const w = await world(t, { config: { timezone: NY } }); await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  const c = clock('2027-01-15T07:30:00Z', 15 * 60_000); // 02:30, 02:45, 03:00 (starts), 03:15 ... EST
  const ticks: string[] = []; const summary = await w.ai.worker({ intervalMs: 15 * 60_000, now: c.now, sleep: c.sleep, maxTicks: 6, onTick: x => ticks.push(x.daily) });
  assert.equal(summary.ticks, 6); assert.equal(summary.errors, 0); assert.equal(summary.started, 1, 'exactly one cycle ran');
  assert.match(ticks[0]!, /^wait/); assert.match(ticks[2]!, /^ran COMPLETED/); assert.match(ticks[3]!, /ALREADY_COMPLETED_FOR_LOCAL_DATE/);
  const events = await w.ai.events(100); const daily = events.filter(e => e.trigger === 'daily' || e.type === 'dream_skipped');
  assert.deepEqual(types(daily).filter(x => x !== 'dream_skipped'), ['dream_scheduled', 'dream_claimed', 'dream_started', 'dream_completed']);
  assert.equal(events.filter(e => e.type === 'dream_skipped' && e.reason === 'ALREADY_COMPLETED_FOR_LOCAL_DATE').length, 1, 'a repeated skip reason is logged once, not every tick');
  const completed = events.find(e => e.type === 'dream_completed')!; assert.ok(completed.watermark !== undefined && completed.durationMs !== undefined && completed.runId);
  assert.ok(!JSON.stringify(events).includes('TypeScript'), 'telemetry carries no document content');
  const status = await w.ai.status(at('2027-01-15T09:00:00Z')); assert.equal(status.providerReady, true); assert.equal(status.nextDue, `2027-01-16 03:00 ${NY}`); assert.ok(status.lastCompleted && status.lastStarted); assert.equal(status.lastOutcome, 'COMPLETED'); assert.equal(status.deadLetters, 0);
  recordCase({ suite: 'adaptive', name: 'worker-daily-once', status: 'PASS', detail: { ticks: summary.ticks } });
});

test('worker restart and two simultaneous workers: one execution per local date, the loser logs ANOTHER_INSTANCE_RUNNING', async t => {
  const w = await world(t, { config: { timezone: NY } }); await w.say('alpha', 'I prefer TypeScript [key:lang]');
  const run = (name: string) => runWorker(w.ai.scheduler, new MicroTrigger(w.vault, w.provider, w.ai.store), w.ai.store, { ...clock('2027-01-15T08:00:00Z', 60_000), instance: name, maxTicks: 1 });
  const [a, b] = await Promise.all([run('worker-a'), run('worker-b')]);
  assert.equal(a.started + b.started, 1, 'only one worker executed the cycle'); const cycles = await w.ai.cycles(); assert.equal(cycles.length, 1); assert.equal(cycles[0]!.state, 'COMPLETED');
  const events = await w.ai.events(100); assert.equal(events.filter(e => e.type === 'dream_completed').length, 1);
  const restarted = await run('worker-c'); assert.equal(restarted.started, 0, 'a restarted worker finds the date already done');
  assert.equal((await w.ai.cycles()).length, 1, 'no duplicate cycle after restart');
  recordCase({ suite: 'adaptive', name: 'worker-two-instances-restart', status: 'PASS' });
});

test('worker: a tick that throws is counted, backed off and never kills the loop; abort stops it promptly', async t => {
  const w = await world(t, { config: { timezone: NY } }); let calls = 0; const sleeps: number[] = [];
  const failing = { tick: async () => { calls++; throw new Error('boom'); } } as unknown as typeof w.ai.scheduler;
  const summary = await runWorker(failing, new MicroTrigger(w.vault, w.provider, w.ai.store), w.ai.store, { intervalMs: 1000, maxTicks: 4, now: () => new Date(), sleep: async ms => { sleeps.push(ms); } });
  assert.equal(summary.errors, 4); assert.equal(calls, 4); assert.ok(sleeps[2]! > sleeps[0]! * 2.5, `exponential backoff: ${sleeps.join(',')}`);
  const controller = new AbortController(); controller.abort(); const aborted = await runWorker(failing, new MicroTrigger(w.vault, w.provider, w.ai.store), w.ai.store, { signal: controller.signal }); assert.equal(aborted.ticks, 0); assert.equal(aborted.stopped, 'aborted');
  recordCase({ suite: 'adaptive', name: 'worker-errors-and-abort', status: 'PASS' });
});

test('no model provider: the cycle is blocked and reported as MODEL_UNAVAILABLE, never faked as success; the event log says so', async t => {
  const w = await world(t, { config: { timezone: NY }, provider: false }); await w.say('alpha', 'I prefer TypeScript [key:lang]');
  const tick = await w.ai.tick(at('2027-01-15T08:00:00Z')); assert.notEqual(tick.run!.cycle!.state, 'COMPLETED');
  const events = await w.ai.events(50); assert.ok(events.some(e => e.type === 'dream_retry' && e.reason === 'MODEL_UNAVAILABLE'), JSON.stringify(types(events)));
  assert.equal((await w.ai.status(at('2027-01-15T08:30:00Z'))).providerReady, false);
  recordCase({ suite: 'adaptive', name: 'worker-no-provider-blocked', status: 'PASS' });
});

test('poison cycle: after the configured failed attempts it is dead-lettered and quarantined for the local date, then retried on the next date', async t => {
  const w = await world(t, { config: { timezone: NY, deadLetterAfterAttempts: 2 } }); await buildPack(w.vault); await w.say('alpha', 'I prefer TypeScript [key:lang]'); w.provider.dreamFails = () => new Error('provider exploded');
  let now = at('2027-01-15T08:00:00Z'); const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) { const r = await w.ai.tick(now); outcomes.push(r.decision.action === 'skip' || r.decision.action === 'wait' ? `${r.decision.action}:${r.decision.reason.split(':')[0]}` : `${r.decision.action}:${r.run?.cycle?.state}`); now = new Date(now.getTime() + 31 * 60_000); }
  assert.ok(outcomes.some(o => o.startsWith('skip:DEAD_LETTER')), outcomes.join(' | ') + ' ' + JSON.stringify((await w.ai.cycles()).map(c => ({ s: c.state, a: c.attempts, e: c.error, ws: c.workspaces.alpha?.error })))); const events = await w.ai.events(200); assert.ok(events.some(e => e.type === 'dream_dead_letter'), JSON.stringify(types(events)));
  assert.equal((await w.ai.status(now)).deadLetters, 1);
  w.provider.dreamFails = undefined; const next = await w.ai.tick(at('2027-01-16T08:05:00Z')); assert.equal(next.run?.cycle?.state, 'COMPLETED', 'the next local date gets a fresh cycle'); assert.equal(next.run?.cycle?.localDate, '2027-01-16');
  recordCase({ suite: 'adaptive', name: 'worker-dead-letter', status: 'PASS', detail: { outcomes } });
});

test('micro Dream trigger: opt-in, debounced, one bounded job per accepted-change range, no recursion, daily cap, no model means a logged skip', async t => {
  const w = await world(t, { config: { timezone: NY, micro: { enabled: true, debounceMinutes: 10, maxPerDay: 1, kinds: ['wiki_page', 'user_insight'] } } });
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  assert.equal(await w.ai.microTick(later(0)), 'initialized', 'enabling never backfills history');
  await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Python JSON APIs', body: 'Python services expose JSON over HTTP using FastAPI.', tags: ['domain:python-api', 'api', 'json', 'provides:json'] });
  await w.vault.put({ scope: { type: 'workspace', workspaceId: 'alpha' }, kind: 'wiki_page', title: 'Alpha dashboards', body: 'Browser dashboards consume JSON through fetch and render widgets.', tags: ['domain:js-frontend', 'dashboard', 'consumes:json'] });
  assert.match(await w.ai.microTick(later(1)), /^debouncing/, 'inside the debounce window nothing runs'); assert.equal(w.provider.dreamCalls().length, 0);
  assert.equal(await w.ai.microTick(later(11)), 'completed'); const dreamCalls = w.provider.dreamCalls().length; assert.ok(dreamCalls > 0, 'the micro job reached the model once the window was quiet');
  assert.equal(await w.ai.microTick(later(12)), 'idle', 'the same range is never run twice');
  const events = await w.ai.events(100); assert.deepEqual(types(events.filter(e => e.trigger === 'micro')), ['dream_scheduled', 'dream_claimed', 'dream_started', 'dream_completed']);
  // Derived output (a discovery, a daily summary) must not trigger another micro job: it only moved the cursor.
  await w.note('alpha', 'discovery', 'Derived', 'A generated hypothesis'); assert.equal(await w.ai.microTick(later(30)), 'no relevant change'); assert.equal(w.provider.dreamCalls().length, dreamCalls);
  // Daily cap: a second relevant change the same local day is deferred, and says why.
  await w.note('alpha', 'wiki_page', 'More notes', 'Another accepted page.'); assert.equal(await w.ai.microTick(later(45)), 'DAILY_CAP'); assert.equal(w.provider.dreamCalls().length, dreamCalls);
  recordCase({ suite: 'adaptive', name: 'micro-trigger', status: 'PASS' });
});

test('micro trigger without a provider and when disabled: no model call, explicit reason', async t => {
  const off = await world(t, { config: { timezone: NY } }); assert.equal(await off.ai.microTick(), 'disabled');
  const w = await world(t, { config: { timezone: NY, micro: { enabled: true, debounceMinutes: 1, maxPerDay: 6, kinds: ['wiki_page'] } }, provider: false });
  await w.ai.microTick(new Date()); await w.note('alpha', 'wiki_page', 'Page', 'accepted'); assert.equal(await w.ai.microTick(new Date(Date.now() + 5 * 60_000)), 'MODEL_UNAVAILABLE');
  assert.ok((await w.ai.events(10)).some(e => e.type === 'dream_skipped' && e.reason === 'MODEL_UNAVAILABLE' && e.trigger === 'micro'));
  recordCase({ suite: 'adaptive', name: 'micro-disabled-no-provider', status: 'PASS' });
});

test('service definitions are printed, never installed, and carry the explicit worker command; schedule events and configure --micro work through the CLI', async t => {
  const w = await world(t, { config: { timezone: NY } });
  const launchd = await execute(['--root', w.root, 'intelligence', 'schedule', 'service', 'launchd']) as { content: string; install: string; note: string }; assert.match(launchd.content, /<key>RunAtLoad<\/key>/); assert.match(launchd.content, /schedule<\/string><string>worker/); assert.match(launchd.note, /nothing was installed/i);
  const systemd = await execute(['--root', w.root, 'intelligence', 'schedule', 'service', 'systemd']) as { content: string }; assert.match(systemd.content, /ExecStart=.*schedule worker/); assert.match(systemd.content, /Nice=10/);
  await assert.rejects(() => execute(['--root', w.root, 'intelligence', 'schedule', 'service', 'cron']), /launchd or systemd/);
  const cfg = await execute(['--root', w.root, 'intelligence', 'schedule', 'configure', '--micro', 'on', '--micro-max-per-day', '3']) as { micro: { enabled: boolean; maxPerDay: number } }; assert.equal(cfg.micro.enabled, true); assert.equal(cfg.micro.maxPerDay, 3);
  assert.deepEqual(await execute(['--root', w.root, 'intelligence', 'schedule', 'events']), []);
  recordCase({ suite: 'adaptive', name: 'service-print-and-cli', status: 'PASS' });
});

test('a skip whose reason only differs in numbers (load average, minutes) is logged once, not on every tick', async t => {
  const w = await world(t, { config: { timezone: NY } }); const scheduler = w.ai.scheduler as unknown as { noteSkip(reason: string): Promise<void> };
  for (const load of ['12.5', '13.1', '14.9', '9.8']) await scheduler.noteSkip(`load average ${load} > 9`); await scheduler.noteSkip('PAUSED');
  const skips = (await w.ai.events(20)).filter(e => e.type === 'dream_skipped'); assert.deepEqual(skips.map(e => e.reason), ['load average 12.5 > 9', 'PAUSED']);
  recordCase({ suite: 'adaptive', name: 'skip-reason-dedupe', status: 'PASS' });
});
