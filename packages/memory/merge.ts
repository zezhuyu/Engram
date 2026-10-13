/**
 * Three-way merge used by the SERVER when a client that was offline writes back a record that somebody else changed in the meantime. It works like `git merge`:
 * `base` is the version the offline writer started from, `ours` is its write, `theirs` is what the server has now. Changes that do not overlap are combined; the same change
 * made on both sides is taken once; overlapping different changes are a conflict and are never resolved by guessing. Pure functions, no I/O.
 */
export interface Merge3Result { text: string; conflicts: number }
export const MAX_MERGE_LINES = 4000;
type Hunk = { bs: number; be: number; os: number; oe: number }; // base lines [bs,be) were replaced by other lines [os,oe)

/** Longest common subsequence of two line arrays, as matched index pairs. Common prefix and suffix are peeled off first so ordinary small edits stay cheap. */
function matches(x: string[], y: string[]): Array<[number, number]> {
  let start = 0; while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length, endY = y.length; while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const out: Array<[number, number]> = []; for (let i = 0; i < start; i++) out.push([i, i]);
  const n = endX - start, m = endY - start;
  if (n && m) {
    const width = m + 1, table = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * width + j] = x[start + i] === y[start + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) { if (x[start + i] === y[start + j]) { out.push([start + i, start + j]); i++; j++; } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++; else j++; }
  }
  for (let k = 0; k < x.length - endX; k++) out.push([endX + k, endY + k]);
  return out;
}
function hunks(base: string[], other: string[]): Hunk[] {
  const result: Hunk[] = []; let b = 0, o = 0;
  for (const [i, j] of [...matches(base, other), [base.length, other.length] as [number, number]]) { if (i > b || j > o) result.push({ bs: b, be: i, os: o, oe: j }); b = i + 1; o = j + 1; }
  return result;
}
const same = (x: string[], y: string[]): boolean => x.length === y.length && x.every((line, i) => line === y[i]);

export interface MergeLabels { ours: string; theirs: string; base?: string }
/** Merge three texts line by line. Conflict regions carry git's diff3 markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`). */
export function merge3(baseText: string, oursText: string, theirsText: string, labels: MergeLabels = { ours: 'local', theirs: 'server' }): Merge3Result {
  if (oursText === theirsText) return { text: oursText, conflicts: 0 };
  if (oursText === baseText) return { text: theirsText, conflicts: 0 };
  if (theirsText === baseText) return { text: oursText, conflicts: 0 };
  const base = baseText.split('\n'), ours = oursText.split('\n'), theirs = theirsText.split('\n');
  if (Math.max(base.length, ours.length, theirs.length) > MAX_MERGE_LINES) return { text: conflictBlock(base, ours, theirs, labels), conflicts: 1 }; // too large to merge safely: keep all three sides
  const hA = hunks(base, ours), hB = hunks(base, theirs); const out: string[] = []; let conflicts = 0, pos = 0, i = 0, j = 0;
  while (i < hA.length || j < hB.length) {
    const first = i < hA.length && (j >= hB.length || hA[i]!.bs <= hB[j]!.bs) ? 'A' : 'B';
    const start = first === 'A' ? hA[i]!.bs : hB[j]!.bs; let end = first === 'A' ? hA[i]!.be : hB[j]!.be; const takenA: Hunk[] = [], takenB: Hunk[] = [];
    if (first === 'A') takenA.push(hA[i++]!); else takenB.push(hB[j++]!);
    for (let grew = true; grew;) { // adjacent or overlapping changes from either side belong to one region, as in git
      grew = false;
      while (i < hA.length && hA[i]!.bs <= end) { takenA.push(hA[i]!); end = Math.max(end, hA[i]!.be); i++; grew = true; }
      while (j < hB.length && hB[j]!.bs <= end) { takenB.push(hB[j]!); end = Math.max(end, hB[j]!.be); j++; grew = true; }
    }
    for (let k = pos; k < start; k++) out.push(base[k]!);
    const side = (taken: Hunk[], text: string[]): string[] => taken.length ? text.slice(taken[0]!.os - (taken[0]!.bs - start), taken.at(-1)!.oe + (end - taken.at(-1)!.be)) : base.slice(start, end);
    const a = side(takenA, ours), b = side(takenB, theirs);
    if (!takenA.length) out.push(...b); else if (!takenB.length) out.push(...a); else if (same(a, b)) out.push(...a);
    else { conflicts++; out.push(...conflictLines(base.slice(start, end), a, b, labels)); }
    pos = end;
  }
  for (let k = pos; k < base.length; k++) out.push(base[k]!);
  return { text: out.join('\n'), conflicts };
}
const conflictLines = (base: string[], ours: string[], theirs: string[], labels: MergeLabels): string[] => [`<<<<<<< ${labels.ours}`, ...ours, `||||||| ${labels.base ?? 'base'}`, ...base, '=======', ...theirs, `>>>>>>> ${labels.theirs}`];
const conflictBlock = (base: string[], ours: string[], theirs: string[], labels: MergeLabels): string => conflictLines(base, ours, theirs, labels).join('\n');

export type ScalarMerge<T> = { value: T; conflict: false } | { value: T; conflict: true; ours: T; theirs: T };
/** A field that is a single value (title, status, assignee): if only one side changed it, that side wins; the same change on both sides is taken once; different changes conflict. */
export function mergeScalar<T>(base: T | undefined, ours: T, theirs: T): ScalarMerge<T> {
  if (ours === theirs) return { value: ours, conflict: false };
  if (ours === base) return { value: theirs, conflict: false };
  if (theirs === base) return { value: ours, conflict: false };
  return { value: theirs, conflict: true, ours, theirs };
}
/** Tags are a set: a tag added or removed on one side is kept; both sides' additions are kept; a tag removed on one side and untouched on the other is removed. */
export function mergeTags(base: string[], ours: string[], theirs: string[]): string[] {
  const b = new Set(base), o = new Set(ours), t = new Set(theirs); const out = new Set<string>();
  for (const tag of new Set([...b, ...o, ...t])) { const inBase = b.has(tag), inOurs = o.has(tag), inTheirs = t.has(tag); if (inBase ? inOurs && inTheirs : inOurs || inTheirs) out.add(tag); }
  return [...out];
}
