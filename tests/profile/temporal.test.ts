import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableVault } from '../helpers/disposable-vault.js';
import { evaluateInsight, projectProfile } from '../../packages/intelligence/insights.js';
import { endOfLocalDay, insightActiveAt, parseTimeLimit, startOfLocalDay } from '../../packages/intelligence/temporal.js';
import { Engram } from '../../packages/sdk/index.js';
import { localParts } from '../../packages/adaptive/clock.js';
import type { Scope } from '../../packages/sdk/index.js';

const at = (iso: string) => new Date(iso);
const until = (text: string, ref: string, tz = 'UTC') => parseTimeLimit(text, at(ref), tz)?.until;

test('parser: weekdays, today, week boundaries in UTC (Wednesday 2026-11-04)', () => {
  const ref = '2026-11-04T10:00:00.000Z';
  assert.equal(until('Until Friday please answer tersely.', ref), '2026-11-06T23:59:59.999Z');
  assert.equal(until('until Wednesday', ref), '2026-11-04T23:59:59.999Z', 'the same weekday means the end of today');
  assert.equal(until('until next Wednesday', ref), '2026-11-11T23:59:59.999Z');
  assert.equal(until('just for today answer in French', ref), '2026-11-04T23:59:59.999Z');
  assert.equal(until('tonight keep it short', ref), '2026-11-04T23:59:59.999Z');
  assert.equal(until('this week use tabs', ref), '2026-11-08T23:59:59.999Z', 'ISO week ends Sunday');
  assert.equal(until('this week use tabs', '2026-11-08T08:00:00.000Z'), '2026-11-08T23:59:59.999Z', 'on Sunday the week ends tonight');
  assert.equal(until('until tomorrow', ref), '2026-11-05T23:59:59.999Z');
  assert.equal(until('until the end of the month', ref), '2026-11-30T23:59:59.999Z');
  assert.equal(until('until the end of the year', ref), '2026-12-31T23:59:59.999Z');
});
test('parser: durations and explicit dates', () => {
  const ref = '2026-11-04T10:00:00.000Z';
  assert.equal(until('for the next 2 hours', ref), '2026-11-04T12:00:00.000Z'); assert.equal(until('for a couple of hours', ref), '2026-11-04T12:00:00.000Z');
  assert.equal(until('for three days', ref), '2026-11-07T10:00:00.000Z'); assert.equal(until('for the next 30 minutes', ref), '2026-11-04T10:30:00.000Z');
  assert.equal(until('until November 10', ref), '2026-11-10T23:59:59.999Z'); assert.equal(until('until January 5', ref), '2027-01-05T23:59:59.999Z', 'a month already past rolls to next year');
  assert.equal(until('through 2026-12-24', ref), '2026-12-24T23:59:59.999Z'); assert.equal(until('until February 30', ref), undefined, 'an impossible date is not guessed');
  assert.equal(until('until the cows come home', ref), undefined);
});
test('time-zone boundaries: the window ends at LOCAL midnight, including UTC+14, UTC-11 and DST days', () => {
  assert.equal(until('for today', '2026-11-04T23:30:00.000Z', 'Pacific/Kiritimati'), '2026-11-05T09:59:59.999Z', 'UTC+14: already Thursday locally');
  assert.equal(until('tonight', '2026-11-04T05:00:00.000Z', 'Pacific/Pago_Pago'), '2026-11-04T10:59:59.999Z', 'UTC-11: still Tuesday locally');
  assert.equal(until('until Sunday', '2026-03-07T20:00:00.000Z', 'America/New_York'), '2026-03-09T03:59:59.999Z', 'spring-forward Sunday is 23 hours long');
  assert.equal(until('until Sunday', '2026-10-31T15:00:00.000Z', 'America/New_York'), '2026-11-02T04:59:59.999Z', 'fall-back Sunday is 25 hours long');
  assert.equal(startOfLocalDay('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z'); assert.equal(endOfLocalDay('2026-03-08', 'America/New_York').toISOString(), '2026-03-09T03:59:59.999Z');
  assert.equal(until('for today', '2026-11-04T23:30:00.000Z', 'UTC'), '2026-11-04T23:59:59.999Z');
});
test('property: for many zones and DST transition days a local day starts at its first instant and ends one millisecond before the next local day', () => {
  const zones = ['UTC', 'America/New_York', 'America/Santiago', 'America/Havana', 'Pacific/Auckland', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Apia', 'Europe/London', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
  const dates = ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-28', '2026-03-29', '2026-04-04', '2026-04-05', '2026-09-05', '2026-09-06', '2026-09-27', '2026-10-03', '2026-10-04', '2026-10-31', '2026-11-01', '2026-11-02'];
  for (const zone of zones) for (const date of dates) {
    const start = startOfLocalDay(date, zone), end = endOfLocalDay(date, zone);
    assert.equal(localParts(start, zone).date, date, `${zone} ${date}: start is on the date`); assert.ok(localParts(new Date(start.getTime() - 1), zone).date < date, `${zone} ${date}: one ms before the start is the previous day`);
    assert.equal(localParts(end, zone).date, date, `${zone} ${date}: end is on the date`); assert.ok(localParts(new Date(end.getTime() + 1), zone).date > date, `${zone} ${date}: one ms after the end is the next day`);
  }
});
test('parser: "until the end of the week" runs to Sunday night', () => { assert.equal(until('until the end of the week', '2026-11-04T10:00:00.000Z'), '2026-11-08T23:59:59.999Z'); assert.equal(until('through the end of the day', '2026-11-04T10:00:00.000Z'), '2026-11-04T23:59:59.999Z'); });
test('activity: active up to and including the last millisecond, standing insights never expire', () => {
  const m = { validUntil: '2026-11-06T23:59:59.999Z' };
  assert.equal(insightActiveAt(m, at('2026-11-06T23:59:59.999Z')), true); assert.equal(insightActiveAt(m, at('2026-11-07T00:00:00.000Z')), false); assert.equal(insightActiveAt({}, at('2999-01-01T00:00:00Z')), true);
});

const proj: Scope = { type: 'workspace', workspaceId: 'proj' }, profile: Scope = { type: 'global', area: 'profile' };
async function world(t: { after(fn: () => void | Promise<void>): void }) { const { root, vault } = await disposableVault(t); await vault.createWorkspace('proj', ''); return { root, vault }; }
const said = (w: Awaited<ReturnType<typeof world>>, body: string, eventTime = '2026-11-04T10:00:00.000Z') => w.vault.put({ scope: proj, kind: 'observation', title: 'm', body, metadata: { speaker: 'user', evidenceClass: 'user_authored', eventType: 'user.message', eventTime, timeZone: 'UTC' } });
const evalAt = (w: Awaited<ReturnType<typeof world>>, d: { uri: string; revisionId: string }, span: string, claim: string, key: string, now: string, category = 'preference') => evaluateInsight(w.vault, { kind: 'user_insight', scope: profile, title: claim, body: claim, status: 'candidate', evidence: [{ uri: d.uri, revisionId: d.revisionId, span }], metadata: { category, preferenceKey: key, scopeLabel: 'proj', sensitivity: 'none', explicitStatement: true } }, { now: at(now) });

test('P4 reproduced and fixed: "Until Friday please answer tersely" is kept as a time-limited candidate with an exact expiry, not rejected and not indefinite', async t => {
  const w = await world(t); const d = await said(w, 'Until Friday please answer tersely.');
  const r = await evalAt(w, d, 'please answer tersely', 'The user wants terse answers.', 'answer-style', '2026-11-04T10:05:00.000Z');
  assert.notEqual(r.verdict, 'reject'); assert.equal(r.patch.validUntil, '2026-11-06T23:59:59.999Z'); assert.equal(r.patch.temporalKind, 'time_limited'); assert.equal(r.patch.timeZone, 'UTC'); assert.ok(r.flags.includes('time_limited')); assert.equal(r.verdict, 'review_required');
  assert.equal(r.supersede.length, 0);
});
test('expiry boundary at evaluation time: an instruction processed after its window is dropped, on the last millisecond it is still kept', async t => {
  const w = await world(t); const d = await said(w, 'Until Friday please answer tersely.');
  assert.notEqual((await evalAt(w, d, 'please answer tersely', 'The user wants terse answers.', 'k1', '2026-11-06T23:59:59.999Z')).verdict, 'reject');
  const late = await evalAt(w, d, 'please answer tersely', 'The user wants terse answers.', 'k2', '2026-11-07T00:00:00.000Z'); assert.equal(late.verdict, 'reject'); assert.ok(late.flags.includes('expired_instruction'));
});
test('a window that cannot be computed is rejected rather than promoted to a standing preference; single-use wording is rejected', async t => {
  const w = await world(t);
  const vague = await said(w, 'For the rest of this session please answer tersely.'); const r = await evalAt(w, vague, 'please answer tersely', 'The user wants terse answers.', 'k3', '2026-11-04T10:05:00.000Z'); assert.equal(r.verdict, 'reject'); assert.ok(r.flags.includes('temporary_evidence'), JSON.stringify(r.flags));
  const once = await said(w, 'This once, skip the explanations.'); const o = await evalAt(w, once, 'skip the explanations', 'The user wants no explanations.', 'k4', '2026-11-04T10:05:00.000Z'); assert.equal(o.verdict, 'reject');
});
test('legitimate long-term preferences carry no expiry and are unaffected', async t => {
  const w = await world(t);
  const d = await said(w, 'I always prefer concise answers in code reviews.'); const r = await evalAt(w, d, 'I always prefer concise answers in code reviews', 'The user prefers concise answers in code reviews.', 'review-style', '2026-11-04T10:05:00.000Z');
  assert.notEqual(r.verdict, 'reject'); assert.equal(r.patch.validUntil, undefined); assert.ok(!r.flags.includes('time_limited'));
  const goal = await said(w, 'My goal this week is to ship the beta.'); const g = await evalAt(w, goal, 'My goal this week is to ship the beta', 'The user wants to ship the beta.', 'ship-beta', '2026-11-04T10:05:00.000Z', 'goal'); assert.equal(g.patch.validUntil, undefined);
});
const accepted = (w: Awaited<ReturnType<typeof world>>, key: string, body: string, extra: Record<string, unknown> = {}) => w.vault.put({ scope: profile, kind: 'user_insight', title: body, body, status: 'accepted', metadata: { insightSchema: 1, category: 'preference', preferenceKey: key, evidenceClass: 'explicit', userStatementVerified: true, origin: 'user_statement', confidenceLabel: 'high', scopeLabel: 'proj', sensitivity: 'none', validFrom: '2026-11-04', ...extra } });
test('contradiction: a time-limited instruction coexists with the standing preference and never supersedes it; a later standing statement supersedes the time-limited one', async t => {
  const w = await world(t); const standing = await accepted(w, 'answer-style', 'The user prefers detailed answers.');
  const d = await said(w, 'Until Friday please answer tersely.'); const r = await evalAt(w, d, 'please answer tersely', 'The user wants terse answers.', 'answer-style', '2026-11-04T10:05:00.000Z');
  assert.equal(r.supersede.includes(standing.id), false, 'the standing preference is not replaced by a temporary one');
  const limited = await accepted(w, 'answer-style', 'The user wants terse answers.', { validUntil: '2026-11-06T23:59:59.999Z', temporalKind: 'time_limited' });
  const back = await said(w, 'Never mind, from now on please give detailed answers again.', '2026-11-05T09:00:00.000Z');
  const c = await evalAt(w, back, 'please give detailed answers again', 'The user wants detailed answers.', 'answer-style', '2026-11-05T09:01:00.000Z');
  assert.ok(c.supersede.includes(limited.id), 'a correction supersedes the time-limited instruction'); assert.ok(c.supersede.includes(standing.id));
});
test('cross-session retrieval: active inside the window with precedence over the standing preference, gone after it, standing preference resumes; expired items are hidden unless requested', async t => {
  const w = await world(t); const client = new Engram(w.root);
  await accepted(w, 'answer-style', 'The user prefers detailed answers.');
  await accepted(w, 'answer-style', 'The user wants terse answers.', { validUntil: '2026-11-06T23:59:59.999Z', temporalKind: 'time_limited' });
  const during = (await client.memory.insights({ status: 'accepted', scopeLabel: 'proj', asOf: '2026-11-05T12:00:00.000Z' })).insights;
  assert.deepEqual(during.map(i => [i.claim, i.effective]).sort(), [['The user prefers detailed answers.', false], ['The user wants terse answers.', true]].sort());
  const edge = (await client.memory.insights({ status: 'accepted', scopeLabel: 'proj', asOf: '2026-11-06T23:59:59.999Z' })).insights; assert.equal(edge.length, 2);
  const after = (await client.memory.insights({ status: 'accepted', scopeLabel: 'proj', asOf: '2026-11-07T00:00:00.000Z' })).insights;
  assert.deepEqual(after.map(i => [i.claim, i.effective]), [['The user prefers detailed answers.', true]]);
  const all = (await client.memory.insights({ status: 'accepted', scopeLabel: 'proj', asOf: '2026-11-07T00:00:00.000Z', includeExpired: true })).insights; assert.equal(all.length, 2);
  await assert.rejects(client.memory.insights({ asOf: 'not a date' }), { code: 'INVALID_INPUT' });
});
test('projection: an expired time-limited instruction is not listed as a profile fact; an active one says until when', async t => {
  const w = await world(t);
  await accepted(w, 'answer-style', 'The user wants terse answers.', { validUntil: '2026-11-06T23:59:59.999Z', temporalKind: 'time_limited' }); await accepted(w, 'indent', 'The user prefers spaces for indentation.');
  await projectProfile(w.vault, { now: at('2026-11-05T12:00:00.000Z') }); const fs = await import('node:fs/promises'); const during = await fs.readFile(`${w.root}/PROFILE.md`, 'utf8');
  assert.match(during, /terse answers/); assert.match(during, /only until 2026-11-06T23:59:59\.999Z/);
  await projectProfile(w.vault, { now: at('2026-11-07T08:00:00.000Z') }); const after = await fs.readFile(`${w.root}/PROFILE.md`, 'utf8');
  assert.doesNotMatch(after, /terse answers/); assert.match(after, /spaces for indentation/);
});
