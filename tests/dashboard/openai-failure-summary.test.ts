import test from 'node:test';
import assert from 'node:assert/strict';
import { safeGatewayLogLine } from '../../packages/dashboard/openai-tunnel.js';

test('gateway crash summaries select the error before the Node.js trailer and redact secrets', () => {
  const summary = safeGatewayLogLine('file:///tmp/keyed-gateway.mjs:25\n  throw new Error("no keys configured");\n        ^\n\nError: no keys configured\n    at file:///tmp/keyed-gateway.mjs:25:9\n\nNode.js v24.22.2');
  assert.equal(summary, 'No workspace keys are configured: add at least one workspace row below, then start the gateway.');
  assert.doesNotMatch(summary, /Node\.js v24/);
  assert.equal(safeGatewayLogLine('Error: api_key=super-secret\nNode.js v24.22.2'), 'Error: [redacted]');
  assert.equal(safeGatewayLogLine('throw new Error("token=secret");'), '[redacted]');
});
