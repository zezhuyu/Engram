import { StringDecoder } from 'node:string_decoder';
import { MDBError } from '../../core/types.js';
import { all, count, has, last, parseOptions, UsageError } from '../args.js';
import { common, fail, openBytes, openInput, operandsOrStdin, spec, writerFor, type Ctx } from '../ctx.js';
import { Quiet, ResourceError, decodeRecords, records, type Rec } from '../io.js';
import { cutText } from '../../query/operators/text.js';

const cmpBytes = (a: string, b: string): number => { // UTF-8 byte order == code point order (LC_ALL=C semantics)
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a.charCodeAt(i), y = b.charCodeAt(i); if (x !== y) { const xs = x >= 0xd800 && x <= 0xdfff, ys = y >= 0xd800 && y <= 0xdfff; return xs !== ys ? (xs ? 1 : -1) : x - y; } }
  return a.length - b.length;
};
export { cmpBytes };

// ---- cut ----------------------------------------------------------------------------------------------------------------------
function parseList(list: string): [number, number][] {
  return list.split(',').map(part => {
    const m = /^(\d*)-(\d*)$/.exec(part) ?? /^(\d+)$/.exec(part); if (!m || part === '-' || part === '') throw new UsageError(`invalid byte, character or field list`);
    if (m.length === 2) { const n = Number(m[1]); if (n < 1) throw new UsageError('fields are numbered from 1'); return [n, n] as [number, number]; }
    const a = m[1] ? Number(m[1]) : 1, b = m[2] ? Number(m[2]) : Infinity; if (a < 1 || b < a) throw new UsageError('invalid decreasing range'); return [a, b] as [number, number];
  });
}
export async function cut(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ b: true, c: true, f: true, d: true, s: false, n: false }, { bytes: 'b', characters: 'c', fields: 'f', delimiter: 'd', 'only-delimited': 's', complement: false, 'output-delimiter': true }));
  const c = common(p); const modes = ['b', 'c', 'f'].filter(k => has(p, k)); if (modes.length !== 1) throw new UsageError('you must specify a list of bytes, characters, or fields (exactly one of -b, -c, -f)');
  const mode = modes[0]!; const ranges = parseList(last(p, mode)!); const complement = has(p, 'complement');
  const delim = has(p, 'd') ? last(p, 'd')! : '\t'; if ([...delim].length !== 1) throw new UsageError('the delimiter must be a single character');
  const outDelim = has(p, 'output-delimiter') ? last(p, 'output-delimiter')! : delim;
  const pick = (index: number) => { const hit = ranges.some(([a, b]) => index >= a && index <= b); return complement ? !hit : hit; };
  const select = (text: string): string | undefined => {
    if (mode === 'f') {
      if (!text.includes(delim)) return has(p, 's') ? undefined : text;
      const parts = text.split(delim); return parts.filter((_, i) => pick(i + 1)).join(outDelim);
    }
    if (mode === 'b') { const buf = Buffer.from(text, 'utf8'); const keep: number[] = []; for (let i = 0; i < buf.length; i++) if (pick(i + 1)) keep.push(buf[i]!); return Buffer.from(keep).toString('utf8'); }
    if (!complement) return cutText(text, { op: 'cut', chars: ranges.map(([a, b]) => [a, b === Infinity ? 1e9 : b] as [number, number]) });
    return Array.from(text).filter((_, i) => pick(i + 1)).join('');
  };
  let status = 0;
  for (const operand of operandsOrStdin(p)) {
    try { const input = await openInput(ctx, operand, c); const w = writerFor(ctx, c, input.format); for await (const r of input.recs) { const out = select(r.text); if (out !== undefined) await w.rec({ ...r, text: out }, true); } await w.end(); }
    catch (e) { if (e instanceof Quiet) throw e; fail(ctx, `${operand}: ${(e as Error).message}`); status = 1; }
  }
  void count; return status;
}

// ---- tr -----------------------------------------------------------------------------------------------------------------------
const TR_CLASSES: Record<string, (c: string) => boolean> = { alpha: c => /[A-Za-z]/.test(c), digit: c => /[0-9]/.test(c), alnum: c => /[A-Za-z0-9]/.test(c), upper: c => /[A-Z]/.test(c), lower: c => /[a-z]/.test(c), space: c => /[ \t\n\r\f\v]/.test(c), blank: c => c === ' ' || c === '\t', punct: c => /[!-/:-@[-`{-~]/.test(c), xdigit: c => /[0-9A-Fa-f]/.test(c), cntrl: c => c < ' ' || c === '\x7f', print: c => c >= ' ' && c <= '~', graph: c => c > ' ' && c <= '~' };
function expandSet(spec_: string): string[] {
  const out: string[] = []; const chars: string[] = [];
  for (let i = 0; i < spec_.length; i++) {
    let ch = spec_[i]!;
    if (ch === '[' && spec_[i + 1] === ':') { const end = spec_.indexOf(':]', i + 2); const name = spec_.slice(i + 2, end); const f = TR_CLASSES[name]; if (end < 0 || !f) throw new UsageError(`invalid character class '${name}'`); for (let code = 0; code < 128; code++) if (f(String.fromCharCode(code))) { if (name === 'upper' || name === 'lower' || true) out.push(String.fromCharCode(code)); } i = end + 1; chars.push('\u0000class'); continue; }
    if (ch === '\\') { const n = spec_[++i]; if (n === undefined) throw new UsageError('trailing backslash'); const oct = /^[0-7]{1,3}/.exec(spec_.slice(i)); if (oct) { ch = String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length - 1; } else ch = ({ n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', '\\': '\\' } as Record<string, string>)[n] ?? n; out.push(ch); chars.push(ch); continue; }
    if (spec_[i + 1] === '-' && i + 2 < spec_.length) { const to = spec_[i + 2]!; if (to.charCodeAt(0) < ch.charCodeAt(0)) throw new UsageError(`range-endpoints of '${ch}-${to}' are in reverse collating sequence order`); for (let code = ch.charCodeAt(0); code <= to.charCodeAt(0); code++) out.push(String.fromCharCode(code)); i += 2; chars.push('\u0000range'); continue; }
    out.push(ch); chars.push(ch);
  }
  return out;
}
export async function tr(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ c: false, C: false, d: false, s: false, t: false }, { complement: 'c', delete: 'd', 'squeeze-repeats': 's', 'truncate-set1': 't' }));
  const del = has(p, 'd'), squeeze = has(p, 's'), complement = has(p, 'c') || has(p, 'C');
  const [s1, s2, extra] = p.operands; if (s1 === undefined || extra !== undefined) throw new UsageError(s1 === undefined ? 'missing operand' : `extra operand '${extra}'`);
  if (!del && !squeeze && s2 === undefined) throw new UsageError(`missing operand after '${s1}'`); if (del && !squeeze && s2 !== undefined) throw new UsageError('extra operand with -d only');
  let set1 = expandSet(s1); const set2 = s2 !== undefined ? expandSet(s2) : [];
  const in1 = (ch: string) => complement ? !set1.includes(ch) : set1.includes(ch);
  const map = new Map<string, string>(); let fill = '';
  if (!del && s2 !== undefined && set2.length) {
    if (complement) { fill = set2.at(-1)!; } else { if (has(p, 't')) set1 = set1.slice(0, set2.length); for (let i = 0; i < set1.length; i++) if (!map.has(set1[i]!)) map.set(set1[i]!, set2[Math.min(i, set2.length - 1)]!); }
  }
  const squeezeSet = squeeze ? (del || s2 === undefined ? (ch: string) => in1(ch) : (ch: string) => set2.includes(ch)) : undefined;
  const translate = (ch: string): string | undefined => { if (del && in1(ch)) return undefined; if (!del && s2 !== undefined && set2.length) { if (complement) return in1(ch) ? fill : ch; return map.get(ch) ?? ch; } return ch; };
  const c = common(p);
  let prev: string | undefined;
  const apply = (text: string): string => { let out = ''; for (const ch of text) { const t = translate(ch); if (t === undefined) continue; if (squeezeSet && squeezeSet(t) && prev === t) continue; prev = t; out += t; } return out; };
  if (c.inFormat === 'ndjson' || c.inFormat === 'json') { const w = writerFor(ctx, c, c.inFormat); for await (const r of decodeRecords(ctx.stdin, c.inFormat, c.delim, ctx.limits, ctx.signal)) { prev = undefined; await w.rec({ ...r, text: apply(r.text) }, true); } await w.end(); return 0; }
  const dec = new StringDecoder('utf8'); for await (const chunk of ctx.stdin) { const s = apply(dec.write(chunk)); if (s) await ctx.out.write(s); } const rest = apply(dec.end()); if (rest) await ctx.out.write(rest); return 0;
}

// ---- paste --------------------------------------------------------------------------------------------------------------------
export async function paste(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ d: true, s: false }, { delimiters: 'd', serial: 's' }));
  const c = common(p); const operands = operandsOrStdin(p); const delims = unescapeList(has(p, 'd') ? last(p, 'd')! : '\t');
  const dchar = (i: number) => delims.length ? delims[i % delims.length]! : '';
  const eol = c.delim; const iters = new Map<string, AsyncGenerator<Rec>>(); const w = writerFor(ctx, c, 'text');
  const next = async (name: string, slot: number): Promise<IteratorResult<Rec>> => { const key = name === '-' ? '-' : `${slot}:${name}`; let it = iters.get(key); if (!it) { it = (await openInput(ctx, name, { ...c, inFormat: c.inFormat === 'auto' ? 'text' : c.inFormat })).recs; iters.set(key, it); } return it.next(); };
  if (has(p, 's')) { // one output line per input
    for (const [slot, name] of operands.entries()) { const parts: string[] = []; for (;;) { const r = await next(name, slot); if (r.done) break; parts.push(r.value.text); } let line = ''; parts.forEach((t, i) => { line += (i ? dchar(i - 1) : '') + t; }); await w.rec({ text: line, eol: true }); }
    await w.end(); return 0;
  }
  for (;;) {
    let live = false; const cells: string[] = [];
    for (const [slot, name] of operands.entries()) { const r = await next(name, slot); if (r.done) cells.push(''); else { live = true; cells.push(r.value.text); } }
    if (!live) break; let line = ''; cells.forEach((t, i) => { line += (i ? dchar(i - 1) : '') + t; }); await w.rec({ text: line, eol: true });
  }
  void eol; await w.end(); return 0;
}
const unescapeList = (s: string): string[] => { const out: string[] = []; for (let i = 0; i < s.length; i++) { if (s[i] === '\\') { const n = s[++i]; out.push(n === 'n' ? '\n' : n === 't' ? '\t' : n === '0' ? '' : n === '\\' ? '\\' : (n ?? '')); } else out.push(s[i]!); } return out; };

// ---- sort ---------------------------------------------------------------------------------------------------------------------
interface KeyDef { from: number; fromChar: number; to: number; toChar: number; n: boolean; r: boolean; f: boolean; b: boolean; d: boolean }
function parseKey(def: string, globals: Pick<KeyDef, 'n' | 'r' | 'f' | 'b' | 'd'>): KeyDef {
  const m = /^(\d+)(?:\.(\d+))?([bdfnr]*)(?:,(\d+)(?:\.(\d+))?([bdfnr]*))?$/.exec(def); if (!m) throw new UsageError(`invalid key definition '${def}'`);
  const opts = (m[3]! + (m[6] ?? '')); const has_ = (ch: string) => opts.includes(ch);
  return { from: Number(m[1]), fromChar: Number(m[2] ?? 1), to: m[4] ? Number(m[4]) : Infinity, toChar: m[5] ? Number(m[5]) : 0, n: has_('n') || (!opts && globals.n), r: has_('r') || (!opts && globals.r), f: has_('f') || (!opts && globals.f), b: has_('b') || (!opts && globals.b), d: has_('d') || (!opts && globals.d) };
}
const numeric = (s: string): number => { const m = /^\s*([+-]?)(\d*\.?\d*)/.exec(s); if (!m || !/\d/.test(m[2]!)) return 0; const v = Number(m[2]); return m[1] === '-' ? -v : v; };
export async function sort(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ r: false, n: false, f: false, u: false, s: false, b: false, d: false, c: false, C: false, k: true, t: true, o: true, m: false, h: false, g: false, V: false },
    { reverse: 'r', 'numeric-sort': 'n', 'ignore-case': 'f', unique: 'u', stable: 's', 'ignore-leading-blanks': 'b', 'dictionary-order': 'd', check: 'c', key: 'k', 'field-separator': 't', output: 'o', merge: 'm' }));
  if (has(p, 'o')) { fail(ctx, 'sort -o is not supported: results go to stdout (use tee for files)'); return 2; }
  if (has(p, 'h') || has(p, 'g') || has(p, 'V')) { fail(ctx, 'unsupported sort mode (supported: -r -n -f -u -s -b -d -c -C -k -t -z -m)'); return 2; }
  const c = common(p); const g = { n: has(p, 'n'), r: has(p, 'r'), f: has(p, 'f'), b: has(p, 'b'), d: has(p, 'd') };
  const sep = has(p, 't') ? last(p, 't')! : undefined; if (sep !== undefined && [...sep].length !== 1) throw new UsageError('multi-character tab');
  const keys = all(p, 'k').map(k => parseKey(k, g));
  const fieldsOf = (line: string): string[] => sep !== undefined ? line.split(sep) : (line.match(/\s*\S+/g) ?? []);
  const keyText = (line: string, k: KeyDef): string => {
    const f = fieldsOf(line); const startField = f[k.from - 1]; if (startField === undefined) return '';
    let start = (sep !== undefined ? 0 : 0); let text: string;
    if (k.to === Infinity) text = f.slice(k.from - 1).join(sep ?? ''); else text = f.slice(k.from - 1, k.to).join(sep ?? '');
    const lead = (sep !== undefined ? 0 : 0); start = lead + Math.max(0, k.fromChar - 1);
    const firstField = sep !== undefined ? f[k.from - 1]! : f[k.from - 1]!; const blanks = /^\s*/.exec(firstField)![0].length;
    text = text.slice(k.b || (sep === undefined) ? (k.b ? blanks : 0) + start : start);
    if (k.to !== Infinity && k.toChar > 0) { const lastF = f[k.to - 1] ?? ''; const full = f.slice(k.from - 1, k.to).join(sep ?? ''); const cut_ = full.length - lastF.length + (/^\s*/.exec(lastF)![0].length && sep === undefined && !k.b ? 0 : 0) + k.toChar; text = full.slice(Math.max(0, k.b ? blanks + start : start), cut_); }
    return text;
  };
  const prepare = (k: KeyDef | undefined, s: string): string | number => { let t = s; if (k?.b ?? g.b) t = t.replace(/^\s+/, ''); if (k?.d ?? g.d) t = t.replace(/[^A-Za-z0-9\s]/g, ''); if (k?.f ?? g.f) t = t.toUpperCase(); return (k?.n ?? g.n) ? numeric(t) : t; };
  const keyList: Array<KeyDef | undefined> = keys.length ? keys : [undefined];
  /** keys are extracted once per line (decorate-sort-undecorate), not once per comparison */
  const decorate = (text: string): Array<string | number> => keyList.map(k => prepare(k, k ? keyText(text, k) : text));
  const cmpKeys = (x: Array<string | number>, y: Array<string | number>): number => { for (let i = 0; i < keyList.length; i++) { const a = x[i]!, b = y[i]!; const r = typeof a === 'number' && typeof b === 'number' ? (a < b ? -1 : a > b ? 1 : 0) : cmpBytes(String(a), String(b)); if (r) return (keyList[i]?.r ?? g.r) ? -r : r; } return 0; };
  const compare = (a: string, b: string): number => cmpKeys(decorate(a), decorate(b));
  const total = (a: string, b: string): number => compare(a, b) || (has(p, 's') || has(p, 'u') ? 0 : (g.r ? -cmpBytes(a, b) : cmpBytes(a, b)));
  let status = 0; const operands = operandsOrStdin(p);
  if (has(p, 'c') || has(p, 'C')) { // check
    let prev: string | undefined; let n = 0;
    for (const name of operands) for await (const r of (await openInput(ctx, name, c)).recs) { n++; if (prev !== undefined) { const d = has(p, 'u') ? compare(prev, r.text) >= 0 : total(prev, r.text) > 0; if (d) { if (has(p, 'c')) fail(ctx, `${name === '-' ? '-' : name}:${n}: disorder: ${r.text}`); return 1; } } prev = r.text; }
    return 0;
  }
  const lines: Rec[] = []; let detected: 'text' | 'ndjson' | 'json' = 'text';
  for (const name of operands) { try { const input = await openInput(ctx, name, c); detected = input.format; for await (const r of input.recs) { lines.push(r); if (lines.length > ctx.limits.maxBufferLines) throw new ResourceError(`sort would hold more than ${ctx.limits.maxBufferLines} lines in memory (no external merge: narrow the input)`); } } catch (e) { if (e instanceof Quiet) throw e; fail(ctx, `${name}: ${(e as Error).message}`); status = 2; } }
  const idx = lines.map((r, i) => ({ r, i, k: decorate(r.text) })); const last_ = (a: string, b: string) => has(p, 's') || has(p, 'u') ? 0 : (g.r ? -cmpBytes(a, b) : cmpBytes(a, b));
  idx.sort((a, b) => cmpKeys(a.k, b.k) || last_(a.r.text, b.r.text) || a.i - b.i);
  const w = writerFor(ctx, c, detected); let prev: { r: Rec; k: Array<string | number> } | undefined;
  for (const x of idx) { if (has(p, 'u') && prev && cmpKeys(prev.k, x.k) === 0) continue; prev = x; await w.rec(x.r, true); }
  await w.end(); return status;
}

// ---- uniq ---------------------------------------------------------------------------------------------------------------------
export async function uniq(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ c: false, d: false, u: false, D: false, i: false, f: true, s: true, w: true }, { count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i', 'skip-fields': 'f', 'skip-chars': 's', 'check-chars': 'w' }));
  const c = common(p); const skipF = count(last(p, 'f'), 'fields to skip', 0), skipC = count(last(p, 's'), 'chars to skip', 0), width = has(p, 'w') ? count(last(p, 'w'), 'chars to compare', 0) : Infinity;
  const [inName = '-'] = p.operands; const input = await openInput(ctx, inName, c); const w = writerFor(ctx, c, input.format);
  const keyOf = (t: string) => { let s = t; if (skipF) { const m = new RegExp(`^(?:\\s*\\S+){0,${skipF}}`).exec(s); s = s.slice(m![0].length); } s = Array.from(s).slice(skipC, Number.isFinite(width) ? skipC + width : undefined).join(''); return has(p, 'i') ? s.toLowerCase() : s; };
  let cur: { rec: Rec; key: string; n: number } | undefined;
  const flush = async () => { if (!cur) return; const dup = cur.n > 1; if (has(p, 'd') && !dup) return; if (has(p, 'u') && dup) return; const text = has(p, 'c') ? `${String(cur.n).padStart(7)} ${cur.rec.text}` : cur.rec.text; await w.rec({ ...cur.rec, text, row: { ...(cur.rec.row ?? {}), count: cur.n } }, true); };
  for await (const r of input.recs) { const key = keyOf(r.text); if (cur && cur.key === key) cur.n++; else { await flush(); cur = { rec: r, key, n: 1 }; } }
  await flush(); await w.end(); return 0;
}

// ---- comm ---------------------------------------------------------------------------------------------------------------------
export async function comm(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ '1': false, '2': false, '3': false, i: false }, { 'check-order': false, 'nocheck-order': false, 'output-delimiter': true, total: false }));
  const c = common(p); if (p.operands.length !== 2) throw new UsageError(p.operands.length < 2 ? 'missing operand' : `extra operand '${p.operands[2]}'`);
  if (p.operands[0] === '-' && p.operands[1] === '-') throw new UsageError('only one input can be standard input');
  const [a, b] = (await Promise.all(p.operands.map(n => openInput(ctx, n, { ...c, inFormat: c.inFormat === 'auto' ? 'text' : c.inFormat })))) as [Awaited<ReturnType<typeof openInput>>, Awaited<ReturnType<typeof openInput>>];
  const od = has(p, 'output-delimiter') ? last(p, 'output-delimiter')! : '\t'; const hide = [has(p, '1'), has(p, '2'), has(p, '3')]; const fold = has(p, 'i');
  const key = (s: string) => fold ? s.toLowerCase() : s; const w = writerFor(ctx, c, 'text');
  const prefix = (col: number) => col === 1 ? '' : col === 2 ? (hide[0] ? '' : od) : (hide[0] ? '' : od) + (hide[1] ? '' : od);
  const line = (col: 1 | 2 | 3, text: string) => hide[col - 1] ? undefined : prefix(col) + text;
  const counts = [0, 0, 0]; let disorder = false; let prevA: string | undefined, prevB: string | undefined; const check = !has(p, 'nocheck-order');
  const ia = a.recs, ib = b.recs; let ra = await ia.next(), rb = await ib.next();
  const emit = async (col: 1 | 2 | 3, text: string) => { counts[col - 1]!++; const l = line(col, text); if (l !== undefined) await w.value({ column: col, text }, l + c.delim); };
  const advA = async () => { const t = ra.value!.text; ra = await ia.next(); if (check && !ra.done && cmpBytes(key(t), key(ra.value.text)) > 0) disorder = true; prevA = t; };
  const advB = async () => { const t = rb.value!.text; rb = await ib.next(); if (check && !rb.done && cmpBytes(key(t), key(rb.value.text)) > 0) disorder = true; prevB = t; };
  while (!ra.done || !rb.done) {
    if (disorder && has(p, 'check-order')) break;
    if (ra.done) { await emit(2, rb.value!.text); await advB(); }
    else if (rb.done) { await emit(1, ra.value.text); await advA(); }
    else { const d = cmpBytes(key(ra.value.text), key(rb.value.text)); if (d < 0) { await emit(1, ra.value.text); await advA(); } else if (d > 0) { await emit(2, rb.value.text); await advB(); } else { await emit(3, ra.value.text); await advA(); await advB(); } }
  }
  if (has(p, 'total')) await w.value({ total: counts }, `${counts.join(od)}${od}total${c.delim}`);
  await w.end();
  if (disorder && check) { fail(ctx, 'input is not in sorted order'); return 1; }
  void MDBError; void openBytes; void records; return 0;
}
