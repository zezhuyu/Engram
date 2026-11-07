import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFactGrounding, polarityConflict, sourceSupportsFact, type GroundingFailure } from '../../packages/intelligence/dream/grounding.js';

const src = (body: string, title = ''): { title: string; body: string } => ({ title, body });
const bad = (fact: string, sources: Array<{ title: string; body: string }>, reasons: GroundingFailure[], options = {}) => { const r = assessFactGrounding(fact, sources, options); assert.equal(r.ok, false, `should be refused: ${fact}`); assert.ok(reasons.includes(r.reason!), `${fact}: got ${r.reason} (${r.detail})`); };
const good = (fact: string, sources: Array<{ title: string; body: string }>, options = {}) => { const r = assessFactGrounding(fact, sources, options); assert.equal(r.ok, true, `should be accepted: ${fact} (${r.reason}: ${r.detail})`); };

const CACHE = src('Caching authenticated API responses is unsafe and leaks data between users.', 'Authenticated responses must not be cached');
test('affirmation versus negation: a contradicted claim is refused despite high lexical overlap', () => {
  bad('Caching authenticated API responses is safe and never leaks data between users', [CACHE], ['contradicted']);
  bad('Caching authenticated API responses does not leak data between users', [CACHE], ['contradicted']);
  good('Caching authenticated API responses is unsafe', [CACHE]);
  good('Caching authenticated API responses is unsafe and leaks data between users', [CACHE]);
});
test('safe versus unsafe (and a double negative that restores the meaning)', () => {
  const s = src('The rollout procedure is safe to run twice.');
  bad('The rollout procedure is unsafe to run twice', [s], ['contradicted']);
  bad('The rollout procedure is not safe to run twice', [s], ['contradicted']);
  good('The rollout procedure is not unsafe to run twice', [s]);
  good('The rollout procedure is safe to run twice', [s]);
});
test('can versus cannot, must versus must not, always versus never', () => {
  const can = src('Clients can retry the request after a timeout.');
  bad('Clients cannot retry the request after a timeout', [can], ['contradicted']);
  bad("Clients can't retry the request after a timeout", [can], ['contradicted']);
  good('Clients can retry the request after a timeout', [can]);
  const must = src('Operators must rotate the signing key after an incident.');
  bad('Operators must not rotate the signing key after an incident', [must], ['contradicted']);
  const always = src('Deploys always run the migration before the restart.');
  bad('Deploys never run the migration before the restart', [always], ['contradicted']);
});
test('historical versus current truth', () => {
  const old = src('Version 1 of the API supported XML but XML is no longer supported.');
  bad('The API supports XML', [old], ['contradicted', 'temporal_mismatch']);
  good('XML is no longer supported', [old]);
  good('Version 1 of the API supported XML', [old]);
  const removed = src('The legacy endpoint was removed in version 2.');
  bad('The legacy endpoint exists in version 2', [removed], ['contradicted', 'temporal_mismatch']);
  // Known limitation (documented, not tested as refused): a one-word semantic substitution ("deprecated" -> "recommended") keeps two of three content words and is left to the critic and the reviewer.
});
test('conditional statements: dropping the condition is refused, keeping it is accepted', () => {
  const c = src('Caching is safe only if responses are not authenticated.');
  bad('Caching is safe', [c], ['conditional_dropped']);
  good('Caching is safe only if responses are not authenticated', [c]);
  const u = src('Deploys are blocked unless the health check passes.');
  bad('Deploys are blocked', [u], ['conditional_dropped']);
  good('Deploys are blocked unless the health check passes', [u]);
});
test('conflicting evidence: a claim matching one source but contradicted by another is refused unless attributed or in contradiction mode', () => {
  const a = src('Caching authenticated API responses is unsafe and leaks data between users.');
  const b = src('Caching all API responses is always safe and speeds everything up.');
  bad('Caching all API responses is always safe', [a, b], ['conflicting_evidence', 'contradicted']);
  good('Source B states that caching all API responses is always safe', [a, b]);
  good('Caching all API responses is always safe', [a, b], { contradictionMode: true });
  assert.equal(sourceSupportsFact('Caching all API responses is always safe', b), true);
  assert.equal(sourceSupportsFact('Caching all API responses is always safe', a), false, 'a source that says the opposite does not represent the claim');
});
test('"no longer" carries polarity even when the past tense hides the temporal marker', () => {
  bad('The batch endpoint is enabled', [src('The batch endpoint is no longer enabled.')], ['contradicted', 'temporal_mismatch']);
  good('The batch endpoint is no longer enabled', [src('The batch endpoint is no longer enabled.')]);
});
test('attribution excuses a fact that another cited source contradicts; the same flat claim is refused', () => {
  const unsafe = src('Caching authenticated responses is unsafe.'), safe = src('Caching authenticated responses is safe.');
  bad('Caching authenticated responses is safe', [unsafe, safe], ['conflicting_evidence']);
  good('Source B claims caching authenticated responses is safe', [unsafe, safe]);
});
test('partial lexical overlap (three to six tenths of the claim) is not support', () => {
  bad('Python services expose XML over gRPC for Rust clients', [src('Python services expose JSON over HTTP using FastAPI.')], ['unsupported_proposition']);
});
test('mixed supported and unsupported propositions are refused as a whole', () => {
  const s = src('Python services expose JSON over HTTP using FastAPI.');
  bad('Python services expose JSON over HTTP and run on Kubernetes clusters in three regions', [s], ['unsupported_proposition']);
  good('Python services expose JSON over HTTP using FastAPI', [s]);
  bad('Python services expose JSON over HTTP', [src('Unrelated gardening note about tomato soil acidity.')], ['unsupported_proposition']);
});
test('legitimate paraphrases of a cited revision (title counts, plurals, split compounds) are still accepted', () => {
  const python = src('Use a token bucket per client to enforce request quotas in a Python API.', 'Python rate limiting');
  const cache = src('Client side caches reduce repeated fetches but need ratelimit friendly invalidation.', 'Frontend caching');
  good('Python rate limiting uses a token bucket per client', [python]);
  good('Frontend caching needs rate limit friendly invalidation', [cache]);
  good('Client side caches reduce repeated fetches', [cache]);
  bad('Token buckets could schedule cache invalidation and mitigate abuse', [python], ['unsupported_proposition']);
});
test('polarityConflict unit behaviour', () => {
  assert.equal(polarityConflict('x is safe', 'x is unsafe'), true);
  assert.equal(polarityConflict('x is not unsafe', 'x is safe'), false);
  assert.equal(polarityConflict('x can run', 'x cannot run'), true);
  assert.equal(polarityConflict('x can run', 'x can run'), false);
  assert.equal(polarityConflict('x was disabled', 'x was enabled'), true);
});

import { checkDiscovery } from '../../packages/intelligence/dream/critic.js';
import type { Document, ModelProposal } from '../../packages/core/types.js';
const doc = (id: string, title: string, body: string, domain: string): Document => ({ id, uri: `mdb://wiki/objects/${id}`, revisionId: `rev_${id}`, revisionNumber: 1, scope: { type: 'global', area: 'wiki' }, kind: 'wiki_page', title, body, tags: [`domain:${domain}`], links: [], evidence: [], status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 'owner', metadata: {}, path: `wiki/${id}.md` } as unknown as Document);
const A = doc('a1', 'Authenticated responses', 'Caching authenticated API responses is unsafe and leaks data between users.', 'security');
const B = doc('b1', 'Dashboard speed', 'Browser dashboards render faster when API responses are cached by the client.', 'frontend');
const discovery = (facts: string[]): ModelProposal => ({ kind: 'discovery', title: 'Cache and dashboards', body: 'Hypothesis: client caching could speed dashboards but may leak data.', evidence: [{ uri: A.uri, revisionId: A.revisionId, span: 'Caching authenticated API responses is unsafe' }, { uri: B.uri, revisionId: B.revisionId, span: 'Browser dashboards render faster' }], metadata: { subtype: 'transfer', novelty: 'new_to_user', reasoningSummary: 'Both sources discuss caching of API responses from different angles.', limitations: ['Only two sources.'], testPlan: ['Measure render time with and without client caching.'], counterarguments: ['Caching authenticated data leaks it.'], proposedValidation: 'Measure dashboard render time and check responses for cross-user leakage.', mechanism: 'Client caching reduces fetches but responses may be shared across users.', distance: 'complementary', hops: ['Dashboards -> client caching', 'Client caching -> authenticated responses'], facts, speculation: ['Caching may be selectively enabled'], missingEvidence: ['Leak rate under real traffic'] } } as unknown as ModelProposal);
test('checkDiscovery refuses a deep discovery whose fact is contradicted by a cited source and accepts the faithful fact', () => {
  assert.throws(() => checkDiscovery('deep', discovery(['Caching authenticated API responses is safe and never leaks data between users']), [A, B], [], []), /contradict/);
  assert.doesNotThrow(() => checkDiscovery('deep', discovery(['Caching authenticated API responses is unsafe', 'Browser dashboards render faster when API responses are cached by the client']), [A, B], [], []));
});
