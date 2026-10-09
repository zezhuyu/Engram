# Backup, restore and disaster recovery

**Status: PASS** — 4/4 tests passed, 0 failed, 0 skipped; 4 recorded cases, 0 case failures.

Run at 2026-10-09T03:14:38.997Z, 9.0 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/backups/backup-restore.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | backup taken while a writer is running restores to a consistent committed prefix with sources, ACLs, tombstones and profiles intact |
| PASS | torn or corrupted backups are refused, never restored as if healthy |
| PASS | purge: removes content from the live vault; a pre-purge backup still holds it (documented retention limit) |
| PASS | manifest-checked backups: complete ones restore; missing manifest, extra files, edits and a backup killed mid-copy are all refused |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Restore on a different machine | Restores go to a fresh directory on the same host. |
| UNSUPPORTED | Hard-purge propagation into existing backups | A backup taken before a purge keeps the plaintext. This is tested and documented, not solved. |
| NOT_RUN | Backup cadence RPO/RTO policy | Restore wall time is measured on a small vault; no cadence is defined or scheduled. |
| UNSUPPORTED | Incremental backup | Backups are full copies under the writer lock. |

## Limitations

- Backups hold the writer lock, so a backup during writes is a consistent point but delays writers.
- A same-disk revision history is not a backup.
