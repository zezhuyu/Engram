import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Engram, MDBError, runLocal, type QueryResult } from '../sdk/index.js';
import type { QueryOp } from '../query/ast.js';

/** `mdb query` plus the stream aliases (cat, head, tail, cut, sed, ...). Aliases build the same typed AST / operators as `mdb query`; nothing here is a shell. */
export const STREAM_COMMANDS = new Set(['query', 'sed', 'trim', 'split', 'replace', 'distinct', 'reverse', 'select', 'pluck', 'count', 'sum', 'avg', 'min', 'max', 'tac']);
export const STREAMED = Symbol('streamed');
const FLAG_VALUES = new Set(['n', 'c', 'b', 'f', 'd', 'format', 'file', 'root', 'workspace', 'collection', 'limit', 'cursor', 'scope', 'by', 'fields', 'names', 'path', 'from', 'to', 'field', 'as', 'script', 'name', 'timeout-ms', 'max-rows']);
const SWITCH = new Set(['json', 'explain', 'help', 'meta', 'i', 'v', 'all', 'coerce', 'no-shared', 'allow-cursor-drift', 'lines', 'ndjson', 'regex', 'stdin']);

interface Parsed { pos: string[]; opts: Record<string, string | true> }
function parseArgs(argv: string[]): Parsed {
  const cmd = argv.find((t, i) => !t.startsWith('-') && argv[i - 1] !== '--root'); const numberFlag = ['sed', 'grep', 'cat', 'query'].includes(cmd ?? ''); // -n is a switch there (quiet / line numbers), a value elsewhere (-n COUNT)
  const pos: string[] = [], opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--') { pos.push(...argv.slice(i + 1)); break; }
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(t) ?? (/^-([A-Za-z])$/.exec(t) as RegExpExecArray | null);
    if (!m) { if (/^-\d+$/.test(t)) opts.n = t.slice(1); else pos.push(t); continue; }
    const key = m[1]!;
    if (m[2] !== undefined) opts[key] = m[2]; else if (SWITCH.has(key) || !FLAG_VALUES.has(key) || (numberFlag && key === 'n')) opts[key] = true; else { const v = argv[++i]; if (v === undefined) throw new MDBError('INVALID_ARGUMENT', `--${key} requires a value`); opts[key] = v; }
  }
  return { pos, opts };
}
const str = (p: Parsed, k: string): string | undefined => typeof p.opts[k] === 'string' ? p.opts[k] as string : undefined;
const int = (p: Parsed, k: string, d?: number): number | undefined => { const v = str(p, k); if (v === undefined) return d; const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new MDBError('INVALID_ARGUMENT', `-${k.length === 1 ? '' : '-'}${k} must be a non-negative integer`); return n; };
function rangesOf(spec: string): [number, number][] {
  return spec.split(',').map(part => {
    const m = /^(\d*)-(\d*)$/.exec(part.trim()) ?? /^(\d+)$/.exec(part.trim()); if (!m) throw new MDBError('INVALID_ARGUMENT', `Bad range "${part}" (use N, N-M, N-, -M)`);
    if (m.length === 2) return [Number(m[1]), Number(m[1])] as [number, number];
    return [m[1] ? Number(m[1]) : 1, m[2] ? Number(m[2]) : 1e9] as [number, number];
  });
}
async function* stdinRows(): AsyncGenerator<unknown> {
  let n = 0;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    n++; if (line === '') { yield { text: '', lineNumber: n }; continue; }
    if (line.startsWith('{') || line.startsWith('"') || /^-?\d/.test(line)) { try { yield JSON.parse(line); continue; } catch { /* plain text */ } }
    yield { text: line, lineNumber: n };
  }
}

function opsFor(command: string, p: Parsed): QueryOp[] {
  const [a, b] = p.pos;
  switch (command) {
    case 'head': case 'tail': return [{ op: command, n: int(p, 'n', 10)! }];
    case 'cut': {
      if (str(p, 'c')) return [{ op: 'cut', chars: rangesOf(str(p, 'c')!) }]; if (str(p, 'b')) return [{ op: 'cut', bytes: rangesOf(str(p, 'b')!) }];
      if (str(p, 'f')) return [{ op: 'cut', fields: str(p, 'f')!.split(',').map(Number), delimiter: str(p, 'd') ?? '\t' }]; throw new MDBError('INVALID_ARGUMENT', 'cut needs -c, -b or -f');
    }
    case 'sed': return [{ op: 'sed', script: [p.opts.n === true ? '-n;' : '', a ?? str(p, 'script') ?? ''].join('') }];
    case 'trim': return [{ op: 'trim' }];
    case 'split': return [{ op: 'split', delimiter: str(p, 'd') ?? '\t', ...(str(p, 'names') ? { names: str(p, 'names')!.split(',') } : {}) }];
    case 'replace': if (a === undefined || b === undefined) throw new MDBError('INVALID_ARGUMENT', 'replace needs FIND and WITH'); return [{ op: 'replace', find: a, with: b, all: !p.opts.first, ...(p.opts.i ? { ignoreCase: true } : {}) }];
    case 'uniq': return [{ op: 'uniq', ...(str(p, 'fields') ? { fields: str(p, 'fields')!.split(',') } : {}) }];
    case 'distinct': return [{ op: 'distinct', ...(str(p, 'fields') ? { fields: str(p, 'fields')!.split(',') } : {}) }];
    case 'sort': return [{ op: 'sort', fields: (str(p, 'by') ?? 'text').split(',').map(k => { const [field, dir] = k.split(':'); return { field: field!, dir: dir === 'desc' ? 'desc' as const : 'asc' as const }; }) }];
    case 'reverse': case 'tac': return [{ op: 'reverse' }];
    case 'select': return [{ op: 'select', fields: (str(p, 'fields') ?? a ?? '').split(',').filter(Boolean) }];
    case 'pluck': return [{ op: 'pluck', field: str(p, 'field') ?? a ?? 'text' }];
    case 'count': case 'sum': case 'avg': case 'min': case 'max': return [{ op: command, ...(str(p, 'field') ?? a ? { field: str(p, 'field') ?? a! } : {}), ...(p.opts.coerce ? { coerce: true } : {}) }];
    default: throw new MDBError('INVALID_ARGUMENT', `Unknown command ${command}`);
  }
}

type Format = 'table' | 'json' | 'jsonl' | 'text';
function render(rows: unknown[], format: Format, numbered: boolean): string {
  const scalar = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v);
  if (format === 'jsonl') return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  if (format === 'text') return rows.map(r => { const o = r as Record<string, unknown> | null; if (o && typeof o === 'object' && typeof o.text === 'string') return numbered && typeof o.lineNumber === 'number' ? `${o.lineNumber}:${o.text}` : o.text; return scalar(r); }).join('\n') + (rows.length ? '\n' : '');
  const objects = rows.filter(r => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[];
  if (!objects.length) return rows.map(scalar).join('\n') + (rows.length ? '\n' : '');
  const cols = [...new Set(objects.slice(0, 200).flatMap(o => Object.keys(o)))];
  const cell = (v: unknown) => { const t = v === undefined ? '' : scalar(v).replace(/[\r\n\t]+/g, ' '); return t.length > 48 ? `${t.slice(0, 47)}…` : t; };
  const width = cols.map(c => Math.min(48, Math.max(c.length, ...objects.map(o => cell(o[c]).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i]!)).join('  ').trimEnd();
  return [line(cols), line(width.map(w => '-'.repeat(w))), ...objects.map(o => line(cols.map(c => cell(o[c]))))].join('\n') + '\n';
}
const defaultFormat = (rows: unknown[]): Format => process.stdout.isTTY ? (rows[0] && typeof (rows[0] as { text?: unknown }).text === 'string' ? 'text' : 'table') : 'jsonl';

export async function queryCommand(argv: string[], client: Engram, root: string): Promise<unknown> {
  const p = parseArgs(argv.filter(t => t !== '--root' || true)); // --root VALUE is consumed by FLAG_VALUES
  const command = p.pos.shift()!;
  const format = (str(p, 'format') ?? (p.opts.json && command !== 'query' ? 'json' : undefined)) as Format | undefined;
  if (format && !['table', 'json', 'jsonl', 'text'].includes(format)) throw new MDBError('INVALID_ARGUMENT', '--format must be table, json, jsonl or text');
  const out = (text: string) => { process.stdout.write(text); return STREAMED; };
  const scopeFlags = () => ({ ...(str(p, 'workspace') ? { workspace: str(p, 'workspace')! } : {}), ...(str(p, 'collection') ? { collection: str(p, 'collection')! } : {}), ...(p.opts['no-shared'] ? { includeShared: false } : {}) });
  const ctx = { ...(int(p, 'timeout-ms') ? { deadlineMs: int(p, 'timeout-ms')! } : {}), ...(int(p, 'max-rows') ? { maxRows: int(p, 'max-rows')! } : {}), ...(p.opts['allow-cursor-drift'] ? { allowCursorDrift: true } : {}) };
  const finish = (result: QueryResult): unknown => {
    const f = format ?? defaultFormat(result.rows);
    if (f === 'json') return out(JSON.stringify(result, null, 2) + '\n');
    out(render(result.rows, f, p.opts.n === true));
    if (result.cursor || result.truncated || result.fallback) process.stderr.write(`${JSON.stringify({ ...(result.cursor ? { cursor: result.cursor } : {}), ...(result.truncated ? { truncated: result.truncated } : {}), ...(result.fallback ? { fallback: result.fallback } : {}) })}\n`);
    if (p.opts.meta) process.stderr.write(`${JSON.stringify(result.stats)}\n`);
    return STREAMED;
  };

  if (command === 'query') {
    const sub = p.pos[0];
    if (sub === 'capabilities') return client.queries.capabilities();
    if (sub === 'save') { // mdb query save NAME (--file F | JSON) --scope workspace:ID
      const name = p.pos[1]; if (!name) throw new MDBError('INVALID_ARGUMENT', 'query save needs a NAME'); const raw = str(p, 'file') ? await readFile(resolve(str(p, 'file')!), 'utf8') : p.pos[2]; if (!raw) throw new MDBError('INVALID_ARGUMENT', 'query save needs --file or a JSON argument');
      const sc = str(p, 'scope'); const pieces = (sc ?? '').split(':'); const scope = pieces[0] === 'workspace' && pieces[1] ? { type: 'workspace' as const, workspaceId: pieces[1], ...(pieces[2] ? { collectionId: pieces[2] } : {}) } : ['wiki', 'shared', 'discoveries', 'profile'].includes((pieces[0] === 'global' ? pieces[1] : pieces[0]) ?? '') ? { type: 'global' as const, area: (pieces[0] === 'global' ? pieces[1] : pieces[0]) as 'wiki' } : undefined;
      if (!scope) throw new MDBError('INVALID_ARGUMENT', '--scope workspace:ID[:COLLECTION] or global:AREA is required');
      return client.queries.save(name, JSON.parse(raw), scope);
    }
    const raw = str(p, 'file') ? await readFile(resolve(str(p, 'file')!), 'utf8') : p.pos.find(t => t.trimStart().startsWith('{')) ?? str(p, 'query');
    if (!raw) throw new MDBError('INVALID_ARGUMENT', 'query needs --json \'{…}\', --file PATH or query text');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (str(p, 'limit')) parsed.limit = int(p, 'limit'); if (str(p, 'cursor')) parsed.cursor = str(p, 'cursor');
    if (Object.keys(scopeFlags()).length && !parsed.scope) parsed.scope = scopeFlags();
    if (p.opts.explain) return client.queries.explain(parsed, ctx);
    return finish(await client.queries.run(parsed, ctx));
  }
  if (command === 'cat') { // mdb cat ID|URI [...] [--from N --to M]
    const ids = p.pos; if (!ids.length) throw new MDBError('INVALID_ARGUMENT', 'cat needs an object ID or mdb:// URI');
    const where = { or: ids.flatMap(id => [{ field: 'id', op: 'eq', value: id }, { field: 'path', op: 'eq', value: id }]) };
    const pipe: unknown[] = [str(p, 'from') || str(p, 'to') ? { op: 'range', from: int(p, 'from', 1), to: int(p, 'to', 1e9) } : { op: 'cat' }];
    return finish(await client.queries.run({ from: 'documents', where, pipe, ...(Object.keys(scopeFlags()).length ? { scope: scopeFlags() } : {}) }, ctx));
  }
  // Stream transforms read JSONL (or plain text lines) from stdin; they cannot read the vault.
  const rows: unknown[] = []; for await (const r of runLocal(opsFor(command, p), stdinRows())) rows.push(r);
  void root; const f = format ?? defaultFormat(rows);
  return out(f === 'json' ? JSON.stringify(rows, null, 2) + '\n' : render(rows, f, p.opts.n === true && command !== 'sed'));
}

/** `mdb grep PATTERN --path ID` / `--stdin`: line grep over a stored document or piped lines. Without those flags `grep` remains the index search. */
export async function lineGrep(argv: string[], client: Engram): Promise<unknown> {
  const p = parseArgs(argv); p.pos.shift(); const pattern = p.pos[0]; if (!pattern) throw new MDBError('INVALID_ARGUMENT', 'grep needs a pattern');
  const op: QueryOp = { op: 'grep', pattern, ...(p.opts.i ? { ignoreCase: true } : {}), ...(p.opts.v ? { invert: true } : {}), ...(p.opts.regex ? { regex: true } : {}) };
  const format = (str(p, 'format') as Format | undefined);
  if (p.opts.stdin) { const rows: unknown[] = []; for await (const r of runLocal([op], stdinRows())) rows.push(r); const f = format ?? defaultFormat(rows); process.stdout.write(render(rows, f, p.opts.n === true)); return STREAMED; }
  const target = str(p, 'path')!; const where = { or: [{ field: 'id', op: 'eq', value: target }, { field: 'path', op: 'eq', value: target }] };
  const result = await client.queries.run({ from: 'documents', where, pipe: [{ op: 'cat' }, op], ...(str(p, 'workspace') ? { scope: { workspace: str(p, 'workspace') } } : {}) });
  const f = format ?? defaultFormat(result.rows); process.stdout.write(f === 'json' ? JSON.stringify(result, null, 2) + '\n' : render(result.rows, f, p.opts.n === true)); return STREAMED;
}
