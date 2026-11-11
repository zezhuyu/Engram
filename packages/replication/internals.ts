import { killAtBoundary } from '../core/fault-injection.js';

/** Test-only persistence-boundary fault injection. */
export const replicaFault = killAtBoundary;

export type ReplicaLimits = {
  maxReplicaBytes: number;
  maxPendingOps: number;
  maxPendingBytes: number;
  maxBlobBytes: number;
};

export const DEFAULT_REPLICA_LIMITS: Readonly<ReplicaLimits> = Object.freeze({
  maxReplicaBytes: 2 * 1024 ** 3,
  maxPendingOps: 10_000,
  maxPendingBytes: 256 * 1024 ** 2,
  maxBlobBytes: 64 * 1024 ** 2,
});

export function pendingBytes(ops: readonly { revisionBytes: string }[]): number {
  return ops.reduce((total, op) => total + Buffer.byteLength(JSON.stringify(op)), 0);
}

export function quotaExceeded(message: string): Error & { code: string } {
  return Object.assign(new Error(`QUOTA_EXCEEDED: ${message}`), { code: 'QUOTA_EXCEEDED' });
}
