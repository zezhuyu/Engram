import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuite, summarize } from '../../scripts/lib/suite.js';

test('a suite with any skipped test reports SKIPPED and keeps successful process exit status', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-suite-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = path.join(process.cwd(), `.suite-status-${process.pid}.test.mjs`);
  t.after(() => fs.rm(fixture, { force: true }));
  await fs.writeFile(fixture, `import test from 'node:test';\ntest('optional prerequisite', { skip: true }, () => {});\ntest('ordinary assertion', () => {});\n`);

  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let report: Awaited<ReturnType<typeof runSuite>>;
  try {
    report = await runSuite({
      name: 'runner-status-regression', title: 'runner status regression', files: [fixture], gaps: [], limitations: []
    }, path.join(root, 'verification'));
  } finally {
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }

  assert.equal(report.status, 'SKIPPED');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.counts, { pass: 1, fail: 0, skipped: 1, total: 2 });
  assert.equal(report.tests.find(item => item.name === 'optional prerequisite')?.status, 'SKIPPED');
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    summarize(report);
    assert.equal(process.exitCode, undefined, 'a successful SKIPPED suite does not fail the verify command');
  } finally {
    process.exitCode = previousExitCode;
  }
});
