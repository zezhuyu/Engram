import type { ModelProvider, ModelProposal, Document } from '../packages/core/types.js';

/** Explicit synthetic fixture, never selected implicitly by the runtime. */
export class SyntheticFixtureModel implements ModelProvider {
  readonly id = 'synthetic-fixture-not-an-llm';
  async generate(input: { job: string; documents: Document[]; goals: string; instruction: string }): Promise<ModelProposal> {
    const evidence = input.documents.map(doc => ({ uri: doc.uri, revisionId: doc.revisionId }));
    if (input.job === 'dream') return {
      kind: 'discovery', title: '[SYNTHETIC FIXTURE] Compose an API and a browser interface',
      body: '# Synthetic compositional hypothesis\n\nEvidence records describe Python API and JavaScript UI capabilities. Combining them may produce a full-stack research notebook. This is a hypothesis, not a demonstrated result or model-generated discovery.\n\n## Mechanism\nThe API provides structured data; the UI consumes it.\n\n## Goal relevance\n' + input.goals + '\n\n## Constraints\nAuthentication, schema compatibility, and deployment need independent validation.\n\n## Evidence\n' + evidence.map(e => `- ${e.uri} @ ${e.revisionId}`).join('\n'),
      evidence, status: 'hypothesis', metadata: { synthetic: true, subtype: 'composition', novelty: 'new_to_user', reasoningSummary: 'The Python API returns structured JSON that the JavaScript interface can consume.', limitations: ['Authentication, schema compatibility and deployment need independent validation.'], proposedValidation: 'Build a minimal API and browser client and record whether one request round-trips.', testPlan: ['Define a shared response schema', 'Test one browser request against the API', 'Evaluate the result with a user'], counterarguments: ['Skill descriptions do not establish production readiness', 'This composition is familiar and its usefulness still needs validation'] }
    };
    return { kind: input.job === 'profile' ? 'user_insight' : input.job === 'reflect' ? 'reflection' : input.job === 'memory' ? 'insight' : 'wiki_page', title: `[SYNTHETIC FIXTURE] ${input.job} proposal`, body: '# Synthetic evidence-linked derivative\n\nThis fixture demonstrates review and provenance plumbing only. It is not a real model synthesis.\n\n' + evidence.map(e => `- ${e.uri} @ ${e.revisionId}`).join('\n'), evidence, metadata: { synthetic: true } };
  }
}
