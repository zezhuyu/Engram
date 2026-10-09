---
name: wiki-update
description: Update the wiki from the current project, user insight, or newly learned information. Use when the user says update the wiki, sync this knowledge, save this to my wiki, or wants current work distilled into `wiki/pages` or `output` without necessarily ingesting a new external source.
---

# Wiki Update — Distill Current Work

Use this skill when the source is not just an external document but the user's current work, insight, or discussion.

## Targets

- durable knowledge -> `wiki/pages/`
- operational memory or personal context -> `output/`

## Workflow

1. Read `AGENTS.md`
2. Inspect recent repo context relevant to the request
3. Decide whether the result belongs in the long-term wiki or in `output/`
4. Update or create the markdown artifact
5. If wiki pages changed, run:
   - `.venv/bin/python .skills/llm-wiki/scripts/wiki_index_sync.py`
6. Append the change with:
   - `.venv/bin/python .skills/llm-wiki/scripts/wiki_log_append.py`
7. If `wiki/pages/` or `raw/` changed, run:
   - `.venv/bin/python .skills/llm-wiki/scripts/qmd_sync.py`

## Heuristic

Ask implicitly: “Would future me want this as durable knowledge, or just as saved memory?”
