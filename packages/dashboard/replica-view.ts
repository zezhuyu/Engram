export type ReplicaPill = 'Sync mode' | 'Syncing' | 'Cache mode (offline)' | 'Conflict' | 'Access refused' | 'Paused' | 'Epoch changed' | 'Daemon stopped';
export function deriveReplicaPill(input: { status: Record<string, unknown> | null; daemonRunning: boolean; statusAgeMs: number | null; now?: number; intervalMs?: number }): ReplicaPill {
  const status = input.status ?? {}, now = input.now ?? Date.now(), interval = input.intervalMs ?? 30_000;
  if (!input.daemonRunning || input.statusAgeMs === null || input.statusAgeMs > interval * 3) return 'Daemon stopped';
  if (status.epochState === 'epoch-changed' || status.state === 'epoch-changed') return 'Epoch changed';
  if (Number(status.diverged) > 0 || status.state === 'conflict') return 'Conflict';
  if (status.state === 'refused') return 'Access refused';
  if (status.state === 'paused') return 'Paused';
  if (status.state === 'offline') return 'Cache mode (offline)';
  if (status.state === 'syncing') return 'Syncing';
  const updated = Date.parse(String(status.updatedAt ?? ''));
  if (!Number.isFinite(updated) || now - updated > interval * 3) return 'Daemon stopped';
  return Number(status.pendingPush) === 0 ? 'Sync mode' : 'Syncing';
}
