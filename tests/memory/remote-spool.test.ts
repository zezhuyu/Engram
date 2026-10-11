import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { drainRemoteCaptureSpool, queueRemoteCapture } from '../../packages/memory/remote-spool.js';
import { tempDir } from '../helpers/host.js';
import { recordCase } from '../helpers/report.js';

// Regression from the multi-container run: 1100 concurrent hook processes left 1002 entries in a spool capped at 1000.
test('the remote capture spool never exceeds its cap under concurrent writers', async t => {
  const dir = path.join(await tempDir(t, 'spool-cap'), 'spool'); await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < 990; i++) await fs.writeFile(path.join(dir, `${String(i).padStart(14, '0')}-seed.json`), '{}');
  const attempts = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => queueRemoteCapture({ url: 'https://example.invalid/mcp', registrationId: 'reg', payload: { hook_event_name: 'PostToolUse', tool_use_id: `c${i}` }, directory: dir })));
  const entries = (await fs.readdir(dir)).filter(n => n.endsWith('.json')).length; const leftovers = (await fs.readdir(dir)).filter(n => n.endsWith('.tmp')).length;
  assert.ok(entries <= 1000, `spool holds ${entries} entries`); assert.equal(leftovers, 0);
  assert.ok(attempts.some(a => a.status === 'rejected'), 'writers beyond the cap are refused');
  recordCase({ suite: 'memory', name: 'remote-spool-cap-concurrent', status: 'PASS', detail: { entries } });
});

test('a revoked or rotated credential (401/403) keeps the backlog for re-authentication; only envelope-specific refusals are quarantined', async t => {
  const dir = path.join(await tempDir(t, 'spool-auth'), 'spool'); await fs.mkdir(dir, { recursive: true });
  let mode: 401 | 403 | 400 | 202 = 401; const seen: number[] = [];
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { seen.push(mode); res.writeHead(mode, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/capture`;
  for (let i = 0; i < 3; i++) await queueRemoteCapture({ url, registrationId: 'reg', payload: { hook_event_name: 'PostToolUse', tool_use_id: `a${i}` }, directory: dir });
  const queued = async () => (await fs.readdir(dir)).filter(n => n.endsWith('.json')).length;
  assert.equal(await queued(), 3);
  for (const status of [401, 403] as const) { mode = status; const r = await drainRemoteCaptureSpool({ token: 'revoked', directory: dir }); assert.deepEqual([r.delivered, r.rejected, r.queued], [0, 0, 3], `${status} keeps every envelope`); }
  await assert.rejects(() => fs.stat(path.join(dir, 'rejected')), /ENOENT/, 'nothing was quarantined');
  mode = 202; const ok = await drainRemoteCaptureSpool({ token: 'reissued', directory: dir }); assert.deepEqual([ok.delivered, ok.queued], [3, 0], 'after re-authentication the retained events are delivered');
  await queueRemoteCapture({ url, registrationId: 'reg', payload: { hook_event_name: 'PostToolUse', tool_use_id: 'bad' }, directory: dir });
  mode = 400; const bad = await drainRemoteCaptureSpool({ token: 'ok', directory: dir }); assert.deepEqual([bad.delivered, bad.rejected, bad.queued], [0, 1, 0], 'an envelope the server refuses as malformed is quarantined with its reason');
  recordCase({ suite: 'memory', name: 'spool-auth-failure-retains-backlog', status: 'PASS' });
});
