// Aggregates a .cpuprofile: self time per function and per source group. Usage: node analyze-cpuprofile.mjs file.cpuprofile [top]
import { readFileSync } from 'node:fs';
const prof = JSON.parse(readFileSync(process.argv[2], 'utf8')); const top = Number(process.argv[3] ?? 12);
const byId = new Map(prof.nodes.map(n => [n.id, n])); const self = new Map(); const dt = prof.timeDeltas;
for (let i = 0; i < prof.samples.length; i++) self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + (dt[i] ?? 0));
const group = url => !url ? '(native/idle)' : url.startsWith('node:') ? 'node internals' : url.includes('/node_modules/') ? 'node_modules' : /dist\/packages\/([^/]+)/.exec(url)?.[0]?.replace('dist/', '') ?? /dist\/scripts/.exec(url)?.[0] ?? 'other';
const fn = new Map(), grp = new Map(); let total = 0;
for (const [id, us] of self) { const n = byId.get(id); const f = n.callFrame; const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`; fn.set(key, (fn.get(key) ?? 0) + us); const g = group(f.url); grp.set(g, (grp.get(g) ?? 0) + us); total += us; }
const fmt = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => ({ name: k, selfMs: Math.round(v / 1000), pct: Number((100 * v / total).toFixed(1)) }));
console.log(JSON.stringify({ totalMs: Math.round(total / 1000), byGroup: fmt(grp), topFunctions: fmt(fn) }, null, 1));
