# ADR 0005 — Typed query AST, CandidateSource and read snapshots

Status: accepted for the isolated `Engram-query` worktree; merge pending.

## Decision
- One validated, versioned AST (`packages/query/ast.ts`) is the only query form. CLI aliases, the SDK (`Engram.queries`) and MCP (`mdb_query`, `mdb_query_explain`, `mdb_query_capabilities`) all build it. The validator rejects unknown keys everywhere, so a forged `principalId` is an error. The principal is always the Vault's trusted actor.
- Retrieval is reached through `CandidateSource` (`packages/query/backends/candidates.ts`). It returns manifest-level rows pinned to a snapshot revision; the engine re-applies every filter, so pushdown is an optimization, never a correctness dependency (tested with a source that returns unordered supersets).
- Snapshot = the journal sequence of the manifest after `sync()`, plus the ACL-readable scope set evaluated at open. Rows are read with `Vault.get(id, revision)` (pinned, live ACL re-check). Search results from the existing index-backed engine are accepted only when their revision equals the pinned one; objects changed after the snapshot are re-verified on the pinned revision with the shared scorer.
- Queries are read-only: no operator writes; saved queries are ordinary `saved_query` objects written with Vault CRUD.
- Cursors bind query hash, principal, snapshot sequence and expiry. A moved snapshot yields `SNAPSHOT_EXPIRED` (opt-in drift mode).

## Interface deviations from the RFC sketch
`revision` is a revision id string, not a number. `execute()` is an async generator; `run()` adds paging, budgets and stats. `limit` is the page size, a `limit` pipe step bounds the total.

## Consequences
SQLite only accelerates text search (through the existing engine). Blocking operators fail with `RESOURCE_LIMIT` instead of spilling. Semantic/hybrid return `CAPABILITY_UNAVAILABLE` unless a labelled downgrade is requested.
