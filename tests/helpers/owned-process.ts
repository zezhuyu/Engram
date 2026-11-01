import type { ChildProcess } from 'node:child_process';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const childrenByTest = new WeakMap<Cleanup, Set<ChildProcess>>();
const liveChildren = new Set<ChildProcess>();

process.once('exit', () => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try { child.kill('SIGKILL'); } catch { /* best-effort process-exit safeguard */ }
    }
  }
});

/** Stops only a child created by the test itself, escalating after a bounded grace period. */
export async function stopOwnedChildProcess(child: ChildProcess, graceMs = 2_000): Promise<void> {
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await Promise.race([closed.then(() => true), delay(graceMs).then(() => false)])) return;
  child.kill('SIGKILL');
  if (!await Promise.race([closed.then(() => true), delay(graceMs).then(() => false)])) {
    throw new Error(`Owned test child ${child.pid ?? '(unspawned)'} remained alive after SIGTERM and SIGKILL`);
  }
}

/** Registers bounded cleanup for a child created by the test itself. Never signals process-name matches or external PIDs. */
export function ownChildProcess(t: Cleanup, child: ChildProcess, graceMs = 2_000): void {
  let owned = childrenByTest.get(t);
  if (!owned) { owned = new Set(); childrenByTest.set(t, owned); }
  owned.add(child);
  liveChildren.add(child);
  child.once('close', () => { liveChildren.delete(child); owned?.delete(child); });
  t.after(() => stopOwnedChildProcess(child, graceMs));
}

/** Stops all children registered to a test before any resource they may be using is removed. */
export async function stopOwnedChildren(t: Cleanup): Promise<void> {
  const children = childrenByTest.get(t);
  if (!children?.size) return;
  const results = await Promise.allSettled([...children].map(child => stopOwnedChildProcess(child)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Failed to stop owned test child processes');
}
