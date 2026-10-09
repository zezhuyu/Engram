# Changelog

## Unreleased - memory & dream update (M0-M5)

### Added
- **Passive memory (M1):** host hooks (Claude Code, Codex) record sessions into a redacted, bounded, fail-open spool; owner-registered identity binding; recall tools (`recent`, `timeline`, `time_range`, `search`, `get`, `insight search`) with progressive disclosure and token budgets; `mdb capabilities`.
- **Evidence-backed user insights (M2):** evidence classes (explicit, user_conversation, wiki_exposure, agent_observation, dream), hypothesis confirmation, conflict handling, `mdb profile correct|project|reconcile`, user-private storage with applicability scope.
- **Wiki & session memory (M3):** dependency-driven page updates, citation lint with one bounded repair, session-end retrospective and handoff, `mdb memory record`.
- **Dreaming (M4):** micro/deep/strategic planners, association retrieval, per-mode schema, discovery critic, rejected-idea suppression, feedback lifecycle (`candidate -> tested -> validated|rejected`), budgets (daily cap, quiet hours, duration), `mdb dream run|feedback|status|list`.
- Providers: OpenAI-compatible adapter, local agent CLI (`claude`/`codex`) backend, `auto` default; private content is not sent to remote providers by default.
- Index-backed retrieval (manifest + ripgrep / SQLite FTS5 overlay), batched backup, FIFO writer-lock queue.
- Verification lanes `verify:{acid,security,search,intelligence,recovery,platform,memory,profile,wiki,dream,release}`.

- **Query engine (v1):** typed AST (`mdb query`, `Engram.queries`, MCP `mdb_query*`), all RFC operator families, CandidateSource seam, snapshot-pinned reads, saved queries, explain; see docs/query.md.
- **Unix text tools:** native `cat head tail grep cut sort uniq wc tr paste comm diff find tree tee`, `mdb filter jq|awk|sed` bridge, `mdb tools`, MCP `mdb_unix`; see docs/unix.md.

- **Search:** bounded top-K evaluation for keyword/grep/regex; SQLite FTS5/BM25 keyword ranking; optional SQLite-backed semantic and hybrid retrieval (RRF, auto = hybrid when ready) with HTTP embedding providers and optional sqlite-vec; `mdb embed`. Memory capture: background drains register themselves so vault removal waits for them.

### Changed
- Data dir: `--root` > `ENGRAM_DATA_DIR` > `MDB_ROOT` > `~/.Engram`.
- Release report has separate verdicts per area; no aggregate GO while any lane is not PASS.
