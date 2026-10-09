# Benchmark methodology

The benchmark runner has explicit corpus lifecycle modes:

```sh
npm run benchmark -- build --size 10000 --seed 20261007 --root verification/benchmarks/corpora/10k-<label> --retain
npm run benchmark -- replay --root verification/benchmarks/corpora/10k-<label> --runs 15 --warmups 2
npm run benchmark -- cleanup --root verification/benchmarks/corpora/10k-<label> --confirm-id <corpusId>
```

`build` requires a new or empty root. `--retain` keeps it for replay; without it, the temporary build is removed after the command. `replay` verifies every listed canonical file hash before using the corpus and writes a fresh report under `verification/benchmarks/runs/<corpusId>/` (or `--output-dir`). It does not rewrite canonical corpus files. SQLite and the MDB search manifest are disposable derivatives excluded from corpus hashes. `cleanup` verifies the corpus and requires the exact `corpusId` as a deletion confirmation.

## Provenance and reproducibility

Every retained root contains `.engram-benchmark-manifest.json` with the seed, generator version/source hash/distribution, canonical file count/paths/sizes/SHA-256 hashes, expected hit counts, exact query workloads, code revision when Git metadata is available, hardware, Node runtime, and build configuration. Benchmark Vault IDs and timestamps are deterministic for a given seed. The corpus ID is derived from the seed, document count, generator metadata, and canonical file hashes. Replay reports repeat the corpus ID and verified hash status; they are distinct from historical aggregate reports (`1k.json`, `10k.json`).

## Workloads and instrumentation

The 12 recorded searches cover literal grep (rare, common, nonexistent, punctuation, CJK), keyword (rare, phrase, multi-term, boolean NOT), regex alternation, and tag/kind/scope filters. Filesystem and SQLite result IDs are compared on every workload. Search latency reports p50/p95/p99 and samples, expected/actual hits, CPU user/system time, allocations measured with V8's `total_allocated_bytes` counter, and heap delta.

Opt-in instrumentation records candidate discovery and ripgrep subprocess time, candidate read bytes, `Vault.get`, ACL checks, revision parsing/validation, line mapping, result materialization, journal reads/parsing/appends, file/directory fsync time, writer-lock wait time, SQLite sync/rebuild/commit time, and query plans for FTS5/trigram queries. Instrumentation is enabled only by the benchmark runner (`MDB_BENCH_PROFILE=1`). SQLite commit timing includes SQLite-managed sync work; the adapter does not expose its internal fsync call count.

## Cache and interpretation limits

Measurements are sequential with explicit warmups. Hash verification and warmups can populate the OS page cache. The harness does not claim cold-cache numbers and does not purge OS caches; a fresh process is not equivalent to a cold OS cache. Reports are machine-specific. Multiple replay commands against the same corpus create separate run reports; compare those reports rather than historical one-off numbers. No performance changes to durability, ACL, or revision-validation paths should be based on these measurements without crash-recovery and parity verification.

## Retrieval profiling

`npm run profile:retrieval -- <scratch-copy-of-retained-corpus> [runs=15] [warmups=2]` profiles rare/common literals, regex, bounded head/tail pages, recent retrieval, and both filesystem and SQLite backends. It accepts only corpus `4e43f472288a4ecfa1678727`, verifies the copy against its manifest before and after the measured operations, and writes a new report under `verification/benchmarks/profiles/<corpusId>/`; it does not modify the retained source corpus or existing replay reports. The profile separates ripgrep child spawn wait, search, and Node output processing, and includes an `rg --files` traversal probe plus a separate explicit-head-path scan probe. Probe timings include process startup and are diagnostic estimates, not additive components of query latency. It records files searched/matched, child count, per-query latency/CPU/allocations, process CPU and peak memory, and SQLite plans. Because V8 allocation counters are process-wide, per-query allocation deltas are comparative estimates rather than isolated allocation attribution. The report labels the warm-cache condition and includes the corpus and current code revisions.
