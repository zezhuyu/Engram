import { MDBError } from '../core/types.js';
import type { Engram } from '../sdk/index.js';
import { UsageError } from './args.js';
import { cat, head, tail, tee, wc } from './cmds/basic.js';
import { filter } from './bridge.js';
import { diff } from './cmds/diff.js';
import { find, tree } from './cmds/find.js';
import { grep } from './cmds/grep.js';
import { comm, cut, paste, sort, tr, uniq } from './cmds/text.js';
import type { Ctx } from './ctx.js';
import { DEFAULT_LIMITS, Quiet, ResourceError, memoryOut, type Limits } from './io.js';

export { type Ctx } from './ctx.js';
export { DEFAULT_LIMITS, memoryOut, type Limits } from './io.js';
export { toolStatus } from './bridge.js';
export const UNIX_COMMANDS = ['cat', 'head', 'tail', 'grep', 'cut', 'sort', 'uniq', 'wc', 'tr', 'paste', 'comm', 'diff', 'find', 'tree', 'tee'] as const;
export type UnixCommand = (typeof UNIX_COMMANDS)[number];
const TABLE: Record<UnixCommand | 'filter', (ctx: Ctx, argv: string[]) => Promise<number>> = { cat, head, tail, grep, cut, sort, uniq, wc, tr, paste, comm, diff, find, tree, tee, filter };
/** Exit status for usage and internal errors follows the tool being emulated: 2 for grep/diff/comm (1 is "no match"/"differ"), 1 otherwise. */
const ERR: Partial<Record<UnixCommand, number>> = { grep: 2, diff: 2, comm: 2, sort: 2 };

/** Runs one command. Never throws: returns the exit status (0 ok; grep 0/1/2; diff 0/1/2; comm/sort -c 1 on disorder). */
export async function runUnix(command: UnixCommand | 'filter', argv: string[], ctx: Omit<Ctx, 'prog'>): Promise<number> {
  const full: Ctx = { ...ctx, prog: `mdb ${command}` };
  const deadline = ctx.limits.deadlineMs; const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal; full.signal = signal;
  const timer = setTimeout(() => controller.abort(), deadline); timer.unref();
  const aborted = new Promise<number>(resolve => signal.addEventListener('abort', () => resolve(-1), { once: true }));
  try { const r = await Promise.race([TABLE[command](full, argv), aborted]); if (r === -1 || (signal.aborted && r !== 0)) throw new MDBError('CANCELLED', 'aborted'); return r; }
  catch (error) {
    if (error instanceof Quiet) return error.status;
    const e = error as Error & { code?: string };
    if (signal.aborted && !(error instanceof UsageError)) { full.err(`${full.prog}: ${ctx.signal?.aborted ? 'interrupted' : `exceeded the ${deadline} ms deadline`}\n`); return 130; }
    const message = error instanceof MDBError || error instanceof UsageError ? e.message : 'internal error';
    full.err(`${full.prog}: ${message}${error instanceof UsageError ? "\nTry 'mdb help' for the supported options." : ''}\n`);
    return (ERR as Record<string, number | undefined>)[command] ?? 1;
  } finally { clearTimeout(timer); }
}

export interface CapturedRun { exitCode: number; stdout: string; stderr: string; truncated: boolean }
/** In-process, text-only execution for MCP/SDK: input is a string, no local files, no tee, output capped. */
export async function runCaptured(command: UnixCommand, argv: string[], opts: { client?: Engram; input?: string; limits?: Partial<Limits>; maxOutputBytes?: number; signal?: AbortSignal } = {}): Promise<CapturedRun> {
  if (command === 'tee') throw new MDBError('INVALID_ARGUMENT', 'tee writes files and is only available from the command line');
  const out = memoryOut(); const cap = opts.maxOutputBytes ?? 4_000_000; let truncated = false; const errors: string[] = [];
  const capped = { get bytes() { return out.bytes; }, async write(c: string | Uint8Array) { if (out.bytes + Buffer.byteLength(typeof c === 'string' ? c : Buffer.from(c)) > cap) { truncated = true; throw new Quiet(0); } await out.write(c); } };
  const limits: Limits = { ...DEFAULT_LIMITS, maxInputBytes: 8_000_000, maxBufferLines: 200_000, deadlineMs: 20_000, ...opts.limits };
  const stdin = (async function* () { if (opts.input) yield Buffer.from(opts.input); })();
  const exitCode = await runUnix(command, argv, { stdin, out: capped, err: m => { if (errors.join('').length < 8000) errors.push(m); }, ...(opts.client ? { client: opts.client } : {}), limits, vaultRoots: opts.client ? [opts.client.vault.root] : [], allowLocalFiles: false, allowTee: false, ...(opts.signal ? { signal: opts.signal } : {}) });
  void ResourceError; return { exitCode, stdout: out.text(), stderr: errors.join(''), truncated };
}
