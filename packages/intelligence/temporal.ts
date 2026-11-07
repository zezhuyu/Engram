import { addDays, localParts } from '../adaptive/clock.js';

/**
 * Time-limited user instructions ("until Friday answer tersely", "for the next two hours", "this week"): parsed deterministically from the user's own words relative to the
 * time the message was written and the user's IANA time zone, so the instruction can be kept for exactly its window instead of being rejected or promoted to a standing
 * preference. All day boundaries are LOCAL calendar boundaries (DST and offset aware); the stored instant is the last millisecond of the window.
 */
export interface TimeLimit { until: string; phrase: string; scope: 'day' | 'week' | 'month' | 'year' | 'weekday' | 'date' | 'duration'; timeZone: string }
const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DURATION_UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, an: 1, a: 1, couple: 2 };

/** UTC instant at which the given local calendar date (YYYY-MM-DD) begins in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]; const want = Date.UTC(y, m - 1, d, 0, 0);
  let guess = want;
  for (let i = 0; i < 4; i++) {
    const lp = localParts(new Date(guess), timeZone); const [ly, lm, ld] = lp.date.split('-').map(Number) as [number, number, number];
    const delta = Date.UTC(ly, lm - 1, ld, 0, lp.minutes) - want; if (delta === 0) break; guess -= delta;
  }
  // Around a DST change at midnight the search can oscillate (the local midnight may not exist): settle on the FIRST instant whose local date is `date`.
  for (let i = 0; i < 720 && localParts(new Date(guess), timeZone).date < date; i++) guess += 60_000;
  for (let i = 0; i < 720 && localParts(new Date(guess - 60_000), timeZone).date >= date; i++) guess -= 60_000;
  return new Date(guess);
}
/** Last millisecond of a local calendar day. */
export const endOfLocalDay = (date: string, timeZone: string): Date => new Date(startOfLocalDay(addDays(date, 1), timeZone).getTime() - 1);
const lastDayOfMonth = (date: string): string => { const [y, m] = date.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const clamp = (n: number) => Math.min(Math.max(n, 1), 3650);

export function parseTimeLimit(text: string, reference: Date, timeZone: string): TimeLimit | undefined {
  const t = text.toLowerCase().replace(/[‘’]/g, "'"); const today = localParts(reference, timeZone); const done = (until: Date, phrase: string, scope: TimeLimit['scope']): TimeLimit => ({ until: until.toISOString(), phrase: phrase.trim(), scope, timeZone });
  let m: RegExpExecArray | null;
  if ((m = /\bfor\s+(?:the\s+)?next\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|(?:an?\s+)?couple(?:\s+of)?|an?)\s+)?(minute|hour|day|week)s?\b/.exec(t)) || (m = /\bfor\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|(?:an?\s+)?couple\s+of|an?)\s+(minute|hour|day|week)s?\b/.exec(t))) {
    const raw = (m[1] ?? '1').replace(/^an?\s+/, '').replace(/\s+of$/, ''); const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 1; return done(new Date(reference.getTime() + clamp(n) * DURATION_UNIT_MS[m[2]!]!), m[0], 'duration');
  }
  if ((m = /\b(?:until|till|through|by)\s+(?:the\s+)?end\s+of\s+(?:the\s+)?(day|today|week|month|year)\b/.exec(t))) {
    const unit = m[1]!; if (unit === 'day' || unit === 'today') return done(endOfLocalDay(today.date, timeZone), m[0], 'day');
    if (unit === 'week') return done(endOfLocalDay(addDays(today.date, (7 - today.weekday) % 7), timeZone), m[0], 'week');
    if (unit === 'month') return done(endOfLocalDay(lastDayOfMonth(today.date), timeZone), m[0], 'month');
    return done(endOfLocalDay(`${today.date.slice(0, 4)}-12-31`, timeZone), m[0], 'year');
  }
  if ((m = /\b(?:until|till|through|by)\s+(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t))) {
    const target = WEEKDAYS[m[1]!]!; let ahead = (target - today.weekday + 7) % 7; if (/\bnext\s/.test(m[0]) && ahead === 0) ahead = 7; return done(endOfLocalDay(addDays(today.date, ahead), timeZone), m[0], 'weekday');
  }
  if ((m = /\b(?:until|till|through|by)\s+tomorrow\b/.exec(t))) return done(endOfLocalDay(addDays(today.date, 1), timeZone), m[0], 'day');
  if ((m = /\b(?:until|till|through)\s+(\d{4})-(\d{2})-(\d{2})\b/.exec(t))) return done(endOfLocalDay(`${m[1]}-${m[2]}-${m[3]}`, timeZone), m[0], 'date');
  if ((m = new RegExp(`\\b(?:until|till|through|by)\\s+(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(t))) {
    const month = MONTHS.indexOf(m[1]!) + 1; const day = Number(m[2]); let year = m[3] ? Number(m[3]) : Number(today.date.slice(0, 4));
    const iso = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (day < 1 || day > 31 || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return undefined;
    if (!m[3] && iso(year) < today.date) year += 1; return done(endOfLocalDay(iso(year), timeZone), m[0], 'date');
  }
  if ((m = /\b(?:this\s+weekend)\b/.exec(t))) return done(endOfLocalDay(addDays(today.date, (7 - today.weekday) % 7), timeZone), m[0], 'week');
  if ((m = /\b(?:this\s+week|for\s+the\s+week)\b/.exec(t))) return done(endOfLocalDay(addDays(today.date, (7 - today.weekday) % 7), timeZone), m[0], 'week');
  if ((m = /\b(?:just\s+for\s+today|for\s+today|today\s+only|just\s+today|tonight|this\s+(?:morning|afternoon|evening))\b/.exec(t))) return done(endOfLocalDay(today.date, timeZone), m[0], 'day');
  return undefined;
}
/** A time-limited insight is active up to and including its last millisecond; insights without a window are standing. */
export const insightActiveAt = (metadata: Record<string, unknown>, at: Date = new Date()): boolean => typeof metadata.validUntil !== 'string' || !(Date.parse(metadata.validUntil) < at.getTime());
