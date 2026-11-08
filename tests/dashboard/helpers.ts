import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';

// Test vaults live on the data volume when it exists (the system temp directory is subject to the tmp-trust rules); elsewhere they fall back to the system temp directory.
const testParent = process.env.ENGRAM_DASHBOARD_TEST_DIR ?? (existsSync('/Volumes/sambigdisk1') ? '/Volumes/sambigdisk1' : tmpdir());

export async function disposableVault() {
  const root = await mkdtemp(path.join(testParent, 'engram-dashboard-test-'));
  const priorAuthFile = process.env.MDB_DASHBOARD_AUTH_FILE;
  process.env.MDB_DASHBOARD_AUTH_FILE = path.join(root, '.test-auth', 'auth.json');
  const engram = new Engram(root);
  await engram.init({ sqlite: false });
  // A dashboard timer or audit write can still be in flight when the server has just closed; retry the removal instead of failing the test with ENOTEMPTY.
  return { root, engram, cleanup: async () => { await engram.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); if (priorAuthFile === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE; else process.env.MDB_DASHBOARD_AUTH_FILE = priorAuthFile; } };
}
export const tempPath = (root: string, ...parts: string[]) => path.join(root, ...parts);
