# Engram/MDB Release Verification — no-git-repository

## Verdict
STORAGE: PASS
MEMORY: PASS
USER INTELLIGENCE: PASS
WIKI: PASS
DREAM: PASS
QUERY: PASS
UNIX: PASS
INTELLIGENCE (pipelines/providers): PASS
PERFORMANCE: INCOMPLETE
PLATFORM: PASS

## Mandatory v1 feature gates
| Gate | Status | Evidence | Result / limitation |
|---|---|---|---|
| PREFERENCES | PASS | verification/profile/report.json, verification/profile/real-model-evaluation.json, verification/profile/labeled-corpus.json, tests/profile/insights.test.ts, tests/fixtures/profile-raw/, docs/user-insight.md | Fresh run on the combined A+B+C tree (2026-10-09T15:18:16.123Z): real Claude CLI, 32-case labeled corpus, 3 runs, 96 jobs: completed 96/96 (95% CI 0.962-1), 48 proposals + 48 valid abstentions, 0 malformed, 0 repairs needed by the real model; precision 1, recall 0.917 (CI 0.804-0.967), false-positive rate 0, scope 1, grounding 1, correction override True. Root cause and fix (from the Agent A work, unchanged): valid abstentions had no legal envelope (evidence required 1..40) and the old repair step never ran because the provider throws during its own parse; fixed with the versioned profile-extraction/v1 schema, first-class no_insight, bounded repair and separate counters. Repair paths are covered by mock-provider tests only. External factual calibration NOT_RUN. |
| REMOTE_CAPTURE | INCOMPLETE | docs/cross-machine-verification.md, scripts/xhost/run.mjs, tests/memory/remote-real-host.test.ts, tests/memory/remote-spool.test.ts, verification/memory/cross-machine-report.md, verification/memory/remote-real-host-evaluation.json, verification/memory/report.json, verification/memory/xhost/results.json | Fresh run on the combined tree: all 14 scenarios PASS on three Docker containers (own filesystems and network namespaces, dedicated network, real TLS with a test CA, real disconnects, server restart, 1100-hook buffer cap, duplicate/reorder/replay, revocation and reissue, client SIGKILL). The earlier live Claude Code + Codex run on one machine is prior evidence and was not repeated. PHYSICAL separate hosts NOT_RUN (none configured or authorized), so the gate stays INCOMPLETE. Not fixed, documented: no autonomous retry/backoff; head-of-line blocking by a permanently rejected envelope untested; hanging-connection, packet-loss and clock-skew cases NOT_RUN. Also fixed on integration: a drain-lock initialization race in packages/memory/capture.ts (regression test added); container harness re-run on the merged tree in the Engram folder: 14/14 PASS. |
| AGENT_IDENTITY | PASS | verification/security/report.json, verification/identity/report.json, docs/security.md, deploy/Caddyfile | Fresh run on the combined tree: verify:security 25/25 and the identity cases pass. Security and identity tests pass for server-bound actors, spoof rejection, two independently scoped HTTP clients, cross-workspace denial, concurrent provisioning, creation/revocation/rotation/authorization-failure audit, atomic rotate-and-reissue with immediate old-token invalidation and scope narrowing, and the supported loopback-upstream Caddy HTTPS configuration. |
| DREAM_ENGINE | PASS | verification/dream/report.json, verification/dream/labeled-scenarios.json, verification/dream/real-model-evaluation.json, tests/dream/retrieval.test.ts, tests/dream/dream.test.ts, tests/dream/dream.test.ts | Fresh run on the combined tree (this session): real Claude CLI, 3 runs, fresh vault per scenario, thresholds unchanged (0.75/mode): micro 0.889, deep 0.986 (legacy scorer 0.796), strategic 0.944; evidence grounding 1; critic rejected all adversarial cases and accepted the supported case in every run. Original deep 0.667 was two scorer defects (feasibility read prose instead of metadata; quoted source claims counted as hallucination); generation changes: 3 sibling angles, hops/facts/speculation/missingEvidence, bounded repair, deterministic selection, not_selected records. Caveats: deep sample is 3 isolated 2-3 document scenarios; sibling selection gain is small; micro feasibility 0.17 under the stricter scorer; hybrid semantic retrieval comparison NOT_RUN (no embedding model). |

## Environment
Darwin 25.0.0 / arm64 / apfs / Apple M2 Max / 32 GiB / Node v25.8.2 / SQLite 3.53.4 / commit no-git-repository

## Matrix
| Gate | Sev | Status | Cases | Evidence | Limitations |
|---|---|---|---|---|---|
| S1 Lint passes | P0 | PASS | 1 | npm run lint |  |
| S2 Crash recovery at every transaction fault point (kill / EIO / ENOSPC), idempotent recovery, no partial commits | P0 | PASS | 140 | verification/acid/report.json | Process-level faults only; power cut NOT_RUN |
| S3 No lost acknowledged write; no silent lost update (multi-process 10/50, shared-object RMW, same-revision race) | P0 | PASS | 12 | verification/acid/report.json | No real-time linearizability checker |
| S4 Immutability, history and invariants under randomized operation sequences with restarts | P0 | PASS | 24 | verification/acid/report.json | In-repo seeded generator, no shrinking |
| S5 Backup under write load, restore validation, corrupt backup refused | P0 | PASS | 4 | verification/recovery/report.json | Same host; purge does not reach existing backups |
| S6 Zero ACL / non-disclosure leaks in tested surfaces | P0 | PASS | 8 | verification/security/report.json | Local disk access bypasses ACLs |
| S7 Filesystem search correct; SQLite parity, stale fallback, corruption fallback, rebuild, integrity checks | P0 | PASS | 36 | verification/search/report.json | No ranking-quality or semantic claim |
| S8 Supported platforms pass or release is explicitly restricted | P0 | PASS | 7 | verification/release-matrix.json, verification/platforms/report.json | Supported: darwin. Linux NOT_RUN, so Linux is NOT a supported release platform. |
| S9 Power-loss durability | P1 | NOT_RUN | 0 | - | No power-cut or fsync-fault-injection test was performed |
| I1 Deterministic pipelines (profile, retrospective, critic, privacy, budgets, errors) and provider adapter | P0 | PASS | 0 | verification/intelligence/report.json | Fake and one local real model only |
| M1 Passive capture: redaction, spool, fail-open hook, identity binding, recall tools (M1) | P0 | PASS | 20 | verification/memory/report.json | Claude and Codex payloads were live-tested; this single-host run does not prove remote cross-machine outage/restart delivery. Codex exec did not dispatch Stop. |
| U1 Evidence-backed user insights: evidence classes, hypotheses, conflicts, correction, projection (M2) | P0 | PASS | 17 | verification/profile/report.json | One synthetic real-model sample matched four labeled facets and source/scope rules; independent precision/false-positive calibration is not measured. Sensitivity detection is a keyword heuristic. |
| W1 Wiki compilation with citations, dependency-driven updates, retrospectives and handoffs (M3) | P0 | PASS | 10 | verification/wiki/report.json | Lint does not verify that a span supports its sentence; real-model run is opt-in |
| Q1 Typed query engine: operator families on SDK/CLI/MCP, reference-interpreter fuzz, ACL non-disclosure, crash recovery, filesystem-only (QG1-QG5) | P0 | PASS | 74 | verification/query/report.json | Semantic/hybrid require SQLite plus configured vectors; regex is JavaScript RegExp with safety guards, not RE2. |
| X1 Unix text tools (cat head tail grep cut sort uniq wc tr paste comm diff find tree tee): system-tool parity, formats, exit codes, bounds, ACLs, tee guards, interop bridge | P0 | PASS | 139 | verification/unix/report.json | BSD tools only (GNU cases NOT_RUN); Linux NOT_RUN; awk/sed bridge execution NOT_RUN without gawk/GNU sed |
| D1 Dream modes, association retrieval, critic, feedback lifecycle and budgets (M4) | P0 | PASS | 18 | verification/dream/report.json | Real-model structural, evidence, status and critic flags were recorded; independent novelty/usefulness/hallucination scoring and longitudinal feedback impact remain unmeasured. |
| P-1k Benchmark 1k: correct results, filesystem/SQLite parity | P1 | PASS | 20 | verification/benchmarks/1k.json | Warm cache only |
| P-10k Benchmark 10k: correct results, filesystem/SQLite parity | P1 | PASS | 20 | verification/benchmarks/10k.json | Warm cache only |
| P-100k Benchmark 100k: correct results, filesystem/SQLite parity | P1 | NOT_RUN | 0 | verification/benchmarks/100k.json | No measurement exists |
| QB-1k Query benchmark 1k: results match known counts | P1 | PASS | 1 | verification/query/benchmarks/1k.json | warm cache only |
| QB-10k Query benchmark 10k: results match known counts | P1 | PASS | 1 | verification/query/benchmarks/10k.json | warm cache only |
| QB-100k Query benchmark 100k: results match known counts | P1 | NOT_RUN | 0 | verification/query/benchmarks/100k.json | warm cache only |
| PB-keyword p95 100k budget: keyword p95 (<150 ms) | P1 | NOT_RUN | 0 | verification/benchmarks/100k.json | No 100k measurement |
| PB-grep p95 100k budget: grep p95 (<200 ms) | P1 | NOT_RUN | 0 | verification/benchmarks/100k.json | No 100k measurement |
| PB-durable write p95 100k budget: durable write p95 (<50 ms) | P1 | NOT_RUN | 0 | verification/benchmarks/100k.json | No 100k measurement |

## ACID scope and caveats
Transaction = one logical operation in one vault (all objects of a put/patch/delete/ingest). Commit point = journal record appended and fsynced. Isolation = writes serialized by one vault-wide lock plus optimistic expected-revision conflicts; readers are lock-free and see whole committed revisions. Cross-workspace atomic transactions are not offered. Unacknowledged transactions past the commit point may appear after recovery. Power-cut test: NOT_RUN.

## Decision
BETA (not GA: PERFORMANCE not PASS)

- Release is explicitly restricted to macOS (APFS, tested). Linux/ext4 was NOT_RUN and is not a supported release platform until the reliability lane passes there.
- Process-crash atomicity and recovery are verified; power-loss durability is not.
- Writes are serialized by one vault-wide lock; per-workspace write parallelism is not offered.

Generated by scripts/verify-release.ts from verification/*/report.json; status words come from reports, not opinion.
