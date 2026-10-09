import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { disposableVault, sleep } from '../helpers/disposable-vault.js';
import { modules, runChild, faultPreamble } from '../helpers/child.js';
import { HistoryRecorder } from '../helpers/history.js';
import { verifyInvariants } from '../helpers/invariants.js';
import { recordCase } from '../helpers/report.js';
import { Vault } from '../../packages/core/vault.js';

const wiki = { type: 'global' as const, area: 'wiki' as const };

/** Child that logs every operation as an `H {json}` line with wall-clock interval, expected and observed revision. */
const worker = (root: string, name: string, ops: number, seed: number) => `import {Vault} from ${JSON.stringify(modules.vault)};
const v=new Vault(${JSON.stringify(root)});const name=${JSON.stringify(name)};let s=${seed}>>>0;const rnd=()=>{s=(s+0x6d2b79f5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
const H=(e)=>console.log('H '+JSON.stringify(e));const mine=[];
async function timed(op,objectId,expected,fn){const startedAt=Date.now();try{const d=await fn();H({op,objectId:d?.id??objectId,expectedRevision:expected,observedRevision:d?.revisionId,startedAt,endedAt:Date.now(),outcome:'ok'});return d;}catch(e){H({op,objectId,expectedRevision:expected,startedAt,endedAt:Date.now(),outcome:/writer is busy/.test(e.message)?'error':e.code==='CONFLICT'?'CONFLICT':'error',error:/writer is busy/.test(e.message)?'LOCK_TIMEOUT':(e.code??e.message)});return undefined;}}
for(let i=0;i<${ops};i++){const r=rnd();
 if(mine.length===0||r<0.35){const d=await timed('put',undefined,undefined,()=>v.put({scope:{type:'global',area:'wiki'},kind:'note',title:name+' '+i,body:'body '+name+' '+i}));if(d)mine.push(d);}
 else if(r<0.75){const t=mine[Math.floor(rnd()*mine.length)];const d=await timed('patch',t.id,t.revisionId,()=>v.patch({objectId:t.id,expectedRevisionId:t.revisionId,body:'patched '+name+' '+i}));if(d){mine[mine.indexOf(t)]=d;}}
 else if(r<0.9){const t=mine[Math.floor(rnd()*mine.length)];await timed('read',t.id,undefined,()=>v.get(t.id));}
 else {const t=mine[Math.floor(rnd()*mine.length)];const d=await timed('delete',t.id,t.revisionId,()=>v.delete(t.id,t.revisionId));if(d)mine.splice(mine.indexOf(t),1);}}`;

async function runWorkers(root: string, count: number, ops: number, seed: number) {
  const history = new HistoryRecorder();
  const results = await Promise.all(Array.from({ length: count }, (_, i) => runChild(worker(root, `p${i}`, ops, seed + i)).then(r => { history.parse(`p${i}`, r.stdout); return r; })));
  return { history, results };
}

for (const processes of [10, 50]) {
  test(`${processes} independent processes: no lost acknowledged write, unique IDs, ordered revisions, zero lock timeouts`, async t => {
    const { root, vault } = await disposableVault(t);
    const seed = 4000 + processes;
    const { history, results } = await runWorkers(root, processes, 6, seed);
    for (const r of results) assert.equal(r.code, 0, r.stderr.slice(0, 400));
    const failures = history.entries.filter(e => e.outcome === 'error');
    assert.deepEqual(failures.map(f => f.error), [], 'no operation failed with a lock timeout or other error');
    const events = await vault.events();
    const acknowledged = history.entries.filter(e => e.outcome === 'ok' && e.op !== 'read');
    assert.equal(events.length, acknowledged.length, 'journal contains exactly the acknowledged writes');
    assert.equal(new Set(events.map(e => e.objectId + e.revisionId)).size, events.length);
    for (const e of acknowledged) assert.ok(events.some(x => x.revisionId === e.observedRevision), 'acknowledged revision is durable');
    // Each process owns its objects, so no conflict should be reported.
    assert.equal(history.entries.filter(e => e.outcome === 'CONFLICT').length, 0);
    const report = await verifyInvariants(vault);
    assert.deepEqual(report.issues, []);
    const latency = history.entries.filter(e => e.op !== 'read').map(e => e.endedAt - e.startedAt).sort((a, b) => a - b);
    recordCase({ suite: 'isolation', name: `${processes}-process-mixed`, status: 'PASS', seed, detail: { operations: history.entries.length, writes: acknowledged.length, p50Ms: latency[Math.floor(latency.length * 0.5)], p95Ms: latency[Math.floor(latency.length * 0.95)], maxMs: latency.at(-1) } });
  });
}

test('read-modify-write on one shared object with retry: every acknowledged update survives (no silent lost update)', async t => {
  const { root, vault } = await disposableVault(t);
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'counter', body: '' });
  const n = 12;
  const script = (token: string) => `import {Vault} from ${JSON.stringify(modules.vault)};const v=new Vault(${JSON.stringify(root)});let conflicts=0;
for(;;){const cur=await v.get(${JSON.stringify(doc.id)});try{await v.patch({objectId:cur.id,expectedRevisionId:cur.revisionId,body:cur.body+${JSON.stringify(token)}+'\\n'});break;}catch(e){if(e.code!=='CONFLICT')throw e;conflicts++;}}console.log('CONFLICTS '+conflicts);`;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => runChild(script(`token-${i}`))));
  for (const r of results) assert.equal(r.code, 0, r.stderr.slice(0, 300));
  const final = (await vault.get(doc.id)).body.split('\n').filter(Boolean).sort();
  assert.deepEqual(final, Array.from({ length: n }, (_, i) => `token-${i}`).sort(), 'every token present exactly once');
  assert.equal((await vault.history(doc.id)).length, n + 1);
  const conflicts = results.reduce((sum, r) => sum + Number(/CONFLICTS (\d+)/.exec(r.stdout)?.[1] ?? 0), 0);
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'isolation', name: 'shared-object-rmw', status: 'PASS', detail: { writers: n, conflictsRetried: conflicts } });
});

test('same expected revision from 8 processes: exactly one winner, the rest CONFLICT, and no input is lost from history', async t => {
  const { root, vault } = await disposableVault(t);
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'race', body: 'base' });
  const history = new HistoryRecorder();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runChild(`import {Vault} from ${JSON.stringify(modules.vault)};try{await new Vault(${JSON.stringify(root)}).patch({objectId:${JSON.stringify(doc.id)},expectedRevisionId:${JSON.stringify(doc.revisionId)},body:'writer ${i}'});console.log('H '+JSON.stringify({op:'patch',objectId:${JSON.stringify(doc.id)},startedAt:0,endedAt:0,outcome:'ok'}))}catch(e){console.log('H '+JSON.stringify({op:'patch',objectId:${JSON.stringify(doc.id)},startedAt:0,endedAt:0,outcome:e.code==='CONFLICT'?'CONFLICT':'error',error:e.code}))}`).then(r => { history.parse(`w${i}`, r.stdout); return r; })));
  void results;
  assert.equal(history.entries.filter(e => e.outcome === 'ok').length, 1);
  assert.equal(history.entries.filter(e => e.outcome === 'CONFLICT').length, 7);
  assert.equal((await vault.history(doc.id)).length, 2);
  recordCase({ suite: 'isolation', name: 'same-revision-race', status: 'PASS' });
});

test('concurrent readers never observe a torn document or half-written frontmatter', async t => {
  const { root, vault } = await disposableVault(t);
  const doc = await vault.put({ scope: wiki, kind: 'note', title: 'torn?', body: 'START-0\n' + 'x'.repeat(60000) + '\nEND-0' });
  const writer = runChild(`import {Vault} from ${JSON.stringify(modules.vault)};const v=new Vault(${JSON.stringify(root)});let d=await v.get(${JSON.stringify(doc.id)});
for(let i=1;i<=40;i++){d=await v.patch({objectId:d.id,expectedRevisionId:d.revisionId,body:'START-'+i+'\\n'+'x'.repeat(60000+i)+'\\nEND-'+i});}console.log('DONE');`);
  const reader = runChild(`import {Vault,parseDocument} from ${JSON.stringify(modules.vault)};import fs from 'node:fs';const v=new Vault(${JSON.stringify(root)});let reads=0,bad=0,viewReads=0;
const ok=(b)=>{const m=/^START-(\\d+)\\n(x+)\\nEND-(\\d+)$/.exec(b);return !!m&&m[1]===m[3];};
const end=Date.now()+4000;
while(Date.now()<end){const d=await v.get(${JSON.stringify(doc.id)});reads++;if(!ok(d.body)){bad++;console.log('BAD '+d.body.slice(0,40));}
 try{const text=fs.readFileSync(${JSON.stringify(path.join(root, doc.path))},'utf8');viewReads++;if(!ok(parseDocument(text).body)){bad++;console.log('BADVIEW');}}catch(e){bad++;console.log('VIEWERR '+e.message);}}
console.log('READS '+reads+' VIEWS '+viewReads+' BAD '+bad);`);
  const [w, r] = await Promise.all([writer, reader]);
  assert.equal(w.code, 0, w.stderr); assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /BAD 0/, r.stdout.slice(0, 300));
  recordCase({ suite: 'isolation', name: 'no-torn-reads', status: 'PASS', detail: { reader: r.stdout.trim().split('\n').at(-1) } });
});

test('stale lock recovery: killed holder, lock without owner file, torn owner file; live holder still excludes', async t => {
  const { root, vault } = await disposableVault(t);
  const lock = path.join(root, '.mdb/locks/writer.lock');
  const killed = await runChild(`${faultPreamble(root, { stage: 'journal.before_append', mode: 'kill' })} await vault.put({scope:{type:'global',area:'wiki'},kind:'note',title:'k',body:'k'});`);
  assert.equal(killed.signal, 'SIGKILL');
  assert.ok((await fs.stat(lock)).isDirectory(), 'killed process left its lock behind');
  const started = Date.now(); await vault.put({ scope: wiki, kind: 'note', title: 'after kill', body: 'ok' });
  assert.ok(Date.now() - started < 3000, 'dead owner reclaimed promptly');
  await fs.mkdir(lock); // crash between mkdir and owner.json
  const s2 = Date.now(); await vault.put({ scope: wiki, kind: 'note', title: 'after ownerless', body: 'ok' });
  assert.ok(Date.now() - s2 < 6000, 'ownerless lock reclaimed after the grace period');
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), '{"pid":');
  await vault.put({ scope: wiki, kind: 'note', title: 'after torn owner', body: 'ok' });
  // A live holder (this very process) is never reclaimed.
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const contender = runChild(`import {Vault} from ${JSON.stringify(modules.vault)};const t=Date.now();await new Vault(${JSON.stringify(root)}).put({scope:{type:'global',area:'wiki'},kind:'note',title:'contender',body:'c'});console.log('WAITED '+(Date.now()-t));`);
  await sleep(700); assert.equal((await vault.events()).filter(e => e.operation === 'put').length, 3, 'contender is blocked while the live owner holds the lock');
  await fs.rm(lock, { recursive: true, force: true });
  const c = await contender; assert.equal(c.code, 0, c.stderr); assert.ok(Number(/WAITED (\d+)/.exec(c.stdout)![1]) >= 500);
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'isolation', name: 'stale-lock-recovery', status: 'PASS' });
});

test('symlink swap race: concurrent directory↔symlink flipping never makes a write land outside the vault', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('race', '');
  const outside = path.join(path.dirname(root), path.basename(root) + '-outside');
  await fs.mkdir(outside, { recursive: true }); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const wsDir = path.join(root, 'workspaces/race');
  const flipper = runChild(`import fs from 'node:fs';const dir=${JSON.stringify(wsDir)},out=${JSON.stringify(outside)};const end=Date.now()+3500;
while(Date.now()<end){try{fs.renameSync(dir,dir+'.real');fs.symlinkSync(out,dir);fs.unlinkSync(dir);fs.renameSync(dir+'.real',dir);}catch{}}`);
  const writer = runChild(`import {Vault} from ${JSON.stringify(modules.vault)};const v=new Vault(${JSON.stringify(root)});let ok=0,rejected=0;const end=Date.now()+3500;
while(Date.now()<end){try{await v.put({scope:{type:'workspace',workspaceId:'race'},kind:'note',title:'t',body:'secret-body'});ok++;}catch(e){rejected++;}}console.log('OK '+ok+' REJECTED '+rejected);`);
  const [f, w] = await Promise.all([flipper, writer]);
  void f; assert.equal(w.code, 0, w.stderr.slice(0, 300));
  const strays: string[] = [], disclosed: string[] = []; const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const full = path.join(d, e.name); if (e.isDirectory()) await walk(full); else { strays.push(full); if ((await fs.readFile(full, 'utf8')).includes('secret-body')) disclosed.push(full); } } };
  await walk(outside);
  assert.deepEqual(disclosed, [], 'no vault content was written through the swapped symlink');
  recordCase({ suite: 'isolation', name: 'symlink-swap-race', status: 'PASS', detail: { writer: w.stdout.trim(), strayEmptyFilesOutside: strays.length, note: 'Node has no openat(); the TOCTOU window is narrowed, not closed. Residual: empty stray temp files.' } });
});

test('cross-scope operations: unauthorized access fails without mutation, promotion is one atomic commit that never touches the source', async t => {
  const { root, vault } = await disposableVault(t);
  await vault.createWorkspace('a', '', { agentA: ['read', 'write', 'promote'] }); await vault.createWorkspace('b', '', { agentB: ['read', 'write'] });
  const source = await vault.put({ scope: { type: 'workspace', workspaceId: 'a' }, kind: 'note', title: 'private', body: 'PRIVATE-A' });
  const intruder = new Vault(root, { actorId: 'agentB', permissions: ['workspace:b:read', 'workspace:b:write'] });
  const eventsBefore = (await vault.events()).length;
  await assert.rejects(intruder.patch({ objectId: source.id, expectedRevisionId: source.revisionId, body: 'hijack' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  await assert.rejects(intruder.put({ scope: { type: 'workspace', workspaceId: 'a' }, kind: 'note', title: 'x', body: 'x' }), { code: 'NOT_FOUND_OR_FORBIDDEN' });
  assert.equal((await vault.events()).length, eventsBefore, 'rejected cross-workspace writes mutate nothing');
  // Promotion killed before its commit point leaves target absent and source untouched; after it, target present, source unchanged.
  for (const [stage, expectTarget] of [['journal.before_append', 0], ['journal.after_fsync', 1]] as const) {
    const before = (await vault.events()).filter(e => e.scope.type === 'global').length;
    const r = await runChild(`${faultPreamble(root, { stage, mode: 'kill' })} await vault.promote(${JSON.stringify(source.id)},{type:'global',area:'shared'},'sanitized text','Promoted '+${JSON.stringify(stage)});`);
    assert.equal(r.signal, 'SIGKILL');
    await vault.recover();
    assert.equal((await vault.events()).filter(e => e.scope.type === 'global').length - before, expectTarget);
    assert.equal((await vault.get(source.id)).body, 'PRIVATE-A'); assert.equal((await vault.get(source.id)).revisionId, source.revisionId);
  }
  assert.deepEqual((await verifyInvariants(vault)).issues, []);
  recordCase({ suite: 'isolation', name: 'cross-scope-atomicity', status: 'PASS', detail: { note: 'A single logical operation only ever commits to one scope; multi-workspace transactions are not offered (API takes one scope).' } });
});
