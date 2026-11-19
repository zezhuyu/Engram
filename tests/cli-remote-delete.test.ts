import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapCommand, toWebToolset, usesServer } from '../packages/cli/remote.js';
import { Vault } from '../packages/core/vault.js';
import { OWNER } from '../packages/core/types.js';

test('delete, restore and diff are routed to the server in remote mode', async () => {
  for (const command of ['delete', 'restore', 'diff']) assert.equal(usesServer(command, undefined), true);
  const mapped = await mapCommand('delete', ['delete', 'obj_x'], { revision: 'rev_y' });
  assert.deepEqual(mapped, { tool: 'mdb_delete', input: { objectId: 'obj_x', expectedRevisionId: 'rev_y' } });
  assert.throws(() => toWebToolset(mapped as { tool: string; input: Record<string, unknown> }), /not available through this server/);
});

test('reading a missing object from a vault with no journal is a clean not-found, not a TypeError', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'engram-nojournal-'));
  try {
    await assert.rejects(() => new Vault(dir, OWNER).delete('obj_missing', 'rev_missing'), (e: Error) => !(e instanceof TypeError));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
