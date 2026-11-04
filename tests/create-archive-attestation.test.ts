import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArchiveAttestation, verifyArchiveAttestation } from '../scripts/create-archive-attestation.js';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-archive-attest-'));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts', 'source.ts'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root });
  execFileSync('git', ['add', 'scripts/source.ts'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

test('clean checked-out source creates an attested archive that verifies after extraction', async () => {
  const root = await repository();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'engram-archive-extract-'));
  const archive = path.join(temp, 'source.tar'), attestation = path.join(temp, 'attestation.json'), extracted = path.join(temp, 'extracted');
  try {
    const created = await createArchiveAttestation(root, archive, attestation);
    execFileSync('mkdir', ['-p', extracted]);
    execFileSync('tar', ['-xf', archive, '-C', extracted]);
    assert.equal((await verifyArchiveAttestation(extracted, archive, attestation, created.git_commit)).fingerprint, created.fingerprint);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(temp, { recursive: true, force: true })]); }
});

test('dirty source refuses to create an archive attestation', async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, 'scripts', 'source.ts'), 'changed\n');
    await assert.rejects(createArchiveAttestation(root, path.join(root, 'out.tar'), path.join(root, 'attestation.json')), /Refusing archive attestation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive digest, extracted fingerprint, expected commit, and strict duplicate-key parsing are enforced', async () => {
  const root = await repository();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'engram-archive-verify-'));
  const archive = path.join(temp, 'source.tar'), attestation = path.join(temp, 'attestation.json'), extracted = path.join(temp, 'extracted');
  try {
    const created = await createArchiveAttestation(root, archive, attestation);
    await mkdir(extracted);
    execFileSync('tar', ['-xf', archive, '-C', extracted]);
    await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, '0'.repeat(40)), /commit does not match/);
    const original = await readFile(attestation, 'utf8');
    await writeFile(attestation, original.replace(created.fingerprint, '0'.repeat(64)));
    await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, created.git_commit), /fingerprint does not match/);
    await writeFile(attestation, original);
    await writeFile(path.join(extracted, 'scripts', 'source.ts'), 'tampered extracted file\n');
    await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, created.git_commit), /fingerprint does not match/);
    await writeFile(path.join(extracted, 'scripts', 'source.ts'), 'export const value = 1;\n');
    const bytes = await readFile(archive); bytes[0] = bytes[0]! ^ 1; await writeFile(archive, bytes);
    await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, created.git_commit), /SHA-256 does not match/);
    await writeFile(archive, Buffer.from('tampered'));
    await writeFile(attestation, original.replace('{', `{"fingerprint":"${created.fingerprint}",`));
    await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, created.git_commit), /duplicate JSON key/);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(temp, { recursive: true, force: true })]); }
});

test('archive attestation rejects malformed shapes, fields, paths, and missing expected commit', async () => {
  const root = await repository();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'engram-attest-negative-'));
  const archive = path.join(temp, 'source.tar'), attestation = path.join(temp, 'attestation.json'), extracted = path.join(temp, 'extracted');
  try {
    const created = await createArchiveAttestation(root, archive, attestation);
    await mkdir(extracted); execFileSync('tar', ['-xf', archive, '-C', extracted]);
    const good = JSON.parse(await readFile(attestation, 'utf8')) as Record<string, unknown>;
    for (const [label, value] of [
      ['unknown key', { ...good, unexpected: true }], ['missing key', { fingerprint: good.fingerprint }],
      ['string field wrong type', { ...good, created_by: 3 }], ['array field wrong type', { ...good, fingerprint: [] }], ['top-level array', [good]],
      ['oversized string', { ...good, created_by: 'x'.repeat(1_000_000) }], ['non-hex fingerprint', { ...good, fingerprint: 'g'.repeat(64) }],
      ['non-hex archive hash', { ...good, archive_sha256: 'z'.repeat(64) }], ['bad timestamp', { ...good, created_at: 'yesterday' }],
    ] as const) {
      await writeFile(attestation, JSON.stringify(value));
      await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, created.git_commit), label);
    }
    await writeFile(attestation, JSON.stringify(good));
    await assert.rejects(verifyArchiveAttestation(extracted, archive, attestation, ''), /Expected commit/);
    const symlinkedAttestation = path.join(temp, 'attestation-link.json'); await symlink(attestation, symlinkedAttestation);
    await assert.rejects(verifyArchiveAttestation(extracted, archive, symlinkedAttestation, created.git_commit), /regular file/);
    await assert.rejects(verifyArchiveAttestation(extracted, temp, attestation, created.git_commit), /regular file/);
    await assert.rejects(verifyArchiveAttestation(extracted, path.dirname(archive), attestation, created.git_commit), /regular file/);
    const archiveLink = path.join(temp, 'archive-link.tar'); await symlink(archive, archiveLink);
    await assert.rejects(verifyArchiveAttestation(extracted, archiveLink, attestation, created.git_commit), /regular file/);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(temp, { recursive: true, force: true })]); }
});
