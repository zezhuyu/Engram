import test from 'node:test';
import assert from 'node:assert/strict';
import { redactCaptureText, redactText } from '../../packages/memory/redact.js';

const adversarial = [
  ['url-scheme-backtracking', 'x'.repeat(900_000)],
  ['aws-token', 'AKIA'.repeat(225_000)],
  ['jwt-prefix', 'eyJ'.repeat(300_000)],
  ['openai-prefix', 'sk-'.repeat(300_000)],
  ['url-credentials', 'https://a:b@'.repeat(75_000)],
  ['bearer-prefix', 'Bearer '.repeat(130_000)],
  ['private-key-prefix', '-----BEGIN '.repeat(90_000)],
] as const;

test('credential redaction stays bounded on 900KB adversarial inputs', () => {
  for (const [name, input] of adversarial) {
    assert.ok(Buffer.byteLength(input) >= 900_000, `${name} must exercise the large-input path`);
    const started = performance.now();
    const result = redactText(input);
    const elapsedMs = performance.now() - started;
    assert.equal(typeof result, 'string');
    assert.ok(elapsedMs < 250, `${name} took ${elapsedMs.toFixed(1)}ms`);
  }
});

test('capture redaction bounds its scan and retains only a scrubbed prefix of oversized payloads', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const small = `${secret} ${'x'.repeat(30_000)}`;
  const retained = redactCaptureText(small);
  assert.equal(retained.length <= 20_000, true);
  assert.equal(retained.includes(secret), false);

  const oversized = `${secret}${'x'.repeat(1_048_576)}`;
  const oversizedRetained = redactCaptureText(oversized);
  assert.equal(oversizedRetained.length, 20_000);
  assert.equal(oversizedRetained.includes(secret), false);
  assert.match(oversizedRetained, /\[REDACTED\]/);
});

test('credential URL schemes and secret formats remain redacted', () => {
  const value = [
    'https://user:pass@example.test',
    'ftp://user:pass@example.test',
    'postgres://user:pass@example.test/db',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer example-token-value',
    '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----',
  ].join('\n');
  const result = redactText(value);
  for (const secret of ['user:pass', 'AKIAIOSFODNN7EXAMPLE', 'example-token-value', '-----BEGIN PRIVATE KEY-----secret']) {
    assert.equal(result.includes(secret), false, `secret format remained visible: ${secret.slice(0, 8)}`);
  }
});
