// Turns raw samples into the comparison report (Markdown + JSON). Ratios are computed only when both sides are CORRECT/equivalent; everything else is labeled.
import { promises as fs } from 'node:fs';
const label = process.argv[2] ?? 'baseline-before'; const outName = process.argv[3] ?? 'competitive-100k-baseline'; const out = 'verification/performance';
const run = JSON.parse(await fs.readFile(`${out}/raw/${label}-samples.json`, 'utf8')); const get = (w, s) => run.rows.find(r => r.workload === w && r.system === s);
const f = n => n === undefined || n === null || Number.isNaN(n) ? '-' : n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 10 ? 1 : 2);
const cell = r => r?.stats ? `${f(r.stats.p50)} / ${f(r.stats.p95)} / ${f(r.stats.p99)}` : (r?.status === 'NOT_EQUIVALENT_OR_UNSUPPORTED' ? 'n/a' : '-');
const ratio = (a, b) => a?.stats && b?.stats ? a.stats.p95 / b.stats.p95 : null;
const names = [...new Set(run.rows.map(r => r.workload))]; const table = [];
for (const w of names) {
  const sh = get(w, 'shell-topk'), fl = get(w, 'shell-floor'), fs_ = get(w, 'engram-fs'), sq = get(w, 'engram-sqlite'), pb = get(w, 'sqlite-fts-hydrated'), cf = get(w, 'engram-cli-fs'), cs = get(w, 'engram-cli-sqlite');
  const ok = r => r && (r.status === 'CORRECT'); const pbEq = pb?.equivalentToProductAnswer && ok(pb);
  table.push({ workload: w, shellTopK: sh?.stats, shellFloor: fl?.stats, engramFs: fs_?.stats, engramSqlite: sq?.stats, purposeBuiltSqlite: pb?.stats, engramCliFs: cf?.stats, engramCliSqlite: cs?.stats,
    status: { shellTopK: sh?.status, shellFloor: fl?.status, engramFs: fs_?.status, engramSqlite: sq?.status, purposeBuiltSqlite: pb?.status, engramCliFs: cf?.status },
    speedupFsVsShellTopK_p95: ok(fs_) && ok(sh) ? sh.stats.p95 / fs_.stats.p95 : null, speedupFsVsShellFloor_p95: ok(fs_) ? fl.stats.p95 / fs_.stats.p95 : null,
    speedupCliFsVsShellTopK_p95: ok(cf) && ok(sh) ? sh.stats.p95 / cf.stats.p95 : null,
    fsOverPurposeBuiltSqlite_p95: ok(fs_) && pbEq ? fs_.stats.p95 / pb.stats.p95 : null, fsOverEngramSqlite_p95: ok(fs_) && sq?.stats ? fs_.stats.p95 / sq.stats.p95 : null });
}
const md = [`# Competitive 100k baseline (${label})`, '', `Corpus ${run.corpusId}, 100,000 documents, ${run.iterations} measured + ${run.warmups} warmup iterations (slow workloads capped at ${run.slowIterations}). ${run.cacheNote}`, '', 'Latencies are wall milliseconds, **p50 / p95 / p99**. "Shell top-K" is the equivalent pipeline (rg candidates + awk scorer + sort + head for ranked workloads; sorted ids for unranked grep). "Shell floor" is the cheapest scan returning the unranked match set only. "Purpose-built SQLite" is an independent FTS5 trigram database returning title and a snippet-sized hydration for the same K; it cannot reproduce Engram\'s lexical ranking, so for keyword workloads it is a diagnostic, not an equivalent.', '',
  '| Workload | Shell top-K | Shell floor | Engram FS (in-process) | Engram SQLite (in-process) | Purpose-built SQLite | Engram CLI FS | FS vs shell top-K (p95) | FS / purpose-built (p95) |', '|---|---|---|---|---|---|---|---|---|'];
for (const t of table) md.push(`| ${t.workload} | ${cell({ stats: t.shellTopK })} | ${cell({ stats: t.shellFloor })} | ${cell({ stats: t.engramFs })} | ${cell({ stats: t.engramSqlite })} | ${cell({ stats: t.purposeBuiltSqlite })}${t.status.purposeBuiltSqlite === 'DIAGNOSTIC' ? ' (diag)' : ''} | ${cell({ stats: t.engramCliFs })} | ${t.speedupFsVsShellTopK_p95 ? t.speedupFsVsShellTopK_p95.toFixed(2) + 'x' : '-'} | ${t.fsOverPurposeBuiltSqlite_p95 ? t.fsOverPurposeBuiltSqlite_p95.toFixed(1) + 'x' : '-'} |`);
const wrong = run.rows.filter(r => r.status === 'WRONG'), err = run.rows.filter(r => r.status === 'ERROR');
md.push('', `Correctness: ${run.rows.filter(r => r.status === 'CORRECT').length} CORRECT, ${run.rows.filter(r => r.status === 'VALID_DIFFERENT_RANKING').length} valid with different (BM25) ranking, ${run.rows.filter(r => r.status === 'DIAGNOSTIC').length} diagnostic, ${run.rows.filter(r => r.status === 'NOT_EQUIVALENT_OR_UNSUPPORTED').length} unsupported, ${wrong.length} WRONG, ${err.length} ERROR.`, '', 'Every CORRECT row equals the independent oracle (`scripts/competitive/lib.mjs`), which itself equals Engram on all 12 workloads (full match sets and ranked top-K).');
await fs.writeFile(`${out}/${outName}.md`, md.join('\n') + '\n'); await fs.writeFile(`${out}/${outName}.json`, JSON.stringify({ label, createdAt: run.createdAt, corpusId: run.corpusId, iterations: run.iterations, warmups: run.warmups, cacheNote: run.cacheNote, environment: run.environment, table, wrong: wrong.map(r => `${r.workload}/${r.system}`), errors: err.map(r => `${r.workload}/${r.system}`) }, null, 2) + '\n');
console.log(md.join('\n'));
