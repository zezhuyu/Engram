const tokenize = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
const NEGATORS = new Set(['not', 'never', 'no', "don't", 'dont', 'without', 'avoid', 'avoids', 'avoiding']);
const canonical = (word: string): string => {
  if (word === 'postgresql' || word === 'postgres') return 'postgres';
  if (word === 'pinning' || word === 'pinned') return 'pin';
  if (word === 'linter' || word === 'linters') return 'lint';
  if (/[^s]s$/.test(word) && word.length > 4) return word.slice(0, -1);
  return word;
};

const normalizePredictionText = (value: string): string => value.normalize('NFKC').toLowerCase()
  .replace(/\p{Dash_Punctuation}/gu, '-')
  .replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().replace(/\s+/g, ' ');

/** Normalize Unicode punctuation in labeled terms without erasing negation or relation order. */
export function predictionTermsMatch(claim: string, terms: string[]): boolean {
  const normalizedClaim = normalizePredictionText(claim);
  return terms.length > 0 && terms.every(term => normalizedClaim.includes(normalizePredictionText(term)));
}

export interface ProfilePrediction { expected: 'insight' | 'none'; extracted: boolean; match: boolean }
/** Counts retained wrong claims as false positives, even when the source case was a positive example. */
export function predictionCounts(rows: ProfilePrediction[]): { positives: number; negatives: number; truePositive: number; falseNegative: number; falsePositive: number; predicted: number } {
  const positives = rows.filter(row => row.expected === 'insight').length;
  const negatives = rows.length - positives;
  const truePositive = rows.filter(row => row.expected === 'insight' && row.extracted && row.match).length;
  const falseNegative = positives - truePositive;
  const falsePositive = rows.filter(row => row.extracted && !row.match).length;
  return { positives, negatives, truePositive, falseNegative, falsePositive, predicted: truePositive + falsePositive };
}

/** Score every retained candidate while counting recall at the labeled case level. */
export function predictionCountsByCase(rows: Array<{ expected: 'insight' | 'none'; predictions: boolean[] }>): { positives: number; negatives: number; truePositive: number; truePositiveCases: number; falseNegative: number; falsePositive: number; predicted: number } {
  const positives = rows.filter(r => r.expected === 'insight').length;
  const negatives = rows.length - positives;
  const correct = rows.reduce((n, r) => n + r.predictions.filter(Boolean).length, 0);
  const predicted = rows.reduce((n, r) => n + r.predictions.length, 0);
  const falsePositive = predicted - correct;
  const truePositiveCases = rows.filter(r => r.expected === 'insight' && r.predictions.some(Boolean)).length;
  return { positives, negatives, truePositive: correct, truePositiveCases, falseNegative: positives - truePositiveCases, falsePositive, predicted };
}

/** A keyword counts as supported only when its local phrase is asserted, not explicitly negated. */
export function assertedTermsHit(claim: string, terms: string[]): boolean {
  const words = tokenize(claim).map(canonical); const wanted = terms.flatMap(tokenize).map(canonical);
  if (!wanted.length) return false;
  return wanted.every(term => {
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== term && !(term.length >= 4 && words[i]!.startsWith(term))) continue;
      const prefix = words.slice(Math.max(0, i - 3), i);
      if (!prefix.some(word => NEGATORS.has(word))) return true;
    }
    return false;
  });
}
