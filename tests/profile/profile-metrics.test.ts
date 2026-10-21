import test from 'node:test';
import assert from 'node:assert/strict';
import { hasExactSourceEvidence, predictionCounts, predictionCountsByCase, predictionTermsMatch, profileClaimMatches } from '../../scripts/lib/profile-metrics.js';

test('Preferences precision counts wrong-category retained outputs as false positives', () => {
  const counts = predictionCounts([
    { expected: 'insight', extracted: true, match: false }, // retained, wrong category
    { expected: 'insight', extracted: true, match: true },
    { expected: 'insight', extracted: false, match: false }, // unmatched expected prediction
    { expected: 'none', extracted: true, match: false }
  ]);
  assert.deepEqual(counts, { positives: 3, negatives: 1, truePositive: 1, falseNegative: 2, falsePositive: 2, predicted: 3 });
  assert.equal(counts.truePositive / counts.predicted, 1 / 3);
});

test('Preferences scores every retained output even when an incorrect proposal precedes a correct one', () => {
  const counts = predictionCountsByCase([
    { expected: 'insight', predictions: [false, true] },
    { expected: 'insight', predictions: [] },
    { expected: 'none', predictions: [false] }
  ]);
  assert.deepEqual(counts, { positives: 2, negatives: 1, truePositive: 1, truePositiveCases: 1, falseNegative: 1, falsePositive: 2, predicted: 3 });
  assert.equal(counts.truePositive / counts.predicted, 1 / 3);
});

test('profile evaluation normalizes Unicode dashes without erasing polarity or relation order', () => {
  assert.equal(predictionTermsMatch('The user prefers configurable values rather than hard‑coded environment values.', ['configurable', 'hard-coded']), true);
  assert.equal(predictionTermsMatch('The user prefers Rust over Python.', ['Python over Rust']), false);
  assert.equal(predictionTermsMatch('The user does not prefer Python.', ['prefers Python']), false);
});

test('every retained profile candidate uses case-insensitive directional relation scoring', () => {
  const expected = { category: 'preference', terms: ['go', 'over', 'rust'], relation: { left: 'go', operator: 'over', right: 'rust' } };
  assert.equal(profileClaimMatches('Preference for Go over Rust: I prefer Go over Rust.', 'preference', expected), true);
  assert.equal(profileClaimMatches('Preference for Rust over Go: I prefer Rust over Go.', 'preference', expected), false);
  assert.equal(profileClaimMatches('Preference for Go over Rust', 'goal', expected), false);
});

test('profile grounding scores canonical evidence only when URI, revision and exact span match', () => {
  const source = { uri: 'mdb://profile/objects/one', revisionId: 'rev-one', body: 'I prefer exact citations in every review.' };
  assert.equal(hasExactSourceEvidence([{ ...source, span: 'exact citations' }], source), true);
  assert.equal(hasExactSourceEvidence([{ ...source, uri: 'mdb://profile/objects/other', span: 'exact citations' }], source), false);
  assert.equal(hasExactSourceEvidence([{ ...source, revisionId: 'rev-old', span: 'exact citations' }], source), false);
  assert.equal(hasExactSourceEvidence([{ ...source, span: 'exact citations, roughly' }], source), false);
  assert.equal(hasExactSourceEvidence([{ ...source, span: '' }], source), false);
  assert.equal(hasExactSourceEvidence(undefined, source), false);
});
