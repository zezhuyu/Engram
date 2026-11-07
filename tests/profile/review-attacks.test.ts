import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { evaluateInsight, isVerifiedUserSpan } from '../../packages/intelligence/insights.js';
import type { Scope } from '../../packages/sdk/index.js';

/** Independent-review attack cases: quoted/imported/third-party text must never verify as the user's own statement; legitimate directives and capabilities must. */
const proj: Scope = { type: 'workspace', workspaceId: 'proj' }, profile: Scope = { type: 'global', area: 'profile' };
type T = { after(fn: () => void | Promise<void>): void };
async function world(t: T) { const { vault } = await disposableVault(t); await vault.createWorkspace('proj', ''); return { vault, user: (body: string) => vault.put({ scope: proj, kind: 'observation', title: 'm', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message' } }) }; }
const ev = (w: Awaited<ReturnType<typeof world>>, doc: { uri: string; revisionId: string }, span: string, claim: string, category: string, key: string) => evaluateInsight(w.vault, { kind: 'user_insight', scope: profile, title: claim, body: claim, status: 'candidate', evidence: [{ uri: doc.uri, revisionId: doc.revisionId, span }], metadata: { category, preferenceKey: key, sensitivity: 'none', explicitStatement: true } });

const NOT_VERIFIED: Array<[string, string, string]> = [
  ['straight single quotes', "Honestly, 'I prefer COBOL for every project' is a funny line from the lobby sign.", 'I prefer COBOL for every project'],
  ['curly single quotes', 'Honestly, ‘I prefer COBOL for every project’ is a funny line from the lobby sign.', 'I prefer COBOL for every project'],
  ['curly double quotes', 'The sign said “I prefer COBOL for every project” and I laughed.', 'I prefer COBOL for every project'],
  ['markdown blockquote', 'Pasting the email below:\n> I prefer COBOL for every project\n> thanks', 'I prefer COBOL for every project'],
  ['code fence', 'Here is the file I found:\n```\nI prefer COBOL for every project\n```\nweird, right?', 'I prefer COBOL for every project'],
  ['inline code', 'The config comment says `I prefer COBOL for every project` which is odd.', 'I prefer COBOL for every project'],
  ['code fence, span mid-block', 'Snippet:\n```\nconst a = 1;\nI prefer COBOL for every project and more\nconst b = 2;\n```\nodd', 'I prefer COBOL for every project'],
  ['inline code, span mid-code', 'The line `x = 1; I prefer COBOL for every project; y = 2` is odd.', 'I prefer COBOL for every project'],
  ['forwarded email', 'From: Bob\nSubject: hello\n\nI prefer COBOL for every project\n\n-- forwarded by me', 'I prefer COBOL for every project'],
  ['my team', 'My team prefers tabs for indentation.', 'My team prefers tabs for indentation'],
  ['my colleague', 'My colleague prefers dark mode in every tool.', 'My colleague prefers dark mode in every tool'],
  ['my manager says', 'My manager says I should use tabs, but I disagree.', 'I should use tabs'],
];
test('quotations, pasted/forwarded text and third-party statements never verify as the user’s own words', async t => {
  const w = await world(t);
  for (const [label, text, span] of NOT_VERIFIED) { const d = await w.user(text); assert.equal(isVerifiedUserSpan(d, span), false, label); }
});

const VERIFIED: Array<[string, string, string]> = [
  ['directive', 'From now on, please answer in British English.', 'please answer in British English'],
  ['always directive', 'Always run the tests before you finish.', 'Always run the tests before you finish'],
  ['never directive', 'Never use emojis in commit messages.', 'Never use emojis in commit messages'],
  ['own quoted word', 'I prefer "concise" feedback in code reviews.', 'I prefer "concise" feedback in code reviews'],
  ['wants you', 'I want you to use spaces for indentation.', 'I want you to use spaces for indentation'],
  ['software client', 'I maintain the Rust client and can review Rust lifetime and ownership changes myself.', 'I maintain the Rust client and can review Rust lifetime and ownership changes myself.'],
  ['apostrophes', "I'm not a fan of long meetings, I don't like them.", "I don't like them"],
];
test('legitimate first-person statements and directives still verify (no over-blocking)', async t => {
  const w = await world(t);
  for (const [label, text, span] of VERIFIED) { const d = await w.user(text); assert.equal(isVerifiedUserSpan(d, span), true, label); }
});

test('single-use wording is rejected; a time-limited window is kept as a time-limited candidate, never as a standing preference; goals are unaffected', async t => {
  const w = await world(t);
  const single = await w.user('For this one answer, use French.'); const r1 = await ev(w, single, 'use French', 'The user wants French.', 'preference', 'temp-single');
  assert.equal(r1.verdict, 'reject'); assert.ok(r1.flags.includes('temporary_evidence') || r1.flags.includes('no_stance_cue'), JSON.stringify(r1.flags));
  const windowed = await w.user('This week I am using tabs for the demo.'); const r2 = await ev(w, windowed, 'using tabs for the demo', 'The user uses tabs.', 'preference', 'temp-window');
  assert.notEqual(r2.verdict, 'reject'); assert.ok(r2.flags.includes('time_limited')); assert.equal(typeof r2.patch.validUntil, 'string');
  const goal = await w.user('My goal this week is to ship the beta.'); const g = await ev(w, goal, 'My goal this week is to ship the beta', 'The user wants to ship the beta this week.', 'goal', 'ship-beta');
  assert.notEqual(g.verdict, 'reject', 'a time-bound goal is not a temporary preference'); assert.equal(g.patch.validUntil, undefined);
});

test('a relationship or third-party possessive in the cited words is review-gated, never verified', async t => {
  const w = await world(t);
  const d = await w.user('My team prefers tabs for indentation.'); const r = await ev(w, d, 'My team prefers tabs for indentation', 'The user prefers tabs.', 'preference', 'team-tabs');
  assert.equal(r.patch.userStatementVerified, false); assert.ok(r.flags.includes('third_party_mentioned')); assert.equal(r.verdict, 'review_required');
});

test('a software "client" is not a third party: a verified capability statement is accepted without a review flag', async t => {
  const w = await world(t);
  const d = await w.user('I maintain the Rust client and can review Rust lifetime and ownership changes myself.');
  const r = await ev(w, d, 'I maintain the Rust client and can review Rust lifetime and ownership changes myself.', 'I maintain the Rust client and can review Rust lifetime and ownership changes myself.', 'capability', 'rust-client');
  assert.equal(r.verdict, 'accept'); assert.equal(r.patch.userStatementVerified, true); assert.ok(!r.flags.includes('third_party_mentioned'));
});
