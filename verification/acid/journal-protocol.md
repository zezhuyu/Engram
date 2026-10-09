# Commit and recovery protocol (as implemented and verified)

Scope of a transaction: one logical operation (`put`, `patch`, `delete`, `restore`, `ingest`, `promote`) inside one vault. It creates exactly one immutable revision (ingest also one content-addressed original), appends one journal record, and republishes one head pointer and one current view. No API accepts several scopes, so cross-workspace atomic transactions do not exist; an operation that would span scopes (promotion) commits only to the target scope and never touches the source.

## Sequence (`Vault.commit`, under the vault writer lock)

| Step | Action | Fault points |
|---|---|---|
| 1 | Validate input, ACL, expected revision, idempotency key | `commit.before_revision` |
| 2 | Serialize revision, write temp file, **fsync file**, `link()` into `.mdb/objects/<id>/revs/<rev>.md` (no-replace), **fsync directory**; newly created parent directories are also synced up the tree (`mkdirDurable`) | `revision.temp_written`, `revision.temp_synced`, `revision.after_link`, `revision.after_dirsync` |
| 3 | Append one JSON line (with SHA-256 of the revision bytes) to `.mdb/events/commits.jsonl` | `journal.before_append`, `journal.after_append_before_fsync` |
| 4 | **fsync the journal — the COMMIT POINT** | `journal.after_fsync` |
| 5 | Replace `.mdb/heads/<id>.json`, then the current view, each via temp + fsync + rename + directory fsync | `head.before_replace`, `atomic.temp_written`, `atomic.before_rename`, `atomic.after_rename`, `view.before_replace`, `view.after_replace` |
| 6 | Acknowledge | `commit.before_ack` |

There is no separate intent record: before step 4 nothing is committed, so an intent would add no information. Equivalence argument: a crash before step 4 leaves at most an unreferenced revision file (an orphan) and temp files; a crash after step 4 leaves a complete revision and journal record, and only derived projections (head, view) may be missing.

## Visibility rules
- A record is committed iff it is a newline-terminated, parseable journal line with the next contiguous `sequence`. An unterminated tail is a torn write and is ignored by every reader and truncated by the next writer or `recover()`.
- Readers decide visibility from the journal, never from views, so a reader that never runs recovery already sees whole transactions only.
- Classes: **PRE** (before step 4: never visible), **AMBIG** (written but not yet fsynced: may or may not survive, but never partially), **POST** (after step 4: always visible after recovery, even if the caller received an error).

## Recovery (`Vault.recover`, owner only, under the lock)
1. Truncate a torn journal tail.
2. Finish interrupted purges.
3. For every object's latest committed record: check the revision file against the journal's SHA-256, repair the head and current view from the revision (a stale view that equals an older committed revision is replaced without quarantine; any other differing view is quarantined first), then sweep stray `*.tmp` files.
4. Report orphan revisions (retained, never presented as commits).
Recovery is idempotent: the second run repairs nothing and the on-disk state hash is identical (tested, including repeated SIGKILL during recovery itself).

## Locking
`mkdir`-based writer lock holding the owner PID. A lock is stale if the owner PID is dead, or if its owner file is missing/torn and the lock directory is idle for 2 s. Reclaiming is serialized by a guard directory and re-checks staleness. Live owners are never reclaimed. Waiters poll every 10 ms for up to 10 s, then fail with `CONFLICT`. There is no fairness guarantee. PID reuse after a reboot could make a dead owner look alive until the lock times out.

## Known guarantees not claimed
- Power-loss durability (protocol inspected, never power-cut tested).
- Filesystems without atomic `link`/`rename` or honest `fsync`; network filesystems; several hosts sharing one vault.
- Per-workspace write parallelism.
