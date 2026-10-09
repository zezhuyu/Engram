# Retrieval profiling on retained 10K corpus

## Corpus and method

The immutable baseline is corpus `4e43f472288a4ecfa1678727`. Profiling ran against a verified scratch copy at `/private/tmp/engram-profile-4e43f472288a4ecfa1678727`; the retained corpus and its two previous replay reports were not modified. The corpus verifier checked all 30,110 canonical files (10,000 documents). Ripgrep's recursive Markdown traversal found 10,000 revision files, all current heads, and no historical revision Markdown files. Thus history scanning was a code-path risk, not a measured cost on this particular corpus.

The profile suite used 2 warmups and 15 repeated samples for rare/common literals, regex alternation, bounded head/tail pages, and recent retrieval, on filesystem and SQLite. Filesystem and SQLite result IDs matched for every workload. These are warmed-cache measurements: hash validation and warmups can populate OS caches. p95 and p99 equal the maximum with only 15 samples, so the figures are descriptive and do not establish statistical significance. New reports are separate from historical benchmark replay reports.

Commands:

```sh
npm run profile:retrieval -- /private/tmp/engram-profile-4e43f472288a4ecfa1678727 15 2
npm run verify
npm run test:reliability
```

## Measured changes

The pre-change profile exposed recursive path discovery as the dominant literal-search cost: a separate `rg --files` traversal took 308.38 ms p50 for 10,000 paths, and the rare filesystem query took 541.65 ms p50. After search was restricted to explicit current-head revision paths, rare p50 was 130.10 ms and bounded head/tail were 129.26/131.52 ms. The later line-offset change removed a second raw-revision read from line mapping; common search fell from 1,261.53 ms in the candidate-path-only profile to 928.78 ms final, and regex from 1,763.80 ms to 1,174.03 ms. These are observed sequential profile comparisons, not causal statistical estimates.

| Workload/backend | Before p50 / p95 / p99 ms | Final p50 / p95 / p99 ms | Final files examined / matched | Final CPU user / system p50 ms |
| --- | ---: | ---: | ---: | ---: |
| Rare literal, filesystem | 541.65 / 661.95 / 661.95 | 128.06 / 135.46 / 135.46 | 10,000 / 40 | 23.42 / 15.20 |
| Common literal, filesystem | 1,614.98 / 1,654.27 / 1,654.27 | 928.78 / 1,020.01 / 1,020.01 | 10,000 / 6,116 | 645.85 / 1,116.99 |
| Regex, filesystem | 1,784.94 / 2,074.46 / 2,074.46 | 1,174.03 / 1,199.73 / 1,199.73 | 10,000 / 143 | 965.53 / 1,784.94 |
| Bounded head, filesystem | 642.17 / 670.36 / 670.36 | 126.78 / 143.74 / 143.74 | 10,000 / 40 | recorded with workload; see raw profile |
| Bounded tail, filesystem | 593.49 / 653.13 / 653.13 | 127.22 / 135.94 / 135.94 | 10,000 / 40 | recorded with workload; see raw profile |
| Rare literal, SQLite | not measured in control | 31.05 / 33.98 / 33.98 | index-backed; result parity checked | recorded with workload; see raw profile |
| Common literal, SQLite | not measured in control | 770.54 / 818.79 / 818.79 | index-backed; result parity checked | recorded with workload; see raw profile |
| Regex, SQLite | not measured in control | 1,174.64 / 1,203.46 / 1,203.46 | 10,000 / 143 | recorded with workload; see raw profile |
| Recent (20 items) | 2.17 / 2.76 / 2.76 | 2.05 / 2.63 / 2.63 | 10,000 manifest entries / 20 returned | recorded with workload; see raw profile |

`Files examined` for filesystem grep is the number of explicitly supplied current-head files; matched is the number of candidate files with matches (distinct from returned hit lines). Ripgrep used 8 child processes for the final filesystem queries. Its final per-child spawn wait was about 6.5 ms p50, output processing about 0.01 ms p50. Most query wall time therefore remained in scanning content. The separate explicit-head scan probe isolates scan-plus-process-launch from recursive traversal, but is an estimate and is not added to query latency.

The final profiling process observed 60,771.627 ms user CPU, 101,390.377 ms system CPU, 626,180,096 bytes peak RSS, 450,182,016 bytes peak heap, and 109,229,248,800 allocated bytes across the complete mixed suite. The control process observed 93,082 ms user CPU, 169,056 ms system CPU, 837,009,408 bytes peak RSS, and 124,530,546,848 allocated bytes. These are whole-session totals and peak samples; run-to-run variability and changed workload paths prevent attributing all differences to a single edit. Per-query allocation figures and full workload percentiles are in the raw JSON reports.

Recent retrieval profiled 10,000 manifest entries: entry discovery p50 0.62 ms, ordering 1.38 ms, materialization 0.03 ms, with zero revision-file reads. Filesystem path discovery still takes about 312 ms p50 as a standalone traversal; query execution avoids that traversal by using current-head paths.

## Query plan and safety

The final SQLite rare-term plan was unchanged: `SCAN t VIRTUAL TABLE INDEX 0:M3` on `documents_trigram`, followed by `SEARCH d USING INTEGER PRIMARY KEY (rowid=?)`. The FTS plan and global/workspace plans are recorded in the JSON profile. Filesystem-only mode remains available; the full suite also verified index removal/fallback, ACL enforcement, crash recovery and backend parity.

The code change limits filesystem search candidates to current head revisions and passes those paths in bounded ripgrep batches; it no longer recursively searches old immutable revisions. Body-line mapping uses the byte-accurate offset captured when Vault parses a canonical revision, avoiding a duplicate raw-file read while retaining a fallback for synthetic documents. No journal, fsync, SQLite durability, lock, ACL, or immutable-history semantics were changed.

## Evidence files and verification

Raw repeated profile reports (before candidate change, path-only intermediate, and final) are stored in `verification/benchmarks/profiles/4e43f472288a4ecfa1678727/`. Existing replay reports remain under `verification/benchmarks/runs/4e43f472288a4ecfa1678727/`.

`npm run verify` passed: lint (96 TypeScript files, no failures), typecheck, and 146 tests (145 passed, 1 opt-in real-model test skipped, 0 failed). `npm run test:reliability` also passed all 46 fault-injection, ACID, backup, state-machine, lock-contention, and concurrency tests.

## Limitations

There were no historical Markdown revision files in this corpus, so the reduction from scanning history is established by the changed candidate set and code path, not by a before/after historical-file workload. Cold-cache behavior was not measured. The first pre-change profile's single ripgrep subprocess per query differs from the final explicit-path batching, and the 15-sample p95/p99 are maxima. Do not treat these measurements as a statistically established regression or speedup; use the retained corpus for later controlled repetitions.
