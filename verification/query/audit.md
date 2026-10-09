# Query capability audit (before this work, at copy time)

| Family | Before | Now | Source / test |
|---|---|---|---|
| Search exact/keyword/regex/auto | existing (`SearchEngine.query`, `grep` CLI, `mdb_search/mdb_grep`) | reused as the text-search backend | `packages/search-files`, `tests/search/*` |
| Semantic / hybrid | explicit CAPABILITY_UNAVAILABLE | unchanged, plus negotiation in query (labelled downgrade) | `tests/query/vault.test.ts` |
| Graph links/backlinks/related | existing (`SearchEngine.links/backlinks/related`) | re-exposed as `references/backlinks/related/traverse/edges`; parity-tested against the old API | `tests/query/vault.test.ts` (graph) |
| Memory recent/timeline/range | existing (`MemoryRecall`, `mdb memory`) | re-expressed as `recent/timeline/before/after/between/session` over the manifest | `tests/query/operators.test.ts`, `vault.test.ts` |
| Read files/lines (cat, range) | NOT present | new | `operators/text.ts` |
| head, tail, cut, grep (lines), sed subset, replace, split, trim | NOT present | new | `operators/text.ts` |
| Boolean filters, comparison, in/contains/exists/isNull | metadata filters only (kinds/tags/time) | new AST filters | `rows.ts`, `schema.ts` |
| sort, reverse, limit, offset, cursor | search limit/cursor only | new | `operators/sort.ts`, `execute.ts` |
| select/project/pluck/rename | NOT present | new | `operators/filter.ts` |
| count/sum/avg/min/max/group/distinct/uniq | NOT present | new | `operators/aggregate.ts`, `filter.ts` |
| join/lookup/union/unionAll/intersect/except | NOT present | new | `operators/relational.ts` |
| Subqueries, saved queries, explain | NOT present | new | `execute.ts`, `index.ts` |
| CLI/SDK/MCP | search/grep/context/links; memory tools | `query`, stream aliases, `Engram.queries`, `mdb_query*` | `tests/query/parity.test.ts` |

Unsupported by design (see report): semantic retrieval, spill-to-disk, RE2, SQL pushdown beyond text search.
