# Live S3/PostgreSQL integration tests

These tests use disposable Adobe S3Mock and PostgreSQL 17 with pgvector. Compose binds both services to loopback and uses tmpfs for data; do not point the tests at a shared or production bucket/database. S3Mock exercises live HTTP requests and conditional object operations, but it is a mock implementation: passing here does not establish compatibility with a particular MinIO, AWS S3, or other provider deployment, nor does it test that provider's durability behavior. Run the same opt-in S3 suite against a disposable bucket on each supported target service before deployment.

```sh
docker compose -f verification/live-backends/compose.yaml up -d --wait
MDB_TEST_S3_ENDPOINT=http://127.0.0.1:19000 \
MDB_TEST_S3_CONFIRM=disposable \
MDB_TEST_S3_ACCESS_KEY=test \
MDB_TEST_S3_SECRET_KEY=test \
MDB_TEST_POSTGRES_URL=postgres://engram_test:engram_test@127.0.0.1:15432/engram_test \
MDB_TEST_PGVECTOR=1 \
npm run test:backends:live
docker compose -f verification/live-backends/compose.yaml down
```

The S3 tests create a uniquely named bucket per test and delete it in teardown. They exercise competing Vault writers, a stale-revision conflict, an immutable upload whose success response is lost, a journal record that remains invisible before head publication, a journal-head update whose response is lost, recovery, retry idempotency, and orphan detection. A failed request before S3 receives a single-part `PutObject` must leave no visible object; object stores must not expose partial `PutObject` bodies.

The PostgreSQL tests create/rebuild the disposable index, check FTS ordering and ACL filtering, incrementally apply a new revision, and verify rebuild convergence. When `MDB_TEST_PGVECTOR=1`, a deterministic local test embedder exercises semantic search and hybrid source fusion without network calls. The test confirms pgvector is available in the disposable database before running; otherwise it skips that case.

Run `docker compose ... down` even after an interrupted test run. `tmpfs` data disappears when the containers are removed. The PostgreSQL suite is destructive to the configured database because rebuild replaces the backend's index tables; use only the compose database or another explicitly disposable database.
