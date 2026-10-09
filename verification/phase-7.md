# Phase 7 verification — Performance and hardening

Date: 2026-10-07 (local). Platform: darwin arm64, Apple M2 Max, Node v25.8.2.

Command: `npm run verify` (lint → typecheck → build + `node --test dist/tests/*.test.js`)
Result: lint 0 failures; tsc clean; **42 tests, 42 pass, 0 fail**.

## Benchmark (`npm run benchmark -- 1000 10`, raw: `verification/benchmark-1000.json`)
| Metric | Value |
|---|---|
| Docs | 1000 synthetic, 100 matches |
| Commit p50 / p95 | 26.9 / 33.1 ms |
| Filesystem keyword p50 / p95 | 532 / 971 ms |
| SQLite keyword p50 / p95 | 557 / 678 ms |
| SQLite rebuild / size | 936 ms / 3.7 MB |
| Parity | true |

## Not done
- 10k/100k benchmarks, cold-cache runs, fuzz/property tests, concurrent read/write benchmark, Linux run.
- Backup/restore and purge are tested functionally only.
