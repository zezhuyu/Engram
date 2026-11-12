import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { archiveAttestationMatches, currentSourceEvidence } from '../scripts/lib/source-evidence.js';
import { releaseTreeStateValid, suiteReportConsistent } from '../scripts/lib/release-policy.js';

async function fixture(git = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-provenance-'));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts', 'tracked.ts'), 'one\n');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root });
    execFileSync('git', ['add', 'scripts/tracked.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  }
  return root;
}

test('tracked HEAD bytes yield clean tree provenance; modified and staged bytes are dirty', async () => {
  const root = await fixture();
  try {
    const clean = await currentSourceEvidence(root) as Awaited<ReturnType<typeof currentSourceEvidence>> & { treeState?: { state: string; headTreeMatches: boolean } };
    assert.equal(clean.treeState?.state, 'clean');
    assert.equal(clean.treeState?.headTreeMatches, true);
    await writeFile(path.join(root, 'scripts/tracked.ts'), 'two\n');
    assert.equal((await currentSourceEvidence(root) as typeof clean).treeState?.state, 'dirty');
    execFileSync('git', ['add', 'scripts/tracked.ts'], { cwd: root });
    assert.equal((await currentSourceEvidence(root) as typeof clean).treeState?.state, 'dirty');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('untracked fingerprinted source is dirty and no-git roots are identified', async () => {
  const root = await fixture();
  const archive = await fixture(false);
  try {
    await writeFile(path.join(root, 'scripts', 'new.ts'), 'new');
    assert.equal(((await currentSourceEvidence(root)) as any).treeState?.state, 'dirty');
    assert.equal(((await currentSourceEvidence(archive)) as any).treeState?.state, 'no-git');
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(archive, { recursive: true, force: true })]); }
});

test('ignored untracked files do not enter the fingerprinted source set', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, '.git', 'info', 'exclude'), 'scripts/ignored.ts\n');
    await writeFile(path.join(root, 'scripts', 'ignored.ts'), 'included in evidence');
    const evidence = await currentSourceEvidence(root);
    assert.equal(evidence.files['scripts/ignored.ts'], undefined);
    assert.deepEqual(evidence.treeState.untracked, []);
    assert.equal(evidence.treeState.state, 'clean');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mode changes are dirty; deleted tracked files remain errors', async () => {
  const root = await fixture();
  try {
    const file = path.join(root, 'scripts', 'tracked.ts');
    const { chmod, unlink } = await import('node:fs/promises');
    await chmod(file, 0o755);
    assert.equal((await currentSourceEvidence(root)).treeState.state, 'dirty');
    await unlink(file);
    await assert.rejects(currentSourceEvidence(root), /Required tracked source is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tracked files replaced by symlinks are explicitly reported as dirty', async () => {
  const root = await fixture();
  try {
    const file = path.join(root, 'scripts', 'tracked.ts');
    const { unlink, symlink } = await import('node:fs/promises');
    await unlink(file);
    await symlink(path.join(root, 'README.md'), file);
    const evidence = await currentSourceEvidence(root);
    assert.equal(evidence.treeState.state, 'dirty');
    assert.equal(evidence.treeState.reasonCode, 'SYMLINK_IN_SOURCE');
    assert.deepEqual(evidence.treeState.symlinks, ['scripts/tracked.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tracked hardlinks inside fingerprinted source are dirty with HARDLINK_IN_SOURCE', async () => {
  const root = await fixture();
  const { link } = await import('node:fs/promises');
  try {
    await link(path.join(root, 'scripts', 'tracked.ts'), path.join(root, 'scripts', 'alias.ts'));
    const evidence = await currentSourceEvidence(root);
    assert.equal(evidence.treeState.state, 'dirty');
    assert.equal(evidence.treeState.reasonCode, 'HARDLINK_IN_SOURCE');
    assert.deepEqual(evidence.treeState.hardlinks, ['scripts/alias.ts', 'scripts/tracked.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('gitlink beneath fingerprinted source fails closed', async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, 'scripts', 'module'));
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},scripts/module`], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add gitlink'], { cwd: root });
    await assert.rejects(currentSourceEvidence(root), /Required tracked source is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sparse checkout omitting a fingerprinted tracked path fails closed', async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, 'packages'));
    await writeFile(path.join(root, 'packages', 'required.ts'), 'required\n');
    execFileSync('git', ['add', 'packages/required.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add second source directory'], { cwd: root });
    execFileSync('git', ['sparse-checkout', 'init', '--cone'], { cwd: root });
    execFileSync('git', ['sparse-checkout', 'set', 'packages'], { cwd: root });
    await assert.rejects(currentSourceEvidence(root), /Required tracked source is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked Git worktree has normal clean checkout provenance', async () => {
  const root = await fixture(); const linked = `${root}-linked`;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: root });
    const evidence = await currentSourceEvidence(linked);
    assert.equal(evidence.treeState.state, 'clean');
    assert.equal(evidence.treeState.headTreeMatches, true);
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: root }); } catch { /* cleanup fallback below */ }
    await Promise.all([rm(root, { recursive: true, force: true }), rm(linked, { recursive: true, force: true })]);
  }
});

test('archive attestation requires matching fingerprint, valid hashes, and unique strict JSON keys', () => {
  const fingerprint = 'a'.repeat(64);
  const record = { fingerprint, git_commit: 'b'.repeat(40), archive_sha256: 'c'.repeat(64), created_by: 'ci', created_at: '2026-11-04T12:00:00.000Z' };
  assert.equal(archiveAttestationMatches(JSON.stringify(record), fingerprint), true);
  assert.equal(archiveAttestationMatches(JSON.stringify(record), 'd'.repeat(64)), false);
  assert.equal(archiveAttestationMatches(JSON.stringify({ ...record, extra: true }), fingerprint), false);
  assert.equal(archiveAttestationMatches(`{"fingerprint":"${fingerprint}","fingerprint":"${fingerprint}","git_commit":"${record.git_commit}","archive_sha256":"${record.archive_sha256}"}`, fingerprint), false);
  assert.equal(archiveAttestationMatches('{', fingerprint), false);
});

test('archive attestation rejects wrong JSON types and oversized or deeply nested input', () => {
  const fingerprint = 'a'.repeat(64);
  const record = { fingerprint, git_commit: 'b'.repeat(40), archive_sha256: 'c'.repeat(64), created_by: 'ci', created_at: '2026-11-04T12:00:00.000Z' };
  for (const key of Object.keys(record) as (keyof typeof record)[]) {
    for (const invalid of [null, [], 7, { nested: true }]) {
      assert.equal(archiveAttestationMatches(JSON.stringify({ ...record, [key]: invalid }), fingerprint), false, `${key} rejects ${JSON.stringify(invalid)}`);
    }
  }
  assert.equal(archiveAttestationMatches(JSON.stringify({ ...record, git_commit: [record.git_commit] }), fingerprint), false, 'an array coercible to a valid commit string is still the wrong JSON type');
  assert.equal(archiveAttestationMatches(JSON.stringify({ ...record, archive_sha256: [record.archive_sha256] }), fingerprint), false, 'an array coercible to a valid digest string is still the wrong JSON type');
  assert.equal(archiveAttestationMatches(`${JSON.stringify(record)}${' '.repeat(1024 * 1024)}`, fingerprint), false, 'input above the one MiB bound is rejected');
  assert.equal(archiveAttestationMatches(`${'{"nested":'.repeat(300)}null${'}'.repeat(300)}`, fingerprint), false, 'deep nesting is rejected');
});

test('Unix sockets and FIFOs under fingerprinted source fail closed', async () => {
  const root = await fixture();
  const socketPath = path.join(root, 'scripts', 'listener.sock');
  const fifoPath = path.join(root, 'scripts', 'pipe');
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await assert.rejects(currentSourceEvidence(root), /Unsupported special file in fingerprinted source: scripts\/listener\.sock/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    execFileSync('mkfifo', [fifoPath]);
    await assert.rejects(currentSourceEvidence(root), /Unsupported special file in fingerprinted source: scripts\/pipe/);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('release suite consistency requires recorded tree provenance', () => {
  const inventory = { minimumTests: 1, requiredTests: ['case'], requiredCases: [] };
  const report = { status: 'PASS', exitCode: 0, counts: { pass: 1, fail: 0, skipped: 0, total: 1 }, tests: [{ name: 'case', status: 'PASS' }], cases: 0, caseDetails: [], caseFailures: [] };
  assert.equal(suiteReportConsistent(report, inventory, true, undefined, true), false);
  assert.equal(suiteReportConsistent({ ...report, treeState: 'dirty' }, inventory, true, undefined, true), false);
  assert.equal(suiteReportConsistent({ ...report, treeState: 'clean' }, inventory, true, undefined, true), true);
  assert.equal(releaseTreeStateValid(undefined), false);
  assert.equal(releaseTreeStateValid('dirty'), false);
  assert.equal(releaseTreeStateValid('clean'), true);
  assert.equal(releaseTreeStateValid('no-git'), true, 'no-git reports are usable only when the candidate-level archive attestation passes');
});

test('every symlink under a fingerprinted source path makes provenance dirty with an explicit reason', async () => {
  const root = await fixture();
  const { symlink } = await import('node:fs/promises');
  try {
    await symlink('tracked.ts', path.join(root, 'scripts', 'file-link.ts'));
    await symlink('missing-target', path.join(root, 'scripts', 'broken-link.ts'));
    await symlink('loop-b', path.join(root, 'scripts', 'loop-a'));
    await symlink('loop-a', path.join(root, 'scripts', 'loop-b'));
    await symlink(os.tmpdir(), path.join(root, 'scripts', 'outside-dir'));
    const evidence = await currentSourceEvidence(root);
    assert.equal(evidence.treeState.state, 'dirty');
    assert.equal((evidence.treeState as typeof evidence.treeState & { reasonCode?: string }).reasonCode, 'SYMLINK_IN_SOURCE');
    assert.deepEqual((evidence.treeState as typeof evidence.treeState & { symlinks?: string[] }).symlinks, [
      'scripts/broken-link.ts', 'scripts/file-link.ts', 'scripts/loop-a', 'scripts/loop-b', 'scripts/outside-dir'
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tracked symlink is explicitly reported as dirty', async () => {
  const root = await fixture();
  const { unlink, symlink } = await import('node:fs/promises');
  try {
    await unlink(path.join(root, 'scripts', 'tracked.ts'));
    await symlink('README.md', path.join(root, 'scripts', 'tracked.ts'));
    const evidence = await currentSourceEvidence(root);
    assert.equal(evidence.treeState.state, 'dirty');
    assert.equal((evidence.treeState as typeof evidence.treeState & { reasonCode?: string }).reasonCode, 'SYMLINK_IN_SOURCE');
  } finally { await rm(root, { recursive: true, force: true }); }
});
