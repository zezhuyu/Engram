import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign as signSignature } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION_EVIDENCE, classifyRelease, collectProductionEvidence, currentQualityStatus, mcpEvidenceComplete, modelEvidenceMatches, performanceMeasurementValid, performanceSourceMatches, sourceEvidenceMatches, suiteReportConsistent, validateExclusions, type ProductionEvidence } from '../../scripts/lib/release-policy.js';
import { currentSourceEvidence } from '../../scripts/lib/source-evidence.js';

const green = { storageVerdict: 'PASS', openAreas: [] as string[], openGates: [] as string[], failedGates: [] as string[] };
const ownerKeys = generateKeyPairSync('ed25519');
const ownerPublicKey = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'signature' && k !== 'attestationSignature').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const sign = <T extends Record<string, unknown>>(value: T, field: 'signature' | 'attestationSignature' = 'attestationSignature'): T & Record<string, string> => ({ ...value, [field]: signSignature(null, Buffer.from(canonical(value)), ownerKeys.privateKey).toString('base64') }) as T & Record<string, string>;
const evidence = (over: Record<string, ProductionEvidence['status']> = {}): ProductionEvidence[] => PRODUCTION_EVIDENCE.map(({ id, title }) => ({ id, title, status: over[id] ?? 'PASS', detail: '', source: 'test' }));
const approved = (id: string) => sign({ id, approvedBy: 'owner', reason: 'private tailnet only', approvedAt: new Date().toISOString() }, 'signature');

test('MCP evidence separates private HTTP, tunnel transport and actual hosted invocations', () => {
  const checks = { discovery: true, authorizedRead: true, rejectedAccess: true, clientIsolation: true, versionedWrite: true };
  const http = { status: 'PASS', evidenceType: 'http-service', layer: 'http-service', observedAt: new Date().toISOString(), evidence: ['http-test.log'], evidenceHashes: { 'http-test.log': 'a'.repeat(64) }, checks: { ...checks, loopbackHttp: true } };
  assert.equal(mcpEvidenceComplete('MCP_HTTP_SERVICE', http), true, 'HTTP needs no TLS certificate');
  assert.equal(mcpEvidenceComplete('OPENAI_MCP_TUNNEL', http), false);
  assert.equal(mcpEvidenceComplete('CHATGPT_HOSTED_MCP', http), false);
  const tunnel = { ...http, evidenceType: 'openai-mcp-tunnel', layer: 'openai-tunnel', checks: { ...checks, outboundOnly: true, dedicatedEngramProfile: true, agentSlackUnchanged: true, upstreamHttp: true, oauthDiscovery: true, tokenForwarding: true } };
  assert.equal(mcpEvidenceComplete('OPENAI_MCP_TUNNEL', tunnel), true);
  assert.equal(mcpEvidenceComplete('CHATGPT_HOSTED_MCP', tunnel), false);
  const hosted = { ...http, evidenceType: 'chatgpt-hosted-mcp', layer: 'hosted-client', product: 'chatgpt', checks: { ...checks, actualHostedInvocation: true } };
  assert.equal(mcpEvidenceComplete('CHATGPT_HOSTED_MCP', hosted), true);
  assert.equal(mcpEvidenceComplete('CLAUDE_HOSTED_MCP', hosted), false);
  assert.equal(mcpEvidenceComplete('CLAUDE_HOSTED_MCP', { ...hosted, evidenceType: 'claude-hosted-mcp', product: 'claude.ai' }), true);
  assert.equal(mcpEvidenceComplete('CHATGPT_HOSTED_MCP', { ...hosted, checks: { ...checks, actualHostedInvocation: false } }), false);
  assert.equal(mcpEvidenceComplete('MCP_HTTP_SERVICE', { status: 'PASS' }), false);
  assert.equal(mcpEvidenceComplete('MCP_HTTP_SERVICE', { ...http, evidence: { length: 1 } }), false);
  const incomplete = collectProductionEvidence(() => ({ status: 'PASS', layer: 'https-network-probe' }), undefined);
  assert.equal(incomplete.find(e => e.id === 'CHATGPT_HOSTED_MCP')!.status, 'INCOMPLETE');
});

test('historical model PASS needs matching source evidence and never promotes missing or failed runs', () => {
  const current = { 'engine.ts': 'engine-v2', 'provider.ts': 'provider-v2' };
  assert.equal(modelEvidenceMatches(undefined, current), false);
  assert.equal(modelEvidenceMatches({ status: 'PASS' }, current), false);
  assert.equal(modelEvidenceMatches({ status: 'PASS', evidenceSource: { files: { 'engine.ts': 'engine-v1', 'provider.ts': 'provider-v2' } } }, current), false);
  assert.equal(modelEvidenceMatches({ status: 'FAIL', evidenceSource: { files: current } }, current), false);
  assert.equal(modelEvidenceMatches({ status: 'PASS', evidenceSource: { files: current } }, current), true);
  assert.equal(modelEvidenceMatches({ status: 'PASS', evidenceSource: { files: {} } }, {}), false);
});

test('current-source evidence requires every consumer source hash; a partial or mismatched map is stale', () => {
  const current = { 'packages/core/vault.ts': 'vault-v2', 'packages/storage-local/index.ts': 'storage-v2', 'verification/profile/labeled-corpus.json': 'corpus-v2' };
  assert.equal(sourceEvidenceMatches(undefined, current), false);
  assert.equal(sourceEvidenceMatches({ evidenceSource: { files: { 'packages/core/vault.ts': 'vault-v2' } } }, current), false);
  assert.equal(sourceEvidenceMatches({ evidenceSource: { files: { ...current, 'packages/core/vault.ts': 'vault-v1' } } }, current), false);
  assert.equal(sourceEvidenceMatches({ evidenceSource: { files: current } }, current), true);
  assert.equal(sourceEvidenceMatches({ evidenceSource: { files: { ...current, 'extra.example': 'hash' } } }, current), false);
  assert.equal(sourceEvidenceMatches({ evidenceSource: { files: current } }, {}), false);
});

test('release aggregation rejects inconsistent suite totals, missing cases and contradictory status fields', () => {
  const valid = { status: 'PASS', exitCode: 0, counts: { pass: 1, fail: 0, skipped: 0, total: 1 }, tests: [{ name: 'suite case', status: 'PASS' }], cases: 1, caseDetails: [{ name: 'suite case', status: 'PASS' }], caseFailures: [] };
  const inventory = { minimumTests: 1, requiredTests: ['suite case'], requiredCases: ['suite case'] };
  assert.equal(suiteReportConsistent(valid, inventory), true);
  assert.equal(suiteReportConsistent(valid, undefined), false, 'reports without a declared required-case inventory are not admissible');
  assert.equal(suiteReportConsistent({ ...valid, counts: { ...valid.counts, total: 2 } }, inventory), false);
  assert.equal(suiteReportConsistent({ ...valid, cases: 0 }, inventory), false);
  assert.equal(suiteReportConsistent({ ...valid, status: 'FAIL' }, inventory), false);
  assert.equal(suiteReportConsistent({ ...valid, status: 'PASS', tests: [], counts: { pass: 0, fail: 0, skipped: 0, total: 0 }, cases: 0, caseDetails: [] }, inventory), false);
});

test('mandatory suite inventory prevents reduced totals, unknown substitutions and duplicate case ids', () => {
  const report = { status: 'PASS', exitCode: 0, counts: { pass: 2, fail: 0, skipped: 0, total: 2 }, tests: [{ name: 'one', status: 'PASS' }, { name: 'two', status: 'PASS' }], cases: 2, caseDetails: [{ name: 'case-a', status: 'PASS' }, { name: 'case-b', status: 'PASS' }], caseFailures: [] };
  const inventory = { minimumTests: 2, requiredTests: ['one', 'two'], requiredCases: ['case-a', 'case-b'] };
  assert.equal(suiteReportConsistent(report, inventory), true);
  assert.equal(suiteReportConsistent({ ...report, tests: [report.tests[0]!], counts: { pass: 1, fail: 0, skipped: 0, total: 1 }, cases: 1, caseDetails: [report.caseDetails[0]!] }, inventory), false, 'consistently reduced totals still omit mandatory cases');
  assert.equal(suiteReportConsistent({ ...report, caseDetails: [{ name: 'case-a', status: 'PASS' }, { name: 'unknown', status: 'PASS' }] }, inventory), false);
  assert.equal(suiteReportConsistent({ ...report, caseDetails: [{ name: 'case-a', status: 'PASS' }, { name: 'case-a', status: 'PASS' }] }, inventory), false);
});

test('current source quality FAIL dominates base PASS, INCOMPLETE, NOT_RUN and missing reports', () => {
  const current = { 'engine.ts': 'sha-current' };
  const fail = { status: 'FAIL', runAt: new Date().toISOString(), evidenceSource: { files: current } };
  for (const base of ['PASS', 'INCOMPLETE', 'NOT_RUN']) assert.equal(currentQualityStatus(base, fail, current), 'FAIL', `base=${base}`);
  assert.equal(currentQualityStatus(undefined, fail, current), 'FAIL', 'a missing historical/base gate cannot mask current-source quality failure');
  assert.equal(currentQualityStatus('PASS', undefined, current), 'INCOMPLETE');
  assert.equal(currentQualityStatus('PASS', { ...fail, runAt: '2000-01-01T00:00:00Z' }, current), 'INCOMPLETE');
  assert.equal(currentQualityStatus('PASS', { ...fail, evidenceSource: { files: { 'engine.ts': 'stale' } } }, current), 'INCOMPLETE');
});

test('performance evidence requires current full-source and scoped source identities', () => {
  const current = { fingerprint: 'full-current', files: { 'vault.ts': 'v2', 'query.ts': 'q2', 'other.ts': 'o2' } };
  const report = { fingerprint: 'full-current', workingTreeSourceFingerprint: 'full-current', fullSourceFileCount: 3, files: { 'vault.ts': 'v2', 'query.ts': 'q2' } };
  assert.equal(performanceSourceMatches(report, current, ['vault.ts', 'query.ts']), true);
  assert.equal(performanceSourceMatches({ ...report, fullSourceFileCount: 2 }, current, ['vault.ts', 'query.ts']), false);
  assert.equal(performanceSourceMatches({ ...report, fingerprint: 'old' }, current, ['vault.ts', 'query.ts']), false);
  assert.equal(performanceSourceMatches({ ...report, files: { 'vault.ts': 'v1', 'query.ts': 'q2' } }, current, ['vault.ts', 'query.ts']), false);
});

test('performance measurements need fresh corpus-bound finite distributions; pass booleans are irrelevant', () => {
  const base = { timestamp: new Date().toISOString(), corpusDocuments: 100_000, measurementCount: 15, measured: { p50Ms: 10, p95Ms: 20, p99Ms: 30, samples: 15 }, thresholdMs: 50 };
  assert.equal(performanceMeasurementValid(base, 100_000), true);
  assert.equal(performanceMeasurementValid({ ...base, corpusDocuments: 10_000 }, 100_000), false);
  assert.equal(performanceMeasurementValid({ ...base, measured: { ...base.measured, p95Ms: Number.NaN } }, 100_000), false);
  assert.equal(performanceMeasurementValid({ ...base, measured: { ...base.measured, samples: 0 } }, 100_000), false);
  assert.equal(performanceMeasurementValid({ ...base, timestamp: '2099-01-01T00:00:00Z' }, 100_000), false);
});

test('source fingerprint covers extensionless deployment inputs and detects deletion', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engram-source-evidence-'));
  const samples: Array<[string, string]> = [['integrations/lifecycle.ts', 'one'], ['macos/App.swift', 'one'], ['linux/README.md', 'one'], ['macos/icon.png', 'one'], ['deploy/Caddyfile', 'one'], ['deploy/.env.example', 'one'], ['verification/profile/labeled-corpus.json', 'one'], ['verification/dream/labeled-scenarios.json', 'one'], ['verification/benchmarks/corpus-manifest.json', 'one']];
  for (const [name, body] of samples) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body); }
  const before = await currentSourceEvidence(root);
  for (const name of samples.map(([name]) => name)) {
    writeFileSync(path.join(root, name), 'two'); const after = await currentSourceEvidence(root);
    assert.notEqual(after.fingerprint, before.fingerprint, `${name} must be included in current-source identity`);
    writeFileSync(path.join(root, name), 'one');
  }
  const beforeDelete = await currentSourceEvidence(root);
  await import('node:fs/promises').then(fs => fs.unlink(path.join(root, 'deploy/Caddyfile')));
  assert.notEqual((await currentSourceEvidence(root)).fingerprint, beforeDelete.fingerprint, 'deleting any declared source must alter source identity');
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

test('only trusted signed exclusions with an approver, reason, fresh date and known id count', () => {
  const bad = [{ id: 'PHYSICAL_POWER_LOSS' }, { id: 'PHYSICAL_POWER_LOSS', approvedBy: 'owner', reason: 'x' }, { id: 'PHYSICAL_POWER_LOSS', approvedBy: ' ', reason: 'x', approvedAt: '2026-10-12' }, { id: 'NOT_A_THING', approvedBy: 'owner', reason: 'x', approvedAt: '2026-10-12' }, { id: 'PHYSICAL_POWER_LOSS', approvedBy: 'owner', reason: 'x', approvedAt: 'yesterday' }, 'text', null];
  const checked = validateExclusions(bad, PRODUCTION_EVIDENCE.map(e => e.id), ownerPublicKey); assert.equal(checked.valid.length, 0); assert.equal(checked.ignored.length, bad.length);
  const result = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN' }), exclusions: bad });
  assert.equal(result.level, 'BETA'); assert.equal(result.excludedEvidence.length, 0); assert.equal(result.ignoredExclusions.length, bad.length);
});

test('GA eligibility needs every evidence item PASS or validly excluded, and is eligibility only', () => {
  assert.equal(classifyRelease({ ...green, evidence: evidence(), exclusions: [] }).level, 'GA_ELIGIBLE');
  const excluded = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN', TRANSPORT_TLS: 'INCOMPLETE' }), exclusions: { exclusions: [approved('PHYSICAL_POWER_LOSS'), approved('TRANSPORT_TLS')] } }, ownerPublicKey);
  assert.equal(excluded.level, 'GA_ELIGIBLE'); assert.deepEqual(excluded.excludedEvidence.sort(), ['PHYSICAL_POWER_LOSS', 'TRANSPORT_TLS']);
  assert.match(excluded.summary, /owner/); assert.doesNotMatch(excluded.summary, /^GA-ready/);
  const partial = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN', TRANSPORT_TLS: 'INCOMPLETE' }), exclusions: [approved('PHYSICAL_POWER_LOSS')] }, ownerPublicKey);
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
  assert.equal(restarted.find(e => e.id === 'REMOTE_SERVER_RESTART')!.status, 'INCOMPLETE', 'an omitted notRun marker is not positive restart evidence');
  const files = collectProductionEvidence(file => file.endsWith('physical-power-loss.json') ? { status: 'PASS' } : file.endsWith('cold-cache-benchmark.json') ? { status: 'maybe' } : undefined, undefined);
  assert.notEqual(files.find(e => e.id === 'PHYSICAL_POWER_LOSS')!.status, 'PASS'); assert.equal(files.find(e => e.id === 'COLD_CACHE_BENCHMARK')!.status, 'NOT_RUN');
});

test('MCP PASS requires recent evidence whose exact artifact bytes match the recorded hashes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-evidence-')); mkdirSync(path.join(root, 'verification/remote-clients'), { recursive: true });
  const artifact = 'verification/remote-clients/check.json'; writeFileSync(path.join(root, artifact), '{"actual":true}\n');
  const sha = createHash('sha256').update(readFileSync(path.join(root, artifact))).digest('hex');
  const currentFiles = { 'src.ts': 'current-hash' };
  const record = { status: 'PASS', evidenceType: 'http-service', layer: 'http-service', observedAt: new Date().toISOString(), evidence: [artifact], evidenceHashes: { [artifact]: sha }, evidenceSource: { files: currentFiles }, checks: { discovery: true, authorizedRead: true, rejectedAccess: true, clientIsolation: true, versionedWrite: true, loopbackHttp: true } };
  const collect = (value: unknown) => collectProductionEvidence(file => file.endsWith('http-service.json') ? value : undefined, undefined, root, currentFiles).find(e => e.id === 'MCP_HTTP_SERVICE')!.status;
  assert.equal(collect(record), 'PASS');
  assert.equal(collect({ ...record, observedAt: '2000-01-01T00:00:00.000Z' }), 'INCOMPLETE', 'old evidence is not current PASS');
  assert.equal(collect({ ...record, evidenceHashes: { [artifact]: '0'.repeat(64) } }), 'INCOMPLETE', 'a digest mismatch cannot certify the record');
  assert.equal(collect({ ...record, evidence: ['/tmp/outside.log'] }), 'INCOMPLETE', 'absolute paths cannot certify evidence');
  writeFileSync(path.join(root, artifact), 'mutated'); assert.equal(collect(record), 'INCOMPLETE', 'changed evidence cannot retain its old attestation');
});

test('the release script has no path that turns passing automated gates directly into GA', () => {
  const source = readFileSync('scripts/verify-release.ts', 'utf8');
  assert.ok(source.includes('classifyRelease(')); assert.doesNotMatch(source, /decision === 'GO'/); assert.doesNotMatch(source, /'GO'/); assert.doesNotMatch(source, /Yes: every area and mandatory gate is PASS/);
  assert.match(source, /policy\.level === 'NOT_RELEASABLE' \? 'No:/);
});

test('editable local proof, bare physical PASS and agent-named future exclusions cannot close release evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engram-untrusted-release-proof-'));
  mkdirSync(path.join(root, 'verification'), { recursive: true });
  const local = 'verification/local-only.json';
  writeFileSync(path.join(root, local), JSON.stringify({ layer: 'http-service', product: 'local', actualHostedInvocation: false }));
  const sha = createHash('sha256').update(readFileSync(path.join(root, local))).digest('hex');
  const currentFiles = { 'src.ts': 'current-hash' };
  const forged = { status: 'PASS', evidenceType: 'chatgpt-hosted-mcp', layer: 'hosted-client', product: 'chatgpt', observedAt: new Date().toISOString(), evidence: [local], evidenceHashes: { [local]: sha }, evidenceSource: { files: currentFiles }, checks: { actualHostedInvocation: true, discovery: true, authorizedRead: true, rejectedAccess: true, clientIsolation: true, versionedWrite: true } };
  const hosted = collectProductionEvidence(file => file.endsWith('chatgpt-hosted.json') ? forged : undefined, undefined, root, currentFiles, ownerPublicKey).find(e => e.id === 'CHATGPT_HOSTED_MCP')!;
  assert.notEqual(hosted.status, 'PASS');
  const physical = collectProductionEvidence(file => file.endsWith('physical-power-loss.json') ? { status: 'PASS' } : undefined, undefined, root).find(e => e.id === 'PHYSICAL_POWER_LOSS')!;
  assert.notEqual(physical.status, 'PASS');
  const excluded = classifyRelease({ ...green, evidence: evidence({ PHYSICAL_POWER_LOSS: 'NOT_RUN' }), exclusions: [{ id: 'PHYSICAL_POWER_LOSS', approvedBy: 'implementation-agent', reason: 'test', approvedAt: '2099-01-01' }] });
  assert.notEqual(excluded.level, 'GA_ELIGIBLE');
});
