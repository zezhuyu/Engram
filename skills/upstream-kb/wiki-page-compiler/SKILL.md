---
name: wiki-page-compiler
description: Compile `raw/` grounding material into durable English wiki pages. Use when the user wants the real LLM wiki-building step, after source download/conversion is complete and the agent must decide whether to create, update, merge, or split pages under `wiki/pages/`.
---

# Wiki Page Compiler — The Real LLM Build Step

This is the synthesis stage of the system.

It does **not** conflict with the LLM wiki builder — it **is** the LLM wiki builder.
The deterministic scripts in this repo only help with:
- source download
- markdown/transcript/OCR conversion
- compile packet generation
- wiki index/log/QMD synchronization

The actual page writing still happens through the agent's reasoning.

## Use When

- `raw/` already contains a converted source
- the user says "build the wiki", "compile this into the wiki", or "write wiki pages from this raw file"
- an ingest flow finished downloading/parsing and now needs English wiki pages

## Workflow

1. Run `bash setup.sh`
2. Read `AGENTS.md`
3. Inspect the target `raw/*.md` file(s)
4. Inspect existing `wiki/pages/` for overlap
5. Generate a compile packet:

```bash
.venv/bin/python .skills/wiki-page-compiler/scripts/wiki_compile_packet.py raw/<file>.md
```

6. Read the packet under `wiki/meta/compile-packets/`
7. Decide whether to:
   - update an existing page
   - create a new page
   - merge overlapping pages
   - split one raw source into multiple durable pages
8. Write the final English page(s) under `wiki/pages/`
9. Run:

```bash
.venv/bin/python .skills/llm-wiki/scripts/wiki_index_sync.py
```

10. Append a log entry:

```bash
.venv/bin/python .skills/llm-wiki/scripts/wiki_log_append.py COMPILE --path raw/<file>.md --path wiki/pages/<page>.md --collection raw --collection wiki --message "Compiled raw source into English wiki pages"
```

11. Sync QMD:

```bash
.venv/bin/python .skills/llm-wiki/scripts/qmd_sync.py
```

## Writing Standard

The final page is not a translation dump.

A good compiled page should:
- begin with a short English definition
- keep only durable, reusable knowledge
- cite the relevant `raw/` files
- use Obsidian `[[wikilink]]` syntax for internal mentions
- prefer synthesis over paraphrase
- preserve important ambiguity when the source is suggestive rather than rigorous

## Heuristics

- If the raw file contains one strong durable idea, create one page.
- If it contains several distinct durable ideas, split them into multiple pages.
- If the idea already exists in the wiki, update the existing page instead of creating a near-duplicate.
- If the source is mostly prompts, examples, or tactics, prefer a `topic` or `workflow` page over a `concept` page.

## Important Boundary

The compile packet is a helper artifact, not the final wiki page.
Do not copy the packet into `wiki/pages/`.
Do not store compile packets in `output/`; `output/` is reserved for conversation history and user insight memory.
