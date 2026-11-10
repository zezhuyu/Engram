import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDashboardCredential } from '../../packages/dashboard/credentials.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';

test('Dream run-status route requires owner/admin access and rejects cross-origin reads', async t => {
  const vault = await disposableVault();
  const priorPath = process.env.PATH, priorRemote = process.env.MDB_DASHBOARD_REMOTE_ADMIN;
  const fakeBin = path.join(vault.root, 'fake-bin'); await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nprintf "state = running\\npid = 43\\n"\nexit 0\n', { mode: 0o700 });
  process.env.PATH = fakeBin + path.delimiter + (priorPath ?? ''); process.env.MDB_DASHBOARD_REMOTE_ADMIN = 'true';
  const view = await createDashboardCredential(vault.root, { label: 'dream-view', mode: 'view' });
  const admin = await createDashboardCredential(vault.root, { label: 'dream-admin', mode: 'admin' });
  let dashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  try {
    dashboard = await createDashboardServer({ engram: vault.engram, token: 'a'.repeat(64), idleMs: 60_000 });
    const base = 'http://127.0.0.1:' + dashboard.port + '/api/dream/run-status';
    const request = (token: string, origin?: string) => fetch(base, { headers: { Authorization: 'Bearer ' + token, ...(origin ? { Origin: origin } : {}) } });
    const owner = await request(dashboard.token); assert.equal(owner.status, 200);
    const body = await owner.json() as any; assert.equal(body.scheduler.worker.running, true); assert.equal(body.nextRun.time, null); assert.match(body.nextRun.whyLater, /No schedule configured/);
    assert.equal((await request(view.token)).status, 403);
    assert.equal((await request(admin.token)).status, 200);
    assert.equal((await request(dashboard.token, 'http://evil.invalid')).status, 403);
  } finally {
    await dashboard?.close(); await vault.cleanup();
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorRemote === undefined) delete process.env.MDB_DASHBOARD_REMOTE_ADMIN; else process.env.MDB_DASHBOARD_REMOTE_ADMIN = priorRemote;
  }
});
