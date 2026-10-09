import { queryError, type AggregateSpec } from '../ast.js';
import { comparator, compareValues, getField, type Row } from '../rows.js';
import type { Run } from '../runtime.js';

/** count(*) counts every row; count(field) skips null/missing. sum/avg need numbers (strings only with coerce:true); min/max need one comparable type. Empty or all-null input gives null (count gives 0). */
export interface Acc { add(row: unknown): void; result(): unknown }
function numeric(v: unknown, coerce: boolean, field: string): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw queryError('QUERY_INVALID', `Non-finite number in ${field}`); return v; }
  if (coerce && (typeof v === 'string' || typeof v === 'boolean')) { const n = typeof v === 'boolean' ? Number(v) : v.trim() === '' ? NaN : Number(v); if (Number.isFinite(n)) return n; }
  throw queryError('QUERY_INVALID', `Aggregate over "${field}" met a non-numeric value${coerce ? ' that could not be coerced' : ' (use coerce:true to convert numeric strings)'}`);
}
export function accumulator(spec: AggregateSpec): Acc {
  const f = spec.field; const read = (row: unknown) => f === undefined ? row : getField(row, f); const name = f ?? '(value)';
  switch (spec.op) {
    case 'count': { let n = 0; return { add: row => { if (f === undefined) n++; else { const v = read(row); if (v !== null && v !== undefined) n++; } }, result: () => n }; }
    case 'sum': case 'avg': { let sum = 0, n = 0; return { add: row => { const v = numeric(read(row), !!spec.coerce, name); if (v !== undefined) { sum += v; n++; } }, result: () => n === 0 ? null : spec.op === 'sum' ? sum : sum / n }; }
    default: {
      let best: unknown; let type: string | undefined;
      return { add: row => {
        let v = read(row); if (v === null || v === undefined) return;
        if (spec.coerce && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
        if (typeof v !== 'number' && typeof v !== 'string') throw queryError('QUERY_INVALID', `${spec.op}(${name}) needs numbers or strings`);
        if (type && typeof v !== type) throw queryError('QUERY_INVALID', `${spec.op}(${name}) met mixed types`); type = typeof v;
        if (best === undefined || (spec.op === 'min' ? compareValues(v, best) < 0 : compareValues(v, best) > 0)) best = v;
      }, result: () => best === undefined ? null : best };
    }
  }
}
export async function* single(input: AsyncIterable<any>, spec: AggregateSpec, as: string, run: Run): AsyncGenerator<Row> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const acc = accumulator(spec); for await (const row of input) { run.check(); acc.add(row); } yield { [as]: acc.result() };
}
export async function* group(input: AsyncIterable<any>, fields: string[], aggregates: Record<string, AggregateSpec>, run: Run): AsyncGenerator<Row> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const groups = new Map<string, { key: Row; accs: Record<string, Acc> }>();
  for await (const row of input) {
    run.check();
    const keyValues = fields.map(f => { const v = getField(row, f); return v === undefined ? null : v; });
    const k = JSON.stringify(keyValues); let g = groups.get(k);
    if (!g) { g = { key: Object.fromEntries(fields.map((f, i) => [f, keyValues[i]])), accs: Object.fromEntries(Object.entries(aggregates).map(([n, s]) => [n, accumulator(s)])) }; groups.set(k, g); run.buffer(groups.size, 'group'); }
    for (const a of Object.values(g.accs)) a.add(row);
  }
  const out = [...groups.values()].map(g => ({ ...g.key, ...Object.fromEntries(Object.entries(g.accs).map(([n, a]) => [n, a.result()])) }));
  if (!fields.length && !out.length) out.push(Object.fromEntries(Object.entries(aggregates).map(([n, s]) => [n, accumulator(s).result()])));
  out.sort(comparator(fields.map(field => ({ field, dir: 'asc' as const, nulls: 'last' as const })), '\u0000'));
  for (const row of out) yield row;
}
