# Engram implementation plan

Primary contract: MDB_IMPLEMENTATION_GUIDE.md. CLI name: mdb; product: Engram.

0. Bootstrap strict TypeScript project, shared contracts, doctor/init, source guides, docs, tests.
1. Implement Vault, immutable local object store, journal/recovery, ACL, source capture, revisions and edit reconciliation. Verify the end-to-end vertical slice before integration.
2. Add ACL-first filesystem grep/keyword/graph/context and deterministic generated navigation.
3. Add optional native SQLite FTS5 with parity and stale/missing fallback; semantic remains an explicit extension.
4. Expose SDK/CLI/stdio MCP with host-bound actor identity and explicit generic lifecycle capture.
5. Add bounded event worker, evidence-checked reviewed profile/wiki/memory proposals and no-provider blocking.
6. Add bounded dream proposals, critic/review/dedup and synthetic fixture demonstration.
7. Integrate adapted copies of all KB skills, benchmark, security/crash tests, samples, docs and phase evidence.

Validation: npm run verify; CLI and MCP integration tests; source hashes, expected-revision races, crash injection, ACL non-disclosure, pure-files operation, SQLite parity/fallback, no-provider/model-fixture, skill registry execution, backup/recovery/purge. Report platform/provider limitations.

Design decisions: single TypeScript package with cohesive packages directories; Node native optional SQLite (Node >=22.13); YAML is the only runtime dependency; JSON-RPC MCP stdio without mandatory SDK; local application-level immutability; no automatic network fetch or implicit capture.
