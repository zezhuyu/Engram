import test from 'node:test';
import assert from 'node:assert/strict';
import { FairRequestAdmission } from '../../packages/mcp/http-admission.js';

test('authenticated admission schedules principal queues round-robin', async () => {
  const admission = new FairRequestAdmission(1, 1, 8);
  const first = await admission.acquire('alpha'); assert.ok(first);
  const order: string[] = [];
  const a1 = admission.acquire('alpha').then(release => { assert.ok(release); order.push('alpha-1'); return release; });
  const a2 = admission.acquire('alpha').then(release => { assert.ok(release); order.push('alpha-2'); return release; });
  const b1 = admission.acquire('beta').then(release => { assert.ok(release); order.push('beta-1'); return release; });
  const b2 = admission.acquire('beta').then(release => { assert.ok(release); order.push('beta-2'); return release; });
  first(); const releaseA1 = await a1; releaseA1(); const releaseB1 = await b1;
  assert.deepEqual(order, ['alpha-1', 'beta-1'], 'the other principal is scheduled before alpha receives a second slot');
  releaseB1(); const releaseA2 = await a2; releaseA2(); const releaseB2 = await b2; releaseB2();
  assert.deepEqual(order, ['alpha-1', 'beta-1', 'alpha-2', 'beta-2']);
  assert.equal(admission.active, 0); assert.equal(admission.queued, 0);
});

test('authenticated admission bounds the wait queue and cancellation removes a waiter', async () => {
  const admission = new FairRequestAdmission(1, 1, 1);
  const first = await admission.acquire('one'); assert.ok(first);
  const controller = new AbortController();
  const cancelled = admission.acquire('one', controller.signal);
  assert.equal(admission.queued, 1);
  assert.equal(await admission.acquire('one'), undefined, 'overflow is refused without a permit');
  controller.abort(); assert.equal(await cancelled, undefined); assert.equal(admission.queued, 0);
  const next = admission.acquire('one'); first(); const releaseNext = await next; assert.equal(typeof releaseNext, 'function');
  releaseNext!(); assert.equal(admission.active, 0);
});
