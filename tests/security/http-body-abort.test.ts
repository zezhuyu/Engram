import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { readHttpBody } from '../../packages/mcp/index.js';
import { FairRequestAdmission } from '../../packages/mcp/http-admission.js';

/** A request stand-in with the few members readHttpBody touches. */
function fakeRequest(headers: Record<string, string> = {}) {
  const request = new EventEmitter() as EventEmitter & { headers: Record<string, string>; readableEnded: boolean; pause(): void };
  request.headers = headers; request.readableEnded = false; request.pause = () => undefined;
  return request;
}
const asRequest = (request: ReturnType<typeof fakeRequest>) => request as unknown as IncomingMessage;
const listeners = (request: EventEmitter) => ['data', 'end', 'error', 'aborted', 'close'].reduce((count, name) => count + request.listenerCount(name), 0);

test('a body that completes normally still parses, and no listeners remain', async () => {
  const request = fakeRequest(); const body = readHttpBody(asRequest(request));
  request.emit('data', Buffer.from('{"v":')); request.emit('data', Buffer.from('1}')); request.readableEnded = true; request.emit('end'); request.emit('close');
  assert.deepEqual(await body, { v: 1 });
  assert.equal(listeners(request), 0);
});

test('a client that disconnects mid-body settles the read instead of waiting forever', async () => {
  for (const event of ['aborted', 'close']) {
    const request = fakeRequest(); const body = readHttpBody(asRequest(request));
    request.emit('data', Buffer.from('{"partial"'));
    request.emit(event);
    await assert.rejects(body, (error: Error & { statusCode?: number; clientAborted?: boolean }) => error.statusCode === 400 && error.clientAborted === true, event);
    assert.equal(listeners(request), 0, `${event} unhooks every listener`);
  }
});

test('a sender that stalls without closing is cut off by the body timeout', async () => {
  const request = fakeRequest(); const started = Date.now();
  await assert.rejects(readHttpBody(asRequest(request), 1024, 40), (error: Error & { statusCode?: number }) => error.statusCode === 408);
  assert.ok(Date.now() - started < 1000); assert.equal(listeners(request), 0);
});

test('oversized bodies are still refused before and during the read', async () => {
  await assert.rejects(readHttpBody(asRequest(fakeRequest({ 'content-length': '5000' })), 1024), (error: Error & { statusCode?: number }) => error.statusCode === 413);
  const request = fakeRequest(); const body = readHttpBody(asRequest(request), 8);
  request.emit('data', Buffer.alloc(32));
  await assert.rejects(body, (error: Error & { statusCode?: number }) => error.statusCode === 413);
});

test('an interrupted request releases its admission permit, so the same principal is not locked out', async () => {
  const admission = new FairRequestAdmission(8, 1, 8);
  const handle = async (request: ReturnType<typeof fakeRequest>) => {
    const release = await admission.acquire('air-client'); if (!release) throw new Error('busy');
    try { return await readHttpBody(asRequest(request)); } finally { release(); }
  };
  const interrupted = fakeRequest(); const first = handle(interrupted).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  const waiting = fakeRequest(); const second = handle(waiting);              // queued behind the first (one permit per principal)
  interrupted.emit('data', Buffer.from('{')); interrupted.emit('close');       // the first client disconnects mid-body
  assert.equal(((await first) as { clientAborted?: boolean }).clientAborted, true);
  await new Promise(resolve => setImmediate(resolve));
  waiting.emit('data', Buffer.from('{"ok":true}')); waiting.readableEnded = true; waiting.emit('end');
  assert.deepEqual(await second, { ok: true });
});
