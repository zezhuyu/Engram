---
name: wiki-setup
description: Initialize or repair this repository's wiki structure. Use when the user says set up the wiki, initialize the knowledge base, fix the repo structure, create missing special files, or prepare the environment for `.content`, `raw`, `wiki/pages`, `output`, `freemind`, and QMD-backed retrieval.
---

# Wiki Setup — Repository Initialization

Prepare this repo for reliable wiki ingestion.

## Steps

1. Run `bash setup.sh`.
2. Ensure these directories exist:
   - `.content/`
   - `raw/`
   - `wiki/pages/`
   - `output/`
   - `freemind/`
3. Ensure these files exist:
   - `wiki/INDEX.md`
   - `wiki/LOG.md`
   - `AGENTS.md`
   - `.env`
4. Verify `.venv/bin/python` and `.venv/bin/pip` exist.
5. Verify the repo still follows `AGENTS.md`.
6. Verify helper scripts exist:
   - `.skills/llm-wiki/scripts/wiki_index_sync.py`
   - `.skills/llm-wiki/scripts/wiki_log_append.py`
   - `.skills/llm-wiki/scripts/qmd_sync.py`

## `wiki/INDEX.md`

Keep it as the master index of pages under `wiki/pages/`.
Group pages by topic/type when possible.

## `wiki/LOG.md`

Keep it as the chronological operation log for:
- wiki page create/modify/delete
- QMD sync-related wiki/raw changes
- failures during ingest or parse

## Success Criteria

Setup is complete when:
- repo structure exists
- Python environment works via `.venv`
- special files are present
- ingest skills can run without further bootstrap work
