# Selective replication contract harness

This directory is test infrastructure only. It does not implement a client, server endpoint, journal change, or storage protocol. The owner has not approved ADR decision O-05; product integration tests remain registered as TODOs until that approval and the product implementation exist.

## 1. Stable invariants

The checker assigns stable IDs so later product adapters and minimized regressions can target the same properties.

| ID | Invariant |
|---|---|
| INV-01 | `ACK_SERVER` implies a durable operation result and immutable journal entry. |
| INV-02 | A local durable pending operation remains recoverable until it reaches a terminal status. |
| INV-03 | An acknowledged operation is accepted once or remains explicitly conflict/rejected/quarantined. |
| INV-04 | Concurrent inputs are preserved; same-object divergence never silently overwrites. |
| INV-05 | At quiescence, an authorized replica equals the server head or is explicitly CONFLICT/QUARANTINE. |
| INV-06 | Unauthorized objects, metadata, references, and counts are not visible. |
| INV-07 | Accepted revisions and imported source bytes are immutable. |
| INV-08 | Search/index/navigation projections are derived from canonical history. |
| INV-09 | A release PASS is bound to the source fingerprint, trusted commit, artifacts, runtime, OS/filesystem, test inventory, policy, and source-bound evidence. |
| INV-10 | Missing or invalid mandatory release evidence fails closed. |
| INV-11 | Operation order is deterministic and never depends on wall-clock time. |
| INV-12 | An epoch change forces RESYNC; old ACKs are not presumed to exist after restore. |
| INV-13 | `(deviceId, op_id)` is exactly-once; retries replay the original result. |
| INV-14 | Revision ancestry is continuous or missing ancestors are fetched/resynced. |
| INV-15 | Purge is irreversible; stale local data and queued operations cannot resurrect the object. |
| INV-16 | Review-gated operation kinds are rejected, including stale-device replay. |
| INV-17 | Revoked actors cannot push; their pending writes enter QUARANTINE. |
| INV-18 | Replica generations swap atomically and recover to a valid generation. |
| INV-19 | Quota handling never evicts an unacknowledged operation. |
| INV-20 | Cursor validity is bound to actor/device, scopeVersion, and server epoch. |
| INV-21 | Wiki pages are never automatically merged. |
| INV-22 | Durable operation results outlive the retry-retention interval and valid credential. |
| INV-23 | A batch is non-atomic across operations; per-object ordering follows `localSeq`. |
| INV-24 | Logical events, rather than wall-clock timestamps, drive deterministic outcomes. |
| INV-25 | Only authorized working-set items and server-approved dependency closure transfer. |
| INV-26 | At quiescence, server heads equal accepted operations applied in journal order (A12). |

The implementation checks state after every modeled event when scenarios call the checker and checks quiescent state at the convergence boundary. Some product-only properties (including filesystem fsync/rename durability, actual cursor HMAC validation, bounded server feed cost, cross-process transaction behavior, and release evidence binding) cannot be proven by a pure in-memory oracle. They are listed as future adapter obligations, not claimed as verified here.

## 2. Oracle and adapter

`oracle.ts` is a pure deterministic state machine with immutable content-hashed revision records, a server journal/head set, device pending queues, scoped replicas, ACL scope versions, conflicts, idempotency results, epoch, and irreversible purge set. `ISyncSystem` is the stable adapter boundary. `OracleSystem` runs catalogue scenarios; `NotImplementedSystem` makes real-system access explicitly unavailable. No scenario writes to the vault or filesystem.

`scheduler.ts` uses xorshift32 seeded PRNG. A generated run records the seed, complete events, and post-event history hashes. Replaying a seed produces the same event array and history bytes. Crash event names cover B1-B7 and S1-S6. `minimizer.ts` delta-debugs event sequences while retaining the failing predicate; persist minimized regressions under this directory when real adapters are introduced.

`scenarios/index.ts` encodes RC-01 through RC-26. The contract test executes each scenario against the oracle, while a corresponding `test.todo` names the future product-backed contract.

## 3. Assumptions pending owner approval

These are the recommended D11 choices where the draft ADR leaves a choice. They shape only oracle fixtures and do not approve product behavior:

1. Local history retains the current head, pending-operation bases, and the last five revisions.
2. Device credentials have a 30-day maximum offline age; the GA default is seven days.
3. Managed file scope is Markdown objects only.
4. Encryption at rest is on by default when an OS keychain is available; otherwise the user must explicitly opt out or configure a passphrase.
5. Automatic body merge is limited to note/task objects, requires three unchanged context lines between hunks, is marked `autoMerged`, and is never used for Wiki pages.
6. Full-workspace pin defaults to 1 GiB or 10,000 objects, with a configurable hard cap.
7. A server epoch changes after backup restore, journal repair that drops committed events, or migration.
8. Server operation-result retention is at least 45 days after last valid credential use, and does not expire while the device credential remains valid.
9. Resolved conflicts may be collected after 90 days; unresolved conflicts remain until resolution.
10. Selective-session dependency closure defaults to link depth one and is calculated/authorized by the server.
11. Pull uses bounded long-polling with per-request ACL re-check; v1 has no server-push stream.
12. Per-device quotas, operation caps, and rate limits use admission control; a quota failure rejects only new local writes.

## 4. Run and replay

```sh
npm run test:sync-contract
```

The command builds TypeScript and runs all compiled sync-contract tests. The model-only property test prints the inclusive seed range, run count, event count, and elapsed time. A failing property seed prints:

```sh
SYNC_CONTRACT_SEED=<seed> npm run test:sync-contract
```

The deterministic self-test compares complete events and post-event history hashes for repeated seeds. No network or temp files are needed. The expected TODO count is 26 until a real replication adapter exists.

## 5. Mutation self-tests

`mutants.test.ts` injects 15 named faults and requires a designated invariant to detect each one. This tests whether the checker has bite; it does not claim that every production fault boundary is already simulated. The machine-readable test log prints the mutant name and invariant ID.

## 6. Coverage limits

The model represents intended semantic outcomes, not real durability mechanisms. Crash boundaries are named and scheduled, but there is no disk, journal parser, network, HMAC cursor, encryption provider, timing side-channel, large-feed index, or actual filesystem fault injection. RC-20 validation constraints, RC-21 negotiated-version behavior, RC-23 asymptotic feed work, and RC-24 disk-full recovery are scenario inputs/placeholders until product adapters can assert those effects. The 10,000-seed campaign is model-only and is not evidence of implementation correctness.
