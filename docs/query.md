# Query engine (v1)

`mdb query --json '{AST}'`, `Engram.queries.run(ast)`, MCP `mdb_query`. Read-only, ACL-bound, bounded.

## AST
`{ version:1, from, scope?, search?, where?, orderBy?, pipe?, limit?, cursor? }` plus shorthand `groupBy`/`aggregate`/`select`, and `where:{keyword:"x"}`.
Sources: `documents | observations | wiki | insights | discoveries | edges | saved` (`saved` + `saved:"name"`).
Scope: `{workspace, collection, includeShared}`. With a workspace, shared knowledge (wiki/shared/discoveries) is included unless `includeShared:false`; without scope, everything the principal may read. An unreadable workspace behaves exactly like one that does not exist.
Search: `{mode: exact|keyword|regex|auto|semantic|hybrid, text}`. Semantic/hybrid fail with `CAPABILITY_UNAVAILABLE` (no embedding provider); `allowDowngrade:true` returns keyword results labelled as such in `fallback`.

## Operators (all families of the RFC)
- Document/lines: `cat read readLines range` (documents → lines; 1-based, CRLF→LF, original byte range kept, lines over 1,000,000 chars truncated and flagged).
- Text (lines): `head tail cut grep regex sed replace split trim`. `cut` counts Unicode code points (`bytes` explicit; may split a character). `sed` subset: `[addr]s/re/repl/[gi]`, `[addr]d`, `-n;` + `[addr]p`, addresses `N`, `N,M`, `$`, `/re/`; anything else is rejected. Regex: JavaScript, conservative rules (no nested quantifiers/backreferences/lookaround, one repetition operator), evaluated on the first 8 KiB of each line — not RE2.
- Filter: `where`/`filter`, `and or not eq ne gt gte lt lte in contains exists isNull`. Comparisons with null/missing are false (including `ne`); `exists` = present; `isNull` = explicit null. `in` may take a subquery.
- Order/page: `sort` (explicit `nulls`, `collation`; ties break by id), `reverse limit offset head tail cursor`. Default order: id ascending (relevance for search). `tail(n)` keeps a ring of n rows.
- Projection: `select project pluck rename`. Aggregates: `count sum avg min max group distinct uniq` (`count(*)` counts all rows, `count(f)` skips null/missing; sum/avg reject non-numbers unless `coerce`). `distinct` is global and bounded; `uniq` only drops adjacent duplicates.
- Relational: `join` (inner/left/semi/anti, explicit keys, null never matches; right fields get prefix `right_`), `lookup`, `union unionAll intersect except` (set semantics except `unionAll`). Each side is authorized independently.
- Memory: `recent latest timeline before after between session`. Times are ISO 8601 with offset, normalized to UTC; `after` inclusive, `before` exclusive, `between` half-open unless `inclusive:true`. `recent` = eventTime desc, id asc.
- Graph: `references backlinks related traverse` (+`edges:true`, `from:"edges"`). Edges exist only between two readable objects; traversal is bounded by depth, nodes and graph budget and tracks cycles.
- `explain` (`--explain`, `mdb_query_explain`): stages, pushed-down fields (never values), blocking stages, warnings, authorized candidate estimate. No document is read.

## Budgets
`deadlineMs`, `maxRows`, `maxBytes`, `maxBufferRows`, `maxDocuments`, `maxGraphNodes`, `maxDepth`; MCP callers may only tighten them. Over-budget → `RESOURCE_LIMIT` (never silent truncation, except the explicit `truncated: rows|bytes` page cut with a cursor). Errors: `QUERY_INVALID CAPABILITY_UNAVAILABLE SCOPE_DENIED RESOURCE_LIMIT SNAPSHOT_EXPIRED INDEX_STALE CANCELLED`.

## CLI
`query`, `cat ID`, `grep PAT --path ID`, and stdin transforms `head tail cut sed trim split replace uniq distinct sort reverse select pluck count sum avg min max` (JSONL or plain lines in; `--format table|json|jsonl|text`; default jsonl when piped). `grep` without `--path`/`--stdin` is still the index search. These aliases never read the vault when fed by stdin and never run a shell.
`mdb query save NAME --scope S --file F`, `mdb query capabilities`.

## Performance
Metadata, time, graph and aggregate queries use the manifest (no Markdown read). Text search uses the existing ripgrep/FTS5 path; `contains body` becomes a text prefilter. Stats report `candidates`, `documentsRead`, `searchDocumentsLoaded`, `firstRowMs`. Benchmarks: `verification/query/benchmarks/`.
