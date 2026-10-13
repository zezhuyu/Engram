import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'security', title: 'Security and isolation',
  files: ['dist/tests/security.test.js', 'dist/tests/security/adversarial.test.js', 'dist/tests/security/identity.test.js', 'dist/tests/interfaces.test.js', 'dist/tests/security/read-only.test.js', 'dist/tests/security/private-network.test.js', 'dist/tests/security/private-network-server.test.js', 'dist/tests/security/release-policy.test.js', 'dist/tests/memory/hardening.test.js', 'dist/tests/security/tls-verification.test.js', 'dist/tests/security/ci-diagnostics.test.js'],
  gaps: [
    { item: 'Real prompt-injection resistance of a live model', status: 'NOT_RUN', reason: 'Deterministic tests prove injected text has no authority in the runtime (validated proposals, review gate, scope checks). Behaviour of a real model under injection is a model-eval item.' },
    { item: 'Embedding leakage', status: 'UNSUPPORTED', reason: 'No embeddings exist.' },
    { item: 'Case-insensitive filesystem path collisions beyond workspace/collection IDs', status: 'NOT_RUN', reason: 'IDs are folded and rejected; object IDs are generated lowercase.' },
    { item: 'Local-owner disk access', status: 'UNSUPPORTED', reason: 'Application-level ACLs and immutability do not defend against a user with direct filesystem access.' }
  ],
  limitations: ['Zero-disclosure gate covers get/history/diff/patch/delete/restore/promote/links/backlinks/related, search counts and cursors, generated index files, forged queue payloads, traversal and YAML injection in the tested configurations.']
}));
