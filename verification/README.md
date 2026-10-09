# verification/

Evidence for the claims in `docs/`. Everything here is produced by commands, not written by hand, except the protocol documents and `release-matrix.json`.

| Path | Produced by | Contents |
|---|---|---|
| `acid/report.{json,md}`, `acid/cases.jsonl` | `npm run verify:acid` | fault matrix, multi-process isolation, state-machine fuzz, storage/durability tests; seeds; explicit NOT_RUN / UNSUPPORTED list |
| `acid/journal-protocol.md`, `acid/fault-points.json` | hand-written, checked against the code | commit point, visibility rules, recovery, locking |
| `security/`, `search/`, `intelligence/`, `recovery/`, `platforms/` | `npm run verify:<lane>` | same report format per lane |
| `benchmarks/<size>.json`, `corpus-manifest.json`, `methodology.md` | `npm run benchmark -- <docs> <runs> <seed>` | seeded corpus, p50/p95/p99, correctness vs known hit counts, filesystem vs SQLite parity |
| `release-report.{json,md}` | `npm run verify:release` | gate matrix and GO / NO-GO / STORAGE-ONLY BETA, computed from the reports above |
| `release-matrix.json` | hand-written | supported platforms and decision notes |
| `phase-0..8.md` | earlier implementation phases | historical; superseded by the lane reports where they overlap |

Status words: `PASS` and `FAIL` are observed; `SKIPPED`, `NOT_RUN` and `UNSUPPORTED` are never counted as verified. Reports older than 24 h are treated as NOT_RUN by the aggregator.

Reproduce everything: `npm run verify:all` (the benchmark is separate because 10k+ takes minutes to hours). Destructive tests only ever touch disposable vaults created under the OS temp directory.
