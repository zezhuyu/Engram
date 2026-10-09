# Durability commit protocol

## Canonical records and acknowledgment

Immutable revision Markdown and `.mdb/events/commits.jsonl` are canonical. The journal record includes the object and revision identifiers, path, scope, operation, and SHA-256 of the immutable revision bytes. Heads, current Markdown paths, SQLite, search indexes, and navigation are projections; recovery can rebuild those from the journal and revision files.

The transaction commit point is the successful return from `FileHandle.sync()` on the journal after the complete JSON record and its terminating newline have been appended. The newline is required for readers to parse a record. A complete record that is present but whose journal sync has not completed is ambiguous: it can be visible in the current process and may survive a crash, but the caller has not been acknowledged. A precommit revision can remain as an orphan and is never exposed as a committed document.

Before journal append, the writer serializes the document, writes a unique temporary file, syncs that file, hard-links it at its immutable revision name without replacement, then syncs the containing directory. Newly created directories are published by syncing each parent directory, including during vault initialization. The journal is then appended and synced. The writer publishes the head and current view with temp-file write, file sync, atomic rename, and containing-directory sync. The API returns successfully after both projections are published.

## Guarantee after successful acknowledgment

On a local filesystem that honors file and directory `fsync`, supports the required hard-link and rename semantics, and does not report directory sync as unsupported, a successfully resolved write has:

1. A complete immutable revision whose bytes match the journal SHA-256.
2. A newline-terminated committed journal record that was synced after append.
3. Durable directory entries for the revision and journal paths, including newly created directory parents.
4. Rebuildable head and current-view projections.

After restart, recovery reads the journal, verifies revision hashes and metadata, and repairs missing or stale heads/views. It does not make an orphan revision committed. A write that throws after the journal sync may still be committed; callers must use an idempotency key or inspect the journal before retrying.

These are conditional filesystem guarantees, not a claim that any particular hardware, controller, virtual disk, or hypervisor truthfully flushes volatile caches. The implementation intentionally tolerates `EINVAL`, `ENOTSUP`, or `EBADF` from directory sync on platforms that do not support it; on such a platform the directory-entry durability guarantee is not established.

## Recovery behavior

- Unterminated journal tail: ignored by readers and removed by `recover()` or the next writer before appending.
- Newline-terminated malformed or out-of-sequence event: rejected as journal corruption; recovery does not invent a commit.
- Missing or hash-mismatched committed revision: recovery fails closed; `verify()` reports the integrity failure.
- Missing/stale head or view: rematerialized from the latest committed immutable revision.
- Uncommitted immutable revision: retained and reported as an orphan; never listed as committed knowledge.
- SQLite/index corruption or removal: canonical Markdown/journal remain authoritative; index rebuild/fallback restores retrieval.
- Repeated interruption during repair: recovery is idempotent and converges to the same canonical/projection state.

## Evidence boundaries

The deterministic hooks and `SIGKILL` tests validate ordering and process-crash recovery. They do not discard the host kernel page cache and therefore do not prove power-loss persistence. The acknowledgment ledger is stored outside the vault and synced before child termination, but it shares the same host filesystem; it is logically independent evidence, not a separate-device witness. Docker Desktop is available, but its Linux VM is shared with other work and was not terminated. No isolated disposable VM, physical power cut, or actual device-cache loss was performed.
