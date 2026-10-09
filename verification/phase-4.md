# Phase 4 verification — Agent interfaces and capture

Date: 2026-10-07 (local). Platform: darwin arm64, Apple M2 Max, Node v25.8.2.

Command: `npm run verify` (lint → typecheck → build + `node --test dist/tests/*.test.js`)
Result: lint 0 failures; tsc clean; **42 tests, 42 pass, 0 fail**.

## Evidence (tests/interfaces)
- spawned CLI: CRUD, conflicts, history, restore, sessions
- spawned MCP: host actor, scope ACL, schemas, stable permission errors
- manual session capture redacts secrets; automatic capture is opt-in; lifecycle adapter allowlist + redaction
- MCP tools present: search, grep, get, put, patch, link, context, session_start/observe/end, workspace_list, collection_list, history, propose_insight, promote, plus skills tools.

## Limitations
- Lifecycle adapter is a generic library (`integrations/lifecycle.ts`); no host-specific hook (Claude Code/Codex) is wired.
- No hosted HTTP service. Without host identity the MCP actor is anonymous with no grants.
