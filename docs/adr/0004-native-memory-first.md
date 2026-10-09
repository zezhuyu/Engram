# ADR 0004 — Native memory first; MDB is a passive recorder and secondary recall

**Status:** accepted. **Context:** hosts (Codex, Claude Code, others) own live context, compaction and built-in memory. Competing with them would duplicate and distort it; asking agents to call `mdb.put` for routine capture is unreliable.

**Decision**
1. The host's memory is primary. MDB never injects history unprompted and never claims to supersede host context. MCP tool descriptions say so, and `capabilities` reports it.
2. Capture is passive and opt-in. A one-time, reversible adapter installs host lifecycle hooks. The hook is a fail-open recorder: it never opens the vault, never calls a model, never prints to stdout, and exits 0 on any problem. It writes a redacted event into a bounded spool; a separate drain commits events through the normal `Vault.put` path.
3. Identity comes from an owner-written **registration** (host, principal, workspace/collection, allowed event types, exclusions). An event is only a claim: principal, workspace and type are re-checked against the registration at ingest, and the registration principal's ACL applies to every write. A failed check is a rejection, never a bypass.
4. Recall is a separate, model-free read path (`recent`, `timeline`, `time_range`, lexical search, `links`, batch fetch) with progressive disclosure and hard token budgets. Semantic and hybrid report `CAPABILITY_UNAVAILABLE` until a provider and index exist.
5. The recorded data are ordinary Markdown objects (`session`, `observation`, `note`, `decision`, `finding`) with provenance metadata (`eventType`, `speaker`, `hostSessionId`, `eventTime`, `evidenceClass`, `consentPolicyId`). No journal, revision or object-schema change; derived structures (search manifest v2, spool) are disposable.

**Consequences:** recording can lose events when the spool overflows or the host is killed before a hook runs (counted and reported, never blocking). `SessionEnd` is best-effort, so abandoned sessions are closed by an inactivity sweep and labeled incomplete. Hook payload shapes are host-defined: Claude Code's were recorded from a live session; Codex's are not yet verified live.
