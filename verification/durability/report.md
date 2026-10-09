# Power-Loss Durability — Verification Report

**Status: INCOMPLETE** — deterministic storage/crash checks pass; actual isolated VM or physical power-loss evidence is not available in this environment.

## Reproducible verification

Environment: Darwin 25.0.0 arm64, APFS, Apple M2 Max, Node v25.8.2, SQLite 3.53.4. Docker reports Docker Desktop Linux `overlayfs`; the VM is shared with other work and was not stopped.

Commands run from the isolated `durability/power-loss` worktree:

```sh
npm run lint && npm run typecheck && npm run test:reliability
node --test --test-reporter=tap --test-concurrency=1 dist/tests/storage.test.js dist/tests/durability.test.js dist/tests/search/golden.test.js
```

Results:

| Area | Result | Evidence |
|---|---|---|
| Lint and typecheck | PASS | 154 TypeScript files, 0 lint failures; `tsc --noEmit` succeeded |
| ACID, injected faults, recovery, isolation, fuzz, backups | PASS | 55/55 tests, 0 failures, 0 skipped; includes new deterministic fsync boundary tests |
| Storage, source immutability, SQLite-disabled retrieval, index corruption fallback | PASS | 22/22 tests, 0 failures, 0 skipped |
| Independent acknowledgment ledger after process death | PASS | A separately fsynced JSONL ledger outside the vault recorded one acknowledged write; after child `SIGKILL`, recovery found the journal event, revision bytes, and matching SHA-256 |
| Torn/truncated journal tails | PASS | Existing test exercises cuts at 1 byte, 10 bytes, half-record, and final-byte boundary; committed prefix remains and subsequent writing succeeds |
| Repeated crash during recovery | PASS | Existing fault suite kills recovery at repair stages, reruns recovery, and confirms identical final state |
| Missing revisions and corrupt indexes | PASS | Backup verification refuses missing/corrupt revision data; golden search suite verifies corrupt/truncated/deleted SQLite fallback and rebuild |
| Abrupt isolated VM termination | NOT_RUN | Docker Desktop VM is shared; terminating it could interfere with concurrent work. No separate QEMU/Multipass VM was installed. |
| Actual physical power loss/device-cache loss | NOT_RUN | No isolated hardware power-cut setup was available; host filesystem was not subjected to destructive tests. |
| Kernel `fsync()` returning EIO / real short-write / ENOSPC | NOT_RUN | EIO/ENOSPC are injected before system calls; no FUSE or block fault-injection filesystem was available. |

The acknowledgment ledger uses a separate file outside the vault and is fsynced before terminating the child, but it resides on the same APFS filesystem. It is independent of the vault journal as a logical test oracle, not an independent physical-device witness.

## Fault coverage

The implementation exposes named hooks around immutable writes, file sync, directory sync, hard-link/rename publication, journal append and sync, view/head publication, journal-tail repair, and recovery. Existing tests cover SIGKILL, thrown EIO/ENOSPC/EACCES, torn tails, repeated recovery interruption, and acknowledged-write survival. New tests explicitly inject failures at revision file sync, revision directory sync, journal sync, head/view file and directory sync, and initialization directory sync.

See [fault-points.json](fault-points.json) for the tested and untested boundary inventory.

## Commit point and guarantee

The commit point is after a complete newline-terminated journal event has been appended and its `FileHandle.sync()` returns successfully. A precommit orphan revision is never visible as a committed document. A complete record whose sync has not completed is ambiguous: it may appear after a process failure, but it has not been acknowledged. After successful acknowledgment, recovery must retain the journal transaction and verify its immutable revision hash, assuming the filesystem honors file and directory sync and local hard-link/rename semantics.

Initialization now syncs the root and every newly created directory's parent, so the journal/revision tree is not acknowledged based solely on unsynced recursive `mkdir` entries. Full protocol details and platform caveats are in [commit-protocol.md](commit-protocol.md).

## Integration

This work is isolated in branch `durability/power-loss` at sibling worktree `/Volumes/sambigdisk1/code/Engram-durability`. The shared repository had no commits or refs, so this worktree was created as an orphan branch from a source snapshot. Once the shared baseline is committed, integrate the storage/test/documentation patch onto the parallel feature branch; an ordinary merge-base merge is unavailable until a common baseline commit exists.
