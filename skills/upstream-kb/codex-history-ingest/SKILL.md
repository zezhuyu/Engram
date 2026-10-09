---
name: codex-history-ingest
description: Ingest Codex CLI conversation and rollout history into this repository's wiki. Use when the user wants to mine `~/.codex`, session logs, rollout files, or Codex work history and turn it into reusable wiki knowledge, raw notes, and output memory artifacts.
---

# Codex History Ingest — Session Mining

Extract durable knowledge from Codex session history.

## Sources

Typical useful inputs:
- `~/.codex/session_index.jsonl`
- `~/.codex/sessions/**/rollout-*.jsonl`
- `~/.codex/history.jsonl` when available

## Distillation Rules

- extract decisions, patterns, workflows, and reusable insights
- skip telemetry and low-value operational noise
- cluster knowledge by topic or project, not one page per session
- write durable knowledge to `wiki/pages/`
- write personal/operational memory to `output/`
- write supporting raw extracted notes to `raw/`
