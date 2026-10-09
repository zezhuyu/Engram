# Platform and filesystem edge cases

**Status: PASS** — 6/6 tests passed, 0 failed, 0 skipped; 6 recorded cases, 0 case failures.

Run at 2026-10-09T15:08:40.015Z, 2.2 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/platform/environment.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | vault under a path with spaces, Unicode, emoji and punctuation works end to end (write, search, backup, restore) |
| PASS | maximum-length identifiers produce valid long paths |
| PASS | mixed-case identifiers that would collide on case-insensitive filesystems are rejected |
| PASS | invalid UTF-8, NUL and control bytes: originals keep exact bytes; text paths never crash the parser |
| PASS | read-only vault: writes fail cleanly with no committed state, reads keep working |
| PASS | permission denied on the current-view directory after the commit point: commit stays durable and recover() repairs the view |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Linux (ext4) run of any suite | Only macOS/APFS hardware was available. Linux is not a supported release platform until the reliability lane passes there. |
| UNSUPPORTED | Windows | POSIX link/rename/fsync semantics and mkdir locking are assumed; never run. |
| NOT_RUN | Real disk-full (ENOSPC) on a full volume | ENOSPC is injected at stages; no small tmpfs/ramdisk was filled. |
| UNSUPPORTED | Network filesystems (NFS, SMB), multi-host shared volumes | Not designed for or tested on shared volumes. |
| NOT_RUN | Node versions other than the one run | Engines field requires >=22.13; only the version in the environment block was run. |

## Limitations

- Case-insensitive filesystem behaviour is verified by rejecting identifiers that differ only by case, on a case-insensitive APFS volume; a case-sensitive volume was not run.
