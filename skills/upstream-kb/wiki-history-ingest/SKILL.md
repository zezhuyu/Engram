---
name: wiki-history-ingest
description: Unified router for agent history ingestion. Use when the user wants to ingest conversation history, session history, Claude history, or Codex history into the wiki but has not yet chosen the underlying source-specific history skill.
---

# Wiki History Ingest — Router

Route history ingestion to the correct specialized skill.

## Routes

- Claude history -> `claude-history-ingest`
- Codex history -> `codex-history-ingest`

## Rule

Use this router only for agent/session history.
Use `wiki-ingest` or `data-ingest` for normal documents and URLs.
