# Security and isolation

**Status: PASS** — 25/25 tests passed, 0 failed, 0 skipped; 8 recorded cases, 0 case failures.

Run at 2026-10-09T03:13:17.223Z, 4.7 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/security.test.js dist/tests/security/adversarial.test.js dist/tests/security/identity.test.js dist/tests/interfaces.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | spawned CLI supports Markdown CRUD, conflicts, history, restore and sessions |
| PASS | spawned MCP honors host actor, scope ACL, schemas and stable permission errors |
| PASS | MCP HTTP transport is opt-in, authenticated, origin-checked, and serves the same tool API as stdio |
| PASS | two scoped remote agents passively deliver lifecycle observations to one authorized memory store |
| PASS | MCP transport selection rejects ambiguous modes and HTTP refuses a missing bearer secret |
| PASS | lifecycle adapter captures only explicit allowlisted events and redacts supplied text |
| PASS | remote lifecycle hook adapters install against one shared server and can be removed cleanly |
| PASS | remote capture spool redacts before persistence and retries delivery without storing credentials |
| PASS | unauthorized objects, scope lists, histories and journal metadata are non-disclosing |
| PASS | collections narrow workspace privileges and global sharing requires explicit grants |
| PASS | promotion produces sanitized derivative and hides protected origin from shared readers |
| PASS | malicious content has no authority and protected source snapshots remain unchanged |
| PASS | forged reference URIs do not validate through unrelated accessible object IDs |
| PASS | workspace IDs differing only by case cannot alias one directory (case-insensitive filesystems) |
| PASS | forbidden and nonexistent objects are indistinguishable across every read/write entry point |
| PASS | backlinks, related-graph traversal and context never reveal private nodes, edges, counts or titles |
| PASS | frontmatter/YAML injection through title, tags and metadata cannot forge status, kind, scope or visibility |
| PASS | path traversal, encoded separators, NUL bytes and hostile identifiers are rejected without touching the filesystem |
| PASS | forged worker payloads cannot make a job read or send inaccessible content to a model |
| PASS | secrets are redacted in stored observations, error messages and journal records |
| PASS | purge removes plaintext from derived SQLite indexes and WAL files, not only from canonical files |
| PASS | credential rotation atomically revokes the old bearer, preserves identity, narrows scopes, and audits without secrets |
| PASS | credential identities remain distinct under simultaneous provisioning and unauthorized audit reads disclose nothing |
| PASS | credential revocation is immediate and writes a secret-free administrative audit event |
| PASS | supported TLS reverse-proxy example terminates HTTPS in front of loopback-only MCP |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Real prompt-injection resistance of a live model | Deterministic tests prove injected text has no authority in the runtime (validated proposals, review gate, scope checks). Behaviour of a real model under injection is a model-eval item. |
| UNSUPPORTED | Embedding leakage | No embeddings exist. |
| NOT_RUN | Case-insensitive filesystem path collisions beyond workspace/collection IDs | IDs are folded and rejected; object IDs are generated lowercase. |
| UNSUPPORTED | Local-owner disk access | Application-level ACLs and immutability do not defend against a user with direct filesystem access. |

## Limitations

- Zero-disclosure gate covers get/history/diff/patch/delete/restore/promote/links/backlinks/related, search counts and cursors, generated index files, forged queue payloads, traversal and YAML injection in the tested configurations.
