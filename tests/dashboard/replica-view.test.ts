import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveReplicaPill } from '../../packages/dashboard/replica-view.js';
const now = 1_000_000;
const input = (state: string, pendingPush = 0, extra: Record<string, unknown> = {}) => ({ status: { state, pendingPush, updatedAt: new Date(now).toISOString(), ...extra }, daemonRunning: true, statusAgeMs: 30_000, now });
test('replica dashboard state derivation fails closed for stale or stopped daemons', () => {
  assert.equal(deriveReplicaPill(input('synced')), 'Sync mode');
  assert.equal(deriveReplicaPill(input('syncing')), 'Syncing');
  assert.equal(deriveReplicaPill(input('offline')), 'Cache mode (offline)');
  assert.equal(deriveReplicaPill(input('conflict')), 'Conflict');
  assert.equal(deriveReplicaPill(input('refused')), 'Access refused');
  assert.equal(deriveReplicaPill(input('paused')), 'Paused');
  assert.equal(deriveReplicaPill(input('synced', 0, { epochState: 'epoch-changed' })), 'Epoch changed');
  assert.equal(deriveReplicaPill({ ...input('synced'), daemonRunning: false }), 'Daemon stopped');
  assert.equal(deriveReplicaPill({ ...input('synced'), statusAgeMs: 90_001 }), 'Daemon stopped');
  assert.equal(deriveReplicaPill({ ...input('synced'), statusAgeMs: 90_000 }), 'Sync mode');
  assert.equal(deriveReplicaPill(input('synced', 1)), 'Syncing');
});
