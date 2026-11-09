import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardBanner, announceDashboard } from '../../packages/dashboard/announce.js';

test('banner lists every URL with its token and the first-run hint', () => {
  const text = dashboardBanner({ urls: ['http://127.0.0.1:4871/#t=abc'], passwordSet: false });
  assert.match(text, /http:\/\/127\.0\.0\.1:4871\/#t=abc/);
  assert.match(text, /set your dashboard password/);
  assert.match(dashboardBanner({ urls: ['x'], passwordSet: true }), /Sign in with your dashboard password/);
});

test('private client note still produces a macOS alert without writing the token to stderr', () => {
  const old = { note: process.env.MDB_DASHBOARD_TOKEN_NOTE, alert: process.env.MDB_DASHBOARD_ALERT, nodeEnv: process.env.NODE_ENV };
  process.env.MDB_DASHBOARD_TOKEN_NOTE = '/private/client-dashboard.txt'; delete process.env.MDB_DASHBOARD_ALERT; process.env.NODE_ENV = 'test';
  const writes: string[] = [], originalWrite = process.stderr.write.bind(process.stderr); let calls = 0;
  const fake = ((command: string, args: string[]) => { calls++; assert.equal(command, 'osascript'); assert.ok(args.some(arg => arg.includes('http://127.0.0.1:4872/#t=private-token'))); assert.ok(args.some(arg => arg.includes('First run: open this URL'))); return { on: () => ({ unref() {} }), unref() {} }; }) as never;
  process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    announceDashboard({ urls: ['http://127.0.0.1:4872/#t=private-token'], passwordSet: false }, 'darwin', fake);
    assert.equal(calls, 1); assert.deepEqual(writes, []);
    process.env.MDB_DASHBOARD_ALERT = 'false'; announceDashboard({ urls: ['http://127.0.0.1:4872/#t=private-token'], passwordSet: false }, 'darwin', fake);
    assert.equal(calls, 1); assert.deepEqual(writes, []);
    delete process.env.MDB_DASHBOARD_ALERT;
    announceDashboard({ urls: ['http://127.0.0.1:4872/#t=private-token'], passwordSet: false }, 'linux', fake);
    assert.equal(calls, 1); assert.deepEqual(writes, []);
    delete process.env.MDB_DASHBOARD_TOKEN_NOTE;
    announceDashboard({ urls: ['http://127.0.0.1:4872/#t=private-token'], passwordSet: false }, 'linux', fake);
    assert.deepEqual(writes, [dashboardBanner({ urls: ['http://127.0.0.1:4872/#t=private-token'], passwordSet: false })]);
  } finally {
    process.stderr.write = originalWrite;
    for (const [key, value] of [['MDB_DASHBOARD_TOKEN_NOTE', old.note], ['MDB_DASHBOARD_ALERT', old.alert], ['NODE_ENV', old.nodeEnv]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
