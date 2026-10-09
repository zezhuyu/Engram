---
name: wiki-export
description: Export this repository's wiki into structured outputs for external tools. Use when the user asks to export the wiki, export the graph, create JSON or markdown summaries of wiki/pages, or prepare the knowledge graph for downstream visualization or analysis.
---

# Wiki Export — Structured Outputs

Export compiled knowledge from `wiki/pages/` into structured artifacts under `output/`.

## Possible Export Targets

- markdown summaries
- JSON page inventory
- link graph data
- tag/topic inventories
- page/source maps

## Minimum Export Bundle

Write into `output/exports/`:
- page inventory
- link map
- topic/tag summary
- export log entry

## Rules

- Source pages come from `wiki/pages/`
- `wiki/INDEX.md` and `wiki/LOG.md` are support files, not primary content nodes
- note the export timestamp and source scope
