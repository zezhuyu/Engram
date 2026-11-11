import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('dashboard model settings tests do not require claude or codex on PATH', () => {
  const testFile = fileURLToPath(new URL('./settings.test.js', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', testFile], { encoding: 'utf8', env, timeout: 180_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
