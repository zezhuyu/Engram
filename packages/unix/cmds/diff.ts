import { count, has, last, all, parseOptions, UsageError } from '../args.js';
import { common, fail, openInput, spec, writerFor, type Ctx } from '../ctx.js';
import { Quiet, ResourceError, type Rec } from '../io.js';

type Op = { t: 'eq' | 'del' | 'ins'; a: number; b: number };
const MAX_D = 3000;
/** Shortest edit script (Myers). Beyond MAX_D edits the middle block is reported as a plain replacement: still a correct diff, not minimal. */
function myers(a: string[], b: string[]): { ops: Op[]; minimal: boolean } {
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf), n = A.length, m = B.length, max = n + m;
  const ops: Op[] = []; for (let i = 0; i < pre; i++) ops.push({ t: 'eq', a: i, b: i });
  let minimal = true;
  if (n === 0 || m === 0) { for (let i = 0; i < n; i++) ops.push({ t: 'del', a: pre + i, b: pre }); for (let j = 0; j < m; j++) ops.push({ t: 'ins', a: pre, b: pre + j }); }
  else {
    const off = Math.min(max, MAX_D) + 1; let v = new Int32Array(2 * off + 2); const trace: Int32Array[] = []; let found = -1;
    outer: for (let d = 0; d <= Math.min(max, MAX_D); d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1; let y = x - k;
        while (x < n && y < m && A[x] === B[y]) { x++; y++; }
        v[off + k] = x; if (x >= n && y >= m) { found = d; break outer; }
      }
    }
    if (found < 0) { minimal = false; for (let i = 0; i < n; i++) ops.push({ t: 'del', a: pre + i, b: pre }); for (let j = 0; j < m; j++) ops.push({ t: 'ins', a: pre + n, b: pre + j }); }
    else {
      const back: Op[] = []; let x = n, y = m;
      for (let d = found; d > 0; d--) {
        const vv = trace[d]!; const k = x - y; const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1; const px = vv[off + prevK]!, py = px - prevK;
        while (x > px && y > py && x - 1 >= 0 && A[x - 1] === B[y - 1]) { x--; y--; back.push({ t: 'eq', a: pre + x, b: pre + y }); }
        if (x === px) { y--; back.push({ t: 'ins', a: pre + x, b: pre + y }); } else { x--; back.push({ t: 'del', a: pre + x, b: pre + y }); }
      }
      while (x > 0 && y > 0) { x--; y--; back.push({ t: 'eq', a: pre + x, b: pre + y }); }
      back.reverse(); ops.push(...back);
    }
  }
  for (let i = 0; i < suf; i++) ops.push({ t: 'eq', a: a.length - suf + i, b: b.length - suf + i });
  return { ops, minimal };
}
interface Block { aStart: number; aEnd: number; bStart: number; bEnd: number } // half-open, 0-based
function blocks(ops: Op[]): Block[] {
  const out: Block[] = []; let cur: Block | undefined;
  for (const o of ops) {
    if (o.t === 'eq') { cur = undefined; continue; }
    if (!cur) { cur = { aStart: o.a, aEnd: o.a, bStart: o.b, bEnd: o.b }; out.push(cur); }
    if (o.t === 'del') cur.aEnd = o.a + 1; else cur.bEnd = o.b + 1;
  }
  return out;
}
const range = (s: number, e: number) => e - s <= 1 ? String(s + 1) : `${s + 1},${e}`;

export async function diff(ctx: Ctx, argv: string[]): Promise<number> {
  const p = parseOptions(argv, spec({ u: false, U: true, q: false, s: false, i: false, w: false, b: false, B: false, c: false, N: false }, { unified: 'U', brief: 'q', 'report-identical-files': 's', 'ignore-case': 'i', 'ignore-all-space': 'w', 'ignore-space-change': 'b', 'ignore-blank-lines': 'B', label: true, normal: false }));
  if (has(p, 'c')) { fail(ctx, 'context diff (-c) is not supported; use -u'); return 2; }
  const c = common(p); if (p.operands.length !== 2) throw new UsageError(p.operands.length < 2 ? 'missing operand after the first file' : `extra operand '${p.operands[2]}'`);
  const [na, nb] = p.operands as [string, string]; if (na === '-' && nb === '-') throw new UsageError('only one input can be standard input');
  const read = async (name: string): Promise<Rec[]> => { const recs: Rec[] = []; for await (const r of (await openInput(ctx, name, { ...c, inFormat: c.inFormat === 'auto' ? 'text' : c.inFormat })).recs) { recs.push(r); if (recs.length > ctx.limits.maxBufferLines) throw new ResourceError(`diff input longer than ${ctx.limits.maxBufferLines} lines`); } return recs; };
  let A: Rec[], B: Rec[]; try { [A, B] = await Promise.all([read(na), read(nb)]); } catch (e) { if (e instanceof Quiet) throw e; fail(ctx, (e as Error).message); return 2; }
  const norm = (r: Rec, last_: boolean): string => { let t = r.text; if (has(p, 'i')) t = t.toLowerCase(); if (has(p, 'w')) t = t.replace(/\s+/g, ''); else if (has(p, 'b')) t = t.replace(/\s+/g, ' ').replace(/\s+$/, ''); return last_ && !r.eol ? t + '\u0000noeol' : t; };
  const ka = A.map((r, i) => norm(r, i === A.length - 1)), kb = B.map((r, i) => norm(r, i === B.length - 1));
  const { ops } = myers(ka, kb); const bl = blocks(ops).filter(b => !(has(p, 'B') && A.slice(b.aStart, b.aEnd).every(r => !r.text.trim()) && B.slice(b.bStart, b.bEnd).every(r => !r.text.trim())));
  const w = writerFor(ctx, c, 'text');
  if (!bl.length) { if (has(p, 's')) await w.value({ identical: true }, `Files ${na} and ${nb} are identical\n`); await w.end(); return 0; }
  if (has(p, 'q')) { await w.value({ differ: true }, `Files ${na} and ${nb} differ\n`); await w.end(); return 1; }
  const noeol = (r: Rec) => r.eol ? '' : '\\ No newline at end of file\n';
  const unified = has(p, 'u') || has(p, 'U'); const ctxN = has(p, 'U') ? count(last(p, 'U'), 'context', 3) : 3;
  const labels = all(p, 'label');
  if (c.outFormat === 'ndjson' || c.outFormat === 'json') {
    for (const b of bl) await w.value({ aStart: b.aStart + 1, aLines: b.aEnd - b.aStart, bStart: b.bStart + 1, bLines: b.bEnd - b.bStart, removed: A.slice(b.aStart, b.aEnd).map(r => r.text), added: B.slice(b.bStart, b.bEnd).map(r => r.text) }, '');
    await w.end(); return 1;
  }
  let out = '';
  if (!unified) {
    for (const b of bl) {
      const del = b.aEnd > b.aStart, ins = b.bEnd > b.bStart; const cmd = del && ins ? 'c' : del ? 'd' : 'a';
      out += `${del ? range(b.aStart, b.aEnd) : String(b.aStart)}${cmd}${ins ? range(b.bStart, b.bEnd) : String(b.bStart)}\n`;
      for (const r of A.slice(b.aStart, b.aEnd)) out += `< ${r.text}\n${noeol(r)}`;
      if (del && ins) out += '---\n';
      for (const r of B.slice(b.bStart, b.bEnd)) out += `> ${r.text}\n${noeol(r)}`;
    }
  } else {
    out += `--- ${labels[0] ?? na}\n+++ ${labels[1] ?? nb}\n`;
    const groups: Block[][] = []; for (const b of bl) { const g = groups.at(-1); if (g && b.aStart - g.at(-1)!.aEnd <= 2 * ctxN) g.push(b); else groups.push([b]); }
    for (const g of groups) {
      const a0 = Math.max(0, g[0]!.aStart - ctxN), a1 = Math.min(A.length, g.at(-1)!.aEnd + ctxN); const b0 = g[0]!.bStart - (g[0]!.aStart - a0), b1 = g.at(-1)!.bEnd + (a1 - g.at(-1)!.aEnd);
      const rng = (s: number, e: number) => e - s === 0 ? `${s},0` : e - s === 1 ? `${s + 1}` : `${s + 1},${e - s}`;
      out += `@@ -${rng(a0, a1)} +${rng(b0, b1)} @@\n`;
      let ai = a0, bi = b0;
      for (const b of g) {
        while (ai < b.aStart) { out += ` ${A[ai]!.text}\n${noeol(A[ai]!)}`; ai++; bi++; }
        for (; ai < b.aEnd; ai++) out += `-${A[ai]!.text}\n${noeol(A[ai]!)}`; for (; bi < b.bEnd; bi++) out += `+${B[bi]!.text}\n${noeol(B[bi]!)}`;
      }
      while (ai < a1) { out += ` ${A[ai]!.text}\n${noeol(A[ai]!)}`; ai++; }
    }
  }
  await ctx.out.write(out); await w.end(); return 1;
}
