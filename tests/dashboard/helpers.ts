import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';

export async function disposableVault() {
  const root = await mkdtemp('/Volumes/sambigdisk1/engram-dashboard-test-');
  const priorAuthFile = process.env.MDB_DASHBOARD_AUTH_FILE;
  process.env.MDB_DASHBOARD_AUTH_FILE = path.join(root, '.test-auth', 'auth.json');
  const engram = new Engram(root);
  await engram.init({ sqlite: false });
  return { root, engram, cleanup: async () => { await engram.close(); await rm(root, { recursive: true, force: true }); if (priorAuthFile === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE; else process.env.MDB_DASHBOARD_AUTH_FILE = priorAuthFile; } };
}
export const tempPath = (root: string, ...parts: string[]) => path.join(root, ...parts);
