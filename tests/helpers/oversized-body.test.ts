import test from 'node:test';
import assert from 'node:assert/strict';
import { oversizedBodyConnectionCode } from './oversized-body.js';

test('oversized body helper accepts only fetch connection rejections from known socket codes', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']) {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code }) });
    assert.equal(oversizedBodyConnectionCode(error), code);
  }
  assert.equal(oversizedBodyConnectionCode(new TypeError('fetch failed', { cause: Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) })), undefined);
  assert.equal(oversizedBodyConnectionCode(new Error('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })), undefined);
  assert.equal(oversizedBodyConnectionCode(new TypeError('aborted', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })), undefined);
});
