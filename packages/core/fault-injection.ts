/** Explicitly opt-in SIGKILL boundary used only by isolated persistence tests. */
export function killAtBoundary(point: string): void {
  if (process.env.MDB_FAULT_KILL_AT !== point) return;
  if (process.env.NODE_ENV !== 'test' && process.env.MDB_FAULT_INJECTION !== '1') return;
  process.kill(process.pid, 'SIGKILL');
}
