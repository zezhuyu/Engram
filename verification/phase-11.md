# Phase 11 — Optional S3 and PostgreSQL backends

Branch: `feature/s3-postgres-backends`

Base: `755252c32832641d83a4b36b3ebf5784085b5c9c`
Original implementation commits (preserved):

- `58f89190567cdc16e84b9efae82842d001877280` — Keep canonical revisions portable across optional backends
- `546bf3edda69e7b74db4cd298e0baad636a0e669` — Bound remote revision reads during batch listing

No merge into the shared branch has been performed. Agent B's durability changes are not integrated in this worktree.

## Changed paths

Original implementation paths relative to the base:

- `README.md`
- `docs/architecture.md`
- `docs/search.md`
- `docs/storage-format.md`
- `package-lock.json`
- `package.json`
- `packages/cli/index.ts`
- `packages/core/types.ts`
- `packages/core/vault.ts`
- `packages/sdk/index.ts`
- `packages/search-files/index.ts`
- `packages/search-postgres/index.ts`
- `packages/search-sqlite/index.ts`
- `packages/storage-s3/index.ts`
- `tests/postgres-search.test.ts`
- `tests/s3.test.ts`
- `verification/phase-11.md`

Verification follow-up adds `verification/live-backends/compose.yaml` and `verification/live-backends/README.md`, improves live coverage in `tests/s3.test.ts` and `tests/postgres-search.test.ts`, fixes `PostgresSearch` to honor its injected environment, and adds `test:backends:live` in `package.json`.

## Delivered

- S3-compatible storage keeps immutable revisions/originals, records SHA-256 integrity data, and publishes a hash-linked journal through conditional pointer writes. An immutable event record is not committed until the conditional head update succeeds; retries find committed transaction/idempotency records. The protocol does not depend on filesystem rename or fsync.
- S3 batch reads preserve key order and cap concurrent requests. Vault listing batches at most 48 revision reads; `readMany` defaults to concurrency 8 and rejects settings above 32.
- PostgreSQL provides FTS keyword ranking, incremental journal checkpointing, revision/tombstone handling, ACL-filtered materialization, metadata/time/tag/kind filtering, rebuild, optional pgvector retrieval, and hybrid fusion. Filesystem/SQLite remain the defaults. Grep and regex paths stay lexical.
- PostgreSQL configuration can be injected by environment; absent/unavailable PostgreSQL falls back to canonical filesystem search with an explicit fallback reason.

## Verification evidence (2026-10-09)

### Unit and local suite

- `npm run lint` — passed; 157 TypeScript files, 0 failures.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `env -u MDB_TEST_S3_ENDPOINT -u MDB_TEST_S3_CONFIRM -u MDB_TEST_POSTGRES_URL -u MDB_TEST_PGVECTOR node --test dist/tests/s3.test.js dist/tests/postgres-search.test.js` — 4 passed, 6 skipped, 0 failed. Skips are opt-in S3/PostgreSQL service cases; they are not counted as live passes.
- `npm run verify` — 280 passed, 10 skipped, 2 failed. The failures are `tests/memory/capture.test.ts` (“a drain also picks up events that were enqueued while it was working”; concurrent drain-lock `ENOENT`) and `tests/query/recovery.test.ts` (“kill at journal.after_append_before_fsync”; expected fault hook did not fire). This branch did not change capture logic or the fault-hook implementation. The latter is the Agent B durability boundary; the former needs recheck against the integrated Agent A baseline. Full-suite PostgreSQL/S3 cases were skipped because their opt-in environment variables were not set.

### Live service integration

- `docker compose -f verification/live-backends/compose.yaml up -d --wait` — both disposable services became healthy: Adobe S3Mock and PostgreSQL 17 with pgvector. The Compose setup binds to loopback and uses tmpfs.
- `MDB_TEST_S3_ENDPOINT=http://127.0.0.1:19000 MDB_TEST_S3_CONFIRM=disposable MDB_TEST_S3_ACCESS_KEY=test MDB_TEST_S3_SECRET_KEY=test MDB_TEST_POSTGRES_URL=postgres://engram_test:engram_test@127.0.0.1:15432/engram_test MDB_TEST_PGVECTOR=1 npm run test:backends:live` — 10 passed, 0 skipped, 0 failed.
- S3 cases covered competing independent writers and stale revision conflict; accepted revision upload with lost response and orphan discovery; pre-request interruption with no partial object; event record invisibility before head publication; lost head response, recovery of the committed view, and idempotent retry.
- PostgreSQL cases covered keyword FTS/ranking, ACL filtering, metadata index, incremental revision sync, tombstone exclusion, rebuild convergence, pgvector semantic retrieval, hybrid keyword/semantic fusion, and unavailable-service filesystem fallback.
- An initial live PostgreSQL attempt exposed that an injected `SearchEngine` environment was ignored for the connection string. `PostgresSearch` now honors that injected environment, and the live tests pass after the fix.

## Durability and compatibility limits

- S3's logical commit point is the conditional `_commit-head.json` update. Safety relies on the selected provider honoring conditional `PutObject` (`If-Match`/`If-None-Match`) and providing the consistency assumed by the implementation. S3 does not provide local filesystem `fsync` semantics; provider durability, replication, region behavior, and operational recovery are outside this protocol. No cross-region durability claim is made.
- Live S3 coverage used S3Mock, not MinIO, AWS S3, or another deployment target. It validates real HTTP/API behavior against the mock's supported conditional operations, not production provider compatibility or durability. Run the same suite against a disposable bucket on each intended provider.
- A lost immutable revision response can leave an uncommitted revision object; `recover()` reports it as an orphan. A journal record written before a lost head publication remains unreachable and invisible; no garbage collector for orphan journal records is implemented.
- Compatibility with Agent B's integrated crash-recovery/fault-hook protocol has not yet been tested. Re-run full verification and backend suites after their changes and the shared baseline are integrated; resolve interface conflicts before merging.
- PostgreSQL and S3 remain optional. Real credentials, policy permissions, service outages, and provider-specific conditional-write behavior require deployment testing. This milestone is not a GA readiness claim.
