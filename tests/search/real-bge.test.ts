import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuiltinEmbedder } from '../../packages/search-semantic/embedder.js';

const enabled = process.env.ENGRAM_REAL_EMBEDDING_TEST === '1';
test('real cached bge-m3 multilingual embeddings have normalized 1024-d retrieval signal', { skip: !enabled }, async () => {
  const cache = process.env.ENGRAM_MODEL_CACHE;
  assert.ok(cache, 'ENGRAM_MODEL_CACHE must point to the already cached pinned model directory');
  const embedder = await createBuiltinEmbedder({ provider: 'builtin', model: 'bge-m3', dimensions: 1024 }, { env: { ...process.env, ENGRAM_MODEL_CACHE: cache } });
  const texts = ['A dog is playing fetch in the park.', 'A puppy runs after a ball outdoors.', '今天天气很好，我们去公园散步。', '天气晴朗，适合在公园走走。', 'The library closes at 8 p.m.; 请在关门前归还书籍。', 'Please return books before the library closes tonight.', 'The stock market and investment portfolios fell sharply this morning.'];
  const started = performance.now(); let vectors: number[][], latencyMs: number;
  try { vectors = await embedder.embed(texts); latencyMs = performance.now() - started; } finally { await embedder.close(); }
  assert.equal(vectors.length, texts.length); assert.ok(vectors.every(v => v.length === 1024));
  const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  const related = [cosine(vectors[0]!, vectors[1]!), cosine(vectors[2]!, vectors[3]!), cosine(vectors[4]!, vectors[5]!)];
  const unrelated = [cosine(vectors[0]!, vectors[6]!), cosine(vectors[2]!, vectors[6]!), cosine(vectors[4]!, vectors[6]!)];
  assert.ok(related.every((score, i) => score > unrelated[i]!), `related ${related}; unrelated ${unrelated}`);
  const norms = vectors.map(v => Math.sqrt(v.reduce((sum, value) => sum + value * value, 0)));
  assert.ok(norms.every(n => Math.abs(n - 1) < 0.002));
  console.log(JSON.stringify({ dimensions: 1024, latencyMs: Math.round(latencyMs), relatedCosine: related, unrelatedCosine: unrelated, norms }));
});
