import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { recordCase } from '../helpers/report.js';
import { SearchEngine } from '../../packages/search-files/index.js';
import { buildPack } from '../dream/pack.js';
import { world, type World } from './helpers.js';

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]!.toFixed(2); };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) });
async function foreground(w: World, rounds: number, tag: string): Promise<{ write: number[]; read: number[]; errors: number }> {
  const search = new SearchEngine(w.vault); const write: number[] = [], read: number[] = []; let errors = 0;
  for (let i = 0; i < rounds; i++) {
    try { let t = performance.now(); await w.vault.put({ scope: { type: 'workspace', workspaceId: 'beta' }, kind: 'note', title: `fg ${tag} ${i}`, body: `foreground ${tag} probe ${i} token-${i}` }); write.push(performance.now() - t);
      t = performance.now(); await search.query({ query: `token-${i}`, mode: 'keyword', limit: 5 }); read.push(performance.now() - t); } catch { errors++; }
    await new Promise(r => setTimeout(r, 5));
  }
  return { write, read, errors };
}
test('foreground write/search latency while a profile + dream cycle runs, compared with an idle baseline (measured; no acceptance threshold is defined for it)', async t => {
  const w = await world(t, { workspaces: ['alpha', 'beta', 'gamma', 'delta'] }); await buildPack(w.vault);
  for (const id of ['alpha', 'gamma', 'delta']) for (let i = 0; i < 6; i++) await w.say(id, `I prefer option${i} for ${id} [key:k${id}${i}]`);
  for (let i = 0; i < 150; i++) await w.vault.put({ scope: { type: 'workspace', workspaceId: 'beta' }, kind: 'note', title: `seed ${i}`, body: `seed body ${i} lorem ipsum dolor` });
  const baseline = await foreground(w, 60, 'base'); w.provider.profileWaitMs = 120; // each model call takes ~120 ms of waiting, like a real remote call
  const cycle = w.ai.runCycle({ kind: 'manual', idempotencyKey: 'latency', respectActivity: false }); const during = await foreground(w, 60, 'during'); const result = (await cycle).cycle!;
  assert.equal(baseline.errors + during.errors, 0, 'no foreground operation failed'); assert.equal(result.state, 'COMPLETED', JSON.stringify(result.error)); assert.equal((await w.vault.verify()).ok, true);
  const detail = { baseline: { write: stats(baseline.write), read: stats(baseline.read) }, withBackgroundCycle: { write: stats(during.write), read: stats(during.read) }, p95WriteRatio: +(pct(during.write, 95) / pct(baseline.write, 95)).toFixed(2), p95ReadRatio: +(pct(during.read, 95) / pct(baseline.read, 95)).toFixed(2), cycleStageMs: result.metrics.stageMs, modelCalls: result.budgets.modelCallsUsed, note: 'single machine, deterministic provider with simulated 120 ms latency; the load is bounded model waits plus short commits, not real inference' };
  console.log(JSON.stringify(detail)); recordCase({ suite: 'adaptive', name: 'foreground-latency-under-cycle', status: 'PASS', detail });
});
