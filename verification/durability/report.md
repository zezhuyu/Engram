# Power-Loss Durability — Follow-up Evidence

**Overall status: INCOMPLETE.** The isolated Linux VM crash scenarios and controlled kernel `fsync()` EIO propagation passed. Shared-baseline integration, post-integration regression runs, and physical power-loss validation remain unverified. This report does not claim full power-loss durability.

## Preserved branch and integration boundary

The deterministic implementation remains on `durability/power-loss` at `f36d14d`; follow-up evidence and repeatable VM harness files are being added on that branch. The patch was reviewed as seven changed paths: `packages/core/vault.ts`, `packages/storage-local/index.ts`, `tests/acid/power-loss-durability.test.ts`, and four files under `verification/durability/`. Its parent `755252c` is now a common ancestor with the S3/Postgres feature branch.

The shared main worktree still has no committed baseline and contains untracked repository files. The clean S3/Postgres branch now shares `755252c` as a common baseline with this branch. The full patch was reviewed with `git diff --name-status 755252c f36d14d` and `git diff --stat 755252c f36d14d` (seven paths; 250 insertions and 17 deletions). A read-only `git merge-tree 546bf3e f36d14d` preview reports a content conflict in `packages/core/vault.ts`, which both lines of work changed. No integration was performed, and neither worktree was overwritten. The integration owner must reconcile that file before running the required post-integration suite set.

## Deterministic regression evidence

Environment for the original deterministic run: Darwin 25 arm64 / APFS, Node v25.8.2.

```sh
npm run lint && npm run typecheck && npm run test:reliability
node --test --test-reporter=tap --test-concurrency=1 dist/tests/storage.test.js dist/tests/durability.test.js dist/tests/search/golden.test.js
```

Results on this branch after installing its locked dependencies with `npm ci`: lint and typecheck passed; reliability/ACID/isolation/fuzz/backup suite **55/55**; storage, recovery, immutability and search suite **22/22**. These are reruns on the durability branch, not post-integration results.

## Isolated Linux VM power-cut evidence

An Alpine Linux 3.24.2 ARM64 guest ran Linux `6.18.55-0-virt` with a dedicated 2 GiB ext4 data disk on a separate qcow2 virtual disk. QEMU 11.1.2 ran under macOS arm64 HVF. Each cut killed only this named QEMU guest process; Docker Desktop was never terminated. The separate guest disk was restarted and vault recovery ran after each cut.

Reproduce on the prepared host/VM setup:

```sh
VM_SSH_PORT=2222 verification/durability/vm/run-powercuts.sh
```

The harness writes `ACK` to an acknowledgment ledger outside the guest and fsyncs that host ledger before starting the next operation. It stops the VM when the target guest process reports its selected transaction boundary.

| Cut boundary | Acknowledged baseline | Candidate without caller acknowledgment | Recovery |
|---|---|---|---|
| `revision.temp_written` | Survived | Not visible; incomplete revision remained uncommitted | `verify()` true; second recovery unchanged |
| `journal.after_fsync` | Survived | Visible; full journal record had already synced | `verify()` true; projection repaired; second recovery unchanged |
| `commit.before_ack` | Survived | Visible; journal and projections completed before caller acknowledgment | `verify()` true; second recovery unchanged |

For each case, journal line count and SHA-256 were recorded; every current view was byte-equal to its immutable revision. Evidence is in [vm-results.jsonl](vm-results.jsonl), and independently persisted acknowledgment entries are in [ack-ledger.jsonl](ack-ledger.jsonl).

An unacknowledged transaction can be visible if its complete journal record crossed the durable commit point before the response was lost. This is an ambiguous outcome, not data loss, and callers must use idempotency keys or inspect state before retrying non-idempotent operations.

## Actual kernel `fsync()` EIO

The guest FUSE test filesystem returns `-EIO` from its `fsync` callback for `.mdb/events/commits.jsonl`. This is delivered through the Linux VFS/FUSE path to Node's actual `FileHandle.sync()` syscall, rather than thrown by an application fault hook.

```sh
VM_SSH_PORT=2222 verification/durability/vm/run-kernel-fsync-eio.sh
```

Result: **PASS** — Node received `EIO`; after unmount, recovery verified the vault and found the complete candidate journal record, repairing its view. This confirms that a kernel-visible `fsync` error is ambiguous: it does not establish that no journal bytes reached persistent storage. Structured output is in [kernel-fsync-eio-result.json](vm/kernel-fsync-eio-result.json); the controlled FUSE source is [fsync-eio.c](vm/fsync-eio.c).

## Durable commit point and guarantees

The storage commit point remains a complete newline-terminated journal append followed by successful `FileHandle.sync()`. Once acknowledged, the transaction is expected to survive recovery on filesystems that honor file and directory synchronization and the required local link/rename semantics. The guest VM tests show survival through the measured QEMU/ext4/virtio setup; they do not establish those filesystem or hardware assumptions generally.

Pre-journal revision files are not exposed as committed documents. A complete journal event with a lost/failed response can be visible after recovery. Recovery validates referenced immutable revision hashes, reconstructs current views and heads, and converged to a stable result across the repeated recovery checks in the VM cases.

## Gate results

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Deterministic injected faults and process crash recovery | **PASS** | Reliability 55/55; fault coverage in [fault-points.json](fault-points.json) |
| Storage, search, source immutability, SQLite-disabled fallback | **PASS** | 22/22 targeted tests |
| Abrupt isolated VM termination at selected transaction boundaries | **PASS** | Three ext4/QEMU cases in `vm-results.jsonl`; bounded to this virtual platform |
| Actual guest kernel `fsync()` EIO propagation | **PASS** | FUSE callback returned EIO; Node received EIO; recovery verified |
| Shared-baseline integration | **INCOMPLETE** | Common baseline exists, but `git merge-tree` reports a `packages/core/vault.ts` conflict requiring owner-led resolution |
| Post-integration storage/reliability/search/ACID/release verification | **NOT_RUN** | Must be rerun after owner resolves the integration conflict |
| Physical host power removal / volatile device-cache loss | **NOT_RUN** | No isolated power-cut rig or independently controlled device cache |
| Other filesystems, network filesystems, controllers, and hardware | **UNSUPPORTED** | No test evidence; no guarantee claimed |

See [report.json](report.json) for machine-readable status and exact environment detail. `INCOMPLETE` is the release status for this workstream. The VM result is useful crash evidence, but it is not proof of physical power-loss durability.
