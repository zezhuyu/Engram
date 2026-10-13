import { promises as fs } from 'node:fs';
import { runSuite, summarize } from './lib/suite.js';
const evaluation = await fs.readFile('verification/profile/real-model-evaluation.json', 'utf8').then(JSON.parse).catch(() => undefined) as { status?: string; metrics?: Record<string, number> } | undefined;
const evalSummary = evaluation ? `Real-model labeled evaluation status ${evaluation.status}: precision=${evaluation.metrics?.precision}, recall=${evaluation.metrics?.recall}, falsePositiveRate=${evaluation.metrics?.falsePositiveRate}, jobSuccessRate=${evaluation.metrics?.jobSuccessRate}, scopeAccuracy=${evaluation.metrics?.scopeAccuracy}, evidenceGrounding=${evaluation.metrics?.evidenceGrounding}. See verification/profile/real-model-evaluation.json.` : 'Real-model labeled evaluation has not been run.';
const evaluationGaps = evaluation?.status === 'PASS' ? [] : [{ item: 'Labeled real-model extraction quality (precision, recall, false-positive rate, schema reliability, scope, provenance)', status: evaluation?.status === 'FAIL' ? 'FAIL' as const : 'NOT_RUN' as const, reason: evalSummary }];
summarize(await runSuite({
  name: 'profile', title: 'User intelligence and the evidence hierarchy (M2)',
  files: ['dist/tests/profile/insights.test.js', 'dist/tests/profile/multi-insight.test.js', 'dist/tests/profile/scope-required.test.js', 'dist/tests/profile/provenance.test.js', 'dist/tests/pipelines.test.js'],
  gaps: [
    ...evaluationGaps,
    { item: 'Sensitive-attribute detection beyond keywords', status: 'UNSUPPORTED', reason: 'A keyword heuristic plus the model\'s own label; it can miss sensitive content. Nothing is committed without review.' },
    { item: 'Calibration against external factual truth labels', status: 'NOT_RUN', reason: 'Extraction confidence reflects evidence provenance and density; factual certainty is represented separately and does not claim external calibration.' }
  ],
  limitations: ['Insights are user-private by storage ACL; anyone with global:profile:read (or the owner) can read them.', 'Evidence from a private workspace can support an insight stored in the profile area; the insight text itself is then user-private, not workspace-private.']
}));
