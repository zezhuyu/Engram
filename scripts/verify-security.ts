import { runSuite, summarize } from './lib/suite.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { currentSourceEvidence } from './lib/source-evidence.js';
const report = await runSuite({
  name: 'security', title: 'Security and isolation',
  files: ['dist/tests/security.test.js', 'dist/tests/security/adversarial.test.js', 'dist/tests/security/identity.test.js', 'dist/tests/security/oauth.test.js', 'dist/tests/interfaces.test.js', 'dist/tests/security/read-only.test.js', 'dist/tests/security/private-network.test.js', 'dist/tests/security/private-network-server.test.js', 'dist/tests/security/release-policy.test.js', 'dist/tests/memory/hardening.test.js', 'dist/tests/security/tls-verification.test.js', 'dist/tests/security/ci-diagnostics.test.js'],
  gaps: [
    { item: 'Real prompt-injection resistance of a live model', status: 'NOT_RUN', reason: 'Deterministic tests prove injected text has no authority in the runtime (validated proposals, review gate, scope checks). Behaviour of a real model under injection is a model-eval item.' },
    { item: 'Embedding leakage', status: 'UNSUPPORTED', reason: 'No embeddings exist.' },
    { item: 'Case-insensitive filesystem path collisions beyond workspace/collection IDs', status: 'NOT_RUN', reason: 'IDs are folded and rejected; object IDs are generated lowercase.' },
    { item: 'Local-owner disk access', status: 'UNSUPPORTED', reason: 'Application-level ACLs and immutability do not defend against a user with direct filesystem access.' }
  ],
  limitations: ['Zero-disclosure gate covers get/history/diff/patch/delete/restore/promote/links/backlinks/related, search counts and cursors, generated index files, forged queue payloads, traversal and YAML injection in the tested configurations.']
});
// This evidence is private HTTP only. Never emit tunnel or hosted-client PASS here.
const requiredHttpTests = [
  'OAuth resource validation pins issuer, audience and client and intersects mapped scopes with the subject ACL ceiling',
  'OAuth-only HTTP server starts without legacy credentials and challenges unauthenticated discovery',
  'MCP HTTP transport is opt-in, authenticated, origin-checked, and serves the same tool API as stdio',
  'remote-web MCP exposes bounded authorized tools and idempotent versioned create/patch operations'
];
const httpTests = requiredHttpTests.map(name => report.tests.find(t => t.name === name));
const httpPass = httpTests.every(t => t?.status === 'PASS');
await mkdir('verification/remote-clients', { recursive: true });
const httpArtifact = 'verification/security/report.json';
const artifactHash = createHash('sha256').update(readFileSync(httpArtifact)).digest('hex');
const evidenceSource = await currentSourceEvidence();
await writeFile('verification/remote-clients/http-service.json', JSON.stringify({
  status: httpPass ? 'PASS' : httpTests.some(t => t?.status === 'FAIL') ? 'FAIL' : 'NOT_RUN',
  evidenceType: 'http-service', layer: 'http-service', observedAt: report.run_at, evidence: [httpArtifact], evidenceHashes: { [httpArtifact]: artifactHash }, evidenceSource,
  checks: Object.fromEntries(['loopbackHttp', 'discovery', 'authorizedRead', 'rejectedAccess', 'clientIsolation', 'versionedWrite'].map(check => [check, httpPass])),
  detail: 'Private loopback HTTP tests only; no tunnel, public TLS or hosted-client claim.', tests: requiredHttpTests
}, null, 2) + '\n');
summarize(report);
