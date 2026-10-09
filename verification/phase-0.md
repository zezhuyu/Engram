# Phase 0 verification — Bootstrap and contracts

Date: 2026-10-07 (local). Platform: darwin arm64, Apple M2 Max, Node v25.8.2.

Command: `npm run verify` (lint → typecheck → build + `node --test dist/tests/*.test.js`)
Result: lint 0 failures; tsc clean; **42 tests, 42 pass, 0 fail**.

## Evidence
- Strict TS project, `bin/mdb.js`, `bin/mdb-mcp.js`, `mdb init|doctor`, `--root`/`MDB_ROOT`.
- Test: "doctor reports runtime SQLite and unavailable model dependent capabilities honestly".
- `node bin/mdb.js doctor --root examples/sample-vault` reports semantic unavailable and model "available: false" (providers must be host-supplied).
- Sample vault initialises with `sqlite.enabled=false`, no network, no LLM (`npm run sample`).
- Docs: architecture, storage-format, search, security, intelligence, operations, ADRs 0001–0003.

## Limitations
- Clean registry install not verified (registry DNS unavailable earlier); validated with local node_modules.
- No CI configuration file shipped; `npm run verify` is the gate.
