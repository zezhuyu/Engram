# Phase 10 verification — remote passive capture and scoped agent identity

Date: 2026-10-08. Platform: macOS arm64, Node v25.8.2.

## Result

One canonical local Markdown vault is now reachable by multiple HTTP MCP agents. Each agent credential is bound to one server-side actor and a permission ceiling; workspace ACL grants cannot widen that credential's scopes. Claude Code and Codex can install native hooks that post selected lifecycle events to the authenticated server capture endpoint. Clients persist minimized, redacted events locally until delivery is acknowledged, and the server persists events before acknowledging and retries its own ingestion queue.

The agent harness keeps its native memory as primary. Generated instructions continue to describe Engram as secondary, on-demand memory. Remote project init can opt into hook installation with a server registration and explicit consent; no HTTP-to-stdio bridge or local copy of the shared vault is created.

## Verification evidence

- `npm run verify` — static safety lint: 149 TypeScript files, 0 failures; typecheck and build passed; **272 tests, 269 passed, 0 failed, 3 skipped**.
- `node --test dist/tests/interfaces.test.js dist/tests/project-init.test.js` — **11/11 passed** before the final ACL tightening.
- `node --test dist/tests/interfaces.test.js dist/tests/security.test.js dist/tests/query/security.test.js` — **21/21 passed** after the final ACL tightening.
- The two-client end-to-end test uses separate Claude Code and Codex credentials, posts only passive hook payloads (no explicit memory-write MCP call), confirms both actors retrieve both shared observations, excludes a private-workspace record, rejects mismatched registration and out-of-scope capture, enforces bounded `mdb_context`, and verifies immediate credential revocation.
- Remote spool retry test returns a transient 503, confirms queued content is minimized/redacted and contains no bearer credential, then retries successfully and clears the queue.
- Existing profile tests verify passive user messages feed incremental evidence-backed preference extraction; existing Wiki tests verify incremental dependency-based synthesis without rewriting unrelated pages; Dream tests cover micro/deep/strategic evaluation, privacy, critic and feedback behavior. They all passed in `npm run verify`.

## Setup

See `docs/memory.md` for server credential and registration provisioning, local remote-hook installation, spool recovery, and revocation commands. HTTP access must be protected by TLS at a trusted proxy/network layer.

## Limits

- Codex hook event payloads still need capture from a live Codex session; fixture-level and end-to-end tests validate the current adapter contract but do not prove upstream payload compatibility.
- The transport spool retries on later hook calls or `mdb memory drain-remote`; it does not run a background daemon while the host is closed. Its bounded 1,000-event queue refuses additional items when full. Minimized, redacted payload text can still be sensitive and is stored under the user's home directory with restrictive file modes.
- Server ingestion and canonical Markdown writes are single-vault local POSIX operations. This provides shared access through one server, not multi-region replication or distributed transactions.
- Three full-suite tests remain skipped: real-model integration and GNU awk/sed sandbox checks unavailable in this environment.
