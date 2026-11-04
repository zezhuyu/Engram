import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseStrictJson } from '../scripts/lib/strict-json.js';
import { assertSyntheticEvidenceAllowed, evaluateReleaseEvidence } from '../scripts/lib/release-evaluation.js';
import { suiteReportConsistent } from '../scripts/lib/release-policy.js';
import { suiteEvidenceStatus } from '../scripts/lib/release-policy.js';
import { inventoryDrift } from '../scripts/lib/suite-inventory.js';
import { loadSuiteReport } from '../scripts/lib/suite.js';
import { getSkipClassification, skipClassificationHash, skipClassificationId } from '../scripts/lib/skip-classifications.js';
import { createReleaseFixture } from './helpers/release-fixture.js';

function hasForbiddenKeys(text: string): boolean {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && text[i] !== '\ufeff') i++; };
  const string = (): string => { const start = i++; while (i < text.length) { const c = text[i++]!; if (c === '\\') i++; else if (c === '"') return JSON.parse(text.slice(start, i)) as string; } throw new Error('bad test JSON'); };
  const value = (): boolean => {
    ws();
    if (text[i] === '{') {
      i++; ws(); const keys = new Set<string>(); if (text[i] === '}') { i++; return false; }
      while (true) { ws(); const key = string(); if (key === '__proto__' || keys.has(key)) return true; keys.add(key); ws(); i++; const bad = value(); if (bad) return true; ws(); const sep = text[i++]!; if (sep === '}') return false; }
    }
    if (text[i] === '[') { i++; ws(); if (text[i] === ']') { i++; return false; } while (true) { const bad = value(); if (bad) return true; ws(); const sep = text[i++]!; if (sep === ']') return false; } }
    if (text[i] === '"') { string(); return false; }
    while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
    return false;
  };
  return value();
}

test('strict JSON rejects duplicate keys at every depth, escaped duplicates, dangerous keys and malformed JSON', () => {
  for (const json of ['{"a":1,"a":2}', '{"x":[{"a":1,"a":2}]}', '{"a":1,"\\u0061":2}', '{"__proto__":{}}', '{"a":1} trailing', '{"a":NaN}', '\ufeff{"a":1}']) {
    assert.throws(() => parseStrictJson(json, 'test input'), /test input/);
  }
  assert.deepEqual(parseStrictJson('{"ok":[1,true,null]}', 'test input'), { ok: [1, true, null] });
});

test('strict JSON matches JSON.parse for deterministic one-character mutations', () => {
  let seed = 0x61c88647;
  const random = (max: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
  const valid = ['{"a":1,"b":[true,false,null]}', '["text",-3.25e+2,{"nested":{"x":"y"}}]', '{"unicode":"\\u2603","empty":[]}'];
  const chars = '{}[],:"\\0123456789.eE+- abctruefalsnul';
  for (let n = 0; n < 450; n++) {
    const source = valid[n % valid.length]!;
    const operation = n % 3;
    const at = random(source.length + 1);
    const mutation = operation === 0 ? source.slice(0, at) + chars[random(chars.length)] + source.slice(at)
      : operation === 1 && at < source.length ? source.slice(0, at) + source.slice(at + 1)
        : source.slice(0, at) + chars[random(chars.length)] + source.slice(at + 1);
    let expected: unknown; let jsonAccepts = true;
    try { expected = JSON.parse(mutation) as unknown; } catch { jsonAccepts = false; }
    const shouldAccept = jsonAccepts && !hasForbiddenKeys(mutation);
    let actual: unknown; let strictAccepts = true;
    try { actual = parseStrictJson(mutation, `mutation ${n}`); } catch { strictAccepts = false; }
    assert.equal(strictAccepts, shouldAccept, `mutation ${n}: ${JSON.stringify(mutation)}`);
    if (strictAccepts) assert.deepEqual(actual, expected, `mutation ${n}`);
  }
});

test('strict JSON handles malformed numeric/string edges, BOM, empty input, deep nesting and large numbers', () => {
  for (const input of ['[x,1]', '{"a":foo1}', '[1 2]', '[1,]', '{"a":1,}', '01', '-01', '-', '1.', '.5', '1e', '"line\nfeed"', '\ufeff{}', '']) {
    assert.throws(() => parseStrictJson(input, 'edge input'), Error, input);
  }
  assert.deepEqual(parseStrictJson('"\\ud800"', 'lone surrogate'), JSON.parse('"\\ud800"'));
  assert.deepEqual(parseStrictJson('1e400', 'huge number'), JSON.parse('1e400'));
  const deeplyNested = `${'['.repeat(1000)}0${']'.repeat(1000)}`;
  assert.throws(() => parseStrictJson(deeplyNested, 'deep nesting'), (error: unknown) => error instanceof Error && !(error instanceof RangeError) && /nesting depth exceeded/.test(error.message));
});

test('TMPDIR cannot grant fixture trust, including relative and symlinked paths', async () => {
  const base = await mkdtemp(path.resolve('.engram-trust-'));
  const cwd = process.cwd(); const oldTmp = process.env.TMPDIR; const oldFixture = process.env.MDB_RELEASE_FIXTURE;
  try {
    const fake = path.join(base, 'fake'); await mkdir(fake); await writeFile(path.join(fake, 'evidence.json'), '{"synthetic":true}');
    process.env.MDB_RELEASE_FIXTURE = '1'; process.env.TMPDIR = fake; process.chdir(fake);
    await assert.rejects(assertSyntheticEvidenceAllowed(fake), /synthetic evidence rejected/);
    process.chdir(cwd);
    const link = path.join(base, 'tmp-link'); await symlink(fake, link, 'dir'); process.env.TMPDIR = link; process.chdir(link);
    await assert.rejects(assertSyntheticEvidenceAllowed(fake), /synthetic evidence rejected/);
    process.chdir(cwd); process.env.TMPDIR = 'relative/../fake';
    await assert.rejects(assertSyntheticEvidenceAllowed(fake), /synthetic evidence rejected/);
    process.env.TMPDIR = `${base}/fake/..`; process.chdir(fake);
    await assert.rejects(assertSyntheticEvidenceAllowed(fake), /synthetic evidence rejected/);
  } finally { process.chdir(cwd); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; if (oldFixture === undefined) delete process.env.MDB_RELEASE_FIXTURE; else process.env.MDB_RELEASE_FIXTURE = oldFixture; await rm(base, { recursive: true, force: true }); }
});

test('evidence symlinks, broken links, loops, and symlinked subdirectories fail closed with path', async () => {
  const fixture = await createReleaseFixture(); const cwd = process.cwd(); const old = process.env.MDB_RELEASE_FIXTURE;
  try {
    process.env.MDB_RELEASE_FIXTURE = '1'; process.chdir(fixture.root);
    for (const [name, target, kind] of [['file-link.json', 'release-gate-statuses.json', 'file'], ['broken.json', 'missing.json', 'file'], ['loop.json', 'loop.json', 'file'], ['dir-link', '.', 'dir']] as const) {
      const link = path.join(fixture.root, name); await symlink(target, link, kind);
      await assert.rejects(assertSyntheticEvidenceAllowed(fixture.root), new RegExp(name.replace('.', '\\.')));
      await rm(link, { force: true, recursive: true });
    }
    const link = path.join(fixture.root, 'real-read-link.json'); await symlink('release-gate-statuses.json', link);
    await assert.rejects(evaluateReleaseEvidence(fixture.root, 'core-beta', fixture.provenance), /real-read-link\.json/);
    await rm(link);
  } finally { process.chdir(cwd); if (old === undefined) delete process.env.MDB_RELEASE_FIXTURE; else process.env.MDB_RELEASE_FIXTURE = old; await rm(fixture.root, { recursive: true, force: true }); }
});

test('missing evidence roots and report subdirectories remain NOT_RUN with a clear reason', async () => {
  const sourceRoot = process.cwd();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'engram-missing-release-evidence-'));
  const directories = ['.github', 'bin', 'ci', 'deploy', 'docs', 'fixtures', 'integrations', 'linux', 'macos', 'packages', 'scripts', 'skills', 'tests'];
  const rootFiles = ['.dockerignore', '.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json'];
  try {
    for (const entry of [...directories, ...rootFiles, 'node_modules']) await symlink(path.join(sourceRoot, entry), path.join(temporaryRoot, entry));
    const runMissingEvidence = (createRoot: boolean) => {
      if (createRoot) mkdirSync(path.join(temporaryRoot, 'verification'));
      const result = spawnSync(process.execPath, [path.join(sourceRoot, 'dist/scripts/verify-release.js'), '--profile=core-beta'], {
        cwd: temporaryRoot, encoding: 'utf8', timeout: 120_000,
        env: { PATH: process.env.PATH ?? '', MDB_RELEASE_PROFILE: 'core-beta' }
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      assert.equal(result.error, undefined, output);
      assert.notEqual(result.status, 0, 'missing required release evidence must keep the gate non-PASS');
      assert.match(output, /suite report is missing/);
      assert.doesNotMatch(output, /\n\s+at (?:async )?.*\.(?:js|ts):\d+/);
      const reportText = readFileSync(path.join(temporaryRoot, 'verification/release-report.json'), 'utf8');
      const report = JSON.parse(reportText) as { gates: Array<{ id: string; status: string }>; verdict: Record<string, string> };
      assert.equal(report.gates.find(gate => gate.id === 'S2')?.status, 'NOT_RUN');
      assert.notEqual(report.verdict.STORAGE, 'PASS');
      assert.equal(suiteEvidenceStatus(undefined), 'NOT_RUN');
      assert.deepEqual(inventoryDrift(undefined, { minimumTests: 1, requiredTests: ['one'], requiredCases: [] }), ['suite report is missing']);
    };
    runMissingEvidence(false);
    rmSync(path.join(temporaryRoot, 'verification'), { recursive: true, force: true });
    runMissingEvidence(true);
    const missingReportPath = path.join(temporaryRoot, 'verification', 'missing-suite', 'report.json');
    assert.equal(await loadSuiteReport(missingReportPath), undefined);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('release verifier turns extreme JSON nesting into a normal no-go report', async () => {
  const sourceRoot = process.cwd();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'engram-deep-release-evidence-'));
  const directories = ['.github', 'bin', 'ci', 'deploy', 'docs', 'fixtures', 'integrations', 'linux', 'macos', 'packages', 'scripts', 'skills', 'tests'];
  const rootFiles = ['.dockerignore', '.gitignore', 'AGENTS.md', 'Makefile', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json'];
  try {
    for (const entry of directories) await symlink(path.join(sourceRoot, entry), path.join(temporaryRoot, entry), 'dir');
    for (const entry of rootFiles) await symlink(path.join(sourceRoot, entry), path.join(temporaryRoot, entry));
    await mkdir(path.join(temporaryRoot, 'verification'));
    await writeFile(path.join(temporaryRoot, 'verification', 'deep.json'), `${'['.repeat(100_000)}0${']'.repeat(100_000)}`);
    const result = spawnSync(process.execPath, [path.join(sourceRoot, 'dist/scripts/verify-release.js'), '--profile=core-beta'], {
      cwd: temporaryRoot, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH ?? '', MDB_RELEASE_PROFILE: 'core-beta' }
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, output);
    assert.notEqual(result.status, 0, 'invalid deeply nested evidence must keep the candidate non-releasable');
    assert.doesNotMatch(output, /RangeError|\n\s+at (?:async )?.*\.js:\d+/);
    const report = JSON.parse(readFileSync(path.join(temporaryRoot, 'verification/release-report.json'), 'utf8')) as { decision: string; releaseLevel: string; releasePolicy: { blockers: string[] } };
    assert.equal(report.decision, 'NO-GO');
    assert.equal(report.releaseLevel, 'NOT_RELEASABLE');
    assert.ok(report.releasePolicy.blockers.some(blocker => /nesting depth exceeded/.test(blocker)));
    assert.match(output, /=> NO-GO/);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('evidence walker promptly ignores FIFO and Unix socket entries', { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-special-evidence-'));
  const fifo = path.join(root, 'pipe.json'); const socketPath = path.join(root, 'socket.json');
  const server = createServer();
  try {
    execFileSync('mkfifo', [fifo]);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const started = Date.now();
    await assertSyntheticEvidenceAllowed(root);
    assert.ok(Date.now() - started < 4500, 'special entries are ignored without opening or blocking on them');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('requiredByProfiles controls explained skips, and mandatory skipped tests never pass', () => {
  const name = 'real model: wiki synthesis and critic return schema-valid, evidence-bound, review-gated output';
  const classification = getSkipClassification(`intelligence/${name}`)!;
  const original = classification.requiredByProfiles;
  for (const profile of ['core-beta', 'full-intelligence-beta', 'ga'] as const) {
    const requirements = { minimumTests: 1, requiredTests: [name], requiredCases: [], casesByPlatform: { linux: [] }, allowedSkippedTests: { linux: [{ name, classificationId: skipClassificationId(classification.suite, classification.test), classificationHash: skipClassificationHash(classification) }] } };
    const report = { suite: 'intelligence', status: 'SKIPPED', exitCode: 0, counts: { pass: 0, fail: 0, skipped: 1, total: 1 }, tests: [{ name, status: 'SKIPPED' }], cases: 0, caseDetails: [], caseFailures: [], environment: { platform: 'linux' } };
    const applicable = original.includes(profile);
    assert.equal(suiteReportConsistent(report, requirements, true, profile), applicable, `${profile} classification applicability`);
    assert.equal(suiteEvidenceStatus(report), 'SKIPPED', `${profile} explained skip stays visible as SKIPPED`);
    assert.equal(suiteReportConsistent({ ...report, status: 'PASS' }, requirements, true, profile), false, `${profile} mandatory skip must not produce PASS`);
  }
});

test('report status, skip classification, pending allowance and profile preserve SKIPPED evidence', () => {
  const name = 'real model: wiki synthesis and critic return schema-valid, evidence-bound, review-gated output';
  const classification = getSkipClassification(`intelligence/${name}`)!;
  const id = skipClassificationId(classification.suite, classification.test);
  const allowItem = { name, classificationId: id, classificationHash: skipClassificationHash(classification) };
  const profiles = ['core-beta', 'full-intelligence-beta', 'ga'] as const;
  const skipKinds = ['none', 'classified-for-profile', 'classified-for-other-profile', 'unclassified'] as const;
  const statuses = ['PASS', 'SKIPPED', 'FAIL', 'NOT_RUN'] as const;
  for (const profile of profiles) for (const status of statuses) for (const skipKind of skipKinds) for (const allowPending of [false, true]) {
    const hasSkip = skipKind !== 'none';
    const classified = skipKind === 'classified-for-profile' || skipKind === 'classified-for-other-profile';
    const classificationApplies = classification.requiredByProfiles.includes(profile);
    const inScope = skipKind !== 'classified-for-other-profile' || !classificationApplies;
    const reportStatus = status === 'NOT_RUN' ? 'NOT_RUN' : status;
    const tests = reportStatus === 'NOT_RUN' ? [] : hasSkip
      ? [{ name, status: 'SKIPPED' }]
      : [{ name, status: 'PASS' }];
    const report = {
      suite: 'intelligence', status: reportStatus, exitCode: reportStatus === 'FAIL' ? 1 : reportStatus === 'NOT_RUN' ? null : 0,
      counts: { pass: hasSkip || reportStatus === 'NOT_RUN' ? 0 : 1, fail: 0, skipped: hasSkip ? 1 : 0, total: tests.length },
      tests, cases: 0, caseDetails: [], caseFailures: [], environment: { platform: 'linux' }
    };
    const requirements = {
      minimumTests: 1, requiredTests: [name], requiredCases: [], casesByPlatform: { linux: [] },
      allowedSkippedTests: { linux: hasSkip && classified && inScope ? [allowItem] : [] }
    };
    const expectedEvidenceStatus = reportStatus === 'PASS' && hasSkip ? 'SKIPPED' : reportStatus;
    const expectedConsistent = reportStatus !== 'NOT_RUN' && !(reportStatus === 'PASS' && hasSkip)
      && (!hasSkip || classified && inScope && classificationApplies && allowPending);
    const label = `${status}/${skipKind}/allowPending=${allowPending}/${profile}`;
    assert.equal(suiteReportConsistent(report, requirements, allowPending, profile), expectedConsistent, `${label} consistency`);
    assert.equal(suiteEvidenceStatus(report), expectedEvidenceStatus, `${label} evidenceStatus`);
  }
});

test.todo('KNOWN_GAP reviewer authenticity not enforced: forged reviewedBy plus recomputed hash is still accepted');
