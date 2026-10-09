import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { queueRemoteCapture } from '../../packages/memory/remote-spool.js';
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
