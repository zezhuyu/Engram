import type { ChildProcess } from 'node:child_process';

type Cleanup = { after(fn: () => void | Promise<void>): void };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  t.after(() => stopOwnedChildProcess(child, graceMs));
}
