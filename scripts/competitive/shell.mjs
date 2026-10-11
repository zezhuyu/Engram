// Shell pipelines for the 12 competitive workloads. Two variants per workload:
//   floor : the cheapest honest shell scan that returns the full MATCH SET (class A/C/E). Not ranked, so NOT equivalent to a ranked top-K answer; reported as a lower bound.
//   topk  : the shell pipeline that returns exactly the product's answer: unranked grep = first K object ids in id order; keyword = rg candidate set + an awk scorer
//           implementing the documented lexical formula + sort + head (class F). This is the equivalent comparison.
// Every pipeline writes its result to a file; the runner hashes it against the independent oracle. Nothing is piped to head early without Engram having the same freedom.
import { ripgrepPath } from './lib.mjs';
const RG = ripgrepPath();
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const RGF = `${q(RG)} --no-config --hidden --no-ignore -g '*.md' -g '!.mdb'`;
const IDS = `awk -F/ '{b=$NF; sub(/\\.md$/,"",b); print b}' | LC_ALL=C sort`;
// Scores candidate files (stdin: paths) with the documented keyword formula and prints "score<TAB>id" (sorted by caller).
const AWK_SCORE = `
function count(h, n,  c, i) { c = 0; while ((i = index(h, n)) > 0) { c++; h = substr(h, i + length(n)) } return c }
function flush(  lowtext, i, t, s, idx, heading, lines, lowline, ok) {
  if (id == "") return
  lowtext = tolower(title "\\n" body); s = 0
  n = split(body, lines, "\\n"); idx = 0
  for (i = 1; i <= n && !idx; i++) { lowline = tolower(lines[i]); for (t = 1; t <= nt; t++) if (index(lowline, term[t]) > 0) { idx = i; break } }
  if (idx == 0) idx = 1
  heading = ""
  for (i = 1; i <= idx; i++) if (lines[i] ~ /^#+[ \\t]/ && match(lines[i], /^#+/) && RLENGTH <= 6) { h = lines[i]; sub(/^#+[ \\t]+/, "", h); heading = h }
  for (t = 1; t <= nt; t++) { s += (index(tolower(title), term[t]) > 0 ? 5 : 0) + (heading != "" && index(tolower(heading), term[t]) > 0 ? 2 : 0); c = count(lowtext, term[t]); s += (c < 3 ? c : 3) }
  printf "%d\\t%s\\n", s, id
}
FNR == 1 { flush(); id = ""; title = ""; body = ""; infront = 1; first = 1 }
FNR == 1 { seenbody = 0 }
{ if (infront) { if (FNR == 1) next; if ($0 == "---") { infront = 0; next } if ($0 ~ /^id: /) id = substr($0, 5); else if ($0 ~ /^title: /) title = substr($0, 8); next } if (!seenbody) { body = $0; seenbody = 1 } else body = body "\\n" $0 }
END { flush() }
`;
const scoreCmd = terms => `xargs -n 500 awk -v nt=${terms.length} ${terms.map((t, i) => `-v 't${i + 1}=${t.replace(/'/g, '')}'`).join(' ')} ${q(`BEGIN { ${terms.map((_, i) => `term[${i + 1}] = tolower(t${i + 1})`).join('; ')} } ` + AWK_SCORE)}`;
const rank = k => `LC_ALL=C sort -t "$(printf '\\t')" -k1,1nr -k2,2 | head -n ${k} | cut -f2`;
export function plans(corpus, w) {
  const i = w.input, k = i.limit ?? 50, name = w.name; const T = i.query;
  const lit = t => `${RGF} -l -i -F -e ${q(t)}`;
  const sortedFiles = (cmd, f) => `${cmd} | LC_ALL=C sort > "$TMP/${f}"`;
  const and = (a, b, f) => `${sortedFiles(lit(a), 'a')}; ${sortedFiles(lit(b), 'b')}; comm -12 "$TMP/a" "$TMP/b" > "$TMP/${f}"`;
  const wrap = body => `cd ${q(corpus)} && ${body}`;
  const topkUnranked = floorIds => `${floorIds} | head -n ${k}`;
  let floor, topk, cls, note;
  const rankedFrom = (filesCmd, terms) => `${filesCmd}; cat "$TMP/cand" | ${scoreCmd(terms)} | ${rank(k)}`;
  switch (name) {
    case 'grep-rare': case 'grep-common': case 'grep-nonexistent': case 'grep-punctuation': case 'grep-cjk': {
      const ids = `${lit(T)} | ${IDS}`; floor = `${ids} > "$OUT"`; topk = `${topkUnranked(ids)} > "$OUT"`; cls = 'A (literal match) / unranked top-K by object id'; break; }
    case 'regex-anchored-alternation': {
      const ids = `${RGF} -l -i -e ${q(T.replace(/\\d/g, '[0-9]'))} | ${IDS}`; floor = `${ids} > "$OUT"`; topk = `${topkUnranked(ids)} > "$OUT"`; cls = 'B (regex) / unranked top-K'; note = 'JS \\\\d is ASCII digits: rewritten to [0-9] for rg'; break; }
    case 'keyword-single-rare': case 'keyword-phrase': {
      const term = T.replace(/^"|"$/g, '').toLowerCase(); floor = `${lit(term)} | ${IDS} > "$OUT"`;
      topk = `${lit(term)} > "$TMP/cand"; cat "$TMP/cand" | ${scoreCmd([term])} | ${rank(k)} > "$OUT"`; cls = 'A floor / F ranked top-K'; break; }
    case 'keyword-multi': {
      const [a, b] = T.split(/\s+/); floor = `${and(a, b, 'm')}; cat "$TMP/m" | ${IDS} > "$OUT"`;
      topk = `${and(a, b, 'cand')}; cat "$TMP/cand" | ${scoreCmd([a, b])} | ${rank(k)} > "$OUT"`; cls = 'C (AND) floor / F ranked top-K'; break; }
    case 'keyword-boolean-not': {
      floor = `${sortedFiles(lit('warm'), 'a')}; ${sortedFiles(lit('phrase'), 'b')}; comm -23 "$TMP/a" "$TMP/b" | ${IDS} > "$OUT"`;
      topk = `${sortedFiles(lit('warm'), 'a')}; ${sortedFiles(lit('phrase'), 'b')}; comm -23 "$TMP/a" "$TMP/b" > "$TMP/cand"; cat "$TMP/cand" | ${scoreCmd(['warm'])} | ${rank(k)} > "$OUT"`; cls = 'C (AND NOT) floor / F ranked top-K'; break; }
    case 'metadata-tag': {
      const tag = `${RGF} -l -U -P ${q(`\\ntags:\\n(?:  - [^\\n]*\\n)*?  - ${i.tags[0]}\\n`)} | LC_ALL=C sort > "$TMP/tag"`;
      floor = `${tag}; ${sortedFiles(lit(T), 'txt')}; comm -12 "$TMP/tag" "$TMP/txt" | ${IDS} > "$OUT"`;
      topk = `${tag}; ${sortedFiles(lit(T), 'txt')}; comm -12 "$TMP/tag" "$TMP/txt" > "$TMP/cand"; cat "$TMP/cand" | ${scoreCmd([T.toLowerCase()])} | ${rank(k)} > "$OUT"`; cls = 'E (frontmatter metadata) floor / F ranked top-K'; break; }
    case 'metadata-kind-scope': {
      const ws = i.scopes[0].workspaceId; const kind = `${RGF} -l -P ${q(`^kind: ${i.kinds[0]}$`)} workspaces/${ws} | LC_ALL=C sort > "$TMP/kind"`; const txt = `${RGF} -l -i -F -e ${q(T)} workspaces/${ws} | LC_ALL=C sort > "$TMP/txt"`;
      floor = `${kind}; ${txt}; comm -12 "$TMP/kind" "$TMP/txt" | ${IDS} > "$OUT"`; topk = `${kind}; ${txt}; comm -12 "$TMP/kind" "$TMP/txt" > "$TMP/cand"; cat "$TMP/cand" | ${scoreCmd([T.toLowerCase()])} | ${rank(k)} > "$OUT"`; cls = 'E (kind + path scope) floor / F ranked top-K'; note = 'scope is mapped to the workspace directory, which the corpus layout guarantees'; break; }
    default: throw new Error(`no shell plan for ${name}`);
  }
  return { class: cls, note, floor: wrap(floor), topk: wrap(topk) };
}
