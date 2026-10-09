---
name: wiki-rebuild
description: Rebuild or archive this repository's wiki state. Use when the user explicitly wants to archive, restore, start over, or rebuild the curated wiki from raw sources because the current wiki has drifted too far from the source material.
---

# Wiki Rebuild — Archive and Recompile

This is a destructive workflow.

## Use Carefully

Before destructive changes:
1. archive the current wiki state into `output/archives/`
2. preserve `wiki/INDEX.md`, `wiki/LOG.md`, and page snapshots in the archive
3. only then rebuild from `raw/`

## Modes

- archive only
- archive + rebuild
- restore from archive

## Rebuild Principle

After archiving, rebuild by re-reading `raw/` and recompiling `wiki/pages/` in English.
Do not destroy `.content/` or `raw/` originals.
