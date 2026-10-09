---
name: wiki-ingest
description: Ingest URLs, files, and staged content into this repository's wiki. Use when the user says add this to the wiki, ingest this source, process this URL, build wiki pages from a document, or turn `.content` and `raw` material into English pages under `wiki/pages`.
---

# Wiki Ingest — Source to Wiki

This is the main high-level ingest workflow.

## Before Starting

1. Run `bash setup.sh`
2. Read `AGENTS.md`
3. Read `wiki/INDEX.md` and `wiki/LOG.md`
4. Inspect existing `wiki/pages/` for overlap

## Preferred Pipeline

### If the user gives a URL
1. Use `$download-source` or `$ingest-source`
2. Preserve the artifact in `.content/`
3. Ensure converted markdown/transcript lands in `raw/`
4. Run `$wiki-page-compiler` on the resulting `raw/*.md`
5. Read the raw markdown
6. Update existing wiki pages when possible
7. Create new English pages only when the topic is genuinely new
7. Run:
   - `.venv/bin/python .skills/llm-wiki/scripts/wiki_index_sync.py`
8. Append a log entry with:
   - `.venv/bin/python .skills/llm-wiki/scripts/wiki_log_append.py`
9. Sync `raw` and `wiki` into QMD with:
   - `.venv/bin/python .skills/llm-wiki/scripts/qmd_sync.py`

### If the user gives a file already in `.content/`
1. Use `$convert-to-markdown`, `$transcribe-media`, or `$ingest-source`
2. Write the result to `raw/`
3. Run `$wiki-page-compiler`
4. Compile to `wiki/pages/`
5. Update index/log/QMD with the helper scripts above

### If the user gives a raw markdown file
1. Treat it as grounding input
2. Run `.venv/bin/python .skills/wiki-page-compiler/scripts/wiki_compile_packet.py raw/<file>.md`
3. Distill it into English wiki pages
4. Do not simply copy it into the wiki

## Writing Rules

- Use English in `wiki/pages/`
- Cite `raw/` sources
- Prefer synthesis over repetition
- Add relative markdown links to related pages
- Keep pages stable and reusable

## Logging

Whenever ingest changes the wiki, append a dated line to `wiki/LOG.md` with:
- action
- affected files
- short reason

Prefer the helper:

```bash
.venv/bin/python .skills/llm-wiki/scripts/wiki_log_append.py INGEST --path raw/file.md --path wiki/pages/page.md --collection raw --collection wiki --message "Compiled source into wiki"
```
