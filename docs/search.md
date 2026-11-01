# Search and context

The native filesystem adapter needs neither SQLite nor an `rg` executable. It reads actor-authorized canonical documents and excludes tombstones. Query modes are `grep`, `keyword`, `auto`, `semantic` and `hybrid`; `auto` is lexical. Explicit semantic search reports `CAPABILITY_UNAVAILABLE`. Hybrid does the same unless `allowFallback` is true, when the result explicitly reports lexical degradation.

## Lexical semantics

Grep is a case-insensitive literal substring by default, with optional case sensitivity or bounded regular expressions. Oversized/known-dangerous regex constructs are rejected; this guard is not a formal proof against all expensive regular expressions. Keyword mode supports quoted phrases, `AND`, `OR` and `NOT` using deterministic substring matching. Unicode text is matched using JavaScript case normalization. Ranking weights title/heading/body matches, with stable object/revision tie breaking; scores are not calibrated relevance probabilities.

SDK filters include scopes, kinds, tags, timestamps, history, limit and cursor. CLI exposes scope/workspace/collection, kinds, tags, limit/cursor, regex, case sensitivity and history. History access requires authority and reads immutable revisions. Snippets include exact revision IDs, object URIs, body line spans and nearest heading. Lines refer to the Markdown body, not frontmatter-inclusive disk line numbers. Numeric cursors are offsets, not stable snapshots during concurrent changes.

```bash
node bin/mdb.js grep 'literal text' --scope workspace:research --root ./my-vault
node bin/mdb.js grep '^## Evidence' --regex --root ./my-vault
node bin/mdb.js search '"source integrity" OR recovery' --mode keyword --tags storage --root ./my-vault
node bin/mdb.js search 'semantic idea' --mode hybrid --allow-fallback --root ./my-vault
```

## Optional SQLite

SQLite is dynamically imported from Node; it is not required for pure-file CRUD/retrieval. Enabled indexes live under `.mdb/indexes/`, with workspace databases and a global database. They include document metadata, FTS5 Unicode/prefix and trigram tables, edges and rebuild state, and use WAL. Authorized current rows are validated against canonical revision/title/body before retrieval. Safe queries use an authorized-ID-restricted union of trigram and Unicode61 MATCH/BM25 candidates. Shared native verification/scoring then preserves filesystem substring semantics and parity; returned scores are lexical weights, not raw BM25. Regex, short terms and negative-only branches scan authorized documents instead of losing recall. This design still checks canonical documents first; it is not a claim of avoiding all file reads or proven large-corpus speedup.

Missing/stale/unavailable indexes cause an explicit filesystem fallback, so a new revision is not silently omitted. History uses canonical files. `index rebuild` regenerates the optional tables and navigation; `index status` reports adapter health. A health object may reflect the last attempted operation, not a comprehensive proactive integrity scan. `verify` checks canonical data separately.

```bash
node bin/mdb.js index rebuild --root ./my-vault
node bin/mdb.js index status --root ./my-vault
```

## Optional PostgreSQL backend

Select PostgreSQL in `mdb.yaml` with `postgres: { enabled: true }` (or initialize with `mdb init --postgres`). The connection string is read from `MDB_POSTGRES_URL` by default; `postgres.connectionStringEnv` may name a different environment variable. Secrets are not stored in the vault config. `mdb index rebuild`, `mdb index sync`, and `mdb index status` use PostgreSQL when selected. The adapter creates `engram_documents` with a `simple`-dictionary `tsvector`, a GIN index, indexed scope/kind/time columns, tags and JSON metadata, and a journal sequence checkpoint. Owner searches catch the index up incrementally. A non-owner query whose index is stale, or any query during a database outage, uses canonical Markdown and reports the fallback. Search candidates are restricted to currently authorized object IDs before PostgreSQL results are materialized through `Vault.get` in batches of 48. Tombstones are removed during sync; revision mismatches are ignored.

PostgreSQL `keyword` mode uses `websearch_to_tsquery('simple', ...)` and `ts_rank_cd`; this is token-based database full-text behavior, not the filesystem engine's substring/Unicode parity contract. `grep`, regex, and history continue through the canonical filesystem search path. Tags, kinds, scopes, and time ranges are applied before results are returned. The index is disposable and can be rebuilt from the journal and Markdown revisions.

If the `vector` extension is available, the adapter also creates `engram_vectors`. Configure the existing `embedding.*` provider and run `mdb embed sync`; vectors are pinned to object/revision/model and stale rows are ignored or removed. Remote embedding providers do not receive private workspace content unless `embedding.allowPrivateContentToRemote` is enabled. `auto` uses hybrid retrieval when current vectors are available; explicit semantic search reports unavailable otherwise, and hybrid can use the labelled keyword fallback with `allowFallback`.

The integration test runs only when `MDB_TEST_POSTGRES_URL` points to a disposable PostgreSQL database. The adapter requires permission to create its tables and indexes; pgvector semantic retrieval additionally requires permission to install/use the `vector` extension.

## References, navigation and context

Links, backlinks and bounded related traversal expose authorized targets. Protected references are omitted rather than leaking their titles or snippets. Context composes retrieved evidence with revision citations and deduplication within a supplied budget. The token counter is deterministic/conservative rather than a model-specific tokenizer; it does not guarantee an identical count for every hosted model.

Navigation uses `MDB:GENERATED` marker blocks and preserves authored prose outside them. Rebuilding shared on-disk navigation is an owner maintenance action: its files are not separately filtered for every disk reader. Agent context must use the actor-bound SDK/MCP, not directly read owner navigation files. All indexing is a derivative; deleting indexes loses no accepted knowledge. Benchmarks and parity tests establish measured behavior, not a promise of streaming or large-corpus acceleration.

## Behavior contract (verified by `tests/search/golden.test.ts`)

Parity between the filesystem engine and SQLite means identical result *sets and snippets* for the modes below, not identical ranking.

| Aspect | Contract |
|---|---|
| `grep` | Literal substring over the body; case-insensitive unless `caseSensitive`; no Unicode normalization (`é` precomposed ≠ `e` + combining accent); regex only with `regex: true`, JavaScript dialect, verified against the text even when SQLite proposed candidates. Matches inside code fences and frontmatter-lookalike text count as body text. |
| `keyword` | Case-folded tokens split on any non-letter/non-digit (so `warm_cache` yields `warm` and `cache`); multiple terms are AND; `"quoted phrase"` requires adjacency; `NOT`/`OR` are supported; no stemming. |
| CJK | `grep` finds any substring. `keyword` terms made of CJK characters match as substrings on both engines (probe: `知识` matches `知识库管理`); there is no word segmentation. SQLite serves them through the trigram table where the term has three or more characters and through the scoped file scan otherwise (equal sets are asserted by the golden parity test). |
| Filters | `kinds`, `tags`, `scopes`, `since/until` apply before matching. Tombstoned objects are never returned (history only with `includeHistory`). |
| Authorization | Scope filtering happens before matching, counting, paging and snippet generation. The query text is never echoed with data. |
| Staleness | SQLite results are never served from an index that is behind the journal without reconciling or falling back; the response states the backend (`backend`, `fallback`). A corrupt, truncated or missing index database is replaced on `rebuild` and bypassed for queries. |
| Ranking | Deterministic scorer (title/heading, term coverage, bounded frequency). Not comparable to `bm25`. |
| Graph | `links`, `backlinks`, `related` operate on the authorized set only and are computed from one corpus load. |
| Retrieval architecture | No query loads all document bodies at once. Pipeline: journal catch-up of a derived **manifest** (`.mdb/indexes/manifest.v4.jsonl`, per-object scope/kind/title/tags/status/time/reference list; rebuilt from the journal when missing, damaged or from another journal) → live ACL check of each scope → metadata filter → text prefilter that returns a **superset** → authorized candidates are read through `Vault.get` in bounded batches of 48 (which re-checks authorization) → the shared scorer keeps only the requested ordered page plus its cursor offset. The output order, snippets, line mapping and cursor match the full-corpus oracle. |
| Filesystem prefilter | Owner and plain-ASCII terms: ripgrep receives an explicit bounded list of authorized current-head revision files. Otherwise a bounded raw-file scan of authorized head revisions only. Titles come from the manifest. `MDB_NO_RIPGREP=1` forces the scanner (ripgrep's Unicode case folding differs from JavaScript for special-casing such as dotted İ). Regex, negative-only and multi-line queries cannot be narrowed and read every authorized, metadata-matching document. |
| SQLite prefilter | Each database stores the journal sequence it covers. FTS5/trigram `MATCH` proposes ids; every object touched after that sequence is always a candidate (create, update, tombstone, restore), so a stale row cannot hide a newer revision. A missing, corrupt, truncated, old-format or self-inconsistent database degrades only its own scope to the raw-file scan, and the response carries `fallback`. `index.lagObjects` reports the overlay size. Terms shorter than 3 characters use the scan. `mdb index sync` re-indexes only touched objects; a lag above 256 objects auto-syncs for the owner. |
| Authorization | Evaluated per query from live ACL files, before any candidate is read; never cached across queries, so grants and revocations apply immediately. Objects skipped as unreadable are fetched when their scope becomes readable. |
| Cost | Candidate discovery and body reads are proportional to the candidates that survive the prefilter. Search streams those documents through bounded batches and retains only the ordered page window, but exact ranking still scores every candidate match. Terms that match many documents and regex queries therefore still read and score every candidate. Context keeps the byte budget bounded while assembling citations. See `verification/benchmarks/`. |

## Modes, ranking and the optional vector backend

| Mode | Path | Ranking | Needs |
|---|---|---|---|
| `grep` (exact text), `regex` | lexical, always | none (id order) | nothing |
| `keyword` | SQLite FTS5 + **BM25** when SQLite is selected; PostgreSQL `ts_rank_cd` when PostgreSQL is selected; otherwise canonical filesystem search | `bm25`, `ts-rank` or `lexical` | selected index is optional |
| `semantic` | vector similarity (cosine), best chunk per object, **no similarity threshold** | `similarity` | SQLite vectors or PostgreSQL pgvector + embedding provider + `mdb embed sync` |
| `hybrid` | keyword and semantic rankings combined by **reciprocal rank fusion** (k=60) | `rrf` | selected vector backend, embedding provider and `mdb embed sync` |
| `auto` (default) | `hybrid` when the vector backend is ready, otherwise `keyword` | as above | nothing |

The result always states what ran: `mode` (the mode that executed), `requestedMode` (present when it differs: auto became hybrid, or a hybrid request fell back), `ranking`, `fallback` (why a downgrade happened) and, for vector modes, `vector {backend, model, dimensions, lagObjects}`.
- Semantic and hybrid require an enabled vector backend and embedding provider. SQLite uses its optional index; PostgreSQL uses pgvector when the extension is available. Without vectors they are unavailable (`CAPABILITY_UNAVAILABLE` with the reason), `hybrid` with `allowFallback` returns labelled keyword results, and `auto` stays keyword. Keyword, grep and regex never require an embedding provider.
- Vectors live in the same per-scope SQLite files as FTS5 (`vec_chunks`, `vec_state`), pinned to (object, revision). A vector of a superseded revision is ignored and counted in `lagObjects`; hybrid still finds those objects by keyword. `mdb embed sync` embeds new revisions and removes stale vectors; a different embedding model purges the old vectors instead of mixing them. Everything is derived and disposable (purge wipes it).
- Fusion never drops an exact keyword match: both lists are kept in full (depth max(100, 5*(offset+limit)), up to 1000) and a keyword match can only be outranked. Hybrid/semantic paging is limited to the first 1000 results.
- Access control: candidate rows are restricted to objects the actor can read, at their current revision, before anything is ranked; returned hits are re-read through the Vault. Hidden objects change neither results nor scores, and lag counts only readable objects.
- Privacy: a `remote` embedding provider never receives workspace (private) text unless `embedding.allowPrivateContentToRemote` is true; skipped objects are counted by `embed sync`. Query text is sent to the provider for semantic modes.
- Optional `embedding.sqliteVec` (path, or `true` to use the `sqlite-vec` package / `ENGRAM_SQLITE_VEC`) runs the same cosine scan in C; if it cannot be loaded the JavaScript scan is used and reported (`vector.backend`).

```yaml
# mdb.yaml
sqlite: { enabled: true }
embedding:
  provider: ollama            # ollama | openai | openai-compatible | null (disabled)
  model: nomic-embed-text
  # baseUrl: http://127.0.0.1:11434/v1   apiKeyEnv: ...   allowNetwork: true (remote hosts)
  # autoHybrid: false         # keep auto lexical
```
Commands: `mdb embed status | sync [--max-objects N] | clear`, `mdb search Q --mode semantic|hybrid|keyword|grep`.

## Bounded evaluation
Keyword and grep retrieval keep only the best `offset + limit + 1` hits and stop reading candidate documents as soon as no unread candidate can enter that set (exact bound for the title part of the score from the manifest, maximum for the rest; exact BM25 ranks when the index supplies them). Results, order, snippets and the cursor are identical to scoring everything; frequent terms with small limits read a small fraction of their matches.
