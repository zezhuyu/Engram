import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardBanner } from '../../packages/dashboard/announce.js';

test('banner lists every URL with its token and the first-run hint', () => {
  const text = dashboardBanner({ urls: ['http://127.0.0.1:4871/#t=abc'], passwordSet: false });
  assert.match(text, /http:\/\/127\.0\.0\.1:4871\/#t=abc/);
  assert.match(text, /set your dashboard password/);
  assert.match(dashboardBanner({ urls: ['x'], passwordSet: true }), /Sign in with your dashboard password/);
});
