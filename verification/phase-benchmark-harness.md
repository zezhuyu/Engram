# Benchmark harness and fresh 10K baseline

## Scope

The former benchmark corpora are unavailable, so these results are a new baseline, not a replay or direct comparison against the historical 1K/10K reports. No performance optimization was made from these measurements. Search candidate discovery has a correctness fallback for unavailable ripgrep paths; it preserves Vault authorization and canonical search validation.

## Harness

`scripts/benchmark.ts` provides deterministic `build`, `replay`, and explicit `cleanup` modes. Build supports `--retain`; replay validates canonical file hashes before running the manifest workload set, interleaves filesystem and SQLite runs, records parity, percentiles, CPU, allocations, memory samples, and SQLite query plans. Cleanup requires the corpus ID. The manifest includes seed, generator version, canonical file counts/sizes/hashes, workload queries and expected hits, source revision fingerprint, hardware, Node runtime, and build configuration.

Instrumentation covers candidate discovery, Vault.get/raw-document access, ACL, journal parsing/appends, revision validation, line mapping, result materialization, file/directory fsync, lock waits, SQLite commits/rebuild/sync, and V8 allocated bytes. Durability operations were not altered. Hash verification warms the page cache, so the reports explicitly make no cold-cache claim.

## Corpus

- Corpus ID: `4e43f472288a4ecfa1678727`
- Retained path: `verification/benchmarks/corpora/10k-seed20261007-v2`
- Seed `20261007`; generator `engram-benchmark` v2.0.0
- 10,000 documents; 30,110 canonical files; 9,256,816 body bytes
- Code revision fingerprint: `source-tree-sha256:a654e30cfbafc4957f337275b7b8e9cd7f4807a3f7ba2ea2b6f0363d1f1c5ceb`
- Hardware: Apple M2 Max, 12 logical CPUs, 32 GiB; Node v25.8.2
- Durable ingestion baseline: 264,880.9 ms; p50/p95/p99 commit latency 25.74/31.21/40.58 ms; peak RSS 327,892,992 bytes; SQLite index build 4,832.22 ms.

## Replays

Each replay used 2 warmups and 15 measured samples per workload. Both verified all manifest hashes and filesystem/SQLite parity. These two replay sessions share the exact corpus and workload definitions. The recorded `firstPassMs` values are after hash verification and are not cold-cache timings.

| Workload/backend | Replay 1 p50 / p95 / p99 ms | Replay 2 p50 / p95 / p99 ms | Hits |
|---|---:|---:|---:|
| Rare grep / filesystem | 452.59 / 663.63 / 663.63 | 439.40 / 462.10 / 462.10 | 40 |
| Rare grep / SQLite | 41.48 / 165.27 / 165.27 | 47.22 / 76.54 / 76.54 | 40 |
| Common grep / filesystem | 1,713.39 / 1,805.66 / 1,805.66 | 1,560.83 / 1,644.29 / 1,644.29 | 50 |
| Common grep / SQLite | 1,174.18 / 1,288.05 / 1,288.05 | 1,213.51 / 1,711.62 / 1,711.62 | 50 |

Replay process totals (including all query workloads and setup within the measurement process):

| Replay | CPU user / system ms | Peak RSS | Peak heap | Allocated bytes |
|---|---:|---:|---:|---:|
| 1 | 163,794.9 / 323,439.0 | 1,045,643,264 | 764,368,176 | 222,451,132,360 |
| 2 | 168,043.6 / 332,006.1 | 1,026,719,744 | 727,006,288 | 223,462,542,776 |

Raw reports:

- `verification/benchmarks/runs/4e43f472288a4ecfa1678727/2026-10-08T18-16-49.461Z.json`
- `verification/benchmarks/runs/4e43f472288a4ecfa1678727/2026-10-08T18-21-55.646Z.json`

## Measured bottleneck evidence

- For rare-term filesystem grep, candidate discovery via ripgrep accounts for nearly the full search time: p50 440.05 ms / 424.05 ms across the two replays. Line mapping p50 is 2.35 / 2.51 ms; result materialization p50 is 0.14 / 0.16 ms. ACL and revision-validation timing are negligible in this workload; Vault.get p50 is 3.04 / 3.55 ms.
- Filesystem CJK grep reads 222,885,870 candidate bytes per replay; candidate-discovery p50 is 229.95 / 233.70 ms. SQLite's rare grep p50 is 41.48 / 47.22 ms, with plans using the trigram virtual table (`SCAN t VIRTUAL TABLE INDEX 0:M3`) followed by primary-key lookup (`SEARCH d USING INTEGER PRIMARY KEY`).
- In the fresh build, journal read/parse totals 39.3 s across 28,970 calls, revision validation 90.6 s across 28,967 calls, and Vault raw-document reads 159.3 s across 18,967 calls. File and directory fsync totals are 95.0 s and 105.2 s respectively. Lock wait totals 2.75 s across 10,020 calls. These phases can overlap nested timings and should not be summed as disjoint wall time.
- Durable commit p95 is 31.21 ms on this new corpus/build; it does not match the previously reported 54.41 ms figure. The corpus and harness differ, so this is not a like-for-like regression comparison.

The two replay sessions show repeatable candidate-discovery dominance for rare filesystem grep. They do not establish statistical confidence or explain the historical slowdown. No durability changes or performance optimizations were made.

## Verification

- `npm run verify` — passed: lint, typecheck, 145 tests; 144 passed, 1 opt-in real-model test skipped, 0 failures.
- Benchmark harness regression test covers deterministic builds, replay/hash validation, and cleanup confirmation.
- Crash recovery, ACID, ACL, SQLite/filesystem parity, and security tests passed as part of the suite.
