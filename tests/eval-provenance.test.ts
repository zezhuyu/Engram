import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProvenance, digestFile, verifyProvenance, sha256Hex } from '../scripts/lib/eval-provenance.js';
import { canonicalInput } from '../scripts/lib/suite.js';
import { EVALUATION_INPUTS } from '../scripts/lib/source-evidence.js';

const model = { provider: 'ollama:gpt-oss', model: 'gpt-oss:latest', baseUrl: null, temperature: null, allowNetwork: false };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prov-')); const corpus = path.join(dir, 'corpus.json'), code = path.join(dir, 'eval.ts'), lib = path.join(dir, 'lib.ts');
  await fs.writeFile(corpus, '{"scenarios":[]}'); await fs.writeFile(code, 'export const a = 1;'); await fs.writeFile(lib, 'export const b = 2;');
  const p = await buildProvenance({ corpusPath: corpus, evaluatorFiles: [code, lib], sourceFingerprint: 'fp1', treeState: 'clean', model, runs: 3 });
  return { dir, corpus, code, lib, p, expected: { corpusPath: corpus, evaluatorFiles: [code, lib], sourceFingerprint: 'fp1' } };
}
test('a provenance-bound report verifies against the same corpus, evaluator and fingerprint', async () => {
  const f = await fixture(); const v = await verifyProvenance({ provenance: f.p }, f.expected);
  assert.deepEqual(v, { status: 'BOUND', problems: [] }); assert.equal(f.p.corpus.sha256, sha256Hex('{"scenarios":[]}')); assert.equal(f.p.model.model, 'gpt-oss:latest');
});
test('every binding is enforced: corpus, evaluator code, fingerprint, tree state, schema and model configuration', async () => {
  const f = await fixture();
  await fs.writeFile(f.corpus, '{"scenarios":[1]}'); assert.match((await verifyProvenance({ provenance: f.p }, f.expected)).problems.join(), /corpus digest/); await fs.writeFile(f.corpus, '{"scenarios":[]}');
  await fs.writeFile(f.code, 'export const a = 99;'); assert.match((await verifyProvenance({ provenance: f.p }, f.expected)).problems.join(), /evaluator version/); await fs.writeFile(f.code, 'export const a = 1;');
  assert.match((await verifyProvenance({ provenance: f.p }, { ...f.expected, sourceFingerprint: 'other' })).problems.join(), /fingerprint/);
  assert.match((await verifyProvenance({ provenance: { ...f.p, treeState: 'dirty' } }, f.expected)).problems.join(), /tree state/);
  assert.match((await verifyProvenance({ provenance: { ...f.p, schema: 'x' } }, f.expected)).problems.join(), /schema/);
  assert.match((await verifyProvenance({ provenance: { ...f.p, model: {} } }, f.expected)).problems.join(), /model configuration/);
  assert.equal((await verifyProvenance({ provenance: f.p }, f.expected)).status, 'BOUND');
});
test('a historical report without provenance is UNBOUND, never silently accepted or rewritten', async () => {
  const f = await fixture(); const v = await verifyProvenance({}, f.expected);
  assert.equal(v.status, 'UNBOUND'); assert.equal((await verifyProvenance({ provenance: 'x' }, f.expected)).status, 'UNBOUND');
});
test('digests are content-addressed and order independent for the evaluator file set', async () => {
  const f = await fixture(); const a = await buildProvenance({ corpusPath: f.corpus, evaluatorFiles: [f.code, f.lib], sourceFingerprint: 'x', treeState: 'clean', model, runs: 1 }), b = await buildProvenance({ corpusPath: f.corpus, evaluatorFiles: [f.lib, f.code], sourceFingerprint: 'x', treeState: 'clean', model, runs: 1 });
  assert.equal(a.evaluator.sha256, b.evaluator.sha256); assert.equal((await digestFile(f.code)).bytes, 19);
});
test('there is exactly one canonical Dream corpus: the tracked fixture, declared as the fingerprinted evaluation input, with no silent fallback', async () => {
  assert.equal(canonicalInput('dream/labeled-scenarios.json'), 'fixtures/inputs/dream/labeled-scenarios.json');
  assert.ok(EVALUATION_INPUTS.includes('fixtures/inputs/dream/labeled-scenarios.json')); assert.ok(!EVALUATION_INPUTS.includes('verification/dream/labeled-scenarios.json'), 'the stale verification copy is no longer a declared evaluation input');
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nocorpus-')); assert.throws(() => canonicalInput('dream/labeled-scenarios.json', empty), /refusing to fall back/);
  const evaluator = await fs.readFile('scripts/evaluate-dream.ts', 'utf8'); assert.ok(!/inputPath\('dream\/labeled-scenarios\.json'\)/.test(evaluator), 'the evaluator must not use the fallback resolver for its default corpus');
  assert.ok(!/corpus: 'verification\/dream/.test(evaluator), 'the report must record the corpus actually read, with a digest');
});
