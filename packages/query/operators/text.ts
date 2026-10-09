import { queryError, type QueryOp } from '../ast.js';
import { assertSafeRegex } from '../schema.js';
import type { Row } from '../rows.js';
import type { Run } from '../runtime.js';

/** Line stream operators. Lines are 1-based, normalized to LF for processing (CRLF -> LF), with the original byte range kept. */
export const MAX_LINE_CHARS = 1_000_000;
/** JavaScript regex has no linear-time guarantee, so regex operators look at the first REGEX_WINDOW characters of a line only (documented limit); this bounds worst-case backtracking. */
export const REGEX_WINDOW = 8192;
const windowed = (t: string): string => t.length > REGEX_WINDOW ? t.slice(0, REGEX_WINDOW) : t;
export interface DocLike { id: string; revision: string; body: string }

export async function* readLines(docs: AsyncIterable<Row>, hydrate: (row: Row) => Promise<DocLike | undefined>, run: Run, from = 1, to = Infinity): AsyncGenerator<Row> {
  for await (const row of docs) {
    const doc = await hydrate(row); if (!doc) continue;
    const text = doc.body; let pos = 0, byte = 0, n = 0;
    while (pos < text.length) {
      run.check();
      let end = text.indexOf('\n', pos); const hasNl = end >= 0; if (!hasNl) end = text.length;
      const raw = text.slice(pos, end); n++;
      const lineBytes = Buffer.byteLength(raw) + (hasNl ? 1 : 0);
      if (n >= from && n <= to) {
        const clean = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        yield { documentId: doc.id, revision: doc.revision, lineNumber: n, text: clean.length > MAX_LINE_CHARS ? clean.slice(0, MAX_LINE_CHARS) : clean, byteStart: byte, byteEnd: byte + lineBytes, ...(clean.length > MAX_LINE_CHARS ? { truncated: true } : {}) };
      }
      byte += lineBytes; pos = hasNl ? end + 1 : end;
      if (n >= to) break;
    }
  }
}

const textOf = (row: Row): string => { const t = row.text; if (typeof t !== 'string') throw queryError('QUERY_INVALID', 'Text operators need a line stream (use readLines/cat first)'); return t; };
const with_ = (row: Row, text: string): Row => ({ ...row, text });

export async function* head(input: AsyncIterable<Row>, n: number): AsyncGenerator<Row> { if (n <= 0) return; let i = 0; for await (const row of input) { yield row; if (++i >= n) return; } }
/** tail(n) keeps a ring of n rows in original order; tail(0) is empty. */
export async function* tail(input: AsyncIterable<Row>, n: number, run: Run): AsyncGenerator<Row> {
  if (n <= 0) { for await (const _ of input) run.check(); return; }
  run.buffer(n, 'tail'); const ring: Row[] = new Array(n); let count = 0;
  for await (const row of input) { run.check(); ring[count % n] = row; count++; }
  const size = Math.min(n, count), start = count > n ? count % n : 0;
  for (let i = 0; i < size; i++) yield ring[(start + i) % n]!;
}

function ranges(rs: [number, number][], length: number): Array<[number, number]> { // merged ascending, clipped to [1,length]
  const clipped = rs.map(([a, b]) => [Math.max(1, a), Math.min(length, b)] as [number, number]).filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = []; for (const r of clipped) { const last = merged.at(-1); if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
  return merged;
}
export function cutText(text: string, op: Extract<QueryOp, { op: 'cut' }>): string {
  if (op.chars) { const cps = Array.from(text); return ranges(op.chars, cps.length).map(([a, b]) => cps.slice(a - 1, b).join('')).join(''); } // Unicode code points, not grapheme clusters
  if (op.bytes) { const buf = Buffer.from(text, 'utf8'); return ranges(op.bytes, buf.length).map(([a, b]) => buf.subarray(a - 1, b).toString('utf8')).join(''); } // may split a character: invalid bytes become U+FFFD
  const delim = op.delimiter ?? '\t'; if (!text.includes(delim)) return text;
  const parts = text.split(delim); return [...new Set(op.fields)].sort((a, b) => a - b).filter(i => i <= parts.length).map(i => parts[i - 1]!).join(delim);
}

export function stage(op: QueryOp): ((input: AsyncIterable<Row>, run: Run) => AsyncIterable<Row>) | undefined {
  switch (op.op) {
    case 'cut': return async function* (input, run) { for await (const row of input) { run.check(); yield with_(row, cutText(textOf(row), op)); } };
    case 'trim': return async function* (input, run) { for await (const row of input) { run.check(); const t = textOf(row); yield with_(row, op.side === 'left' ? t.trimStart() : op.side === 'right' ? t.trimEnd() : t.trim()); } };
    case 'grep': case 'regex': {
      const re = op.op === 'regex' || op.regex ? assertSafeRegex(op.pattern, op.ignoreCase ? 'i' : '') : undefined;
      const lit = op.ignoreCase ? op.pattern.toLocaleLowerCase() : op.pattern;
      return async function* (input, run) { for await (const row of input) { run.check(); const t = textOf(row); const hit = re ? re.test(windowed(t)) : (op.ignoreCase ? t.toLocaleLowerCase() : t).includes(lit); if (hit !== !!op.invert) yield row; } };
    }
    case 'replace': {
      const all = op.all ?? true; const flags = `${all ? 'g' : ''}${op.ignoreCase ? 'i' : ''}`; const re = new RegExp(op.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      return async function* (input, run) { for await (const row of input) { run.check(); yield with_(row, textOf(row).replace(re, () => op.with)); } };
    }
    case 'split': return async function* (input, run) {
      for await (const row of input) {
        run.check(); const parts = textOf(row).split(op.delimiter); const { text: _t, byteStart: _a, byteEnd: _b, truncated: _c, ...base } = row;
        const out: Row = { ...base }; parts.forEach((p, i) => { out[op.names?.[i] ?? `f${i + 1}`] = p; }); yield out;
      }
    };
    case 'sed': return sedStage(op.script);
    default: return undefined;
  }
}

// ---- sed subset ---------------------------------------------------------------------------------------------------------------
// Supported: optional leading "-n;"  then commands separated by ";" or newline:  [address]s/re/repl/[gi]   [address]d   [address]p (with -n)
// Address: N | $ | N,M | /re/. Regex is JavaScript (ERE-like) syntax with the same safety limits as grep. Everything else is rejected.
interface SedCmd { from?: number; to?: number; last?: boolean; match?: RegExp; kind: 's' | 'd' | 'p'; re?: RegExp; repl?: string }
function parseSed(script: string): { quiet: boolean; cmds: SedCmd[] } {
  let rest = script.trim(); let quiet = false;
  if (/^-n\s*(;|\n|$)/.test(rest)) { quiet = true; rest = rest.replace(/^-n\s*[;\n]?/, ''); }
  const cmds: SedCmd[] = []; let i = 0;
  const fail = (m: string): never => { throw queryError('QUERY_INVALID', `Unsupported sed expression: ${m}`); };
  const readDelimited = (delim: string): string => { let out = ''; while (i < rest.length && rest[i] !== delim) { if (rest[i] === '\\' && i + 1 < rest.length) { out += rest[i] === '\\' && rest[i + 1] === delim ? delim : rest[i]! + rest[i + 1]; i += 2; } else out += rest[i++]; } if (rest[i] !== delim) fail('unterminated expression'); i++; return out; };
  while (i < rest.length) {
    while (i < rest.length && /[\s;]/.test(rest[i]!)) i++; if (i >= rest.length) break;
    const cmd: Partial<SedCmd> = {};
    if (/\d/.test(rest[i]!)) { let j = i; while (/\d/.test(rest[j] ?? '')) j++; cmd.from = Number(rest.slice(i, j)); i = j; if (rest[i] === ',') { i++; j = i; while (/\d/.test(rest[j] ?? '')) j++; if (j === i) fail('bad address range'); cmd.to = Number(rest.slice(i, j)); i = j; } else cmd.to = cmd.from; if (cmd.from! < 1 || cmd.to! < cmd.from!) fail('bad address'); }
    else if (rest[i] === '$') { cmd.last = true; i++; }
    else if (rest[i] === '/') { i++; cmd.match = assertSafeRegex(readDelimited('/'), ''); }
    const c = rest[i++];
    if (c === 'd' || c === 'p') { if (c === 'p' && !quiet) fail('"p" needs a leading -n; (otherwise lines would print twice)'); cmd.kind = c; }
    else if (c === 's') {
      const delim: string = rest[i++] ?? ''; if (!delim || /[\s\;a-zA-Z0-9]/.test(delim)) fail('bad s delimiter');
      const pattern = readDelimited(delim), repl = readDelimited(delim); let flags = ''; while (/[gi]/.test(rest[i] ?? '')) flags += rest[i++]!;
      cmd.kind = 's'; cmd.re = assertSafeRegex(pattern, flags.includes('i') ? (flags.includes('g') ? 'gi' : 'i') : (flags.includes('g') ? 'g' : '')); cmd.repl = repl;
    } else fail(`command "${c ?? ''}"`);
    if (i < rest.length && !/[\s;]/.test(rest[i]!)) fail(`unexpected "${rest[i]}"`);
    cmds.push(cmd as SedCmd);
  }
  if (!cmds.length) fail('empty script'); if (cmds.length > 16) fail('too many commands');
  return { quiet, cmds };
}
function expand(repl: string, m: RegExpMatchArray): string { return repl.replace(/\\([0-9])|\\(.)|&/g, (all, d, ch) => d !== undefined ? (m[Number(d)] ?? '') : ch !== undefined ? ch : m[0]!); }
function sedStage(script: string): (input: AsyncIterable<Row>, run: Run) => AsyncIterable<Row> {
  const { quiet, cmds } = parseSed(script);
  return async function* (input, run) {
    // "$" needs one line of lookahead.
    let prev: Row | undefined;
    const apply = function* (row: Row, isLast: boolean): Generator<Row> {
      let text = textOf(row); let deleted = false, printed = false; const n = row.lineNumber as number;
      for (const c of cmds) {
        const inRange = c.from !== undefined ? n >= c.from && n <= c.to! : c.last ? isLast : c.match ? c.match.test(windowed(text)) : true;
        if (!inRange) continue;
        if (c.kind === 'd') { deleted = true; break; }
        if (c.kind === 'p') printed = true;
        else if (c.kind === 's') { const head = windowed(text), tail = text.slice(head.length); text = head.replace(c.re!, (...a) => expand(c.repl!, a.slice(0, -2).map(String) as unknown as RegExpMatchArray)) + tail; }
      }
      if (deleted) return; if (!quiet || printed) yield with_(row, text);
    };
    for await (const row of input) { run.check(); if (prev) yield* apply(prev, false); prev = row; }
    if (prev) yield* apply(prev, true);
  };
}
