import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'intelligence', title: 'Intelligence engine (deterministic, fake and optional real provider)',
  files: ['dist/tests/intelligence.test.js', 'dist/tests/pipelines.test.js', 'dist/tests/models.test.js', 'dist/tests/models-switch.test.js','dist/tests/agents.test.js', 'dist/tests/skills.test.js', 'dist/tests/real-model.test.js'],
  allowedSkips: ['real model'],
  gaps: [
    { item: 'Real-model evaluation pack (20+ documents, 4+ domains, scored)', status: 'NOT_RUN', reason: 'Only a structural opt-in integration test exists (run once against local gpt-oss, see verification/phase-8.md). No evaluation pack, precision or groundedness metrics.' },
    { item: 'Wiki ingest→classify→extract→link→lint pipeline and incremental affected-page detection', status: 'NOT_RUN', reason: 'Only source→proposal→review→page is implemented.' },
    { item: 'Task-complete trigger and context handoff', status: 'NOT_RUN', reason: 'Session-end retrospective is implemented; no task-complete trigger or handoff document.' },
    { item: 'Distinct dream modes (micro/deep/strategic) with different candidate retrieval', status: 'NOT_RUN', reason: 'The mode is accepted as a flag but candidate selection and ranking are identical.' },
    { item: 'Dream validation loop and recursion budget tests', status: 'NOT_RUN', reason: 'No validation-outcome feedback and no test that dreams cannot breed on unvalidated dreams.' },
    { item: 'Worker: lease expiry with concurrent workers, index-job priority, replay of dead letters', status: 'NOT_RUN', reason: 'Jobs, retries, dead letters and idempotency are tested sequentially; concurrent-worker and priority behaviour are not.' },
    { item: 'Job idempotency key bound to source revision + pipeline version', status: 'NOT_RUN', reason: 'Jobs deduplicate by input digest, proposals by content fingerprint; pipeline version is not part of the key.' }
  ],
  limitations: ['The critic is deterministic (lexical duplicate, certainty, preference conflict, sensitivity keywords) plus an optional model critic that can only reject or flag.', 'Sensitive-content detection is a keyword heuristic.']
}));
