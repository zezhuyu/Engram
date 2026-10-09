---
name: data-ingest
description: Ingest arbitrary exported data, logs, transcripts, notes, markdown dumps, and other nonstandard text sources into this repository's wiki. Use when the user wants to process raw data that is not just a normal article, PDF, or media file and still compile it into `raw`, `wiki/pages`, and QMD.
---

# Data Ingest — Generic Source Handler

Use this skill for messy or nonstandard source formats.

## Examples

- exported chat logs
- meeting transcripts
- markdown dumps
- scraped notes
- browser/bookmark exports
- mixed text/image data

## Workflow

1. preserve originals in `.content/` when needed
2. convert the source into markdown under `raw/`
3. cluster the extracted information by topic, not by file boundary alone
4. compile the stable knowledge into English wiki pages
5. store transient or operational memory in `output/` when it does not belong in the durable wiki
6. update index/log/QMD
