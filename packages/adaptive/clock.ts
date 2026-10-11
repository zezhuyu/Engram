/** Time-zone aware local calendar helpers. Local time is always computed with Intl for an explicit IANA zone, never from the process's system zone. */
export interface LocalParts { date: string; minutes: number; hour: number; weekday: number }
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();
export function isValidTimeZone(timeZone: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; } }
export function systemTimeZone(): string { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zone && isValidTimeZone(zone) ? zone : 'UTC'; }
export function localParts(instant: Date, timeZone: string): LocalParts {
  let f = formatters.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }); formatters.set(timeZone, f); }
  const p = Object.fromEntries(f.formatToParts(instant).map(x => [x.type, x.value])) as Record<string, string>;
  const hour = Number(p.hour) % 24; return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute), hour, weekday: WEEKDAY[p.weekday ?? 'Sun'] ?? 0 };
}
export function parseHHMM(value: string): number { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value); if (!m) throw new Error(`Invalid HH:MM time: ${value}`); return Number(m[1]) * 60 + Number(m[2]); }
export const formatHHMM = (minutes: number): string => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** True when `minutes` lies in [start, end), supporting windows that wrap midnight. */
export const inWindow = (minutes: number, start: number, end: number): boolean => start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
/** Local calendar date n days before `date` (calendar arithmetic on the date string, independent of DST). */
export function addDays(date: string, days: number): string { const [y, m, d] = date.split('-').map(Number) as [number, number, number]; const t = new Date(Date.UTC(y, m - 1, d + days)); return t.toISOString().slice(0, 10); }
