# Phase 3 verification — Optional SQLite

Date: 2026-10-07 (local). Platform: darwin arm64, Apple M2 Max, Node v25.8.2.

Command: `npm run verify` (lint → typecheck → build + `node --test dist/tests/*.test.js`)
Result: lint 0 failures; tsc clean; **42 tests, 42 pass, 0 fail**.

## Evidence
- SQLite parity and stale update/delete fallback preserve canonical results
- FTS trigram path preserves substring, short term and quoted punctuation parity
- 1k benchmark: SQLite results identical to filesystem (`parity: true`), `backend: sqlite`, index 3.7 MB, rebuild 936 ms.

## Limitations
- Uses `node:sqlite` (Node >=22.13). Semantic/hybrid search is NOT implemented: `CAPABILITY_UNAVAILABLE`.
- At 1k docs SQLite is not faster than filesystem (p50 557 ms vs 532 ms) because canonical revision validation still reads every authorized document; the speed-up goal is not demonstrated.
