import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { Engram, refreshRelevance, type ModelProvider, type ModelRequest, type Scope } from '../../packages/sdk/index.js';
import { recordCase } from '../helpers/report.js';

test('profile and relevance prompts exclude other projects, denied actors, candidates and sensitive insights across every prompt field', async t => {
  const { root, vault } = await disposableVault(t);
  for (const id of ['project-a', 'project-b']) await vault.createWorkspace(id, '', { alice: ['read', 'write'], bob: ['read', 'write'] });
  await vault.createCollection('project-a', 'bob-private', '', { bob: ['read', 'write'] });
  const global: Scope = { type: 'global', area: 'profile' };
  const insight = async (body: string, scopeLabel: string, status = 'accepted', sensitivity = 'none', scope: Scope = global) => {
    const evidenceScope: Scope = scope.type === 'workspace' ? scope : { type: 'workspace', workspaceId: 'project-a' };
    const source = await vault.put({ scope: evidenceScope, kind: 'observation', title: `Evidence for ${body}`, body, metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
    return vault.put({ scope, kind: 'user_insight', title: body, body, status, evidence: [{ uri: source.uri, revisionId: source.revisionId }], metadata: { insightSchema: 1, category: 'preference', preferenceKey: body, evidenceClass: 'explicit', visibility: 'user_private', scopeLabel, sensitivity } });
  };
  await insight('ALLOW_GLOBAL_CANARY', 'global'); await insight('ALLOW_PROJECT_A_CANARY', 'project-a');
  await insight('DENY_PROJECT_B_INSIGHT_CANARY', 'project-b');
  await insight('DENY_CANDIDATE_CANARY', 'project-a', 'candidate');
  await insight('DENY_SENSITIVE_CANARY', 'project-a', 'accepted', 'sensitive');
  await insight('DENY_OTHER_ACTOR_INSIGHT_CANARY', 'project-a', 'accepted', 'none', { type: 'workspace', workspaceId: 'project-a', collectionId: 'bob-private' });
  await vault.put({ scope: { type: 'workspace', workspaceId: 'project-b' }, kind: 'observation', title: 'DENY_PROJECT_B_NOTE_CANARY', body: 'DENY_PROJECT_B_NOTE_CANARY', metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
  await vault.put({ scope: { type: 'workspace', workspaceId: 'project-a', collectionId: 'bob-private' }, kind: 'note', title: 'DENY_OTHER_ACTOR_TASK_CANARY', body: 'DENY_OTHER_ACTOR_TASK_CANARY', metadata: { typed: 'task', taskStatus: 'open' } });
  const source = await vault.put({ scope: { type: 'workspace', workspaceId: 'project-a' }, kind: 'observation', title: 'Authorized message', body: 'I prefer narrow functions.', metadata: { speaker: 'user', evidenceClass: 'user_authored' } });
  const client = new Engram(root, { actorId: 'alice', permissions: ['global:profile:read', 'global:profile:write'] });
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = { id: 'prompt-spy', locality: 'local', async generate(request) {
    calls.push(request);
    if (request.job === 'profile') return { kind: 'no_insight', title: 'Nothing more', body: 'No further insights.', evidence: [] };
    const first = request.documents[0]!;
    return { kind: 'insight_relevance', title: 'Ranking', body: JSON.stringify({ relevant: request.documents.map(d => d.uri), irrelevant: [] }), evidence: [{ uri: first.uri, revisionId: first.revisionId }] };
  } };
  const engine = new IntelligenceEngine(client.vault, provider);
  const queued = await engine.enqueue('profile', { scope: { type: 'workspace', workspaceId: 'project-a' }, objectIds: [source.id] });
  const [finished] = await engine.run({ job: 'profile', jobId: queued.id, limit: 1 });
  assert.equal(finished?.status, 'complete');
  assert.equal((await refreshRelevance(client, 'project-a', provider, await vault.config())).status, 'model');
  assert.equal(calls.length, 2);
  for (const request of calls) {
    const prompt = JSON.stringify({ goals: request.goals, instruction: request.instruction, documents: request.documents });
    assert.match(prompt, /ALLOW_GLOBAL_CANARY/); assert.match(prompt, /ALLOW_PROJECT_A_CANARY/);
    for (const canary of ['DENY_PROJECT_B_INSIGHT_CANARY', 'DENY_CANDIDATE_CANARY', 'DENY_SENSITIVE_CANARY', 'DENY_OTHER_ACTOR_INSIGHT_CANARY', 'DENY_PROJECT_B_NOTE_CANARY', 'DENY_OTHER_ACTOR_TASK_CANARY']) assert.ok(!prompt.includes(canary), `${request.job}: ${canary} reached a provider prompt`);
  }
  recordCase({ suite: 'profile', name: 'prompt-canary-isolation', status: 'PASS' });
});
