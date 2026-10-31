import test from 'node:test';
import assert from 'node:assert/strict';
import type { Document, ModelRequest } from '../../packages/core/types.js';
import { critiqueMessages, generationMessages, providerMessages } from '../../packages/models/prompts.js';
import { createProviderFromConfig } from '../../packages/models/factory.js';

const canaries = {
  aws: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signaturecanary123',
  bearer: 'Bearer bearer-canary-value-123456',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nprivate-key-canary-material\n-----END RSA PRIVATE KEY-----',
  url: 'https://user-canary:password-canary@example.test/path',
  databaseUrl: 'postgres://svc:database-password-canary@db.example.test/app',
  github: 'ghp_canarygithubcredential0123456789',
  openai: 'sk-canaryopenaicredential0123456789',
  apiAssignment: 'api_key=api-assignment-canary-value',
};

function doc(value: string): Document {
  return {
    id: 'doc-1', revisionId: 'rev-1', revisionNumber: 1,
    scope: { type: 'workspace', workspaceId: 'workspace-1' }, kind: 'note',
    title: `title ${value}`, body: `body ${value}`, tags: [], links: [], evidence: [],
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'actor-1', metadata: {}, path: 'workspace/doc.md', uri: `engram://workspace/doc/${value}`,
  };
}

function assertNoCanaries(prompt: string): void {
  for (const [name, value] of Object.entries(canaries)) assert.equal(prompt.includes(value), false, `${name} canary reached provider prompt`);
  assert.match(prompt, /\[REDACTED/);
}

test('generation prompt redacts credentials in every user and document field', () => {
  const all = Object.values(canaries).join('\n');
  const request: ModelRequest = { job: 'memory', goals: all, instruction: all, documents: [doc(all)] };
  assertNoCanaries(generationMessages(request).map(message => message.content).join('\n'));
});

test('critic prompt redacts credentials in proposal, metadata, instruction, and cited evidence', () => {
  const all = Object.values(canaries).join('\n');
  const prompt = critiqueMessages({
    instruction: `review ${all}`,
    proposal: {
      kind: 'discovery', title: `title ${all}`, body: `body ${all}`, evidence: [],
      metadata: { limitations: [all], missingEvidence: [all], facts: [all], speculation: [all], testPlan: [all], proposedValidation: all, counterarguments: [all] },
    },
    evidence: [doc(all)],
  }).map(message => message.content).join('\n');
  assertNoCanaries(prompt);
});

test('local-provider PII redaction is opt-in and applies to the complete assembled prompt', () => {
  const pii = 'SSN 123-45-6789 email person@example.test card 4111 1111 1111 1111';
  const request: ModelRequest = { job: 'memory', goals: pii, instruction: pii, documents: [doc(pii)] };
  const messages = generationMessages(request);
  const unchangedLocal = providerMessages(messages, 'local').map(message => message.content).join('\n');
  assert.ok(unchangedLocal.includes('123-45-6789'), 'local provider behavior stays compatible by default');
  const protectedLocal = providerMessages(messages, 'local', true).map(message => message.content).join('\n');
  assert.doesNotMatch(protectedLocal, /123-45-6789|person@example\.test|4111 1111 1111 1111/);
  assert.match(protectedLocal, /\[REDACTED SSN\]/);
  assert.match(protectedLocal, /\[REDACTED EMAIL\]/);
  assert.match(protectedLocal, /\[REDACTED CARD\]/);
  const remote = providerMessages(messages, 'remote').map(message => message.content).join('\n');
  assert.doesNotMatch(remote, /123-45-6789|person@example\.test|4111 1111 1111 1111/);
});

test('configured local HTTP provider applies the local PII switch at the actual request boundary', async () => {
  const pii = 'SSN 123-45-6789 email person@example.test card 4111 1111 1111 1111';
  let sent = '';
  const fetchMock: typeof fetch = async (_input, init) => {
    sent = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'note', title: 'ok', body: 'ok', evidence: [{ uri: 'engram://workspace/doc/doc-1', revisionId: 'rev-1' }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createProviderFromConfig({ provider: 'ollama', allowNetwork: false, baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'synthetic', redactPiiForLocal: true }, {}, fetchMock);
  await provider.generate({ job: 'memory', goals: pii, instruction: pii, documents: [doc(pii)] });
  assert.doesNotMatch(sent, /123-45-6789|person@example\.test|4111 1111 1111 1111/);
  assert.match(sent, /\[REDACTED SSN\]/);
  assert.match(sent, /\[REDACTED EMAIL\]/);
  assert.match(sent, /\[REDACTED CARD\]/);
});
