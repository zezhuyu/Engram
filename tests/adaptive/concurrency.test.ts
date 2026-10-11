import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCase } from '../helpers/report.js';
import { runChild, modules } from '../helpers/child.js';
import { world } from './helpers.js';

test('multi-process writers during a cycle: no lost writes, journal verifies, and exactly the writes after W are deferred to the next cycle', async t => {
  const w = await world(t); await w.say('alpha', 'I prefer TypeScript for services [key:lang]');
  let started!: () => void; const gate = new Promise<void>(r => { started = r; }); let child: ReturnType<typeof runChild> | undefined;
  w.provider.onProfile = async () => { if (!child) { child = runChild(`import {Vault} from ${JSON.stringify(modules.vault)}; const v=new Vault(${JSON.stringify(w.root)}); for (let i=0;i<40;i++) await v.put({scope:{type:'workspace',workspaceId:'alpha'},kind:'note',title:'child '+i,body:'CHILDWRITE '+i,idempotencyKey:'child-'+i});`); started(); await child; } };
  const first = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'mp-1', respectActivity: false })).cycle!; await gate; const out = await child!; assert.equal(out.code, 0, out.stderr);
  assert.equal(first.state, 'COMPLETED', JSON.stringify(first.error)); assert.equal((await w.vault.verify()).ok, true); const all = (await w.vault.listDocuments()).filter(d => d.body.startsWith('CHILDWRITE')); assert.equal(all.length, 40, 'no lost acknowledged writes');
  const events = (await w.vault.events()).filter(e => all.some(d => d.id === e.objectId)); assert.ok(events.every(e => e.sequence > first.watermark), 'child writes were all committed after the cycle sealed W'); assert.ok(!JSON.stringify(w.provider.calls).includes('CHILDWRITE'));
  const second = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'mp-2', respectActivity: false })).cycle!; assert.equal(second.workspaces.alpha!.changes!.added, 40, 'all deferred writes are summarized next cycle, none skipped, none repeated');
  recordCase({ suite: 'adaptive', name: 'multiprocess-writes-during-cycle', status: 'PASS' });
});

test('workspace opt-out removes a workspace from every stage, Dream corpus included', async t => {
  const w = await world(t, { config: { workspaces: { include: null, exclude: ['beta'] } } });
  await w.vault.put({ scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title: 'Python JSON APIs', body: 'Python services expose JSON over HTTP using FastAPI.', tags: ['domain:python-api', 'api', 'json', 'provides:json'] });
  const hidden = await w.note('beta', 'wiki_page', 'Beta dashboards', 'OPTEDOUT dashboards consume JSON through fetch.'); hidden.tags.length; await w.vault.put({ scope: { type: 'workspace', workspaceId: 'alpha' }, kind: 'wiki_page', title: 'Alpha dashboards', body: 'Browser dashboards consume JSON through fetch and render widgets.', tags: ['domain:js-frontend', 'dashboard', 'consumes:json'] });
  await w.say('beta', 'OPTEDOUT I prefer Lisp [key:lisp]'); await w.say('alpha', 'I prefer TypeScript [key:lang]');
  const c = (await w.ai.runCycle({ kind: 'manual', idempotencyKey: 'optout-1', respectActivity: false })).cycle!; assert.equal(c.state, 'COMPLETED', JSON.stringify({ e: c.error, d: c.dream.error })); assert.equal(c.workspaces.beta, undefined, 'excluded workspace has no stage record');
  assert.ok(!JSON.stringify(w.provider.calls).includes('OPTEDOUT'), 'nothing from the opted-out workspace reached any model request'); assert.equal((await w.vault.listDocuments()).filter(d => d.kind === 'workspace_daily_summary' && d.scope.type === 'workspace' && d.scope.workspaceId === 'beta').length, 0);
  assert.ok(w.provider.dreamCalls().length > 0, 'Dream still ran over the remaining corpus'); recordCase({ suite: 'adaptive', name: 'workspace-opt-out', status: 'PASS' });
});
