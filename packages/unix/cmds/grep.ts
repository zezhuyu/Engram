import { MDBError } from '../../core/types.js';
import { all, count, has, last, parseOptions, UsageError } from '../args.js';
import { common, fail, openInput, spec, writerFor, type Ctx } from '../ctx.js';
import { Quiet, type Rec } from '../io.js';
import { REGEX_WINDOW } from '../../query/operators/text.js';
import { assertSafeRegex } from '../../query/schema.js';

const CLASSES: Record<string, string> = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e' };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** POSIX BRE (default) or ERE to JavaScript RegExp source. ASCII classes only (C locale). */
export function posixToJs(pattern: string, ere: boolean): string {
  let out = ''; let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '[') { // bracket expression
      let j = i + 1; let body = ''; if (pattern[j] === '^') { body += '^'; j++; } if (pattern[j] === ']') { body += '\\]'; j++; }
      for (; j < pattern.length && pattern[j] !== ']'; j++) {
        if (pattern[j] === '[' && pattern[j + 1] === ':') { const end = pattern.indexOf(':]', j + 2); const name = pattern.slice(j + 2, end); if (end < 0 || !(name in CLASSES)) throw new UsageError('invalid character class'); body += CLASSES[name]; j = end + 1; }
        else body += pattern[j] === '\\' ? '\\\\' : pattern[j] === '[' ? '\\[' : pattern[j];
      }
      if (j >= pattern.length) throw new UsageError('Unmatched [, [^, [:, [., or [='); out += `[${body}]`; i = j + 1; continue;
    }
    if (c === '\\') {
      const n = pattern[i + 1]; if (n === undefined) throw new UsageError('Trailing backslash');
      if (!ere && '(){}|+?'.includes(n)) { out += n; i += 2; continue; }               // BRE: \( \) \{ \} \| \+ \? are operators
      if (n === '<' || n === '>') { out += '\\b'; i += 2; continue; }
      out += '\\' + n; i += 2; continue;
    }
    if (!ere && '(){}|+?'.includes(c)) { out += '\\' + c; i++; continue; }              // BRE: bare ( ) { } | + ? are literals
    if (!ere && c === '*' && (out === '' || out.endsWith('(') || out.endsWith('|'))) { out += '\\*'; i++; continue; }
    out += c; i++;
  }
  return out;
}

export async function grep(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ i: false, v: false, n: false, c: false, l: false, L: false, q: false, o: false, E: false, F: false, G: false, w: false, x: false, H: false, h: false, s: false, r: false, R: false, y: false, e: true, m: true, A: true, B: true, C: true, V: false },
    { 'ignore-case': 'i', 'invert-match': 'v', 'line-number': 'n', count: 'c', 'files-with-matches': 'l', 'files-without-match': 'L', quiet: 'q', silent: 'q', 'only-matching': 'o', 'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', 'word-regexp': 'w', 'line-regexp': 'x', 'with-filename': 'H', 'no-filename': 'h', 'no-messages': 's', regexp: 'e', 'max-count': 'm', 'after-context': 'A', 'before-context': 'B', context: 'C', recursive: 'r', vault: false, workspace: true, stdin: false }));
  const c = common(p);
  if (has(p, 'r') || has(p, 'R')) { fail(ctx, '-r is not supported on the local file system; use --vault to search the vault with its index'); return 2; }
  const patterns = [...all(p, 'e')]; const operands = [...p.operands];
  if (!patterns.length) { const first = operands.shift(); if (first === undefined) throw new UsageError('no pattern given'); patterns.push(first); }
  const list = patterns.flatMap(x => x.split('\n')); if (list.length > 64 || list.some(x => x.length > 4096)) throw new UsageError('too many or too long patterns');
  const ignore = has(p, 'i') || has(p, 'y'), invert = has(p, 'v'), fixed = has(p, 'F'), ere = has(p, 'E'), word = has(p, 'w'), whole = has(p, 'x');
  const flags = ignore ? 'gi' : 'g';
  const regexes = list.map(pat => {
    let src: string; if (fixed) src = escapeRe(pat); else { src = posixToJs(pat, ere); assertSafeRegex(src.length ? src : '(?:)', ''); }
    if (whole) src = `^(?:${src})$`; else if (word) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
    try { return new RegExp(src || '(?:)', flags); } catch { throw new UsageError(`invalid pattern: ${pat.slice(0, 40)}`); }
  });
  const matchLine = (text: string): boolean => { const t = !fixed && text.length > REGEX_WINDOW ? text.slice(0, REGEX_WINDOW) : text; return regexes.some(r => { r.lastIndex = 0; return r.test(t); }); };
  if (has(p, 'vault')) return vaultGrep(ctx, p, list, { fixed, ignore, invert });

  const max = has(p, 'm') ? count(last(p, 'm'), 'max count', Infinity) : Infinity; const after = Math.max(count(last(p, 'A') ?? last(p, 'C'), 'context', 0), 0), before = Math.max(count(last(p, 'B') ?? last(p, 'C'), 'context', 0), 0);
  const sources = operands.length ? operands : ['-']; const withName = has(p, 'H') || (!has(p, 'h') && sources.length > 1);
  const countOnly = has(p, 'c'), listFiles = has(p, 'l'), listMissing = has(p, 'L'), quiet = has(p, 'q'), only = has(p, 'o'), numbers = has(p, 'n');
  let anySelected = false, status = 0; let wroteGroup = false;
  let w = writerFor(ctx, c, 'text'); let wFixed = false; const eol = c.delim;
  for (const name of sources) {
    let selected = 0;
    try {
      const input = await openInput(ctx, name, c); if (!wFixed) { w = writerFor(ctx, c, input.format); wFixed = true; } const display = name === '-' ? '(standard input)' : name;
      const beforeBuf: Array<{ r: Rec; n: number }> = []; let afterLeft = 0; let lastPrinted = 0; let n = 0;
      const prefix = (sep: string, ln: number) => (withName ? `${display}${sep}` : '') + (numbers ? `${ln}${sep}` : '');
      const emit = async (r: Rec, ln: number, sep: string, text = r.text) => { if (countOnly || listFiles || listMissing || quiet) return; await w.rec({ text: prefix(sep, ln) + text, eol: true, row: { ...(r.row ?? {}), file: name === '-' ? null : name, lineNumber: ln, selected: sep === ':' } }); };
      for await (const r of input.recs) {
        n++;
        if (selected >= max) { if (afterLeft <= 0) break; afterLeft--; await emit(r, n, '-'); continue; } // after the last selected line only trailing context is printed (GNU)
        const hit = matchLine(r.text) !== invert;
        if (hit) {
          selected++; anySelected = true; if (quiet) return 0;
          if (!countOnly && !listFiles && !listMissing) {
            if ((before || after) && wroteGroup && lastPrinted !== 0 && n - beforeBuf.length > lastPrinted + 1) await ctx.out.write('--' + eol);
            else if ((before || after) && wroteGroup && lastPrinted === 0 && sources.length > 1) await ctx.out.write('--' + eol);
            for (const b of beforeBuf) await emit(b.r, b.n, '-'); beforeBuf.length = 0;
            if (only && !invert) { for (const regex of regexes) { regex.lastIndex = 0; } const spans: string[] = []; for (const regex of regexes) { regex.lastIndex = 0; for (const m of r.text.matchAll(regex)) if (m[0].length) spans.push(m[0]); } for (const s of spans) await emit(r, n, ':', s); }
            else if (!only) await emit(r, n, ':');
            lastPrinted = n; wroteGroup = true; afterLeft = after;
          }
          if (selected >= max && afterLeft <= 0) break;
        } else if (afterLeft > 0) { afterLeft--; await emit(r, n, '-'); lastPrinted = n; }
        else if (before) { beforeBuf.push({ r, n }); if (beforeBuf.length > before) beforeBuf.shift(); }
      }
      if (countOnly) await w.value({ file: name === '-' ? null : name, count: selected }, (withName ? `${display}:` : '') + `${selected}${eol}`);
      if (listFiles && selected) await w.value({ file: name === '-' ? null : name }, `${display}${eol}`);
      if (listMissing && !selected) await w.value({ file: name === '-' ? null : name }, `${display}${eol}`);
    } catch (e) { if (e instanceof Quiet) throw e; if (!has(p, 's')) fail(ctx, `${name}: ${(e as Error).message}`); status = 2; }
  }
  await w.end();
  if (quiet) return anySelected ? 0 : status || 1;
  return status === 2 ? 2 : anySelected || (listMissing) ? 0 : 1;
}

/** Index-backed search over the vault: the vault's text index narrows candidates, the lines are then matched exactly. Output: vpath:LINE:text (like grep -rn). */
async function vaultGrep(ctx: Ctx, p: ReturnType<typeof parseOptions>, patterns: string[], o: { fixed: boolean; ignore: boolean; invert: boolean }): Promise<number> {
  if (!ctx.client) { fail(ctx, '--vault needs a vault'); return 2; }
  const c = common(p); const w = writerFor(ctx, c, 'text'); if (patterns.length !== 1) { fail(ctx, '--vault takes exactly one pattern'); return 2; }
  const pat = patterns[0]!; const ws = last(p, 'workspace');
  const search = o.fixed ? { mode: 'exact' as const, text: pat, caseSensitive: !o.ignore } : undefined; // regex patterns scan candidates by metadata; fixed strings use the text index
  const pipe: unknown[] = [{ op: 'cat' }, o.fixed ? { op: 'grep', pattern: pat, ...(o.ignore ? { ignoreCase: true } : {}), ...(o.invert ? { invert: true } : {}) } : { op: 'regex', pattern: pat, ...(o.ignore ? { ignoreCase: true } : {}), ...(o.invert ? { invert: true } : {}) }];
  const result = await ctx.client.queries.run({ from: 'documents', ...(search ? { search } : {}), ...(ws ? { scope: { workspace: ws } } : {}), pipe }, { maxRows: 100_000 });
  const docs = new Map<string, string>(); const lister = await ctx.client.queries.run({ from: 'documents', ...(ws ? { scope: { workspace: ws } } : {}), pipe: [{ op: 'select', fields: ['id', 'path'] }] }, { maxRows: 1_000_000 }).catch(() => undefined);
  for (const r of (lister?.rows ?? []) as Array<{ id: string; path: string }>) docs.set(r.id, r.path);
  let any = false;
  for (const r of result.rows as Array<{ documentId: string; lineNumber: number; text: string }>) { any = true; await w.value({ documentId: r.documentId, path: docs.get(r.documentId), lineNumber: r.lineNumber, text: r.text }, `${docs.get(r.documentId) ?? r.documentId}:${r.lineNumber}:${r.text}\n`); }
  await w.end(); void MDBError; void count; return any ? 0 : 1;
}
