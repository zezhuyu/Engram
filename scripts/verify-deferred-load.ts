import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { world } from '../tests/adaptive/helpers.js';

/**
 * Real-load proof that deferred Dream/profile work eventually runs. CPU-bound processes push the actual 1-minute load average above the governor's default threshold (0.75 x cpus), a cycle is
 * attempted and must be deferred without losing its evidence; the load is removed; once the real load average falls below the threshold, the pending work must complete exactly once.
 * Slow by nature (the load average is a 1-minute moving average), so this is an evidence script, not part of `npm test`.  Output: verification/dream/deferred-load-latest.json
 */
const cpus = os.cpus().length; const threshold = Math.max(1, cpus * 0.75);
const cleanups: Array<() => Promise<void> | void> = []; const t = { after: (fn: () => Promise<void> | void) => { cleanups.push(fn); } };
const loads: ChildProcess[] = []; const killLoad = () => { for (const p of loads.splice(0)) p.kill('SIGKILL'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms)); const load1 = () => os.loadavg()[0] ?? 0;
const trace: Array<{ at: string; load: number; note: string }> = []; const mark = (note: string) => trace.push({ at: new Date().toISOString(), load: Number(load1().toFixed(2)), note });
async function waitFor(predicate: () => boolean, timeoutMs: number, note: string): Promise<boolean> { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (predicate()) return true; await sleep(5000); mark(note); } return predicate(); }
const result: Record<string, unknown> = { status: 'FAIL', cpus, threshold, startedAt: new Date().toISOString() };
try {
  const w = await world(t, { provider: true });
  await w.ai.configure({ resources: { maxLoadAverage: threshold, maxRssMiB: 1_000_000, activityPollMs: 20 } } as never); // the default threshold, not the test-friendly unlimited one
  await w.say('alpha', 'I prefer deferred work to survive load [key:deferred]');
  const idle = load1(); mark('baseline');
  for (let i = 0; i < cpus * 2; i++) loads.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  const reached = await waitFor(() => load1() > threshold + 1, 240_000, 'loading'); result.loadReached = reached; result.loadAtAttempt = Number(load1().toFixed(2));
  const first = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'deferred-1', respectActivity: false })).cycle!;
  result.firstCycle = { state: first.state, error: first.error ?? null, skipped: (first as { skipped?: unknown }).skipped ?? null };
  const insightsAfterFirst = (await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.preferenceKey === 'deferred').length; result.insightsWhileLoaded = insightsAfterFirst;
  killLoad(); mark('load removed');
  const calmed = await waitFor(() => load1() < threshold - 0.5, 420_000, 'cooling'); result.loadCalmed = calmed; result.loadAtRetry = Number(load1().toFixed(2));
  const second = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'deferred-2', respectActivity: false })).cycle!;
  result.secondCycle = { state: second.state, error: second.error ?? null };
  const accepted = (await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.preferenceKey === 'deferred' && d.status === 'accepted'); result.acceptedAfterRecovery = accepted.length;
  const third = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'deferred-3', respectActivity: false })).cycle!; result.thirdCycle = { state: third.state };
  result.acceptedAfterThirdCycle = (await w.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.preferenceKey === 'deferred' && d.status === 'accepted').length;
  // Second scenario: the scheduler's OWN decisions, with no manual cycle. Under real load a tick must say wait/defer; after the load is gone the next tick must run the pending work.
  const w2 = await world(t, { provider: true }); await w2.ai.configure({ timezone: 'UTC', mode: 'fixed', targetLocalTime: '00:00', quietStart: '00:00', quietEnd: '23:59', inactivityMinutes: 0, resources: { maxLoadAverage: threshold, maxRssMiB: 1_000_000, activityPollMs: 20 } } as never);
  await w2.say('alpha', 'I prefer the scheduler to retry on its own [key:autonomous]');
  for (let i = 0; i < cpus * 2; i++) loads.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  const loaded2 = await waitFor(() => load1() > threshold + 1, 240_000, 'loading (scheduler scenario)');
  const tickLoaded = await w2.ai.tick(new Date()); const insightsLoaded2 = (await w2.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.preferenceKey === 'autonomous').length;
  result.scheduler = { loadAtTick: Number(load1().toFixed(2)), loadReached: loaded2, decisionUnderLoad: tickLoaded.decision, ran: !!tickLoaded.run?.ran, insightsWhileLoaded: insightsLoaded2 };
  killLoad(); mark('load removed (scheduler scenario)'); const calmed2 = await waitFor(() => load1() < threshold - 0.5, 420_000, 'cooling (scheduler scenario)');
  const ticks: Array<{ action: string; reason?: string; ran: boolean; state?: string }> = []; let completedAt = -1;
  for (let i = 0; i < 6 && completedAt < 0; i++) { const tk = await w2.ai.tick(new Date(Date.now() + i * 60_000)); ticks.push({ action: tk.decision.action, ...('reason' in tk.decision ? { reason: String(tk.decision.reason).slice(0, 120) } : {}), ran: !!tk.run?.ran, ...(tk.run?.cycle ? { state: tk.run.cycle.state } : {}) }); if (tk.run?.cycle?.state === 'COMPLETED') completedAt = i; }
  const acceptedAuto = (await w2.vault.listDocuments()).filter(d => d.kind === 'user_insight' && d.metadata.preferenceKey === 'autonomous' && d.status === 'accepted').length;
  const again = await w2.ai.tick(new Date(Date.now() + 10 * 60_000));
  result.scheduler = { ...(result.scheduler as object), loadCalmed: calmed2, loadAtRecovery: Number(load1().toFixed(2)), recoveryTicks: ticks, acceptedByScheduler: acceptedAuto, tickAfterCompletion: { action: again.decision.action, reason: 'reason' in again.decision ? again.decision.reason : undefined } };
  const sch = result.scheduler as { loadReached: boolean; decisionUnderLoad: { action: string }; ran: boolean; insightsWhileLoaded: number };
  const schedulerOk = loaded2 && sch.decisionUnderLoad.action !== 'start' && !sch.ran && sch.insightsWhileLoaded === 0 && calmed2 && completedAt >= 0 && acceptedAuto === 1 && again.decision.action === 'skip';
  result.schedulerCriteria = { loadExceededThreshold: loaded2, tickUnderLoadDidNotRun: sch.decisionUnderLoad.action !== 'start' && !sch.ran, nothingLostMeanwhile: sch.insightsWhileLoaded === 0, loadCalmed: calmed2, nextTickRanThePendingWork: completedAt >= 0, exactlyOnce: acceptedAuto === 1, nothingRerunForTheSameDate: again.decision.action === 'skip' };
  const deferred = first.state !== 'COMPLETED' && insightsAfterFirst === 0; const recovered = second.state === 'COMPLETED' && accepted.length === 1 && result.acceptedAfterThirdCycle === 1;
  result.status = reached && deferred && calmed && recovered && schedulerOk ? 'PASS' : reached ? 'FAIL' : 'INCOMPLETE';
  result.criteria = { loadActuallyExceededThreshold: reached, firstCycleDeferredWithoutLosingEvidence: deferred, loadActuallyCalmed: calmed, pendingWorkCompletedExactlyOnce: recovered };
} catch (error) { result.error = error instanceof Error ? error.message : String(error); } finally {
  killLoad(); for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => undefined);
  result.finishedAt = new Date().toISOString(); result.trace = trace.slice(-40); result.idleLoadAtStart = trace[0]?.load;
  await fs.mkdir(path.join('verification', 'dream'), { recursive: true }); await fs.writeFile(path.join('verification', 'dream', 'deferred-load-latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, criteria: result.criteria, schedulerCriteria: result.schedulerCriteria, cpus, threshold, error: result.error }, null, 1)); process.exitCode = result.status === 'PASS' ? 0 : 1;
}
