import { MDBError } from '../core/types.js';

/**
 * GNU-style option parser for the supported subsets: clustered short flags (-inr), attached values (-n5, -d,), separate values (-n 5),
 * long options (--max-count=3 or --max-count 3), repeated options (-e A -e B), "--" ends options, "-" is an operand (stdin).
 * Unknown options fail with exit code 2 (usage) instead of being ignored.
 */
export interface OptSpec { /** short flag -> takes a value? */ short: Record<string, boolean>; /** long name -> short flag it aliases, or its own value-ness */ long: Record<string, string | boolean>; /** accept -NUM as -n NUM (head/tail) */ numeric?: string }
export interface Parsed { flags: Map<string, string[]>; operands: string[] }
export class UsageError extends MDBError { constructor(message: string) { super('INVALID_ARGUMENT', message); } }

export function parseOptions(argv: string[], spec: OptSpec): Parsed {
  const flags = new Map<string, string[]>(); const operands: string[] = [];
  const add = (k: string, v: string) => { const list = flags.get(k) ?? []; list.push(v); flags.set(k, list); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='); const name = a.slice(2, eq < 0 ? undefined : eq); let target = spec.long[name];
      if (target === undefined) { // unambiguous prefix, as GNU getopt_long allows
        const hits = Object.keys(spec.long).filter(l => l.startsWith(name)); if (hits.length === 1) target = spec.long[hits[0]!]; else throw new UsageError(`unrecognized option '--${name}'`);
      }
      const key = typeof target === 'string' ? target : name; const takes = typeof target === 'string' ? spec.short[target] === true : target;
      if (takes) { const v = eq >= 0 ? a.slice(eq + 1) : argv[++i]; if (v === undefined) throw new UsageError(`option '--${name}' requires an argument`); add(key, v); }
      else { if (eq >= 0) throw new UsageError(`option '--${name}' doesn't allow an argument`); add(key, ''); }
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(a)) { add(spec.numeric, a.slice(1)); continue; }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!; const takes = spec.short[c];
      if (takes === undefined) throw new UsageError(`invalid option -- '${c}'`);
      if (takes) { const rest = a.slice(j + 1); const v = rest.length ? rest : argv[++i]; if (v === undefined) throw new UsageError(`option requires an argument -- '${c}'`); add(c, v); break; }
      add(c, '');
    }
  }
  return { flags, operands };
}
export const has = (p: Parsed, k: string): boolean => p.flags.has(k);
export const last = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);
export const all = (p: Parsed, k: string): string[] => p.flags.get(k) ?? [];
export function count(value: string | undefined, what: string, fallback: number): number {
  if (value === undefined) return fallback;
  const m = /^([+-]?)(\d+)([kKmMbB]?)$/.exec(value); if (!m) throw new UsageError(`invalid ${what}: '${value}'`);
  const mult = { '': 1, k: 1024, K: 1024, m: 1048576, M: 1048576, b: 512, B: 512 }[m[3]!]!; const n = Number(m[2]) * mult; if (!Number.isSafeInteger(n)) throw new UsageError(`invalid ${what}: '${value}'`);
  return m[1] === '-' ? -n : n;
}
