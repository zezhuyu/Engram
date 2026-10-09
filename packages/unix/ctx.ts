import { createReadStream } from 'node:fs';
import { MDBError } from '../core/types.js';
import { objectIdFromUri } from '../core/vault.js';
import type { Engram } from '../sdk/index.js';
import { parseOptions, last, type OptSpec, type Parsed } from './args.js';
import { decodeRecords, looksLikeRowJson, openLocal, records, type InFormat, type Limits, type Out, type OutFormat, type Rec, Writer } from './io.js';

export interface Ctx {
  prog: string; stdin: AsyncIterable<Buffer>; out: Out; err(message: string): void;
  /** vault access: present for CLI and MCP; absent in pure-text contexts */
  client?: Engram; limits: Limits; vaultRoots: string[];
  /** CLI only: let text tools open local regular files (never inside a vault). MCP: false. */
  allowLocalFiles: boolean; allowTee: boolean; signal?: AbortSignal;
}
export const COMMON_SHORT = { z: false } as const;
/** Options every text command shares. */
export const COMMON_LONG = { null: 'z', in: true, format: true } as const;
export function spec(short: Record<string, boolean>, long: Record<string, string | boolean> = {}, numeric?: string): OptSpec {
  return { short: { z: false, ...short }, long: { null: 'z', in: true, format: true, ...long }, ...(numeric ? { numeric } : {}) };
}
export interface Common { delim: '\n' | '\0'; inFormat: InFormat | 'auto'; outFormat: OutFormat | 'auto' }
export function common(p: Parsed): Common {
  const inF = last(p, 'in') ?? 'auto', outF = last(p, 'format') ?? 'auto';
  if (!['auto', 'text', 'ndjson', 'json'].includes(inF)) throw new MDBError('INVALID_ARGUMENT', `--in must be auto|text|ndjson|json`);
  if (!['auto', 'text', 'ndjson', 'json'].includes(outF)) throw new MDBError('INVALID_ARGUMENT', `--format must be auto|text|ndjson|json`);
  return { delim: p.flags.has('z') ? '\0' : '\n', inFormat: inF as Common['inFormat'], outFormat: outF as Common['outFormat'] };
}
export const OBJECT_ID = /^obj_[A-Za-z0-9_-]+$/;
/** An operand naming a vault object: mdb:ID[@REV], mdb://… URI, a bare obj_… id, or a virtual path ending in ID.md. */
export function vaultRef(operand: string): { id: string; rev?: string } | undefined {
  let s = operand; if (s.startsWith('mdb:') && !s.startsWith('mdb://')) s = s.slice(4);
  let rev: string | undefined; const at = s.lastIndexOf('@'); if (at > 0 && /^rev_/.test(s.slice(at + 1))) { rev = s.slice(at + 1); s = s.slice(0, at); }
  if (s.startsWith('mdb://')) return { id: objectIdFromUri(s), ...(rev ? { rev } : {}) };
  const base = s.split('/').at(-1)!.replace(/\.md$/, ''); if (OBJECT_ID.test(base) && (operand.startsWith('mdb:') || OBJECT_ID.test(s) || s.endsWith('.md'))) return { id: base, ...(rev ? { rev } : {}) };
  return undefined;
}

export interface Input { name: string; format: InFormat; recs: AsyncGenerator<Rec> }
async function* oneBuffer(text: string): AsyncGenerator<Buffer> { yield Buffer.from(text); }
/** Opens one operand as a byte stream: `-` is stdin, vault references read through the actor-bound Vault (ACL, revision pinned), local files only where allowed. */
export async function openBytes(ctx: Ctx, operand: string): Promise<AsyncIterable<Buffer>> {
  if (operand === '-') return ctx.stdin;
  const ref = vaultRef(operand);
  if (ref) {
    if (!ctx.client) throw new MDBError('NOT_FOUND', `${operand}: no vault`);
    const doc = await ctx.client.vault.get(ref.id, ref.rev); // inaccessible and missing look identical
    return oneBuffer(doc.body);
  }
  if (!ctx.allowLocalFiles) throw new MDBError('NOT_FOUND_OR_FORBIDDEN', `${operand}: only '-' and mdb: operands are available here`);
  return openLocal(operand, ctx.vaultRoots) as unknown as AsyncIterable<Buffer>;
}
export async function openInput(ctx: Ctx, operand: string, c: Common): Promise<Input> {
  const bytes = await openBytes(ctx, operand);
  if (c.inFormat === 'json') return { name: operand, format: 'json', recs: decodeRecords(bytes, 'json', c.delim, ctx.limits, ctx.signal) };
  const raw = records(bytes, c.delim, ctx.limits, ctx.signal); const it = raw[Symbol.asyncIterator]();
  const head = await it.next();
  let format: InFormat = c.inFormat === 'auto' ? (!head.done && looksLikeRowJson(head.value.text) ? 'ndjson' : 'text') : c.inFormat;
  async function* chain(): AsyncGenerator<Rec> {
    const emit = function* (r: Rec): Generator<Rec> { if (format === 'ndjson') { if (!r.text.trim()) return; let v: unknown; try { v = JSON.parse(r.text); } catch { throw new MDBError('INVALID_INPUT', 'invalid NDJSON line'); } const o = fromJsonLocal(v); yield o; } else yield r; };
    if (!head.done) yield* emit(head.value);
    for (;;) { const n = await it.next(); if (n.done) return; yield* emit(n.value); }
  }
  return { name: operand, format, recs: chain() };
}
import { fromJson as fromJsonLocal } from './io.js';

export function writerFor(ctx: Ctx, c: Common, detected: InFormat): Writer { return new Writer(ctx.out, c.outFormat === 'auto' ? detected : c.outFormat, c.delim); }
export function operandsOrStdin(p: Parsed): string[] { return p.operands.length ? p.operands : ['-']; }
export { parseOptions };
export function fail(ctx: Ctx, message: string): void { ctx.err(`${ctx.prog}: ${message}\n`); }
export const textStream = (path: string) => createReadStream(path);
