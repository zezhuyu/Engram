import { promises as fs } from 'node:fs';
import { runSuite, summarize } from './lib/suite.js';
const evaluation = await fs.readFile('verification/dream/real-model-evaluation.json', 'utf8').then(JSON.parse).catch(() => undefined) as { status?: string; metrics?: { modes?: Record<string, { meanQuality?: number }>; criticAdversarialRejectionRecall?: number; criticSupportedAcceptanceRate?: number; minimumEvidenceGrounding?: number } } | undefined;
const modelSummary = evaluation ? `Real-model evaluation ${evaluation.status}: mode mean qualities=${JSON.stringify(evaluation.metrics?.modes)}, critic rejection recall=${evaluation.metrics?.criticAdversarialRejectionRecall}, supported acceptance=${evaluation.metrics?.criticSupportedAcceptanceRate}, evidence grounding=${evaluation.metrics?.minimumEvidenceGrounding}. See verification/dream/real-model-evaluation.json.` : 'Real-model quality evaluation has not been run.';
const scoringGaps = evaluation?.status === 'PASS' ? [] : [{ item: 'Independent semantic quality scoring for novelty, feasibility, usefulness, contradictions and hallucinations', status: evaluation?.status === 'FAIL' ? 'FAIL' as const : 'NOT_RUN' as const, reason: modelSummary }];
const criticPass = !!evaluation && Number(evaluation.metrics?.criticAdversarialRejectionRecall) >= 0.8 && Number(evaluation.metrics?.criticSupportedAcceptanceRate) >= 0.8;
const criticGaps = criticPass ? [] : [{ item: 'Real-model Knowledge Critic rejection of unsupported/duplicate/contradictory claims and supported acceptance', status: evaluation ? 'FAIL' as const : 'NOT_RUN' as const, reason: modelSummary }];
summarize(await runSuite({
  name: 'dream', title: 'Cross-domain dreaming: association retrieval, modes, critic, feedback (M4)',
  files: ['dist/tests/dream/retrieval.test.js', 'dist/tests/dream/dream.test.js'],
  allowedSkips: ['real model'],
  gaps: [
    ...scoringGaps,
    ...criticGaps,
    { item: 'Discovery usefulness over time', status: 'NOT_RUN', reason: 'Feedback and success-rate weighting are tested for mechanics; no longitudinal data exists.' },
    { item: 'Experiment execution', status: 'UNSUPPORTED', reason: 'Validation needs user confirmation or recorded experiment evidence; Engram never runs experiments.' }
  ],
  limitations: ['Discoveries are hypotheses. The critic is heuristic (lexical similarity); novelty is not proven.']
}));
