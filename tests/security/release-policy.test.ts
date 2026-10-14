import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRODUCTION_EVIDENCE, classifyRelease, collectProductionEvidence, modelEvidenceMatches, validateExclusions, type ProductionEvidence } from '../../scripts/lib/release-policy.js';

const green = { storageVerdict: 'PASS', openAreas: [] as string[], openGates: [] as string[], failedGates: [] as string[] };
const evidence = (over: Record<string, ProductionEvidence['status']> = {}): ProductionEvidence[] => PRODUCTION_EVIDENCE.map(({ id, title }) => ({ id, title, status: over[id] ?? 'PASS', detail: '', source: 'test' }));
const approved = (id: string) => ({ id, approvedBy: 'owner', reason: 'private tailnet only', approvedAt: '2026-10-12T00:00:00Z' });

test('historical model PASS needs matching source evidence and never promotes missing or failed runs', () => {
  const current = { 'engine.ts': 'engine-v2', 'provider.ts': 'provider-v2' };
  assert.equal(modelEvidenceMatches(undefined, current), false);
  assert.equal(modelEvidenceMatches({ status: 'PASS' }, current), false);
  assert.equal(modelEvidenceMatches({ status: 'PASS', evidenceSource: { files: { 'engine.ts': 'engine-v1', 'provider.ts': 'provider-v2' } } }, current), false);
  assert.equal(modelEvidenceMatches({ status: 'FAIL', evidenceSource: { files: current } }, current), false);
  assert.equal(modelEvidenceMatches({ status: 'PASS', evidenceSource: { files: current } }, current), true);
  assert.equal(modelEvidenceMatches({ status: 'PASS', evidenceSource: { files: {} } }, {}), false);
});

test('every automated gate passing does not make a release GA while production evidence is incomplete', () => {
  const result = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN', TRANSPORT_TLS: 'INCOMPLETE' }), exclusions: undefined });
  assert.equal(result.automatedGatesPass, true);
  assert.equal(result.level, 'BETA');
  assert.deepEqual(result.incompleteEvidence.map(e => e.id), ['PHYSICAL_POWER_LOSS', 'TRANSPORT_TLS']);
  assert.match(result.summary, /does not imply GA/);
});

test('a failed gate or a storage area that is not PASS is not releasable at any evidence level', () => {
  assert.equal(classifyRelease({ ...green, failedGates: ['S2'], evidence: evidence(), exclusions: [] }).level, 'NOT_RELEASABLE');
  assert.equal(classifyRelease({ ...green, storageVerdict: 'INCOMPLETE', evidence: evidence(), exclusions: [] }).level, 'NOT_RELEASABLE');
  assert.equal(classifyRelease({ ...green, evidence: evidence({ LIVE_OBJECT_STORE: 'FAIL' }), exclusions: [approved('PHYSICAL_POWER_LOSS')] }).level, 'NOT_RELEASABLE', 'a FAILED evidence item is never a mere gap');
});

test('open mandatory gates or areas keep the release at BETA even with complete evidence', () => {
  const result = classifyRelease({ ...green, openGates: ['REMOTE_CAPTURE'], openAreas: ['PERFORMANCE'], evidence: evidence(), exclusions: [] });
  assert.equal(result.level, 'BETA'); assert.ok(result.blockers.includes('mandatory gate REMOTE_CAPTURE not PASS')); assert.ok(result.blockers.includes('area PERFORMANCE not PASS'));
});

test('only complete exclusions with an approver, reason, date and known id count', () => {
  const bad = [{ id: 'PHYSICAL_POWER_LOSS' }, { id: 'PHYSICAL_POWER_LOSS', approvedBy: 'owner', reason: 'x' }, { id: 'PHYSICAL_POWER_LOSS', approvedBy: ' ', reason: 'x', approvedAt: '2026-10-12' }, { id: 'NOT_A_THING', approvedBy: 'owner', reason: 'x', approvedAt: '2026-10-12' }, { id: 'PHYSICAL_POWER_LOSS', approvedBy: 'owner', reason: 'x', approvedAt: 'yesterday' }, 'text', null];
  const checked = validateExclusions(bad, PRODUCTION_EVIDENCE.map(e => e.id)); assert.equal(checked.valid.length, 0); assert.equal(checked.ignored.length, bad.length);
  const result = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN' }), exclusions: bad });
  assert.equal(result.level, 'BETA'); assert.equal(result.excludedEvidence.length, 0); assert.equal(result.ignoredExclusions.length, bad.length);
});

test('GA eligibility needs every evidence item PASS or validly excluded, and is eligibility only', () => {
  assert.equal(classifyRelease({ ...green, evidence: evidence(), exclusions: [] }).level, 'GA_ELIGIBLE');
  const excluded = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN', TRANSPORT_TLS: 'INCOMPLETE' }), exclusions: { exclusions: [approved('PHYSICAL_POWER_LOSS'), approved('TRANSPORT_TLS')] } });
  assert.equal(excluded.level, 'GA_ELIGIBLE'); assert.deepEqual(excluded.excludedEvidence.sort(), ['PHYSICAL_POWER_LOSS', 'TRANSPORT_TLS']);
  assert.match(excluded.summary, /owner/); assert.doesNotMatch(excluded.summary, /^GA-ready/);
  const partial = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN', TRANSPORT_TLS: 'INCOMPLETE' }), exclusions: [approved('PHYSICAL_POWER_LOSS')] });
  assert.equal(partial.level, 'BETA'); assert.deepEqual(partial.incompleteEvidence.map(e => e.id), ['TRANSPORT_TLS']);
});

test('production evidence is read from recorded PASS statuses only; a private-network transport is not TLS evidence', () => {
  const none = collectProductionEvidence(() => undefined, undefined);
  assert.equal(none.length, PRODUCTION_EVIDENCE.length); assert.ok(none.every(e => e.status === 'NOT_RUN'));
  const tailnet = collectProductionEvidence(() => undefined, { physicalHostVerified: true, transport: 'tailscale-wireguard', tlsVerified: false, notRunOptional: ['air: server-restart-during-outage'] });
  const by = (id: string) => tailnet.find(e => e.id === id)!;
  assert.equal(by('TRANSPORT_TLS').status, 'INCOMPLETE'); assert.match(by('TRANSPORT_TLS').detail, /TLS was NOT tested/);
  assert.equal(by('REMOTE_SERVER_RESTART').status, 'INCOMPLETE');
  const restarted = collectProductionEvidence(() => undefined, { physicalHostVerified: true, transport: 'tailscale-wireguard', tlsVerified: false, notRunOptional: [] });
  assert.equal(restarted.find(e => e.id === 'REMOTE_SERVER_RESTART')!.status, 'PASS');
  const files = collectProductionEvidence(file => file.endsWith('physical-power-loss.json') ? { status: 'PASS' } : file.endsWith('cold-cache-benchmark.json') ? { status: 'maybe' } : undefined, undefined);
  assert.equal(files.find(e => e.id === 'PHYSICAL_POWER_LOSS')!.status, 'PASS'); assert.equal(files.find(e => e.id === 'COLD_CACHE_BENCHMARK')!.status, 'NOT_RUN');
});

test('the release script has no path that turns passing automated gates directly into GA', () => {
  const source = readFileSync('scripts/verify-release.ts', 'utf8');
  assert.ok(source.includes('classifyRelease(')); assert.doesNotMatch(source, /decision === 'GO'/); assert.doesNotMatch(source, /'GO'/); assert.doesNotMatch(source, /Yes: every area and mandatory gate is PASS/);
});
