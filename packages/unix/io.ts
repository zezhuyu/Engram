import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { MDBError } from '../core/types.js';

export interface Limits { /** longest accepted line in bytes */ maxLineBytes: number; /** lines a blocking command may hold (sort, diff, comm check) */ maxBufferLines: number; /** total input bytes a command will read */ maxInputBytes: number; deadlineMs: number }
export const DEFAULT_LIMITS: Limits = { maxLineBytes: 4 * 1024 * 1024, maxBufferLines: 1_000_000, maxInputBytes: 2 * 1024 ** 3, deadlineMs: 10 * 60_000 };
export class ResourceError extends MDBError { constructor(message: string) { super('RESOURCE_LIMIT', message); } }
/** Thrown to stop a pipeline quietly (downstream closed the pipe, like SIGPIPE) */
export class Quiet extends Error { constructor(readonly status = 0) { super('quiet'); } }

/** One logical record. `eol` is false only for a final unterminated line. `row` carries NDJSON metadata through filters. */
export interface Rec { text: string; eol: boolean; row?: Record<string, unknown> }
export type InFormat = 'text' | 'ndjson' | 'json'; export type OutFormat = 'text' | 'ndjson' | 'json';

export interface Out { write(chunk: string | Uint8Array): Promise<void>; bytes: number }
export function outputOf(stream: Writable): Out {
  let closed = false; stream.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') closed = true; });
  const out: Out = { bytes: 0, async write(chunk) {
    if (closed || stream.destroyed) throw new Quiet(0);
    out.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (!stream.write(chunk)) await new Promise<void>((resolve, reject) => { const ok = () => { stream.off('error', bad); resolve(); }; const bad = (e: Error) => { stream.off('drain', ok); (e as NodeJS.ErrnoException).code === 'EPIPE' ? reject(new Quiet(0)) : reject(e); }; stream.once('drain', ok); stream.once('error', bad); });
  } };
  return out;
}
export function memoryOut(): Out & { text(): string } { const parts: Buffer[] = []; const o = { bytes: 0, async write(c: string | Uint8Array) { const b = Buffer.from(c); parts.push(b); o.bytes += b.length; }, text: () => Buffer.concat(parts).toString('utf8') }; return o; }

/** Splits a byte stream into records on `delim` ('\n' or '\0'), streaming, UTF-8 safe across chunk boundaries, bounded per line. */
export async function* records(source: AsyncIterable<Buffer | string>, delim: '\n' | '\0', limits: Limits, signal?: AbortSignal): AsyncGenerator<Rec> {
  const decoder = new StringDecoder('utf8'); let pending = ''; let total = 0;
  for await (const chunk of source) {
    if (signal?.aborted) throw new MDBError('CANCELLED', 'cancelled');
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk; total += buf.length; if (total > limits.maxInputBytes) throw new ResourceError(`input exceeds ${limits.maxInputBytes} bytes`);
    pending += decoder.write(buf);
    let from = 0, at: number;
    while ((at = pending.indexOf(delim, from)) >= 0) { if (at - from > limits.maxLineBytes) throw new ResourceError(`line longer than ${limits.maxLineBytes} bytes`); yield { text: pending.slice(from, at), eol: true }; from = at + 1; }
    pending = pending.slice(from);
    if (pending.length > limits.maxLineBytes) throw new ResourceError(`line longer than ${limits.maxLineBytes} bytes`);
  }
  pending += decoder.end(); if (pending.length) yield { text: pending, eol: false };
}
/** NDJSON/JSON adapters: objects with a string `text` become line records that keep their metadata; strings become text; anything else is compact JSON text. */
export function fromJson(value: unknown): Rec {
  if (typeof value === 'string') return { text: value, eol: true };
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { text?: unknown }).text === 'string') return { text: (value as { text: string }).text, eol: true, row: value as Record<string, unknown> };
  return { text: JSON.stringify(value), eol: true, ...(value && typeof value === 'object' && !Array.isArray(value) ? { row: value as Record<string, unknown> } : {}) };
}
export async function* decodeRecords(source: AsyncIterable<Buffer | string>, format: InFormat | 'auto', delim: '\n' | '\0', limits: Limits, signal?: AbortSignal): AsyncGenerator<Rec> {
  if (format === 'json') {
    let text = ''; const dec = new StringDecoder('utf8'); let n = 0; for await (const c of source) { n += c.length; if (n > limits.maxInputBytes) throw new ResourceError('JSON input too large'); text += typeof c === 'string' ? c : dec.write(c); } text += dec.end();
    let v: unknown; try { v = JSON.parse(text); } catch { throw new MDBError('INVALID_INPUT', 'input is not valid JSON'); }
    if (!Array.isArray(v)) throw new MDBError('INVALID_INPUT', 'JSON input must be an array'); for (const x of v) yield fromJson(x); return;
  }
  let mode = format; let first = true;
  for await (const r of records(source, delim, limits, signal)) {
    if (first) { first = false; if (mode === 'auto') mode = looksLikeRowJson(r.text) ? 'ndjson' : 'text'; }
    if (mode === 'ndjson') { if (!r.text.trim()) continue; let v: unknown; try { v = JSON.parse(r.text); } catch { throw new MDBError('INVALID_INPUT', 'invalid NDJSON line'); } yield fromJson(v); } else yield r;
  }
}
/** `--in auto` rule, decided from the FIRST record only: a JSON object with a string "text" field means NDJSON line rows; anything else is plain text. */
export function looksLikeRowJson(first: string): boolean { if (!first.startsWith('{')) return false; try { const v = JSON.parse(first) as unknown; return !!v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string'; } catch { return false; } }

export function encode(rec: Rec, format: OutFormat, delim: '\n' | '\0', forceEol = false): string {
  if (format === 'ndjson') return JSON.stringify(rec.row ? { ...rec.row, text: rec.text } : { text: rec.text }) + '\n';
  return rec.text + (rec.eol || forceEol ? delim : '');
}
/** Output sink with format handling: text (delimited), ndjson (one object per record), json (one array). */
export class Writer {
  private first = true;
  constructor(readonly out: Out, readonly format: OutFormat, readonly delim: '\n' | '\0') {}
  async rec(rec: Rec, forceEol = true): Promise<void> {
    if (this.format === 'json') { await this.out.write((this.first ? '[' : ',\n') + JSON.stringify(rec.row ? { ...rec.row, text: rec.text } : { text: rec.text })); this.first = false; return; }
    await this.out.write(encode(rec, this.format, this.delim, forceEol));
  }
  async value(v: unknown, textForm: string): Promise<void> {
    if (this.format === 'text') return this.out.write(textForm);
    if (this.format === 'ndjson') return this.out.write(JSON.stringify(v) + '\n');
    await this.out.write((this.first ? '[' : ',\n') + JSON.stringify(v)); this.first = false;
  }
  async end(): Promise<void> { if (this.format === 'json') await this.out.write(this.first ? '[]\n' : ']\n'); }
}

/** Local file operand guard: regular files only, never inside a vault root (use mdb: operands so ACLs apply), no symlink surprises. */
export async function openLocal(file: string, vaultRoots: string[]): Promise<Readable> {
  const real = await fs.realpath(file).catch(() => { throw new MDBError('NOT_FOUND', `${file}: No such file or directory`); });
  for (const r of await realRoots(vaultRoots)) { if (real === r || real.startsWith(r + path.sep)) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', `${file}: inside a vault; use an mdb:ID operand so access control applies`); }
  const st = await fs.stat(real); if (!st.isFile()) throw new MDBError('INVALID_INPUT', `${file}: not a regular file`);
  return createReadStream(real);
}

/** Vault roots as the file system sees them (symlinks such as /var -> /private/var resolved), so a path cannot dodge the guard by spelling. */
export async function realRoots(roots: string[]): Promise<string[]> { return Promise.all(roots.map(async r => fs.realpath(path.resolve(r)).catch(() => path.resolve(r)))); }
