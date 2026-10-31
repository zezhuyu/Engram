import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { recordCase } from '../helpers/report.js';
import { runChild } from '../helpers/child.js';
import { world, type World } from './helpers.js';
import { buildPack } from '../dream/pack.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';

const url = (p: string) => new URL(p, import.meta.url).href;
const M = { vault: url('../../packages/core/vault.js'), adaptive: url('../../packages/adaptive/index.js'), engine: url('../../packages/intelligence/index.js'), dreamer: url('../dream/helpers.js') };
/** Crash points across the whole micro-Dream job: each is a REAL SIGKILL of a separate process at that transition. */
const POINTS: Array<{ name: string; patch: string; hook?: string }> = [
  { name: 'before-claim (scheduled event about to be written)', patch: `const o=S.prototype.appendEvent;S.prototype.appendEvent=async function(e){if(e.type==='dream_scheduled')kill();return o.call(this,e);};` },
  { name: 'after-claim-before-run (started event about to be written)', patch: `const o=S.prototype.appendEvent;S.prototype.appendEvent=async function(e){if(e.type==='dream_started')kill();return o.call(this,e);};` },
  { name: 'during-provider-call', patch: `provider.generate=async()=>{kill();};` },
  { name: 'after-provider-before-persist', patch: `const g=provider.generate.bind(provider);provider.generate=async(...a)=>{const r=await g(...a);kill();return r;};` },
  { name: 'after-job-complete-before-outcome-check', patch: `const o=E.prototype.jobs;E.prototype.jobs=async function(){if(globalThis.__ran)kill();return o.call(this);};const r=E.prototype.run;E.prototype.run=async function(...a){const x=await r.apply(this,a);globalThis.__ran=true;return x;};` },
  { name: 'after-outcome-before-cursor-checkpoint', patch: `const o=S.prototype.advanceCursors;S.prototype.advanceCursors=async function(f){const c={};f(c);if(c.micro!==undefined&&c.micro>0&&globalThis.__ran)kill();return o.call(this,f);};const r=E.prototype.run;E.prototype.run=async function(...a){const x=await r.apply(this,a);globalThis.__ran=true;return x;};` },
  { name: 'after-cursor-checkpoint-before-return', patch: `const o=S.prototype.advanceCursors;S.prototype.advanceCursors=async function(f){const r=await o.call(this,f);const c={};f(c);if(c.micro!==undefined&&c.micro>0&&globalThis.__ran)kill();return r;};const r=E.prototype.run;E.prototype.run=async function(...a){const x=await r.apply(this,a);globalThis.__ran=true;return x;};` }
];
const childCode = (root: string, point: { patch: string; hook?: string } | undefined) => `
import {Vault} from ${JSON.stringify(M.vault)};import {AdaptiveIntelligence,AdaptiveStore as S} from ${JSON.stringify(M.adaptive)};import {IntelligenceEngine as E} from ${JSON.stringify(M.engine)};import {dreamer} from ${JSON.stringify(M.dreamer)};
const kill=()=>process.kill(process.pid,'SIGKILL');
const fault=${point?.hook ? `(stage)=>{${point.hook}}` : 'undefined'};
const vault=new Vault(${JSON.stringify(path.resolve(root))},undefined,{fault});const provider=dreamer();
${point?.patch ?? ''}
const ai=new AdaptiveIntelligence(vault,provider);
const out=await ai.microTick(new Date(Date.now()+11*60000));console.log(JSON.stringify({out,calls:provider.calls.length}));`;

async function prepared(t: Parameters<typeof world>[0]): Promise<World> {
  const w = await world(t, { config: { timezone: 'UTC', micro: { enabled: true, debounceMinutes: 10, maxPerDay: 100, kinds: ['wiki_page'] } } });
  assert.equal(await w.ai.microTick(new Date()), 'initialized');
  await buildPack(w.vault); // a multi-domain corpus whose micro Dream produces proposals

  return w;
}
/** Everything a micro Dream leaves behind: committed discovery documents AND the engine's proposals (by status, kind and title, which are deterministic; object ids and fingerprints differ between worlds, so duplicates show up as repeated entries). */
const discoveries = async (w: World) => [...(await w.vault.listDocuments()).filter(d => d.kind === 'discovery').map(d => `doc|${d.status}|${d.title}`), ...(await new IntelligenceEngine(w.vault).proposals()).map(p => `proposal|${p.status}|${p.input.kind}|${p.input.title}`)].sort();
/** Simulates the 60 s job lease running out: a killed worker leaves its job 'running'. */
async function expireLeases(root: string): Promise<number> {
  let n = 0; const dir = path.join(root, '.mdb/intelligence');
  for (const f of await fs.readdir(dir)) { if (!f.endsWith('.json') || f.startsWith('dream-')) continue; const file = path.join(dir, f); const s = JSON.parse(await fs.readFile(file, 'utf8')); for (const j of s.jobs ?? []) if (j.status === 'running') { j.leaseUntil = 1; n++; } await fs.writeFile(file, JSON.stringify(s)); }
  return n;
}

test('micro Dream control run: the clean outcome every crashed run must converge to', async t => {
  const w = await prepared(t); const clean = await runChild(childCode(w.root, undefined)); assert.equal(clean.code, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).out, 'completed'); const control = await discoveries(w); assert.ok(control.length > 0, 'the fixture produces at least one discovery');
  assert.equal((await w.vault.verify()).ok, true); recordCase({ suite: 'adaptive', name: 'micro-crash-control', status: 'PASS', detail: { discoveries: control.length } });
});

for (const point of POINTS) {
  test(`micro Dream killed (SIGKILL) at: ${point.name}: restart converges to the clean outcome, no duplicate or lost discoveries, journal verifies`, async t => {
    const control = await prepared(t); const cleanOutcomes: string[] = [];
    for (let i = 0; i < 8; i++) { const cleanRun = await runChild(childCode(control.root, undefined)); assert.equal(cleanRun.code, 0, cleanRun.stderr); cleanOutcomes.push(JSON.parse(cleanRun.stdout).out); if (cleanOutcomes.at(-1) === 'idle') break; }
    assert.equal(cleanOutcomes.at(-1), 'idle', `the control run drains its bounded micro work: ${cleanOutcomes.join(',')}`); const expected = await discoveries(control);
    const w = await prepared(t);
    const crashed = await runChild(childCode(w.root, point)); assert.equal(crashed.signal, 'SIGKILL', `the child must die at the injected point: ${crashed.stdout} ${crashed.stderr}`);
    const afterCrash = await discoveries(w); assert.ok(afterCrash.every(d => expected.includes(d)), 'whatever was committed before the crash is a subset of the final outcome');
    const leases = await expireLeases(w.root);
    // The restarted worker may need a second tick: the first resumes or reports a retry, the next observes completion. It must converge, never duplicate.
    const outcomes: string[] = []; for (let i = 0; i < 4; i++) { const r = await runChild(childCode(w.root, undefined)); assert.equal(r.code, 0, r.stderr); outcomes.push(JSON.parse(r.stdout).out); if (outcomes.at(-1) === 'idle') break; }
    assert.deepEqual(await discoveries(w), expected, `restart outcome ${outcomes.join(',')} (leases expired: ${leases})`);
    assert.equal(outcomes.at(-1), 'idle', `the range is fully processed: ${outcomes.join(',')}`);
    assert.equal((await w.vault.verify()).ok, true); const events = await w.ai.events(200); assert.ok(events.some(e => e.type === 'dream_completed' && e.trigger === 'micro'), 'a completion is recorded');
    recordCase({ suite: 'adaptive', name: `micro-crash-${point.name.split(' ')[0]}`, status: 'PASS', detail: { outcomes, discoveries: expected.length } });
  });
}

test('two micro workers at the same moment: one job, no duplicate discoveries', async t => {
  const w = await prepared(t); const control = await prepared(t); await runChild(childCode(control.root, undefined)); const expected = await discoveries(control);
  const [a, b] = await Promise.all([runChild(childCode(w.root, undefined)), runChild(childCode(w.root, undefined))]); assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  for (let i = 0; i < 3; i++) { const r = await runChild(childCode(w.root, undefined)); if (JSON.parse(r.stdout).out === 'idle') break; await expireLeases(w.root); }
  assert.deepEqual(await discoveries(w), expected); assert.equal((await w.vault.verify()).ok, true);
  recordCase({ suite: 'adaptive', name: 'micro-two-workers', status: 'PASS', detail: { outcomes: [JSON.parse(a.stdout).out, JSON.parse(b.stdout).out] } });
});
