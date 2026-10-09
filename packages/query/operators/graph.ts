import { queryError } from '../ast.js';
import type { Edge, GraphView } from '../backends/candidates.js';
import type { Row } from '../rows.js';
import type { Run } from '../runtime.js';

type S = AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const idOf = (row: unknown): string => { const id = (row as Row | null)?.id; if (typeof id !== 'string') throw queryError('QUERY_INVALID', 'Graph operators need document rows with an id'); return id; };
const edgeRow = (view: GraphView, from: string, to: string, type: string, extra: Row = {}): Row => { const a = view.node(from)!, b = view.node(to)!; return { fromId: from, toId: to, type, fromTitle: a.title, toTitle: b.title, fromPath: a.path, toPath: b.path, ...extra }; };

/** Objects (or edges) the inputs reference / that reference the inputs. Only edges whose two endpoints are readable at the snapshot exist in the view. */
export async function* neighbours(input: S, view: GraphView, dir: 'out' | 'in', types: string[] | undefined, asEdges: boolean, run: Run): AsyncGenerator<Row> {
  const seen = new Set<string>();
  for await (const row of input) {
    run.check(); const id = idOf(row);
    const list = dir === 'out' ? view.out(id).map(o => ({ type: o.type, other: o.to })) : view.in(id).map(o => ({ type: o.type, other: o.from }));
    for (const { type, other } of list) {
      if (types && !types.includes(type)) continue;
      const key = asEdges ? `${id}\0${other.id}\0${type}` : other.id as string; if (seen.has(key)) continue; seen.add(key); run.buffer(seen.size, 'graph result');
      yield asEdges ? (dir === 'out' ? edgeRow(view, id, other.id as string, type) : edgeRow(view, other.id as string, id, type)) : { ...other };
    }
  }
}

/** Breadth-first, bounded by depth and node count, cycle-safe by object id. Starting nodes are not emitted. */
export async function* traverse(input: S, view: GraphView, o: { edgeTypes?: string[]; direction: 'out' | 'in' | 'both'; maxDepth: number; maxNodes: number; edges: boolean }, run: Run): AsyncGenerator<Row> {
  const seen = new Set<string>(); const starts: string[] = [];
  for await (const row of input) { run.check(); const id = idOf(row); if (view.node(id) && !seen.has(id)) { seen.add(id); starts.push(id); } }
  let frontier = starts; let emitted = 0;
  for (let depth = 1; depth <= o.maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      run.check();
      const moves: Array<{ type: string; target: string; reverse: boolean }> = [];
      if (o.direction !== 'in') for (const x of view.out(id)) moves.push({ type: x.type, target: x.to.id as string, reverse: false });
      if (o.direction !== 'out') for (const x of view.in(id)) moves.push({ type: x.type, target: x.from.id as string, reverse: true });
      for (const m of moves) {
        if (o.edgeTypes && !o.edgeTypes.includes(m.type)) continue;
        if (o.edges) { if (emitted >= o.maxNodes) return; emitted++; yield m.reverse ? edgeRow(view, m.target, id, m.type, { depth }) : edgeRow(view, id, m.target, m.type, { depth }); }
        if (seen.has(m.target)) continue;
        if (seen.size - starts.length >= o.maxNodes) return;
        seen.add(m.target); next.push(m.target);
        if (!o.edges) { emitted++; yield { ...view.node(m.target)!, depth, via: m.type, fromId: id }; }
      }
    }
    frontier = next;
  }
}

/** related(): neighbours in either direction up to `depth` hops, nearest first, excluding the inputs. */
export async function* related(input: S, view: GraphView, depth: number, limit: number, run: Run): AsyncGenerator<Row> {
  const seen = new Set<string>(); let frontier: string[] = [];
  for await (const row of input) { const id = idOf(row); if (view.node(id) && !seen.has(id)) { seen.add(id); frontier.push(id); } }
  let count = 0;
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      run.check();
      const adjacent = [...view.out(id).map(o => o.to), ...view.in(id).map(o => o.from)].sort((a, b) => (a.id as string) < (b.id as string) ? -1 : 1);
      for (const node of adjacent) { const nid = node.id as string; if (seen.has(nid)) continue; seen.add(nid); next.push(nid); if (count >= limit) return; count++; yield { ...node, depth: level }; }
    }
    frontier = next;
  }
}
export async function* allEdges(view: GraphView, run: Run): AsyncGenerator<Row> { let i = 0; for (const e of view.edges() as Iterable<Edge>) { if ((++i & 255) === 0) run.check(); yield { ...e }; } }
