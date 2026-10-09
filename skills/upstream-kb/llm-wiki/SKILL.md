---
name: llm-wiki
description: Foundational pattern for this repository's LLM wiki workflow. Use when discussing how the knowledge base should work, how `.content`, `raw`, `wiki/pages`, `output`, `freemind`, and QMD fit together, or when planning wiki architecture and ingest/query behavior.
---

# LLM Wiki — KB Architecture Pattern

This repository is a compiled knowledge system, not a chat transcript dump.

## Core Layers

1. `.content/` — original source artifacts, preserved after download
2. `raw/` — converted markdown, transcripts, OCR, and other grounding text derived from `.content/`
3. `wiki/pages/` — English curated wiki pages synthesized from `raw/`
4. `output/` — conversation history and user insight memory markdown
5. `.qmd` collections — retrieval layer for `wiki` and `raw`

## Repository-Specific Rules

- Raw content may be non-English.
- Wiki pages must be in English.
- `freemind/` is read-only to the agent.
- Generated content goes to `wiki/pages/` or `output/`.
- `wiki/INDEX.md` and `wiki/LOG.md` are always updated after meaningful wiki changes.
- `wiki/pages/` belongs in the QMD `wiki` collection.
- `raw/` belongs in the QMD `raw` collection.

## Default Workflow

When the user gives a URL or source:
1. Run `bash setup.sh`
2. Preserve the source in `.content/`
3. Convert/transcribe/OCR into `raw/`
4. Read the raw material
5. Run the real LLM synthesis step with `$wiki-page-compiler`
6. Compile English wiki pages in `wiki/pages/`
7. Rebuild `wiki/INDEX.md` with:
   - `.venv/bin/python .skills/llm-wiki/scripts/wiki_index_sync.py`
8. Append to `wiki/LOG.md` with:
   - `.venv/bin/python .skills/llm-wiki/scripts/wiki_log_append.py ...`
9. Sync QMD collections with:
   - `.venv/bin/python .skills/llm-wiki/scripts/qmd_sync.py`

## Compiler Step

The repo has a distinct compile stage after `raw/` generation.
Use:

```bash
.venv/bin/python .skills/wiki-page-compiler/scripts/wiki_compile_packet.py raw/<file>.md
```

The packet helps the agent decide create/update/merge targets, but the final English wiki page is still written by the LLM agent.

## Page Design

A good wiki page:
- starts with a short definition/summary
- cites the relevant `raw/` source paths
- links to related wiki pages with Obsidian `[[wikilink]]` syntax
- avoids long raw text dumps
- captures durable concepts, workflows, entities, and comparisons

## Query Principle

Answer from `wiki/pages/` first.
Use `raw/` only for grounding or to fill gaps.
Use `output/` for user/agent memory.
Read `freemind/` only when the user's quick notes matter.
