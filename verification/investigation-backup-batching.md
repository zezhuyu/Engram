# Investigation: backup / restore batching

**Finding (before):** each of ~3 files per object was written through `atomicWrite` (temp file, fsync, rename, fsync of the directory), one at a time. At 1k documents (3,054 files): backup 24.9 s, restore 34.6 s; at 10k (30,174 files): backup 274 s, restore 382 s. The writer lock was held for the whole copy.

**Change (durability not relaxed):** destination files are created exclusively (`wx`), written, and **fsynced individually**; each destination directory is fsynced **once** (children before parents) instead of after every file; files are copied by 16 concurrent workers; a `BACKUP_MANIFEST.json` (path, size, SHA-256 of every file) is written, fsynced and renamed into place **last**. A backup without a matching manifest is incomplete by construction. `Vault.verifyBackup` and `restoreBackup` check presence, size and SHA-256 of every file, reject unexpected files and unsafe manifest paths, then run the journal/revision verification, then recover. Restore copies with the same batching.

**Measured at 1k (same machine):** backup 24.9 s → 6.7 s (3.7×); restore 34.6 s → 15.4 s (2.2×; restore additionally hashes every file and verifies the journal). **At 10k (30,175 files, 117 MB):** backup 274 s → 68 s (4.0×); restore 382 s → 155 s (2.5×) (`verification/benchmarks/10k.json`).

**Evidence** (`tests/backups/backup-restore.test.ts`): backup under a live writer equals a committed prefix; missing manifest, extra file, same-length edit of a revision, path traversal in the manifest, and a backup killed mid-copy are all refused; sources, ACLs, tombstones and profile revisions survive.

**Why not faster:** per-file fsync is the cost; skipping it would make a backup look complete while data may not be on disk, so it was kept. Possible further gains that keep the guarantee: copy-on-write clones (`clonefile` on APFS, `FICLONE` on btrfs/xfs) followed by one fsync pass, or a tar-like single-file container (one fsync). Neither was implemented.

**Limits:** backups are still full copies under the writer lock (writers wait for the copy); no incremental backup; a backup taken before a purge keeps the purged plaintext (documented retention limit).
