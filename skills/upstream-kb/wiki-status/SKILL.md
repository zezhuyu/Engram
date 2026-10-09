---
name: wiki-status
description: Show the current state of this repository's knowledge base. Use when the user asks what has been ingested, what is still raw, what pages exist, what changed recently, how large the wiki is, or wants an overview of `.content`, `raw`, `wiki/pages`, `output`, and recent log activity.
---

# Wiki Status — Current State

Provide a compact operational view of the repo.

## Inspect

- count/source types under `.content/`
- number of files in `raw/`
- number of pages in `wiki/pages/`
- recent entries in `wiki/LOG.md`
- whether `wiki/INDEX.md` appears current
- whether `output/` contains unsorted insight/memory files that may deserve wiki promotion

## Useful Views

### Ingest status
- sources preserved in `.content/`
- sources converted into `raw/`
- raw materials that appear not yet reflected in `wiki/pages/`

### Wiki status
- total pages
- recently changed pages
- most linked/high-signal topics if easy to compute

### Memory status
- what exists in `output/`
- what exists in `freemind/` for reading only

## Goal

Help the user decide whether to ingest more, refine the wiki, or promote notes from `output/`.
