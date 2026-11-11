# Client replica and git-style sync (design record)

Status: DESIGN ACCEPTED, implementation in phases (see "Phases"). Source analysis: `.orchestrate/recon18.report.md`. Owner decisions are recorded verbatim in "Decisions".

## Goal
A Client app machine keeps a local working copy ("replica") of the part of the Engram vault it uses. Agents on that machine read and write the LOCAL copy (fast, works offline). A sync daemon exchanges revisions with the server automatically, the way `git fetch`/`git push` work: the server is the authoritative origin, revisions are immutable commits, a push on top of a stale parent is rejected and must be reconciled, nothing is silently overwritten.

## Decisions (owner, 2026-11-10)
1. "Full local-first replica with two-way sync", "use the same mechanism as the git".
2. What syncs: "only the preference and user insight md files also any client side used or requested workspace. no need to sync the whole server side info. only small portion. so the currently working agent would have full knowledge for their work also others work". "personal would not necessary sync, as its mainly for the chat ai. the client could request an access, but not cache it on the client. only used workspace and root preference and user insight md files will be synced."
   - Replicated: (a) every workspace the client USES (a project bound in replica mode) or REQUESTS (explicit `mdb replica add WORKSPACE`; the server authorizes it against the credential's grants), replicated whole so an agent sees everyone's work in that workspace; (b) the root `PROFILE.md` and `USER_INSIGHT.md` (server-computed, accepted and non-sensitive items only, filtered by the credential's `global:profile:read`).
   - NOT replicated: `personal`, the global `wiki`, `shared`, `discoveries`, other workspaces. These stay live remote calls over MCP (as today) and are never cached by the replica.
3. Conflicts: keep both, flag a conflict, merge explicitly.
4. At rest: private files (0700/0600) in v1, encryption later; disclosed clearly.

## Model (git analogy)
| git | Engram replica |
|---|---|
| commit | immutable revision (`previousRevisionId`, `revisionSha256`) |
| branch history | per-object revision chain (strictly linear in v1) |
| remote `origin` | the server vault (only place compute runs: Dream, profile extraction, ranking) |
| `git fetch` | pull accepted events per workspace after a cursor `(scope, epoch, sequence)` |
| `git push` | push locally committed revisions; the server validates each and stamps the actor |
| non-fast-forward rejection | push with a stale parent returns `conflict`; local work is preserved |
| merge commit | explicit resolution revision whose parent is the server head and which records both source revisions |
| force-push of origin | server restore: the server `epoch` changes; clients stop pushing, keep pending work, resync explicitly |

## Invariants (must hold)
- Markdown revisions and the committed journal stay canonical on both sides; indexes/views/heads are derived and rebuilt locally.
- A client never writes server journal lines. It sends semantic operations; the server validates (schema, size, kind allowlist, parent exists and is current, write ACL now, content hash, redaction/secret rules, no forged ids) and stamps `createdBy`/actor from the authenticated credential. Each operation is committed independently and idempotently `(deviceId, opId) -> result`.
- A client never receives anything its credential cannot read (no ids, titles, counts, cursor gaps). Revocation stops serving immediately; local copies cannot be erased remotely (disclosed).
- Server-computed kinds (insights, profile, dream outputs, wiki curation) flow server -> client only. A client records an explicit preference statement through a typed operation; the server applies it with the existing explicit-statement path and regenerates the root files, which are then pulled.
- No client deletes or purges in v1. Purge, retire and tombstones are server-originated and replicate down as revisions.
- Replicated Markdown is untrusted data; no execution; same neutralization as today.
- No clocks for ordering: server sequence per scope and a per-device local sequence only.

## Conflicts
The journal normally follows one parent chain per object. A replica pull never treats a stale local parent as a scope failure. The replica tracks each object's shared base, newest remote head, pending local revision chain, and `clean`/`ahead`/`behind`/`diverged` state. When the origin advances from the shared base while local revisions are pending, the client preserves all provisional revision bytes, records an open conflict, and installs the origin revision as the working head using the replication-only fork capability. The journal event carries `replicatedFork: { baseRevisionId, candidateRevisionIds }`; the candidate remains an immutable side branch.

Push batches omit candidate operations held by an open conflict. A stale-parent push records the same conflict and the settling pull installs the origin head. Resolution creates a new child of that head with `metadata.resolvedFrom` listing candidate revision IDs and the server head. The conflict remains open until the server accepts and the authoritative revision is reconciled. If that push is stale again, the conflict cycle repeats without dropping either side. `discardCandidate(objectId)` explicitly chooses the already-pulled server version and retains the candidate IDs and bytes in conflict history.

Feed events are isolated by object after feed-chain validation. An event that cannot be installed is durably recorded in `.replica/deferred.jsonl`; the verified cursor may advance because the event is durable locally, while the next sync retries deferred events before fetching new pages. Retries stop after three attempts and remain visible for owner action. On an epoch change the server reports `epoch-changed` once while recording that the client has been notified; the client must clear local cursors with `resync('keep-pending-and-refetch')` before fetching from the new epoch. `status()` and `syncOnce()` expose pending pushes, held operations, open conflicts/divergence, deferred count, and bounded per-object errors. A bad object therefore does not stop unrelated objects in its scope. Deferred state is disposable operational state only after the owner resolves it; revision bytes and the journal remain the evidence source.

The replication capability is internal to Vault and replication code; CLI, MCP, and dashboard operations cannot request fork installation. Vault verification validates fork base/candidate references and hashes; recovery materializes the journal's latest head and current view. No automatic content merge occurs.

## Modes shown in the dashboards
- `Sync` = connected, 0 pending pushes, cursors caught up (last pull/push recent).
- `Syncing` = transfer in progress.
- `Cache` (offline) = server unreachable; N local commits pending; reads/writes keep working locally.
- `Conflict` = at least one object needs an explicit merge. `Refused` = 401/403. `Paused`.
- The server Clients screen shows, per client: pendingPush, pendingPull, lastPullAt, lastPushAt, conflicts, replicated workspaces. Client-reported values are advisory.

## Dashboard state labels

| Label | Meaning |
|---|---|
| Sync mode | Daemon is live, queues are empty, and the last status is fresh. |
| Syncing | A transfer is in progress or local pushes remain queued. |
| Cache mode (offline) | Server contact failed; local reads/writes continue. |
| Conflict | At least one object needs an explicit resolution. |
| Access refused | The server rejected the device credential. |
| Paused | Synchronization is paused pending operator action. |
| Epoch changed | The client must explicitly resync before transferring. |
| Daemon stopped | The daemon is not live or its status is older than three polling intervals. |

The client dashboard's Cached projects tab shows enrolled workspace counts and conflict controls. The owner Clients screen shows the latest client-reported replica fields alongside the authoritative server heartbeat receive time and device enrollment registry.

## Phases
0. This record (done) and the owner questions it resolves.
1. Replication primitives, no network: versioned operation envelope, device identity, local pending queue, per-scope cursors and epoch, atomic cursor update, crash recovery, reconstruction of a replica from events. Tests: crash injection at every boundary, duplicate ops, torn queue, epoch regression.
2. Server pull: authenticated `fetch` and blob endpoints beside `/mcp`, per-workspace sequence index, ACL re-check per batch, scope-version invalidation. Tests: leak tests (ids, titles, counts, snippets, cursors), grant removed mid-pagination, large resume.
3. Server push: operation validator and committer, idempotency table, per-operation partial results, conflict results. Tests: forged actor/object/revision ids, cross-scope parent, computed-kind push, stale grant, replayed/lost-ACK ops, concurrent same-parent pushes.
4. Client integration: replica mode in project binding and init, local MCP/CLI/hook routing to the replica root, sync daemon, enrollment (`mdb replica add|list|remove|status`), migration of queued outbox writes, root `PROFILE.md`/`USER_INSIGHT.md` pull, dashboard Sync/Cache/Conflict states and the Cached projects tab, server Clients screen replication fields.
5. Conflict resolution tooling (CLI and dashboard) and later controlled merge.
6. Scale and hardening: lazy source blobs, quotas and backpressure, epoch restore procedure, benchmarks (full and incremental), encryption at rest design.

Every phase ends with crash-recovery, ACL-leak and forged-push tests, origin/replica convergence (identical logical state) tests, `npm run verify`, and evidence in `verification/phase-N.md`.

## Phase 1 concrete library formats

The implementation lives in `packages/replication/` and makes no network requests. The operation envelope is canonical JSON with lexicographically sorted object keys and UTF-8 SHA-256 over the exact `revisionBytes`. V1 accepts only workspace scopes, the seven allowlisted kinds, UUID operation/device identifiers, and revisions up to 1 MiB. `preference_statement` has empty `revisionBytes` and a typed `{text, category, preferenceKey, sensitive?}` statement; it cannot carry Markdown and is stored inside the authorized workspace. Batches are capped at 100 operations.

The server library rechecks the credential actor's current write grant and validates the revision before import. It stamps `created_by` from the credential actor and installs through the capability-gated Vault import method, preserving object/revision IDs while serializing the actor-stamped revision. Journal event format is unchanged; imported events use `operation: "replica_import"` and the normal journal sequence/hash fields. Idempotency results are stored separately under the configured Engram state directory in `replication/results.json` and expire after 30 days.

Feed cursors are base64url JSON plus an HMAC-SHA256 MAC, bound to actor, device, workspace, server epoch, and a hash of the actor's grants. Feed sequence numbers count only readable events in that workspace. Each returned event carries `prevHash` and `eventHash`, chaining the canonical journal event and revision-byte digest. Epochs and the cursor key are private files under `resolveStoragePath('state')/replication/`; restore operators can bump one scope with `mdb replica epoch bump --scope workspace:ID`, or all scopes with `mdb replica epoch bump`.

A local replica is rooted at `resolveStoragePath('replica')/<replicaId>/`. Its `vault/` is a regular Markdown Vault; `.replica/device.json` stores the device UUID and server URL label at mode 0600. `.replica/pending.jsonl` is fsynced after each append and tolerates an unterminated final record. `cursor.json`, `scopes.json`, `local-seq.json`, `epoch.json`, `epoch-changed.json`, and `conflicts.json` use atomic replacement; `results.jsonl` records terminal push results. Revisions and journal events are installed by Vault before the cursor is advanced. Startup reconstructs unqueued local commits from the enrolled workspace journal; terminal result records prevent accepted, rejected, and conflicted revisions from being requeued. Local conflicts retain both revision IDs. Epoch changes persistently block push batch access and remote installation until `resync('keep-pending-and-refetch')` is explicitly selected.

Phase 1 provides the library surface only. The local Vault callback records supported local commits, and startup reconstructs commits if the process stops between the Vault journal commit and queue append. Source-original retrieval is available as an ACL-checked in-process library operation. Daemon/service integration, UI workflows, and CLI add/list/remove/status flows remain later phase work. The regression suite covers replay, ACL and cursor checks, epoch changes, torn pending tails, queue reconstruction, retrying a pull before cursor advancement, and one deterministic 200-operation convergence run across two replicas. Exhaustive process-kill injection at every persistence boundary remains future hardening.

## Phase 2 HTTP pull API

Phase 2 exposes pull endpoints on the same authenticated HTTP listener as `/mcp`. They are HTTP routes, never MCP tools. Every JSON request uses `v: 1`, rejects unknown fields, and is limited to 64 KiB. Only a scoped revocable HTTP credential is accepted; shared bearer tokens and OAuth identities are denied. Requests are admitted through the MCP fair queue and limited to 120 per credential/device per minute.

| Route | Request | Response |
|---|---|---|
| `POST /replica/v1/hello` | `{v:1,deviceId,label?}` | Server time, readable workspace IDs/names, and enrolled scope versions/sequence heads |
| `POST /replica/v1/enroll` | `{v:1,deviceId,workspaceId,label}` | Enrollment timestamp; only current readable non-retired workspaces are accepted |
| `POST /replica/v1/unenroll` | `{v:1,deviceId,workspaceId}` | `{unenrolled:true}` |
| `POST /replica/v1/fetch` | `{v:1,deviceId,workspaceId,cursor?,limit?}` | Signed feed cursor and events (up to 200 and 1 MiB); ACL/grant changes return `resync-required` |
| `GET /replica/v1/blobs/<sha256>?scope=<workspaceId>&deviceId=<uuid>` | — | Digest-verified source bytes from an enrolled readable workspace |
| `GET /replica/v1/profile` | Optional `If-None-Match` | `{content,revisionId,etag}`; unchanged content returns 304 |

## Phase 3 HTTP push and client synchronization

`POST /replica/v1/push` accepts `{v:1,deviceId,ops}` with a 4 MiB body limit and at most 100 strictly validated operations. The device must be registered and each operation workspace must still be enrolled, active, and writable at push time. Scope-version changes return `resync-required`; missing enrollment and inaccessible workspaces use the generic forbidden response. Operations are processed by `localSeq`. Each result contains `{opId,status,code}` and may include `serverSequence`, `currentHeadId`, and `authoritative:{revisionId,revisionSha256,serverSequence,revisionBytes}`. Preference statements instead carry `profilePull:true`; their generated root snapshots are obtained through `/replica/v1/profile`.

Accepted revision bytes are stamped with the authenticated actor. They can differ from the provisional local bytes even though the revision ID is preserved. `ReplicaStore.markResult` validates those bytes and asks the Vault capability path to replace only the accepted local candidate after checking its object, revision, revision number, parent, scope, kind, and all client-owned fields. The revision digest and local journal digest are updated atomically, then head and Markdown projections are rebuilt. This narrow reconciliation is idempotent; a subsequent pull of the authoritative revision does not create a second local revision. Rejected operations are terminal until the owner explicitly discards them; conflicts preserve the candidate and record the server head. After pulling that head, `resolveConflict` creates a new child with `resolvedFrom` metadata.

The library `syncOnce(store, transport)` performs hello, paginated pull/install, ordered push/result handling, then a settling pull. When a preference result requests a profile pull, it fetches `/replica/v1/profile`, verifies the content hash, and stores the derived snapshot in replica state. `HttpReplicaTransport` reads its bearer token from a caller-selected token file for each request and never logs it. The transport interface also supports in-process adapters in tests. The operation is explicit and one-shot; no scheduler or daemon is started.

Device records live in `.mdb/replication-devices.json`, outside the revision journal, written atomically with mode 0600 under a mode 0700 `.mdb` directory. Records expire after 90 days since last seen; each credential has at most 50 devices and each device at most 20 enrolled workspaces. Credential revocation/rotation removes its records.

## Phase 4a client runtime

Initialize a client replica with `mdb replica init --server URL --token-file FILE [--name LABEL]`. Config under `<replica>/.replica/config.json` contains the device ID, server URL and token-file path, never the token. Enroll whole workspace scopes using `mdb replica add WORKSPACE`; `mdb init --project --mode replica --workspace WORKSPACE --server URL --token-file FILE` performs initialization, enrollment and the initial pull before writing the project binding. Old bindings keep their legacy interpretation: a server URL means remote; a replica is selected only by the explicit `mode: "replica"` and replica ID fields.

Replica mode uses a local stdio MCP server for the bound workspace and a second `engram-remote` HTTP MCP entry for live access to areas that are deliberately not cached. Session context and handoff hooks read and write the local replica. The server-filtered `PROFILE.md`/`USER_INSIGHT.md` snapshot is read-only. Personal memory, wiki, shared knowledge, discoveries and unrelated workspaces remain live server requests. `mdb replica status [--id ID] [--json]` reports daemon state, workspace-level queue/conflict/deferred counts, last contact, pull/push timestamps, epoch state and profile snapshot age. Conflicts can be inspected and resolved explicitly with `mdb replica conflicts show|resolve|discard`.

Run `mdb replica sync --once` for a one-shot exchange or `mdb replica daemon [--interval-s N] [--debounce-ms N]` in the foreground. The daemon wakes every 30 seconds by default (`--interval-s` minimum 1) and debounces queue changes for two seconds (`--debounce-ms` minimum 50). Main-loop waits keep the process alive; queue watcher/poller handles are allowed to be unreferenced. SIGINT and SIGTERM stop the daemon gracefully, release its per-replica lock, and write a stopped status. A second live daemon for the same replica is refused; a lock whose PID is no longer alive is recovered on startup. Transport failures back off exponentially with jitter up to five minutes; the current delay is recorded as `backoffMs` in status, and a server `Retry-After` value is honored. A 401/403 enters `refused` and waits five minutes between credential checks, an epoch change requires explicit `mdb replica resync`, and scope permission changes are reported per scope as requiring resync before pushes resume. Cycle failures are reported to stderr and retried with backoff. The atomic `<replica>/.replica/status.json` is advisory dashboard data. `mdb service install` installs a per-user launchd/systemd replica unit only when a replica is initialized; the unit passes no token argument.

When a workspace is first enrolled, matching queued note/task/handoff writes are replayed oldest first into the local Vault before the queue entries are marked delivered. Their outbox entry IDs, timestamps and merge bases are retained so a crash/retry does not apply the same semantic write twice. The capture spool is separate and untouched. Removing an enrollment keeps local revisions and pending operations; local purge is an explicit, confirmed operation and is refused while pending pushes exist unless forced.

### Dashboard state labels

| Dashboard label | Replica condition |
|---|---|
| Sync mode | Live daemon, fresh status, no pending pushes, and a synced state. |
| Syncing | A transfer is active or pushes remain queued. |
| Cache mode (offline) | The server is unreachable; local workspace reads and writes continue. |
| Conflict | An open conflict or divergence needs an explicit choice. |
| Access refused | The server refused the credential (401/403). |
| Paused | The daemon is paused. |
| Epoch changed | The feed epoch changed and explicit resync is required. |
| Daemon stopped | The process is not alive, status is missing, or status is older than three daemon intervals. |

Workspace disk-size reports are bounded estimates: only the workspace projection and journal-attributed immutable revisions are counted, scanning stops at 20,000 files or 250 ms, capped values are marked approximate, and results are cached for one minute.


## Phase 5-6 hardening defaults

Each replica stores private `limits.json` beneath `.replica/`. Defaults are `maxReplicaBytes: 2147483648` (2 GiB), `maxPendingOps: 10000`, `maxPendingBytes: 268435456` (256 MiB), and `maxBlobBytes: 67108864` (64 MiB). Pending limits are checked before a local Vault commit; a write that would cross either cap fails with `QUOTA_EXCEEDED` and leaves the journal and queue unchanged. `replica status` reports the configured limits and pending usage. `replica add` refuses a server estimate above the cache limit unless `--force` is supplied. The estimate is authorization-filtered, bounded to 20,000 revisions, and may be approximate.

Source manifests and their hashes replicate without the original bytes. `mdb replica fetch-blob SHA256 --workspace WORKSPACE` fetches the source on demand in 1 MiB ranges, resumes a partial transfer, verifies the final SHA-256, and stores the result in the private blob cache. A local original read without a cached payload returns `BLOB_NOT_CACHED`; payloads larger than `maxBlobBytes` remain remote and are reported as too large. Replica status reports local, remote, and too-large blob counts. The server caps fetch pages at 200 events / 1 MiB, limits each device to 120 requests and 64 MiB transferred per minute, and returns `Retry-After` on throttling. The daemon honors `Retry-After` on 429 and 503 responses.

After restoring an older origin backup, `mdb backup restore SOURCE DESTINATION` automatically rotates the global server epoch and prints it in the result. Check `mdb replica epoch status` and preserve the epoch audit record with the restore record. Replicas report an epoch change and block push until the operator runs `mdb replica resync --id ID`; resync keeps pending operations and refetches the restored origin. A local parent missing from the restored origin remains a rejected operation (`PARENT_MISSING`) requiring owner review; it is never force-pushed. Inspect candidates with `mdb replica conflicts list` and `mdb replica conflicts show --object ID`. After review, `mdb replica republish OPID --reviewed` creates a new object from the selected local revision and records its former revision chain in provenance. The original orphaned revisions remain in local history. Source objects require a fresh reviewed ingest of their original bytes.

## Benchmark and crash evidence

Run `npm run bench:replica` for the deterministic synthetic HTTP benchmark. On macOS arm64 / Node 25.8.2, the 2,000-note / 50-source run measured initial clone at 64.6 s / 6.63 MB over HTTP, 100-edit sync at 3.92 s, cumulative 1,000-edit sync at 29.44 s, 500-note push at 45.42 s, and the 50-conflict sync at 4.20 s. A 60.61-second idle sample reported 0.663% average sampled `ps %CPU` and 334 MB peak RSS. Client and server share one process, so clone peak RSS is combined. These are local measurements, not targets or guarantees; the idle CPU value is sampled process-average rather than a CPU-time delta. Full figures and workload details are in [phase 34 verification](../verification/phase-34.md). Crash recovery remains bounded by the documented journal commit point: an acknowledged local write is durable once its journal append is fsynced; unacknowledged writes after that point may appear after restart.
