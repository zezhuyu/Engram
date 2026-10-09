# Durability + S3/PostgreSQL Integration Verification

Date: 2026-10-09
Branch: `integration/durability-s3-postgres`
Integration commit: `05590eefca9ba2d396664af0146851f6dfdbc354`

## Source revisions and workspace state

| Source | Branch | Commit used | Status when inspected |
|---|---|---|---|
| Agent C | `feature/s3-postgres-backends` | `b85357df1b947ff7e26765eb8fcaf9081ff8a691` | Clean |
| Agent B | `durability/power-loss` | `fc2ce18d5071a75566bf7e91a379a93db9cc1e75` | Dirty; committed branch merged, local edits left untouched |

Common ancestor: `755252c32832641d83a4b36b3ebf5784085b5c9c`. Agent C's preserved commits are `58f89190567cdc16e84b9efae82842d001877280`, `546bf3edda69e7b74db4cd298e0baad636a0e669`, and `b85357df1b947ff7e26765eb8fcaf9081ff8a691`. Agent B's merged commits are `f36d14d9826bf8e83ffd443de554c4fdd1e90dbb` and `fc2ce18d5071a75566bf7e91a379a93db9cc1e75`.

The new integration branch was created from Agent C's HEAD and merged Agent B's full committed branch with a two-parent merge commit. The expected conflict was limited to `packages/core/vault.ts`. Its resolution retains the local journal/fsync protocol and S3 conditional-head protocol as separate commit paths. Agent B's uncommitted source and evidence changes were not merged automatically or modified. Relevant missing fault coverage was added on the integration branch.

Agent A's active branch/worktree was not merged, changed, or used as a source.

## Architecture and compatibility decisions

- Markdown revisions and the committed journal remain authoritative. Filesystem and SQLite remain the defaults; S3 and PostgreSQL are explicitly configured alternatives.
- Local commits become durable at the complete newline-terminated journal record followed by successful journal fsync. Revision bytes and containing directories are synced before journal publication. Recovery truncates a torn tail, removes temporary revision files, and reconstructs projections from committed records.
- S3 revisions and journal records are immutable objects. The commit point is conditional publication of `_commit-head.json`; immutable revisions and the journal record exist before that pointer can reference them. Competing writers use conditional object writes and revalidate the current revision. A retry recognizes the already committed transaction/idempotency key. Unreferenced uploads remain orphans and are not visible as commits.
- S3 does not provide or claim local rename/fsync durability. The backend requires conditional `PutObject` and strongly consistent `GET`/`HEAD` after `PUT`; provider behavior outside S3Mock was not verified here.
- Recovery compares generated local views on the local filesystem even when canonical reads come from S3. This prevents every remote-backed recovery from falsely treating local projections as missing and makes repeat recovery idempotent.
- PostgreSQL remains a disposable search projection. Its full-text ranking, optional pgvector semantic/hybrid search, ACL filtering, revision/tombstone handling, and rebuild path read canonical committed records. Search fallback and unavailable-service behavior do not change canonical commit success semantics.
- The four backend combinations were exercised: local filesystem + SQLite in the default parity/recovery suites; local filesystem + PostgreSQL in the PostgreSQL suites; S3 + SQLite and S3 + PostgreSQL in new live cross-backend tests.

## Changes included in the merge commit

- Resolved `packages/core/vault.ts` while preserving both durability paths. Added the missing `journal.after_append_before_fsync` point to the local journal path and a deterministic partial journal append point. Recovery reads generated local views locally when canonical objects are remote.
- Hardened `packages/storage-local/index.ts` cleanup so partially written temporary revisions and atomic-write files are removed after interrupted/error paths. Added deterministic partial revision writes for fault injection.
- Added partial-write and partial-journal crash cases to the fault matrix and durability suite.
- Added S3+SQLite and S3+PostgreSQL live tests covering recovery, index rebuild, revision identity, ACLs, and tombstones.
- Serialized the live backend test command to avoid service/test contention.
- Kept the original Agent B durability evidence and Agent C `verification/phase-11.md`; this report and the integration QEMU evidence are separate artifacts.

The merged implementation/evidence diff from the common ancestor contains these paths:

```text
README.md
docs/architecture.md
docs/search.md
docs/storage-format.md
package-lock.json
package.json
packages/cli/index.ts
packages/core/types.ts
packages/core/vault.ts
packages/sdk/index.ts
packages/search-files/index.ts
packages/search-postgres/index.ts
packages/search-sqlite/index.ts
packages/storage-local/index.ts
packages/storage-s3/index.ts
tests/acid/fault-matrix.test.ts
tests/acid/power-loss-durability.test.ts
tests/postgres-search.test.ts
tests/s3.test.ts
verification/acid/report.json
verification/acid/report.md
verification/durability/ack-ledger.jsonl
verification/durability/commit-protocol.md
verification/durability/fault-points.json
verification/durability/report.json
verification/durability/report.md
verification/durability/vm-results.jsonl
verification/durability/vm/README.md
verification/durability/vm/agent.mjs
verification/durability/vm/fsync-eio.c
verification/durability/vm/kernel-fsync-eio-result.json
verification/durability/vm/run-kernel-fsync-eio.sh
verification/durability/vm/run-powercuts.sh
verification/live-backends/README.md
verification/live-backends/compose.yaml
verification/phase-11.md
verification/recovery/report.json
verification/recovery/report.md
verification/release-report.json
verification/release-report.md
```

## Verification evidence

All commands ran serially in the integration worktree. `npm ci` completed with 0 reported vulnerabilities.

| Command / check | Result |
|---|---|
| `npm run lint` | PASS; 158 TypeScript files, 0 failures |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run verify` | PASS; 282 passed, 0 failed, 12 skipped |
| `npm run verify:release` | BETA; no GA claim. Storage, memory, user intelligence, wiki, dream, query, Unix, intelligence, and platform gates passed; performance gate remains incomplete. |
| `npm run test:reliability` | PASS; 57/57 tests, 0 skipped. Includes partial revision/journal writes, recovery, backup/restore, fuzz, and multiprocess isolation. |
| `npm run verify:acid` | PASS; 57/57 tests, 176 cases |
| `npm run verify:recovery` | PASS; 4/4 tests, 4 cases |
| `npm run test:backends:live` with disposable services | PASS; 12/12, 0 skipped |
| Isolated QEMU power-cut runner | PASS; 3/3: `revision.temp_written`, `journal.after_fsync`, `commit.before_ack` |
| Isolated guest-kernel fsync EIO runner | PASS; Node received `EIO`, injected FUSE kernel callback confirmed, recovery verification true |

`npm run verify`'s 12 skips were not counted as passes: six live backend cases require the disposable services, two PostgreSQL cases require PostgreSQL, two real-model tests require explicit model configuration, and two GNU tool checks require unavailable `gawk`/GNU `sed`. The live backend command then ran with S3Mock and PostgreSQL 17/pgvector and passed all 12 tests, including conditional concurrent S3 writers, ambiguous acknowledgments/retry, interrupted upload visibility, PostgreSQL indexing/ranking/ACL filtering, pgvector semantic/hybrid retrieval, and the cross-backend recovery/rebuild tests.

The QEMU tests ran against a task-specific overlay clone of the dedicated Alpine VM disks on port 2235. The source VM and Agent B's worktree were left untouched. Results and the matching acknowledgment ledger are preserved in `qemu-powercuts.jsonl` and `qemu-ack-ledger.jsonl`; the kernel injection result is in `kernel-fsync-eio.json`.

The previously reported missing `journal.after_append_before_fsync` hook is now present and exercised by the fault matrix and the QEMU journal boundary case. The previously reported Remote Capture drain-lock `ENOENT` was not reproduced: the complete capture tests and full verification passed. No Remote Capture implementation changes were made for it.

## Remaining limitations and verdict

- Physical power removal and volatile-cache loss remain untested; QEMU SIGKILL is a guest-crash simulation over host-managed qcow2 storage.
- S3Mock is the only live object-store provider used here. AWS S3 and MinIO compatibility claims still require provider-specific runs.
- The release gate is BETA. 100k-scale correctness/performance benchmarks and performance budgets remain not run/incomplete.
- Real-model tests were skipped. pgvector live retrieval used the configured deterministic embedding test provider.
- The S3 conditional-head protocol and filesystem fsync protocol have different durability guarantees; callers must not interpret S3 publication as POSIX fsync.

**Integration verdict: ready for subsequent integration with Agent A after review. Not GA-ready.** No known combined-branch test failures remain. The earlier transient S3+recovery assertions were from stale compiled output and passed after rebuilding; they are not counted as failures in the final live run.
