# Passive memory integration and secondary recall (M1)

**Status: PASS** — 20/23 tests passed, 0 failed, 3 skipped; 20 recorded cases, 0 case failures.

Run at 2026-10-09T17:02:35.862Z, 72.3 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/memory/capture.test.js dist/tests/memory/recall.test.js dist/tests/memory/real-host.test.js dist/tests/memory/remote-real-host.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | adapter install is consented, idempotent, merge-only and fully reversible; foreign hooks and backups are preserved |
| PASS | adapter refuses unparseable host settings, creates and removes its own file, and reports honest coverage for Codex |
| PASS | recorded Claude Code payloads flow hook -> spool -> drain -> Markdown evidence, idempotently, with a closed session and a queued retrospective |
| PASS | secrets are redacted before anything is queued or stored; hidden reasoning is never persisted; excluded content is never recorded |
| PASS | forged or unauthorized events are rejected and persist nothing: wrong principal, workspace, collection, registration, type, timestamp, ACL |
| PASS | overflow policy: a full queue evicts or drops low-value events first, counts what it dropped, and never blocks |
| PASS | fail-open: a missing, read-only, locked or corrupt vault never makes the hook fail or print; recording resumes when the vault is healthy |
| PASS | capture, drain and recall make no model call and need no provider |
| PASS | abandoned sessions are closed as INCOMPLETE with a clearly labeled partial retrospective; active ones are left alone |
| PASS | a later session of another authorized principal retrieves the record on demand; unauthorized principals get nothing |
| PASS | shutdown coordination: a detached drain started by session.end is observable, and a vault is only removed after it finishes |
| PASS | concurrent drains never fail on the lock, and the lock is always released with nothing left behind |
| PASS | a drain also picks up events that were enqueued while it was working (their own drain found the lock held) |
| SKIPPED | real Claude Code: hooks installed by the adapter capture a real task; another principal recalls it; the host works with MDB broken or absent |
| SKIPPED | real Codex CLI: trusted hooks pass actual lifecycle payloads, capture without memory-write instructions, and fail open |
| PASS | recent: newest first by event time with id tie-break, exact cursor paging, scope isolation and an upper time bound |
| PASS | time_range and timeline: timezone semantics, ascending order, evidence references preserved |
| PASS | progressive disclosure: index -> snippet -> timeline -> full fetch keep one identity, and token budgets are enforced with continuation |
| PASS | modes: grep, regex, keyword, links and auto work without a model; semantic and hybrid are explicitly unavailable; identity cannot be asserted |
| PASS | authorization: readers see only granted scopes, grants and revocations apply immediately, MCP rejects asserted identities |
| PASS | SQLite and filesystem recall agree, new commits are visible before any reindex, and a damaged index only degrades |
| PASS | CLI: mdb memory recent/search/timeline/get and capabilities work end to end as JSON |
| SKIPPED | real Claude Code and Codex remote capture recover after HTTP outage and server restart |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Independent authenticated agents cross-deliver passively across machines, including disconnect, retry, restart recovery and end-of-session retrospective/handoff | Cross-machine transport: NOT_RUN.  Recent opt-in live run: PASS_WITH_LIMITATION, 1 passed/0 failed in 372963 ms. It used two actual CLIs and credentials through a stopped/restarted HTTP MCP server, including buffered replay, idempotency, SessionEnd and model handoff; limitation: clients/server were on one physical machine, so cross-machine transport remains NOT_RUN. Run MDB_REAL_REMOTE_HOST_TEST=1 with clients on separate machines for that evidence. |
| NOT_RUN | Codex Stop assistant-message lifecycle event | The live Codex 0.161.0 non-interactive `codex exec` dispatched SessionStart, UserPromptSubmit, PostToolUse and SessionEnd, but did not dispatch Stop; assistant-message payload capture is therefore not evidenced for this invocation. |
| UNSUPPORTED | Other harnesses (OpenCode, Cursor, ...) | No adapter. MCP, CLI and SDK remain available. |
| UNSUPPORTED | Semantic / hybrid recall | No embedding provider or vector index; modes return CAPABILITY_UNAVAILABLE. |
| NOT_RUN | Recall benchmarks at 1k/10k/100k | recent/timeline are manifest scans (O(authorized entries) in memory, no document reads); measured with the general benchmark in M5, not here. |
| NOT_RUN | Hook latency under a loaded host | Fail-open and non-blocking behavior is tested (held writer lock, destroyed vault); per-hook wall time is dominated by Node start-up and was not benchmarked. |

## Limitations

- Events can be lost if the spool overflows, the host is killed before a hook runs, or SessionEnd is not delivered; each case is counted or swept, never blocking the host.
- Assistant replies and read-only tool output are not captured by default.
- Secret redaction is pattern based; unknown secret formats need an --exclude pattern.
