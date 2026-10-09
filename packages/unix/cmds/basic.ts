import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { MDBError } from '../../core/types.js';
import { all, count, has, last, parseOptions } from '../args.js';
import { common, fail, openBytes, openInput, operandsOrStdin, spec, vaultRef, writerFor, type Ctx } from '../ctx.js';
import { Quiet, ResourceError, realRoots, records, type Rec } from '../io.js';

const writeRec = async (w: ReturnType<typeof writerFor>, r: Rec, preserve = true) => w.rec(r, !preserve);

// ---- cat ----------------------------------------------------------------------------------------------------------------------
export async function cat(ctx0: Ctx, argv: string[]): Promise<number> {
  const ctx: Ctx = { ...ctx0, allowLocalFiles: false }; // cat reads vault objects and stdin only, never arbitrary local files
  const p = parseOptions(argv, spec({ n: false, b: false, s: false, E: false, A: false }, { number: 'n', 'number-nonblank': 'b', 'squeeze-blank': 's', 'show-ends': 'E' }));
  const c = common(p); const operands = operandsOrStdin(p); const formatting = has(p, 'n') || has(p, 'b') || has(p, 's') || has(p, 'E') || has(p, 'A');
  const structured = (c.outFormat === 'ndjson' || c.outFormat === 'json'); let status = 0; let lineNo = 0;
  const w = writerFor(ctx, c, 'text');
  for (const operand of operands) {
    try {
      if (!formatting && !structured && c.inFormat === 'auto') { for await (const chunk of await openBytes(ctx, operand)) await ctx.out.write(chunk); continue; } // byte-exact copy
      const ref = vaultRef(operand); let revision: string | undefined; let bytes: AsyncIterable<Buffer>;
      if (ref && ctx.client) { const doc = await ctx.client.vault.get(ref.id, ref.rev); revision = doc.revisionId; bytes = (async function* () { yield Buffer.from(doc.body); })(); } else bytes = await openBytes(ctx, operand);
      let n = 0, byte = 0, blankRun = 0;
      for await (const r of records(bytes, c.delim, ctx.limits, ctx.signal)) {
        n++; const lineBytes = Buffer.byteLength(r.text) + (r.eol ? 1 : 0); const startByte = byte; byte += lineBytes;
        const blank = r.text.length === 0; if (has(p, 's')) { blankRun = blank ? blankRun + 1 : 0; if (blankRun > 1) continue; }
        let text = r.text; if ((has(p, 'E') || has(p, 'A')) && r.eol) text += '$'; // GNU: no '$' after an unterminated last line
        if (has(p, 'b') ? !blank : has(p, 'n')) { lineNo++; text = `${String(lineNo).padStart(6)}\t${text}`; }
        const row = ref ? { documentId: ref.id, ...(revision ? { revision } : {}), lineNumber: n, byteStart: startByte, byteEnd: byte } : { lineNumber: n };
        await w.rec({ text: has(p, 'E') || has(p, 'A') ? text : text, eol: r.eol, row }, false);
      }
    } catch (e) { if (e instanceof Quiet) throw e; fail(ctx, `${operand}: ${(e as Error).message}`); status = 1; }
  }
  await w.end(); return status;
}

// ---- head / tail ----------------------------------------------------------------------------------------------------------------
async function* byteChunks(src: AsyncIterable<Buffer>, ctx: Ctx): AsyncGenerator<Buffer> { for await (const c of src) { if (ctx.signal?.aborted) throw new MDBError('CANCELLED', 'cancelled'); yield c; } }
const header = (first: boolean, name: string) => `${first ? '' : '\n'}==> ${name === '-' ? 'standard input' : name} <==\n`;
export async function head(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ n: true, c: true, q: false, v: false }, { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v' }, 'n'));
  const c = common(p); const operands = operandsOrStdin(p); const showNames = has(p, 'v') || (!has(p, 'q') && operands.length > 1);
  const bytesMode = has(p, 'c'); const n = bytesMode ? count(last(p, 'c'), 'number of bytes', 0) : count(last(p, 'n'), 'number of lines', 10);
  let status = 0, first = true;
  for (const operand of operands) {
    try {
      if (showNames) { await ctx.out.write(header(first, operand)); } first = false;
      if (bytesMode) { let left = n < 0 ? Infinity : n; const keep: Buffer[] = []; let held = 0; for await (const chunk of byteChunks(await openBytes(ctx, operand), ctx)) { if (n < 0) { keep.push(chunk); held += chunk.length; while (held - keep[0]!.length >= -n) { held -= keep.shift()!.length; /* bounded ring */ } if (held > -n + ctx.limits.maxInputBytes) throw new ResourceError('too much buffered'); if (held >= -n) { /* emit only what is surely not in the tail */ } continue; } if (left <= 0) break; const piece = chunk.subarray(0, left); await ctx.out.write(piece); left -= piece.length; if (left <= 0) break; } if (n < 0) { const all = Buffer.concat(keep); await ctx.out.write(all.subarray(0, Math.max(0, all.length + n))); } continue; }
      const input = await openInput(ctx, operand, c); const w = writerFor(ctx, c, input.format);
      if (n >= 0) { let i = 0; if (n > 0) for await (const r of input.recs) { await writeRec(w, r); if (++i >= n) break; } }
      else { const ring: Rec[] = []; for await (const r of input.recs) { ring.push(r); if (ring.length > -n) await writeRec(w, ring.shift()!); } }
      await w.end();
    } catch (e) { if (e instanceof Quiet) throw e; fail(ctx, `${operand}: ${(e as Error).message}`); status = 1; }
  }
  return status;
}
export async function tail(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ n: true, c: true, q: false, v: false, f: false, F: false }, { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', follow: 'f' }, 'n'));
  if (has(p, 'f') || has(p, 'F')) { fail(ctx, 'following (-f) is not supported: queries are snapshots, not streams'); return 1; }
  const c = common(p); const operands = operandsOrStdin(p); const showNames = has(p, 'v') || (!has(p, 'q') && operands.length > 1);
  const bytesMode = has(p, 'c'); const spec_ = (bytesMode ? last(p, 'c') : last(p, 'n')) ?? '10'; const fromStart = spec_.startsWith('+'); const n = Math.abs(count(spec_.replace(/^\+/, ''), bytesMode ? 'number of bytes' : 'number of lines', 10));
  let status = 0, first = true;
  for (const operand of operands) {
    try {
      if (showNames) await ctx.out.write(header(first, operand)); first = false;
      if (bytesMode) {
        if (fromStart) { let skip = Math.max(0, n - 1); for await (const chunk of byteChunks(await openBytes(ctx, operand), ctx)) { if (skip >= chunk.length) { skip -= chunk.length; continue; } await ctx.out.write(chunk.subarray(skip)); skip = 0; } continue; }
        if (n > ctx.limits.maxInputBytes) throw new ResourceError('byte count too large'); let buf = Buffer.alloc(0);
        for await (const chunk of byteChunks(await openBytes(ctx, operand), ctx)) { buf = Buffer.concat([buf, chunk]); if (buf.length > n * 2 + 65536) buf = buf.subarray(buf.length - n); }
        if (n > 0) await ctx.out.write(buf.subarray(Math.max(0, buf.length - n))); continue;
      }
      const input = await openInput(ctx, operand, c); const w = writerFor(ctx, c, input.format);
      if (fromStart) { let i = 0; for await (const r of input.recs) { if (++i >= Math.max(1, n)) await writeRec(w, r); } }
      else if (n > 0) { if (n > ctx.limits.maxBufferLines) throw new ResourceError(`tail window larger than ${ctx.limits.maxBufferLines} lines`); const ring: Rec[] = new Array(n); let seen = 0; for await (const r of input.recs) { ring[seen % n] = r; seen++; } const size = Math.min(n, seen), start = seen > n ? seen % n : 0; for (let i = 0; i < size; i++) await writeRec(w, ring[(start + i) % n]!); }
      else for await (const _ of input.recs) void _;
      await w.end();
    } catch (e) { if (e instanceof Quiet) throw e; fail(ctx, `${operand}: ${(e as Error).message}`); status = 1; }
  }
  return status;
}

// ---- wc -----------------------------------------------------------------------------------------------------------------------
interface Counts { lines: number; words: number; chars: number; bytes: number; maxLine: number }
export async function wc(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ l: false, w: false, c: false, m: false, L: false }, { lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L' }));
  const c = common(p); const operands = operandsOrStdin(p);
  let cols = ['l', 'w', 'c', 'm', 'L'].filter(k => has(p, k)); if (!cols.length) cols = ['l', 'w', 'c'];
  const rows: Array<{ name: string; counts: Counts }> = []; let status = 0; const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
  for (const operand of operands) {
    try {
      const k: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 }; const dec = new StringDecoder('utf8'); let inWord = false, col = 0;
      const eat = (s: string) => { for (const ch of s) { k.chars++; if (ch === '\n') { k.lines++; k.maxLine = Math.max(k.maxLine, col); col = 0; } else if (ch === '\t') col = (Math.floor(col / 8) + 1) * 8; else col++; const ws = ch === ' ' || (ch >= '\t' && ch <= '\r'); if (ws) inWord = false; else if (!inWord) { inWord = true; k.words++; } } };
      for await (const chunk of byteChunks(await openBytes(ctx, operand), ctx)) { k.bytes += chunk.length; if (k.bytes > ctx.limits.maxInputBytes) throw new ResourceError('input too large'); eat(dec.write(chunk)); }
      eat(dec.end()); k.maxLine = Math.max(k.maxLine, col);
      rows.push({ name: operand, counts: k }); total.lines += k.lines; total.words += k.words; total.chars += k.chars; total.bytes += k.bytes; total.maxLine = Math.max(total.maxLine, k.maxLine);
    } catch (e) { if (e instanceof Quiet) throw e; fail(ctx, `${operand}: ${(e as Error).message}`); status = 1; }
  }
  if (rows.length > 1) rows.push({ name: 'total', counts: total });
  const field = (k: Counts, col: string) => col === 'l' ? k.lines : col === 'w' ? k.words : col === 'c' ? k.bytes : col === 'm' ? k.chars : k.maxLine;
  const w = writerFor(ctx, c, 'text'); const width = String(Math.max(...rows.flatMap(r => cols.map(col => field(r.counts, col))), 0)).length;
  for (const r of rows) {
    const obj = { file: r.name === '-' ? null : r.name, ...Object.fromEntries(cols.map(col => [{ l: 'lines', w: 'words', c: 'bytes', m: 'chars', L: 'maxLineLength' }[col]!, field(r.counts, col)])) };
    await w.value(obj, cols.map(col => String(field(r.counts, col)).padStart(width)).join(' ') + (rows.length === 1 && operands[0] === '-' ? '' : ` ${r.name}`) + '\n');
  }
  await w.end(); return status;
}

// ---- tee ----------------------------------------------------------------------------------------------------------------------
export async function tee(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ a: false, p: false }, { append: 'a' }));
  if (!ctx.allowTee && p.operands.length) { fail(ctx, 'writing files is not available in this context'); return 1; }
  const handles: Array<{ name: string; fh: import('node:fs/promises').FileHandle }> = []; let status = 0;
  for (const name of p.operands) {
    try {
      const real = path.resolve(name); const dir = await fs.realpath(path.dirname(real)); const target = path.join(dir, path.basename(real));
      for (const r of await realRoots(ctx.vaultRoots)) { if (target === r || target.startsWith(r + path.sep)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', 'refusing to write inside a vault: revisions are immutable and only change through commits'); }
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (has(p, 'a') ? constants.O_APPEND : constants.O_TRUNC);
      const fh = await fs.open(target, flags, 0o666); const st = await fh.stat(); if (!st.isFile()) { await fh.close(); throw new MDBError('INVALID_INPUT', 'not a regular file'); }
      handles.push({ name, fh });
    } catch (e) { fail(ctx, `${name}: ${(e as Error).message}`); status = 1; }
  }
  try {
    for await (const chunk of byteChunks(ctx.stdin, ctx)) { await ctx.out.write(chunk); for (const h of handles) await h.fh.write(chunk); }
  } finally { for (const h of handles) { await h.fh.sync().catch(() => undefined); await h.fh.close(); } }
  void all; return status;
}
