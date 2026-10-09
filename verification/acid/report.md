# ACID, isolation and invariant verification

**Status: PASS** — 57/57 tests passed, 0 failed, 0 skipped; 176 recorded cases, 0 case failures.

Run at 2026-10-09T14:25:44.356Z, 172.0 s. Commit: b85357df1b947ff7e26765eb8fcaf9081ff8a691.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: 1000, 8919, 16838, 24757, 32676, 40595, 48514, 56433, 64352, 72271, 80190, 88109, 96028, 103947, 111866, 119785, 127704, 135623, 143542, 151461, 159380, 167299, 175218, 183137, 4010, 4050

Reproduce: `npm run build && node --test --test-reporter=tap --test-concurrency=1 dist/tests/acid/fault-matrix.test.js dist/tests/isolation/multiprocess.test.js dist/tests/isolation/lock-fairness.test.js dist/tests/fuzz/state-machine.test.js dist/tests/storage.test.js dist/tests/durability.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | fault matrix: put and patch × every fault point × kill / EIO / ENOSPC recover atomically in a fresh process |
| PASS | fault matrix: delete (tombstone) and ingest (original + manifest) × every fault point × kill |
| PASS | torn journal tail (simulated partial write) is discarded, committed records survive, and writing continues |
| PASS | repeated kills during recovery itself still converge |
| PASS | view replacement denied (EACCES) after the commit point: the commit stays durable and the view is rebuilt |
| PASS | pre-authorization failure and rejected input leave no state behind |
| PASS | actual process death recovers committed journal and removes dead writer lock |
| PASS | independent processes serialize writes and optimistic conflict does not erase inputs |
| PASS | filesystem retrieval survives index removal and does not require rg or sqlite |
| PASS | future object-store contract supports immutable writes and CAS without rename |
| PASS | state machine seed 1000: invariants hold after every step and restart |
| PASS | state machine seed 8919: invariants hold after every step and restart |
| PASS | state machine seed 16838: invariants hold after every step and restart |
| PASS | state machine seed 24757: invariants hold after every step and restart |
| PASS | state machine seed 32676: invariants hold after every step and restart |
| PASS | state machine seed 40595: invariants hold after every step and restart |
| PASS | state machine seed 48514: invariants hold after every step and restart |
| PASS | state machine seed 56433: invariants hold after every step and restart |
| PASS | state machine seed 64352: invariants hold after every step and restart |
| PASS | state machine seed 72271: invariants hold after every step and restart |
| PASS | state machine seed 80190: invariants hold after every step and restart |
| PASS | state machine seed 88109: invariants hold after every step and restart |
| PASS | state machine seed 96028: invariants hold after every step and restart |
| PASS | state machine seed 103947: invariants hold after every step and restart |
| PASS | state machine seed 111866: invariants hold after every step and restart |
| PASS | state machine seed 119785: invariants hold after every step and restart |
| PASS | state machine seed 127704: invariants hold after every step and restart |
| PASS | state machine seed 135623: invariants hold after every step and restart |
| PASS | state machine seed 143542: invariants hold after every step and restart |
| PASS | state machine seed 151461: invariants hold after every step and restart |
| PASS | state machine seed 159380: invariants hold after every step and restart |
| PASS | state machine seed 167299: invariants hold after every step and restart |
| PASS | state machine seed 175218: invariants hold after every step and restart |
| PASS | state machine seed 183137: invariants hold after every step and restart |
| PASS | 60 contenders: every one acquires, in FIFO order of arrival, with bounded waiting |
| PASS | CPU oversubscription (2x cores of busy processes plus 40 contenders): zero lock timeouts |
| PASS | a waiter killed with SIGKILL, and a frozen (SIGSTOP) waiter, do not block the queue |
| PASS | a lock holder killed mid-critical-section is reclaimed and the queue continues |
| PASS | 10 independent processes: no lost acknowledged write, unique IDs, ordered revisions, zero lock timeouts |
| PASS | 50 independent processes: no lost acknowledged write, unique IDs, ordered revisions, zero lock timeouts |
| PASS | read-modify-write on one shared object with retry: every acknowledged update survives (no silent lost update) |
| PASS | same expected revision from 8 processes: exactly one winner, the rest CONFLICT, and no input is lost from history |
| PASS | concurrent readers never observe a torn document or half-written frontmatter |
| PASS | stale lock recovery: killed holder, lock without owner file, torn owner file; live holder still excludes |
| PASS | symlink swap race: concurrent directory↔symlink flipping never makes a write land outside the vault |
| PASS | cross-scope operations: unauthorized access fails without mutation, promotion is one atomic commit that never touches the source |
| PASS | accepted revisions survive updates, restore, tombstone and rebuild |
| PASS | two writers with same expected revision produce one conflict |
| PASS | crashes before journal create orphans, crashes after journal recover committed view |
| PASS | torn last journal record is ignored and removed before next commit |
| PASS | import preserves binary and text bytes, source manifest rejects mutation |
| PASS | external edits are versioned and stale editors preserved in quarantine |
| PASS | backup restores revisions and purge erases originals, history and caches |
| PASS | local object store immutable put and pointers reject traversal and symlinks |
| PASS | named root profiles are versioned and cannot be replaced by a second object |
| PASS | watcher and periodic reconciliation import external current-view edits |
| PASS | doctor reports runtime SQLite and unavailable model dependent capabilities honestly |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Power-cut durability (hardware/VM) | SIGKILL keeps the OS page cache, so it cannot prove fsync ordering. The protocol (file fsync, link, directory fsync incl. newly created parents, journal fsync) is implemented and inspected, but no power cut was performed. |
| NOT_RUN | fsync failure semantics (EIO from fsync itself) | EIO/ENOSPC are injected at named stages around the fsync points, not returned by a failing fsync syscall (needs an injectable filesystem adapter or dm-error/FUSE). |
| UNSUPPORTED | Real short writes and disk-full ENOSPC | Simulated by stage faults and by appending partial journal records; no fault-injecting filesystem was used. |
| UNSUPPORTED | Per-workspace write parallelism | A single vault-wide writer lock serializes all writes. Independent workspaces do not run in parallel (documented design limit). |
| NOT_RUN | 100-process mixed workload | 10 and 50 process runs executed; 100 not run. |
| NOT_RUN | Linearizability history checker | Histories are recorded and checked for lost updates, conflicts and revision order; no real-time-order checker is claimed. Isolation claim: serialized writes per vault (single lock) with optimistic expected-revision conflict detection; reads are lock-free and see whole committed revisions. |
| NOT_RUN | Linux ext4 run | Only macOS/APFS was available. |
| UNSUPPORTED | Network/shared filesystems, multi-host | mkdir-based lock and link/rename semantics are only assumed on local filesystems. |

## Limitations

- Commit point: the journal record is appended and fsynced. Unacknowledged transactions that passed the commit point may appear after recovery (tested and documented); transactions before it never do.
- Orphan revisions from pre-commit crashes are reported by recover() and retained, never presented as commits.
- Fuzz uses an in-repo seeded PRNG rather than fast-check to avoid a new dependency; failures print a replayable seed.
- The symlink-swap race is narrowed (verified-open of temp files) but not eliminated: Node has no openat().
