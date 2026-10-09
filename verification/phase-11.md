# Phase 11 — Optional S3 and PostgreSQL backends

Branch: `feature/s3-postgres-backends`

## Delivered

- Added an S3-compatible canonical object store with immutable revision/original writes, SHA-256 metadata, CAS publication of a hash-linked commit journal, idempotent transaction lookup, and conditional metadata updates. The protocol uses S3 conditional PUT and strong read-after-write consistency; it does not rely on rename or fsync.
- Added optional PostgreSQL full-text indexing and ranking, incremental journal checkpointing, tombstone/revision handling, ACL-filtered materialization, tags/kind/time filtering, and optional pgvector semantic/hybrid search. Filesystem retrieval remains the fallback when PostgreSQL is unavailable; grep, regex, and history continue through the existing canonical search path.
- Exposed backend configuration through Vault, SDK, CLI, and documentation. Added mocked S3 protocol tests and PostgreSQL fallback/optional integration tests.

## Verification

- `npm run lint` — passed; 157 TypeScript files, 0 failures.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test dist/tests/s3.test.js dist/tests/postgres-search.test.js` — passed: 3 passed, 1 skipped. The PostgreSQL integration test requires `MDB_TEST_POSTGRES_URL` and was skipped.
- `npm run verify` — 280 passed, 5 skipped, 1 failed. The sole failure is the existing recovery fault-matrix test `kill at journal.after_append_before_fsync`; the hook is absent on this branch and is part of Agent B's durability work. The new S3 tests passed during this run.

## Limits

- No live S3-compatible service or PostgreSQL server was configured in this environment. S3 protocol behavior is verified with a conditional-operation mock; PostgreSQL connection failure/fallback is exercised, while live FTS/pgvector integration remains unverified.
- PostgreSQL and S3 credentials/configuration must be supplied by deployment environment. Bucket/database permissions and network availability are operational requirements.
- No merge or commit was performed. This work remains on the dedicated branch for later integration.
