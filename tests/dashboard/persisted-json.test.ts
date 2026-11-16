import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { passwordIsSet, dashboardSessionFile, loadDashboardSessions } from '../../packages/dashboard/password.js';
import { dashboardAuthFile } from '../../packages/dashboard/password.js';
import { connectorConfig } from '../../packages/dashboard/connectors.js';
import { listDashboardCredentials } from '../../packages/dashboard/credentials.js';
import { readAudit } from '../../packages/dashboard/audit.js';

test('dashboard persisted JSON rejects duplicate and prototype keys and audit reports corruption', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-dashboard-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dashboardDir = path.join(root, '.mdb/dashboard');
  const authFile = path.join(root, 'auth.json');
  await mkdir(dashboardDir, { recursive: true });

  await writeFile(authFile, '{"version":1,"version":1}');
  await assert.rejects(() => passwordIsSet(root, { env: { MDB_DASHBOARD_AUTH_FILE: authFile } }), /corrupt or unreadable/);

  await writeFile(dashboardSessionFile(authFile), '{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"createdAt":1,"lastSeen":1},"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"createdAt":2,"lastSeen":2}}');
  await assert.rejects(() => loadDashboardSessions(authFile, 60_000, 60_000), /sessions file is corrupt/);

  const priorAuthPath = process.env.MDB_DASHBOARD_AUTH_FILE;
  process.env.MDB_DASHBOARD_AUTH_FILE = authFile;
  t.after(() => { if (priorAuthPath === undefined) delete process.env.MDB_DASHBOARD_AUTH_FILE; else process.env.MDB_DASHBOARD_AUTH_FILE = priorAuthPath; });
  await writeFile(path.join(dashboardDir, 'connectors.json'), '{"version":1,"connectors":{},"__proto__":{}}');
  await assert.rejects(() => connectorConfig(root), /configuration is invalid/);
  await writeFile(path.join(dashboardDir, 'credentials.json'), '{"version":1,"credentials":[],"credentials":[]}');
  await assert.rejects(() => listDashboardCredentials(root), /registry is invalid/);

  await writeFile(path.join(dashboardDir, 'audit.jsonl'), '{"at":"now","key":"x","key":"y","oldValue":null,"newValue":null,"result":"applied"}\n');
  const audit = await readAudit(root);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.key, 'dashboard.audit.corruption');
  assert.deepEqual(audit[0]?.newValue, { corrupt: true });
});
