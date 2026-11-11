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

test('once a password is set there is no pop-up and no token URL anywhere; first run still shows both', () => {
  const old = { note: process.env.MDB_DASHBOARD_TOKEN_NOTE, alert: process.env.MDB_DASHBOARD_ALERT, nodeEnv: process.env.NODE_ENV };
  delete process.env.MDB_DASHBOARD_TOKEN_NOTE; delete process.env.MDB_DASHBOARD_ALERT; process.env.NODE_ENV = 'test';
  const url = 'http://127.0.0.1:4871/#t=private-setup-token';
  const writes: string[] = [], originalWrite = process.stderr.write.bind(process.stderr); let alerts = 0;
  const fake = (() => { alerts++; return { on: () => ({ unref: () => undefined }), unref: () => undefined }; }) as never;
  process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    announceDashboard({ urls: [url], passwordSet: true }, 'darwin', fake);
    assert.equal(alerts, 0, 'no native alert when a password exists');
    assert.equal(writes.join('').includes('private-setup-token'), false, 'the token is never printed once a password exists');
    assert.match(writes.join(''), /127\.0\.0\.1:4871\//); assert.match(writes.join(''), /Sign in with your dashboard password/);
    assert.equal(dashboardBanner({ urls: [url], passwordSet: true }).includes('#t='), false);
    announceDashboard({ urls: [url], passwordSet: false }, 'darwin', fake);
    assert.equal(alerts, 1, 'first run still pops up the window');
    process.env.MDB_DASHBOARD_TOKEN_NOTE = '/private/note.txt'; writes.length = 0;
    announceDashboard({ urls: [url], passwordSet: true }, 'darwin', fake);
    assert.equal(alerts, 1); assert.deepEqual(writes, [], 'a supervised client with a password set writes nothing');
  } finally {
    process.stderr.write = originalWrite;
    for (const [key, value] of [['MDB_DASHBOARD_TOKEN_NOTE', old.note], ['MDB_DASHBOARD_ALERT', old.alert], ['NODE_ENV', old.nodeEnv]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
