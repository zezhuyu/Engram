import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultReplicaBase } from '../../packages/replication/client.js';

/** Make `<base>/<id>/.replica/config.json`, the file that marks a replica. */
async function plantReplica(base: string, id = 'rep-1') { const dir = path.join(base, id, '.replica'); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'config.json'), '{}', { mode: 0o600 }); }

test('a terminal with ENGRAM_DATA_DIR set still finds the replica the background service created in the default location, and vice versa', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'engram-replica-base-')); t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, '.Engram');
  const plain = path.join(home, '.local', 'share', 'engram', 'replicas'), underData = path.join(dataDir, '.engram-runtime', 'replica');
  const shell = { HOME: home, ENGRAM_DATA_DIR: dataDir } as NodeJS.ProcessEnv, service = { HOME: home } as NodeJS.ProcessEnv;

  assert.equal(defaultReplicaBase(shell, home), underData, 'no replica anywhere: a new one goes where the environment says');
  assert.equal(defaultReplicaBase(service, home), plain);

  await plantReplica(plain);                                              // created by the launchd service (no ENGRAM_DATA_DIR)
  assert.equal(defaultReplicaBase(service, home), plain);
  assert.equal(defaultReplicaBase(shell, home), plain, 'the shell finds it too');

  await rm(plain, { recursive: true }); await plantReplica(underData);    // created from a shell that exports ENGRAM_DATA_DIR
  assert.equal(defaultReplicaBase(shell, home), underData);
  assert.equal(defaultReplicaBase(service, home), underData, 'the service finds it too');

  await plantReplica(plain);                                              // replicas in both: the environment's own location is preferred
  assert.equal(defaultReplicaBase(shell, home), underData); assert.equal(defaultReplicaBase(service, home), plain);
});

test('an explicit ENGRAM_REPLICA_DIR always wins, even when it holds no replica', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'engram-replica-base-')); t.after(() => rm(home, { recursive: true, force: true }));
  await plantReplica(path.join(home, '.local', 'share', 'engram', 'replicas'));
  const explicit = path.join(home, 'chosen');
  assert.equal(defaultReplicaBase({ HOME: home, ENGRAM_REPLICA_DIR: explicit } as NodeJS.ProcessEnv, home), explicit);
});
