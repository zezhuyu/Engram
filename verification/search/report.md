# Search correctness, parity, staleness, index recovery, bounded retrieval, BM25 ranking, optional semantic/hybrid

**Status: PASS** — 43/43 tests passed, 0 failed, 0 skipped; 36 recorded cases, 0 case failures.

Run at 2026-10-09T15:04:44.383Z, 62.1 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: 11, 4242, 90210

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/search.test.js dist/tests/search/golden.test.js dist/tests/search/optimized.test.js dist/tests/search/bounded.test.js dist/tests/search/semantic.test.js dist/tests/search/embedder.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | native lexical query preserves phrases, boolean operators, regex and filters |
| PASS | ACL applies before matches, graph references, context and pagination |
| PASS | SQLite parity and stale update/delete fallback preserve canonical results |
| PASS | generated navigation preserves authored content and canonical snippet lines |
| PASS | FTS trigram path preserves substring, short term and quoted punctuation parity |
| PASS | bounded retrieval equals scoring everything (hits, order, snippets, cursor) for common terms, phrases, regex, offsets and tiny/large limits |
| PASS | a frequent term with a small limit reads a small fraction of the matching documents; rare terms and large limits still read what they must |
| PASS | exact page boundary: with exactly `limit` matches there is no cursor, with one more there is |
| PASS | query engine pushes the page bound down to retrieval and returns the same rows |
| PASS | HTTP embedder: request shape, batching, ordering, retries with backoff, and strict response validation |
| PASS | HTTP embedder: timeouts, cancellation, redirects, oversize responses and transport errors are bounded and sanitized |
| PASS | createEmbedder / describeEmbedding: validation, defaults and key handling; nothing is built unless configured |
| PASS | end to end over real HTTP and the CLI: embed sync, semantic search, auto becomes hybrid, status and capabilities, keyword unaffected |
| PASS | golden corpus, SQLite OFF: every query returns exactly the authorized golden set and never private/tombstoned data |
| PASS | golden corpus, SQLite ON: every query returns exactly the authorized golden set and never private/tombstoned data |
| PASS | SQLite and filesystem return identical sets (and snippets) for every golden query |
| PASS | stale index: commits, edits and deletes after the last rebuild are never silently missing; health reports staleness |
| PASS | corrupt, truncated or deleted SQLite files: queries stay correct via fallback, rebuild restores the index, integrity checks pass |
| PASS | killing the process during an index rebuild leaves canonical data intact and the next rebuild succeeds |
| PASS | ACL is applied before counts, cursors and snippets on both backends |
| PASS | seed 11: ripgrep, raw-file scan and SQLite equal the full-corpus oracle (ids, revisions, lines, scores, snippets) |
| PASS | seed 4242: ripgrep, raw-file scan and SQLite equal the full-corpus oracle (ids, revisions, lines, scores, snippets) |
| PASS | seed 90210: ripgrep, raw-file scan and SQLite equal the full-corpus oracle (ids, revisions, lines, scores, snippets) |
| PASS | parsed immutable revisions carry exact LF/CRLF body offsets through Vault visibility |
| PASS | journal overlay: create, update, tombstone, purge and restore after the checkpoint are served correctly, lag is reported, sync converges to rebuild |
| PASS | damaged, foreign-format or inconsistent index databases degrade only their own scope, never correctness |
| PASS | authorization is evaluated per query: grants and revocations apply immediately, objects skipped earlier appear after a grant, outsiders see nothing |
| PASS | persisted manifest is only trusted when it provably belongs to this journal; damaged or foreign files are rebuilt, not believed |
| PASS | concurrent writers and readers: every committed document becomes findable, no reader errors, no unauthorized hit |
| PASS | killing the process during sync, rebuild or manifest save leaves canonical data intact and the next query correct |
| PASS | disabled by default: semantic and hybrid are unavailable, keyword/grep/regex/auto work, and the mode that ran is reported |
| PASS | semantic and hybrid REQUIRE the SQLite index: without it they are disabled even with an embedding provider, while keyword and grep stay fully functional |
| PASS | SQLite on but no vectors yet: not ready until "embed sync"; then semantic finds what no keyword shares; keyword matches are unaffected |
| PASS | hybrid fuses keyword and semantic rankings by reciprocal rank fusion; an exact keyword match is never suppressed; auto becomes hybrid when ready |
| PASS | regex and exact grep never touch the vector backend; keyword is lexical when SQLite is off, BM25 when on |
| PASS | ACL: semantic and hybrid never return unreadable objects, never let them influence ranking, and report lag only for readable objects |
| PASS | revision consistency: stale vectors are ignored and reported as lag, new text is found by keyword at once and by meaning after sync, deletes vanish |
| PASS | privacy: a remote embedding service never receives workspace text unless allowed; the skipped objects are counted, global knowledge is embedded |
| PASS | failure handling: embedding outage makes semantic/hybrid fail with a sanitized error, auto degrades to a labelled keyword result, partial sync leaves a consistent index, a model change never mixes vectors |
| PASS | immutability and cleanup: embedding and searching never change the journal or revisions; purge removes vectors |
| PASS | corrupt or foreign vector data is ignored, never trusted: garbage rows, wrong dimensions and a damaged database fall back to keyword with an honest status |
| PASS | query engine: semantic/hybrid/auto through the typed AST report the mode that ran; unavailable without the backend unless a labelled downgrade is requested |
| PASS | optional sqlite-vec acceleration returns the same ranking as the portable scan; when the extension is absent the portable scan is used and reported |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Index-backed retrieval at 100k documents | Building 100k documents through the fsynced commit protocol takes hours; 1k and 10k are measured. Bounded evaluation (tests/search/bounded.test.ts) reads a small fraction of matches for small pages; its effect at 10k/100k has NOT been re-measured since the change. |
| NOT_RUN | Semantic and hybrid retrieval quality with a real embedding model | Mechanics, ACLs, revision consistency, privacy and failure handling are tested with a deterministic concept embedder and a real local HTTP server speaking the OpenAI embeddings protocol. No real model was evaluated, so retrieval quality is not claimed. Semantic/hybrid exist only with SQLite enabled and a configured provider. |
| NOT_RUN | sqlite-vec acceleration | Run with ENGRAM_SQLITE_VEC pointing at the extension (passed once on macOS arm64 during development); otherwise the portable scan is used and tested. Neither path is an approximate index: both scan all accepted vectors. |
| NOT_RUN | Vector search at 100k documents | Brute-force scan cost grows linearly; no benchmark has been run (deferred by request). |
| NOT_RUN | WAL concurrent reader/writer/checkpoint stress | Databases use WAL; rebuild-kill and corruption cases ran, a dedicated concurrent checkpoint stress did not. |
| UNSUPPORTED | Ranking quality | Filesystem parity is exact. With SQLite, keyword results are ordered by FTS5 BM25 (reported as ranking: bm25): result sets, revisions, lines and snippets are compared with the oracle, the order is checked to follow the reported score, and no relevance-quality evaluation was done. |
| NOT_RUN | Files edited outside the API during search | Covered for reconciliation (storage tests); not combined with search in this suite. |

## Limitations

- Filesystem and SQLite engines were compared on 19 golden queries over ASCII, CJK, accents, emoji, punctuation, code fences, frontmatter lookalikes, duplicate titles, tombstones and permission boundaries.
- Both modes run the full golden corpus; the --no-sqlite functional suite is the default configuration of every other suite.
