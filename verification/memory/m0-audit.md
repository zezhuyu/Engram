# M0 — audit and compatibility (MDB_MEMORY_DREAM_UPDATE)

Inputs read: the RFC, the implementation and verification guides, `verification/*` reports (`release-report.md`: STORAGE PASS, INTELLIGENCE INCOMPLETE, PERFORMANCE INCOMPLETE), `packages/*`, tests (94 fast, lanes acid 57 / recovery 4 / search 21 / security 16 / intelligence 39 / platforms 6). No code was changed for M0.

## Inventory: RFC requirement → current state

| RFC area | Exists (tested) | Missing / partial |
|---|---|---|
| Storage, ACID, immutability, ACL, purge, backup | Complete and verified (journal, revisions, fault matrix, locks, manifest-checked backup) | none for this RFC; Linux and power-cut remain NOT_RUN |
| Search | Filesystem (ripgrep/scan) and SQLite FTS5/trigram, journal manifest + overlay, parity/stale/ACL tests, 1k+10k benchmarks | `recent`, `timeline`, `time_range` modes; progressive disclosure; semantic/hybrid return `CAPABILITY_UNAVAILABLE` (correct); 100k not run |
| Passive capture | `LifecycleAdapter` (library; host must call it), manual `session start/observe/end`, secret redaction (4 regexes), capture opt-in config | **MemoryEvent envelope**, durable bounded spool + dedup by `(host,eventId)`, overflow policy, host adapters that actually install hooks (Codex/Claude), principal binding to install-time identity, exclusions, abandoned-session sweep, adapter install/status/uninstall |
| Secondary recall API | `search`, `context`, `history`, MCP search/get/context | `memory recent/timeline/search/get`, `insight search`, cursors on event time, token-budgeted detail levels, capability discovery |
| Profile / user insight | explicit-vs-inferred by `preferenceKey`, sensitivity review gate, supersede on newer explicit, reconcile, idempotent proposals | **evidence classes** (explicit / user-conversation / wiki-exposure / agent / dream) and the rule that wiki exposure is never preference; speaker attribution; per-evidence spans; workspace-vs-global coexistence; `USER_INSIGHT.md` regeneration with history; `insight search` |
| Wiki | source → proposal → evidence check → critic → review → page; dedup | source→page dependency edges, **affected-page** detection, claim extraction, citation lint, new-topic creation, incremental update |
| Memory / reflection | session-end reflect job over that session's observations; blocked without provider | task-complete trigger, handoff document, abandoned/partial handoff, consolidation job |
| Dream | multi-domain evidence requirement, test plan + counterarguments required, certainty/duplicate critic, hypothesis status, goals fingerprint | **real association retrieval** (near/complementary/distant), distinct micro/deep/strategic algorithms, candidate budget accounting, novelty/contradiction critic, discovery lifecycle (candidate→tested→validated/rejected/superseded) with feedback, rejected-repeat suppression, recursion guard, retrieval traces |
| Orchestrator | durable jobs, leases, retries, dead letter, cancellation, idempotency by input digest, cursor over journal | job priorities, task names from the RFC, `intelligence.status` |
| Providers | CLI agents (claude/codex), OpenAI-compatible API, privacy gate, strict schema, budgets | none for this RFC |
| Docs/ADR | ADR 0001–0003 | ADR 0004 native-memory-first, API/adapter docs, insight schema, dream design |

## Compatibility rules for the work below
1. **No change to canonical formats.** New data are ordinary objects with new `kind`/`metadata` keys through the existing `Vault.put/patch` (schema_version stays 1). Old objects are read unchanged; absence of a new field means "legacy".
2. **No journal or revision layout change.** Idempotency uses the existing `idempotencyKey` (journal-enforced), so event dedup survives restarts for free.
3. **Derived structures only:** the search manifest gains optional fields (event time, session, event type); its file version is bumped (`manifest.v2`), and an old file is simply ignored and rebuilt (it is disposable).
4. **Spool and counters** live under `.mdb/capture/` (outside revisions/journal; derived, losable without losing accepted knowledge, but losing unprocessed spool files loses not-yet-recorded events, which is the documented best-effort behavior).
5. **Hook installation never touches real user config in tests**; adapters take an explicit settings path, write a timestamped backup, and mark every entry they own so uninstall removes only those entries.
6. Existing commands and MCP tool names are unchanged; new ones are additive.
7. **Rollback:** every new capability is additive and disabled by default (`capture.enabled=false`, no adapters installed). Removing the new objects is not required to roll back; ignoring them is.

## Verified facts used for design (not assumptions)
- Claude Code hook payloads (recorded live, claude 2.1.285; fixture `tests/fixtures/hook-payloads/claude-code.json`): `SessionStart{session_id,cwd,source}`, `UserPromptSubmit{prompt,…}`, `PostToolUse{tool_name,tool_input,tool_response,duration_ms}`, `Stop{last_assistant_message}`, `SessionEnd{reason}`; `SessionEnd` is best-effort (other hooks were cancelled at process exit in `-p` mode).
- Codex reads `~/.codex/hooks.json` with the same `{matcher?, hooks:[{type:'command',command,timeout}]}` schema and events `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop` when `[features] hooks = true`. Its payload field names (`session_id`, `cwd`, `turn_id`, `last_assistant_message`, `tool_name`, `tool_input`) were read from the installed hook runner, **not recorded from a live Codex session**; Codex payload capture is therefore reported as unverified.
- The user's real `~/.claude/settings.json` and `~/.codex/hooks.json` already contain other tools' hooks; the adapter must merge, never replace.

## Gate
Migration plan above has no backward-incompatible mutation of immutable data. M0 gate: PASS (documentation gate; nothing executed against canonical data).
