import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engram, OWNER, refreshRelevance, readRanking, relevanceStatus, clearRanking, type ModelProvider, type ModelRequest } from '../../packages/sdk/index.js';
import { fetchProjection } from '../../packages/project-init.js';
import { toolsFor } from '../../packages/mcp/index.js';
import type { RemoteSession } from '../../packages/memory/remote-client.js';
import { buildSessionContext } from '../../packages/memory/session-context.js';

const WS = 'proj-a';
async function vault() {
  const client = new Engram(await mkdtemp(path.join(os.tmpdir(), 'mdb-rel-')), OWNER); await client.init({ sqlite: false }); await client.createWorkspace(WS);
  const insight = async (claim: string, scopeLabel: string | undefined, extra: Record<string, unknown> = {}) => (await client.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: claim.slice(0, 30), body: claim, status: 'accepted', metadata: { category: 'preference', evidenceClass: 'explicit', visibility: 'user_private', sensitivity: 'none', ...(scopeLabel ? { scopeLabel } : {}), ...extra } })).id;
  return { client, insight };
}
/** A provider that answers from a function of the supplied document ids; records every request so tests can see exactly what was sent. */
function fake(answer: (ids: string[]) => unknown, locality: 'local' | 'remote' = 'local') {
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = { id: 'fake', locality, async generate(input) { calls.push(input); const first = input.documents[0]!; return { kind: 'insight_relevance', title: 'rank', body: JSON.stringify(answer(input.documents.map(d => d.id))), evidence: [{ uri: first.uri, revisionId: first.revisionId }] }; } };
  return { provider, calls };
}
const config = async (client: Engram, allowPrivate = false) => { const c = await client.vault.config(); return { ...c, model: { ...c.model, allowPrivateContentToRemote: allowPrivate } }; };
const claims = (p: { preferences: Array<{ claim: string }>; insights: Array<{ claim: string }> }) => [...p.preferences, ...p.insights].map(i => i.claim);

test('a fresh model ranking reorders and drops irrelevant GLOBAL insights; project insights are kept and claims stay the vault\'s', async () => {
  const { client, insight } = await vault();
  const g1 = await insight('Global: uses tabs.', undefined), g2 = await insight('Global: prefers pytest.', undefined), w = await insight('Project: deploy on Tuesday.', WS);
  const before = claims(await fetchProjection({ client }, WS, 900));
  assert.deepEqual(before, ['Project: deploy on Tuesday.', 'Global: prefers pytest.', 'Global: uses tabs.'].sort((a, b) => before.indexOf(a) - before.indexOf(b)));
  const { provider } = fake(() => ({ relevant: [g2], irrelevant: [g1, w] }));
  const result = await refreshRelevance(client, WS, provider, await config(client));
  assert.equal(result.status, 'model');
  const after = await fetchProjection({ client }, WS, 900);
  assert.equal(after.ranking, 'model');
  assert.deepEqual(claims(after), ['Project: deploy on Tuesday.', 'Global: prefers pytest.'], 'tabs dropped, project insight kept even though the model called it irrelevant');
  assert.equal(await relevanceStatus(client, WS), 'model');
});

test('invalid model output (unknown, duplicate or overlapping ids) is rejected and nothing is stored', async () => {
  const { client, insight } = await vault(); const a = await insight('Global: A.', undefined); await insight('Global: B.', undefined);
  for (const bad of [{ relevant: ['obj_invented'], irrelevant: [] }, { relevant: [a, a], irrelevant: [] }, { relevant: [a], irrelevant: [a] }, { relevant: 'all', irrelevant: [] }]) {
    await assert.rejects(refreshRelevance(client, WS, fake(() => bad).provider, await config(client)), /Relevance|INVALID_MODEL_OUTPUT|ids|supplied|repeats/);
  }
  assert.equal(await readRanking(client, WS), undefined);
  assert.equal((await fetchProjection({ client }, WS, 900)).ranking, 'deterministic');
});

test('a ranking goes stale when the accepted set changes and injection falls back to the deterministic order', async () => {
  const { client, insight } = await vault(); const a = await insight('Global: A.', undefined); await insight('Global: B.', undefined);
  const base = claims(await fetchProjection({ client }, WS, 900));
  await refreshRelevance(client, WS, fake(() => ({ relevant: [], irrelevant: [a] })).provider, await config(client));
  assert.ok(!claims(await fetchProjection({ client }, WS, 900)).includes('Global: A.'));
  await insight('Global: C.', undefined);
  assert.equal(await relevanceStatus(client, WS), 'stale');
  const stale = await fetchProjection({ client }, WS, 900);
  assert.equal(stale.ranking, 'deterministic'); assert.ok(claims(stale).includes('Global: A.'), 'stale ranking must not hide anything');
  assert.deepEqual(claims(stale).filter(c => base.includes(c)).sort(), base.slice().sort());
  assert.deepEqual(await clearRanking(client, WS), { cleared: true }); assert.equal(await readRanking(client, WS), undefined);
});

test('sensitive, candidate and other-project insights are never sent to the model', async () => {
  const { client, insight } = await vault(); await client.createWorkspace('other');
  await insight('Global: fine.', undefined); await insight('SECRET-SENSITIVE-9 health detail.', undefined, { sensitivity: 'sensitive' });
  await insight('OTHER-PROJECT-9 belongs elsewhere.', 'other'); await client.put({ scope: { type: 'global', area: 'profile' }, kind: 'user_insight', title: 'cand', body: 'CANDIDATE-9 guess', status: 'candidate', metadata: { category: 'preference', sensitivity: 'none' } });
  const { provider, calls } = fake(ids => ({ relevant: ids, irrelevant: [] }));
  await refreshRelevance(client, WS, provider, await config(client));
  const sent = JSON.stringify(calls); assert.equal(calls.length, 1);
  for (const marker of ['SECRET-SENSITIVE-9', 'OTHER-PROJECT-9', 'CANDIDATE-9']) assert.ok(!sent.includes(marker), `${marker} reached the model`);
});

test('remote provider without allowPrivateContentToRemote: no request is made; with it, the request is made', async () => {
  const { client, insight } = await vault(); await insight('Global: fine.', undefined);
  const gated = fake(ids => ({ relevant: ids, irrelevant: [] }), 'remote');
  const skipped = await refreshRelevance(client, WS, gated.provider, await config(client, false));
  assert.equal(skipped.status, 'skipped_private'); assert.equal(gated.calls.length, 0); assert.equal(await readRanking(client, WS), undefined);
  assert.equal((await refreshRelevance(client, WS, gated.provider, await config(client, true))).status, 'model'); assert.equal(gated.calls.length, 1);
  assert.equal((await refreshRelevance(client, WS, undefined, await config(client))).status, 'unavailable');
});

test('injection never calls a model: session context reads only the stored ranking', async () => {
  const { client, insight } = await vault(); const a = await insight('Global: A-LINE.', undefined); await insight('Global: B-LINE.', undefined);
  const { provider, calls } = fake(() => ({ relevant: [], irrelevant: [a] }));
  await refreshRelevance(client, WS, provider, await config(client)); const used = calls.length;
  const context = JSON.stringify(await buildSessionContext(client, { workspaceId: WS } as never));
  assert.equal(calls.length, used, 'session context must not call the provider');
  assert.ok(context.includes('B-LINE') && !context.includes('A-LINE'), 'session context uses the ranking');
});

test('another actor without access to the workspace cannot read its ranking', async () => {
  const { client, insight } = await vault(); await insight('Global: A.', undefined);
  await refreshRelevance(client, WS, fake(ids => ({ relevant: ids, irrelevant: [] })).provider, await config(client));
  const stranger = new Engram(client.vault.root, { actorId: 'stranger', permissions: [] });
  assert.equal(await readRanking(stranger, WS).catch(() => undefined), undefined);
});

/** A remote session whose calls run the server's own tools in-process and record which tools the client asked for. */
const session = (server: Engram) => { const names: string[] = []; const tools = toolsFor(server); const remote: RemoteSession = { sessionId: 's', tools: tools.map(t => t.name), async call(name, args) { names.push(name); const tool = tools.find(t => t.name === name); if (!tool) return { isError: true, value: undefined }; try { return { isError: false, value: JSON.parse(JSON.stringify(await tool.execute(args))) }; } catch { return { isError: true, value: undefined }; } } }; return { remote, names }; };

test('a remote client receives the finished projection from the server and computes nothing itself', async () => {
  const { client, insight } = await vault(); const a = await insight('Global: A-LINE.', undefined); await insight('Global: B-LINE.', undefined); await insight('Project: P-LINE.', WS);
  await refreshRelevance(client, WS, fake(() => ({ relevant: [], irrelevant: [a] })).provider, await config(client));
  const { remote, names } = session(client);
  const viaServer = await fetchProjection({ remote }, WS, 900), local = await fetchProjection({ client }, WS, 900);
  assert.deepEqual(names, ['mdb_project_projection'], 'the client must make exactly one call and fetch no insight rows or rankings');
  assert.deepEqual(claims(viaServer), claims(local)); assert.equal(viaServer.revision, local.revision); assert.equal(viaServer.ranking, 'model'); assert.equal(viaServer.source, 'remote');
  assert.ok(!claims(viaServer).some(c => c.includes('A-LINE')), 'the server-side ranking was applied');
});

test('the server-side projection tool honours access: a caller without workspace access gets no private ranking or project claims', async () => {
  const { client, insight } = await vault(); await insight('Project: P-LINE.', WS);
  await refreshRelevance(client, WS, fake(ids => ({ relevant: ids, irrelevant: [] })).provider, await config(client));
  const stranger = new Engram(client.vault.root, { actorId: 'stranger', permissions: [] });
  const { remote } = session(stranger);
  const seen = await fetchProjection({ remote }, WS, 900);
  assert.deepEqual(claims(seen), []); assert.equal(seen.ranking, 'deterministic');
});
