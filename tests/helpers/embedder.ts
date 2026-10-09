import type { EmbeddingProvider } from '../../packages/core/types.js';

/** Deterministic concept embedder: words of the same concept share an axis, so "automobile" is close to "car" without sharing a single keyword. */
const CONCEPTS: string[][] = [
  ['car', 'automobile', 'vehicle', 'truck', 'sedan', 'driving'],
  ['deploy', 'release', 'ship', 'rollout', 'publish'],
  ['cat', 'feline', 'kitten', 'pet'],
  ['invoice', 'billing', 'payment', 'receipt'],
  ['database', 'sql', 'query', 'storage']
];
export const DIMS = 12;
const wordsOf = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export function conceptVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of wordsOf(text)) { const c = CONCEPTS.findIndex(group => group.includes(w)); if (c >= 0) v[c]! += 1; else { let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[CONCEPTS.length + (h % (DIMS - CONCEPTS.length))]! += 0.15; } }
  return v;
}
export interface FakeEmbedder extends EmbeddingProvider { calls: string[][]; fail: boolean; delay: number; failAfterBatches?: number }
export function fakeEmbedder(options: { modelId?: string; locality?: 'local' | 'remote' } = {}): FakeEmbedder {
  const e: FakeEmbedder = { modelId: options.modelId ?? 'fake-concepts-v1', dimensions: DIMS, locality: options.locality ?? 'local', calls: [], fail: false, delay: 0,
    async embed(texts) {
      if (e.fail) throw new Error('boom secret-api-key-123');
      if (e.failAfterBatches !== undefined && e.calls.length >= e.failAfterBatches) throw new Error('simulated outage');
      e.calls.push([...texts]); if (e.delay) await new Promise(r => setTimeout(r, e.delay)); return texts.map(conceptVector);
    } };
  return e;
}
