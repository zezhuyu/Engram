# Storage format and recovery

The vault contains `mdb.yaml` configuration, access manifests, human-readable current document paths, original-source snapshots, and internal `.mdb` records. Objects carry a stable ID, a new revision ID for each accepted change, revision number, previous revision, scope, kind, title, timestamps, actor, tags, relations, evidence and metadata in YAML frontmatter followed by Markdown body. See `Document`, `PutInput` and `PatchInput` in `packages/core/types.ts` for the exact SDK field names. YAML parsing uses the `yaml` package; user content is data.

## Optional S3 canonical store

Set `MDB_STORAGE_BACKEND=s3`, `MDB_S3_BUCKET`, and optionally `MDB_S3_REGION` and `MDB_S3_PREFIX`. S3-compatible endpoints use `MDB_S3_ENDPOINT` and path-style requests. Credentials use the AWS SDK credential provider chain; secrets are not written to the vault. The endpoint must support conditional `PutObject` (`If-None-Match: *` and `If-Match`) and strongly consistent `GET`/`HEAD` after writes. Stores without those guarantees are unsupported because they cannot safely coordinate writers.

Markdown revisions and imported originals are immutable keys. The adapter records SHA-256 metadata and verifies existing immutable bytes on retry; Vault verification checks revision hashes from journal events and original hashes from source manifests. Commit events are immutable, hash-linked objects. `_commit-head.json` is the publication point and advances with an ETag compare-and-swap. Readers follow only the chain reachable from that head, so a request interrupted before head publication leaves an unreachable record rather than a partial commit. A retry with the same transaction/idempotency key returns the already published event. Concurrent writers reread the head and retry conditional publication; a conflicting revision is rejected.

S3 has no rename or fsync step in this protocol. The acknowledged commit is the successful conditional head update. Local current-view files, navigation, SQLite, and PostgreSQL remain materialized derivatives. Canonical reads fail visibly when S3 is unavailable; search may use the existing fallback only when the selected disposable index is unavailable. An authorized purge publishes a rewritten reachable journal chain before deleting superseded event records and object data; incomplete cleanup can be retried.

The principal internal stores are:

```text
.mdb/
  objects/<object-id>/revs/<revision-id>.md  immutable revision bytes
  heads/                                  regenerable current pointers
  events/commits.jsonl                     committed journal records
  locks/                                  local writer coordination
  indexes/                                disposable SQLite databases
  intelligence/<actor-hash>.json           actor's jobs, cursor and proposals
```

Current document paths are views, not independent sources of truth. Do not edit `.mdb/objects`, journal records or source originals. Imported originals are copied into a scope's `sources/originals/<sha256>/` area; the external input is left untouched. Binary attachments are preserved, with extraction marked unsupported instead of inventing text. Restore creates another revision; deletion creates a tombstone and preserves history.

## Commit ordering

Vault serializes writers with a local lock directory. It validates identity/scope and optimistic revision expectations, durably writes the immutable revision, records the committed journal event, then atomically replaces its head/current view. The local store writes temporary files with exclusive creation and fsync, uses a hard link to publish immutable bytes without replacement, and uses rename for mutable views. An existing immutable key is accepted only when bytes match.

Recovery follows the journal. Pre-journal orphan revisions do not become accepted knowledge; committed revisions whose views are missing are rematerialized. Crash-injection tests, not this description alone, establish which fault stages have been checked. See `verification/` for actual runs. An idempotency key supports explicit retry without creating duplicate logical writes. Patches require the current `expectedRevisionId`; a stale caller receives a conflict rather than silently overwriting another agent's work.

## Editing, deletion and portability

Use the explicit reconcile operation for edits to current Markdown views. Trusted SDK hosts can opt into `vault.watch({ intervalMs, onError })`: it attempts recursive filesystem notifications and also periodically reconciles (default 5 seconds), with a returned `close()` handle. The watcher/timer are unreferenced; they do not keep a process alive. No watcher is installed automatically by the CLI or MCP. Invalid/conflicting external edits must be preserved or quarantined rather than modifying historical bytes. Rebuild navigation and indexes after recovery as needed; these derivatives may be removed without deleting canonical revisions.

Purge is separate from tombstone deletion and requires explicit authority. It concerns known local artifacts; copied exports, backups, external originals and future replicas are outside an automatic erasure guarantee. Stop writers and make a protected backup before purge. Consult the operation's returned report for exclusions.

Files/directories are created with restrictive permissions where supported. Directory fsync tolerates documented unsupported-operation errors. Durability depends on filesystem semantics; network filesystems, multi-host writers, hardware power-loss guarantees and Windows behavior are not established. Development verification in this workspace is on macOS; check phase reports for the exact environment. Application immutability does not prevent a privileged disk owner from modifying bytes.

## Root profile views

`PROFILE.md` and `USER_INSIGHT.md` can be current views of global-profile `user_insight` objects with owner-only `metadata.profileRole` values `explicit` and `inferred`. Their authoritative bytes remain immutable revisions; ordinary profile-area notes keep independent object paths. Root profile views are not permission-independent files: trusted disk access bypasses SDK checks just as it does for workspace views.
