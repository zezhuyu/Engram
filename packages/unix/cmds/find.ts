import { MDBError } from '../../core/types.js';
import { UsageError } from '../args.js';
import { common, fail, spec, writerFor, type Ctx } from '../ctx.js';
import { parseOptions, has, last } from '../args.js';
import { listVfs, normPath, under, type VNode } from '../vfs.js';

const globToRe = (g: string, ci: boolean): RegExp => {
  let s = '^'; for (let i = 0; i < g.length; i++) { const c = g[i]!; if (c === '*') s += '.*'; else if (c === '?') s += '.'; else if (c === '[') { const j = g.indexOf(']', i + 2); if (j < 0) s += '\\['; else { let body = g.slice(i + 1, j); if (body.startsWith('!')) body = '^' + body.slice(1); s += `[${body.replace(/\\/g, '\\\\')}]`; i = j; } } else if (c === '\\' && i + 1 < g.length) { s += g[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } else s += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  return new RegExp(s + '$', ci ? 'i' : '');
};
type Pred = (n: VNode, rootDepth: number) => boolean;
interface Parsed { start: string[]; test: Pred; actions: Array<'print' | 'print0' | 'ls'>; min: number; max: number }
function parseExpr(tokens: string[]): Parsed {
  let i = 0; const actions: Parsed['actions'] = []; let min = 0, max = Infinity;
  const need = (flag: string): string => { const v = tokens[++i]; if (v === undefined) throw new UsageError(`missing argument to '${flag}'`); return v; };
  const primary = (): Pred => {
    const t = tokens[i]; if (t === undefined) throw new UsageError('expression expected');
    switch (t) {
      case '(': { i++; const e = or(); if (tokens[i] !== ')') throw new UsageError("unmatched '('"); i++; return e; }
      case '!': case '-not': { i++; const e = primary(); return n => !e(n, 0); }
      case '-name': case '-iname': { const re = globToRe(need(t), t === '-iname'); i++; return n => re.test(n.name); }
      case '-path': case '-ipath': case '-wholename': { const re = globToRe(need(t), t === '-ipath'); i++; return n => re.test(n.path); }
      case '-title': case '-ititle': { const re = globToRe(need(t), t === '-ititle'); i++; return n => n.title !== undefined && re.test(n.title); }
      case '-type': { const v = need(t); i++; if (v !== 'd' && v !== 'f') throw new UsageError(`unknown argument to -type: ${v} (supported: d, f)`); return n => v === 'd' ? n.dir : !n.dir; }
      case '-kind': { const v = need(t); i++; return n => n.kind === v; }
      case '-tag': { const v = need(t); i++; return n => !!n.tags?.includes(v); }
      case '-updated-after': case '-updated-before': { const v = need(t); i++; const ms = Date.parse(v); if (!Number.isFinite(ms)) throw new UsageError(`bad timestamp '${v}'`); const iso = new Date(ms).toISOString(); return n => n.updatedAt !== undefined && (t === '-updated-after' ? n.updatedAt > iso : n.updatedAt < iso); }
      case '-empty': i++; return n => n.dir && false;
      case '-true': i++; return () => true;
      case '-false': i++; return () => false;
      case '-mindepth': min = Number(need(t)); i++; return () => true;
      case '-maxdepth': max = Number(need(t)); i++; return () => true;
      case '-print': i++; actions.push('print'); return () => true;
      case '-print0': i++; actions.push('print0'); return () => true;
      case '-ls': i++; actions.push('ls'); return () => true;
      default: throw new UsageError(`unknown predicate '${t}' (supported: -name -iname -path -ipath -title -type -kind -tag -updated-after -updated-before -mindepth -maxdepth -print -print0 -ls -not ! -a -o ( ))`);
    }
  };
  const and = (): Pred => { let l = primary(); while (i < tokens.length && tokens[i] !== '-o' && tokens[i] !== '-or' && tokens[i] !== ')') { if (tokens[i] === '-a' || tokens[i] === '-and') i++; const r = primary(); const a = l; l = (n, d) => a(n, d) && r(n, d); } return l; };
  const or = (): Pred => { let l = and(); while (tokens[i] === '-o' || tokens[i] === '-or') { i++; const r = and(); const a = l; l = (n, d) => a(n, d) || r(n, d); } return l; };
  const start: string[] = []; while (i < tokens.length && !tokens[i]!.startsWith('-') && tokens[i] !== '(' && tokens[i] !== '!') start.push(tokens[i++]!);
  const test = i < tokens.length ? or() : () => true; if (i < tokens.length) throw new UsageError(`unexpected '${tokens[i]}'`);
  return { start: start.length ? start : ['/'], test, actions, min, max };
}
export async function find(ctx: Ctx, argv: string[]): Promise<number> {
  // find has its own expression syntax; only the leading common options (--format, --in) are split off.
  const rest: string[] = []; const own: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a === '--format' || a === '--in') { own.push(a, argv[++i] ?? ''); } else if (a.startsWith('--format=') || a.startsWith('--in=')) own.push(a); else rest.push(a); }
  const c = common(parseOptions(own, spec({}, {})));
  let parsed: Parsed; try { parsed = parseExpr(rest); } catch (e) { fail(ctx, (e as Error).message); return 1; }
  if (!ctx.client) { fail(ctx, 'no vault'); return 1; }
  const nodes = await listVfs(ctx); const w = writerFor(ctx, c, 'text'); const actions = parsed.actions.length ? parsed.actions : ['print' as const];
  const nul = actions.includes('print0') || c.delim === '\0'; let status = 0;
  for (const startRaw of parsed.start) {
    const start = normPath(startRaw); const root = nodes.find(n => n.path === start);
    if (!root) { fail(ctx, `'${startRaw}': No such file or directory`); status = 1; continue; }
    const base = start === '/' ? 0 : start.split('/').filter(Boolean).length;
    for (const n of nodes) {
      if (!under(n.path, start)) continue; const depth = n.path === '/' ? 0 : n.path.split('/').filter(Boolean).length - base; if (depth < parsed.min || depth > parsed.max) continue;
      if (!parsed.test(n, depth)) continue;
      for (const a of actions) {
        if (a === 'ls') await w.value({ path: n.path, type: n.dir ? 'd' : 'f', id: n.id, kind: n.kind, updatedAt: n.updatedAt, title: n.title }, `${n.dir ? 'd' : 'f'} ${n.updatedAt ?? '-'} ${n.kind ?? '-'} ${n.path}\n`);
        else await w.value({ path: n.path, type: n.dir ? 'd' : 'f', ...(n.id ? { id: n.id, kind: n.kind, title: n.title, tags: n.tags, updatedAt: n.updatedAt } : {}) }, n.path + (a === 'print0' || nul ? '\0' : '\n'));
      }
    }
  }
  await w.end(); void MDBError; void has; void last; return status;
}

export async function tree(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ L: true, d: false, f: false, a: false, J: false, i: false }, { 'level': 'L', json: 'J', noreport: false, titles: false, charset: true, 'dirs-only': 'd' }));
  const c = common(p); if (!ctx.client) { fail(ctx, 'no vault'); return 1; }
  const levels = has(p, 'L') ? Number(last(p, 'L')) : Infinity; if (!(levels >= 1)) throw new UsageError('Invalid level, must be greater than 0');
  const start = normPath(p.operands[0] ?? '/'); const nodes = (await listVfs(ctx)).filter(n => under(n.path, start)); if (!nodes.some(n => n.path === start)) { fail(ctx, `${p.operands[0]}: error opening dir`); return 2; }
  const ascii = last(p, 'charset') === 'ascii'; const [tee_, elbow, bar, blank] = ascii ? ['|-- ', '`-- ', '|   ', '    '] : ['├── ', '└── ', '│   ', '    '];
  const kids = new Map<string, VNode[]>(); for (const n of nodes) if (n.path !== start) { const parent = n.path.slice(0, n.path.lastIndexOf('/')) || '/'; (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(n); }
  const dirsOnly = has(p, 'd'); let dirs = 0, files = 0;
  const label = (n: VNode) => (has(p, 'f') ? n.path : n.name) + (has(p, 'titles') && n.title ? ` [${n.title}]` : '');
  if (has(p, 'J')) {
    const build = (n: VNode, depth: number): unknown => ({ type: n.dir ? 'directory' : 'file', name: has(p, 'f') ? n.path : n.name, ...(n.id ? { id: n.id, title: n.title, kind: n.kind } : {}), ...(n.dir && depth < levels ? { contents: (kids.get(n.path) ?? []).filter(k => !dirsOnly || k.dir).map(k => build(k, depth + 1)) } : {}) });
    const countAll = (path: string, depth: number) => { for (const k of kids.get(path) ?? []) { if (k.dir) { dirs++; if (depth < levels) countAll(k.path, depth + 1); } else if (!dirsOnly) files++; } }; countAll(start, 1);
    const root = nodes.find(n => n.path === start)!; const out = [build(root, 0), ...(has(p, 'noreport') ? [] : [{ type: 'report', directories: dirs, files }])];
    await ctx.out.write(JSON.stringify(out, null, 2) + '\n'); return 0;
  }
  let text = `${start === '/' ? '/' : start}\n`;
  const walk = (path: string, prefix: string, depth: number) => {
    const list = (kids.get(path) ?? []).filter(k => !dirsOnly || k.dir);
    list.forEach((k, i) => { const lastOne = i === list.length - 1; text += `${prefix}${lastOne ? elbow : tee_}${label(k)}\n`; if (k.dir) { dirs++; if (depth < levels) walk(k.path, prefix + (lastOne ? blank : bar), depth + 1); } else files++; });
  };
  walk(start, '', 1);
  if (!has(p, 'noreport')) text += `\n${dirs} director${dirs === 1 ? 'y' : 'ies'}${dirsOnly ? '' : `, ${files} file${files === 1 ? '' : 's'}`}\n`;
  await ctx.out.write(text); void c; return 0;
}
