# Phase 1 verification — Immutable Markdown foundation

Date: 2026-10-07 (local). Platform: darwin arm64, Apple M2 Max, Node v25.8.2.

Command: `npm run verify` (lint → typecheck → build + `node --test dist/tests/*.test.js`)
Result: lint 0 failures; tsc clean; **42 tests, 42 pass, 0 fail**.

## Evidence (tests/storage, durability, security)
- accepted revisions survive updates, restore, tombstone and rebuild
- two writers with same expected revision produce one conflict; independent processes serialize writes
- crashes before journal create orphans; after journal recover committed view; torn last journal record ignored
- actual process death recovers journal and removes dead writer lock
- import preserves binary and text bytes; source manifest rejects mutation
- external edits versioned, stale editors preserved in quarantine; watcher + periodic reconcile
- backup restores revisions; purge erases originals, history, caches
- local object store rejects traversal/symlinks; fake object store contract works without rename (S3-prep)
- collections narrow workspace privileges; unauthorized objects/scope lists/histories/journal non-disclosing

## Limitations
- Application-level immutability only; privileged local disk access bypasses it (documented in docs/security.md).
- Durability depends on filesystem rename/fsync; no power-loss test on real hardware (crash injection is simulated).
