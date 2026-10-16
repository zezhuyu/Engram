import test from 'node:test';
import assert from 'node:assert/strict';
import { predictionCounts, predictionCountsByCase, predictionTermsMatch } from '../../scripts/lib/profile-metrics.js';

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
