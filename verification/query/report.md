# Typed query AST engine: operators, CLI/SDK/MCP parity, reference fuzz, security, recovery (QG1-QG5)

**Status: PASS** — 78/78 tests passed, 0 failed, 0 skipped; 74 recorded cases, 0 case failures.

Run at 2026-10-09T03:17:04.694Z, 32.6 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: 7000, 7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009, 7010, 7011, 7012, 7013

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/query/operators.test.js dist/tests/query/vault.test.js dist/tests/query/parity.test.js dist/tests/query/fuzz.test.js dist/tests/query/security.test.js dist/tests/query/recovery.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | fuzz seed 7000: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7001: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7002: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7003: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7004: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7005: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7006: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7007: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7008: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7009: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7010: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7011: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7012: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz seed 7013: random ASTs equal the reference interpreter for three principals, filesystem and SQLite |
| PASS | fuzz: queries racing with committed writes never mix revisions and never return an unreadable row |
| PASS | filters: comparison semantics, null vs missing, in/contains/exists/isNull, boolean nesting |
| PASS | unknown fields fail early with a structured error |
| PASS | null/missing semantics through records |
| PASS | sort: explicit null policy, stable ties, descending, multi-key |
| PASS | head/tail/limit/offset edge cases and sort+tail equivalence |
| PASS | uniq removes adjacent duplicates, distinct removes global duplicates |
| PASS | aggregates: count(*) vs count(field), typing, empty input, coercion |
| PASS | select/pluck/rename and type errors |
| PASS | lines: cat/readLines/range, CRLF, no trailing newline, Unicode, byte ranges, empty documents |
| PASS | cut: code points by default, bytes explicitly, ranges clipped and merged, fields |
| PASS | grep/regex/replace/trim/split/sed subset |
| PASS | regex safety: nested quantifiers, backreferences and lookaround are rejected before any work |
| PASS | time operators: after is inclusive, before exclusive, between half-open (or closed on request), recent/latest tie-break |
| PASS | join: inner/left/semi/anti, null keys never match, duplicate keys multiply, lookup takes the first match |
| PASS | set operations: union, unionAll, intersect, except with duplicates |
| PASS | subqueries: `in` with a nested query is evaluated once with the same snapshot |
| PASS | graph: references, backlinks, related, traverse (cycles, depth, node caps, edge types) |
| PASS | the engine never trusts the source: unordered supersets that ignore filters give the same answers |
| PASS | scope: workspace + shared defaults, collection narrowing, includeShared:false |
| PASS | budgets: row cap with cursor, byte cap, buffer cap on blocking operators, deadline, cancellation |
| PASS | early termination: head stops reading documents |
| PASS | saved queries: resolved through the source, refinements compose, cycles are rejected |
| PASS | explain: stages, pushdown and warnings without reading documents |
| PASS | derived text prefilter: contains body becomes a search request, and results are still exact |
| PASS | validator: unknown keys (including a forged principal), depth, size and strictness |
| PASS | capabilities: semantic and hybrid are declared unavailable with a reason |
| PASS | forged principal in the execution context is refused |
| PASS | every operator family returns the same rows through SDK, CLI and MCP |
| PASS | ACL parity: MCP under a restricted host identity equals the SDK under the same identity |
| PASS | MCP: structured errors, forged principal and unknown keys are rejected, tightening-only budgets, explain and capabilities |
| PASS | CLI: stream aliases compose through pipes and match the AST; formats; explain; saved queries; exit codes |
| PASS | cursor paging through CLI: stderr carries the cursor, a second call continues |
| PASS | kill at journal.before_append: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree |
| PASS | kill at revision.after_dirsync: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree |
| PASS | kill at journal.after_append_before_fsync: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree |
| PASS | kill at journal.after_fsync: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree |
| PASS | kill at head.before_replace: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree |
| PASS | kill at view.before_replace: after recovery every acknowledged commit is queryable, nothing partial is, and cat/search agree |
| PASS | killing a process mid-query leaves the vault untouched and the next query correct |
| PASS | derived state damage: deleted, truncated or foreign manifest and SQLite files give correct answers, never silently incomplete ones |
| PASS | writer processes racing with a querying process: no query ever misses an acknowledged commit that preceded it |
| PASS | ranking and scores of readable rows do not depend on hidden documents; hidden titles never appear in errors |
| PASS | paths: traversal strings and absolute paths are plain values, never file reads |
| PASS | symlink swap: a revision file replaced by a link to outside content is never served |
| PASS | malicious YAML in a stored revision cannot crash the engine or leak; other rows still answer |
| PASS | resource abuse: huge lines, oversized sorts, wide joins and deep graphs stay inside budgets |
| PASS | saved queries cannot carry a principal, code, or unsafe regex; a saved query cannot widen scope beyond the reader |
| PASS | cursor tampering: edited, replayed on another query, or forged cursors are refused |
| PASS | the query layer holds no write path: the AST has no operator that writes, and the journal is untouched by a hostile battery |
| PASS | sources, scope defaults, collection narrowing and metadata projections come from the manifest (no document is read) |
| PASS | search modes: exact, keyword, regex and auto go through the index-backed engine, with transparent backend info |
| PASS | semantic and hybrid: CAPABILITY_UNAVAILABLE unless a labelled downgrade is explicitly requested; lexical results are never mislabelled |
| PASS | hydration is pinned to the snapshot revision and counted |
| PASS | search sees commits after the snapshot consistently: edited, created and deleted objects |
| PASS | filesystem and SQLite give the same rows for the same queries (and the files path works with SQLite disabled) |
| PASS | ACL: an agent sees only its workspace and wiki; a stranger sees nothing; no counts, scores, snippets or edges leak |
| PASS | ACL changes take effect on the next query (grant and revoke), cursors are bound to the principal and query |
| PASS | forged identity: the principal cannot be supplied in a query or context |
| PASS | graph over a real vault: references resolve titles, traversal respects readability at every hop |
| PASS | observations: recent/timeline/session/between agree with the memory recall API |
| PASS | saved queries are versioned objects: saved through Vault, readable under ACL, refinable |
| PASS | read-only: running queries never writes to the journal or canonical objects |
| PASS | indexed queries do not materialize the corpus: documents read is proportional to the answer |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | QG6: 100K benchmark | See verification/query/benchmarks/: 1K and 10K are measured; a 100K corpus takes over an hour to build through the fsynced commit protocol. Recorded as NOT_RUN unless verification/query/benchmarks/100k.json exists. |
| UNSUPPORTED | Semantic and hybrid search | No embedding provider exists. Capability negotiation is tested (CAPABILITY_UNAVAILABLE, labelled keyword downgrade only on request); real semantic retrieval is not implemented. |
| UNSUPPORTED | SQL pushdown of metadata, time and graph operators | SQLite accelerates text search only (FTS5/trigram via the existing engine). Metadata, time and graph operators run on the journal-synced manifest, which is in memory and file-only; they are not SQL. |
| UNSUPPORTED | Spill to disk for sort/group/distinct/join | Blocking operators are bounded by maxBufferRows and fail with RESOURCE_LIMIT rather than spilling. |
| UNSUPPORTED | Linear-time regex (RE2) | JavaScript RegExp with conservative pattern rules and an 8 KiB per-line window; documented in docs/query.md. |
| NOT_RUN | Query execution on Linux | All results were produced on macOS/APFS. |
| UNSUPPORTED | Resumable cursors across commits | A cursor is bound to the journal sequence; after any commit it fails with SNAPSHOT_EXPIRED unless allowCursorDrift is requested (then results may shift). |
| NOT_RUN | Integration with the final retrieval-optimizer branch | Developed in an isolated copy (Engram-query) against the retrieval code as it stood at copy time. Merge into the main tree and re-running verify:all is pending. |

## Limitations

- Search-backed queries pin every returned row to the snapshot revision and re-verify objects that changed after the snapshot, but the text index itself is read at its own checkpoint.
- Semantics of default ordering: id ascending for non-search queries, relevance for search; any other order must be requested.
