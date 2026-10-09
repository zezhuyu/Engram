---
name: claude-history-ingest
description: Ingest Claude conversation and memory history into this repository's wiki. Use when the user wants to mine `~/.claude`, Claude project memories, conversation logs, or long-term preferences and convert them into `raw`, `wiki/pages`, and `output` knowledge artifacts.
---

# Claude History Ingest — Conversation Mining

Extract durable knowledge from Claude history.

## Sources

Prefer these in roughly this order:
1. structured memory files under `~/.claude/projects/*/memory/`
2. conversation JSONL files under `~/.claude/projects/*/`
3. supporting session metadata when needed

## Output Strategy

- durable reusable patterns -> `wiki/pages/`
- user preferences and operational memory -> `output/`
- raw extracted transcripts or distilled raw notes -> `raw/`

## Rules

- do not dump entire transcripts into the wiki
- cluster by topic rather than by session file
- prefer incremental ingest when possible
- keep private or highly personal material in `output/` instead of broad wiki pages unless the user wants it generalized
