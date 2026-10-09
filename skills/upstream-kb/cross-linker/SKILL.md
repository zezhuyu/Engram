---
name: cross-linker
description: Discover and add missing cross-links between wiki pages. Use when the user says link my pages, connect the wiki, add cross references, fix orphan pages, or after a large ingest when new pages need to be woven into the rest of `wiki/pages`.
---

# Cross-Linker — Weave the Wiki Graph

Strengthen connectivity in `wiki/pages/`.

## Workflow

1. Build a page registry from `wiki/pages/`
2. Read `wiki/INDEX.md` for quick summaries
3. Find pages that mention concepts/entities already represented elsewhere without linking to them
4. Add natural relative markdown links where they improve navigation
5. Prefer linking the first clear mention instead of over-linking every repetition
6. Update `wiki/LOG.md` when links are added in a meaningful batch

## Focus Areas

- newly created pages
- orphan pages
- pages sharing the same sources or topic cluster
- concept/entity/workflow pages that should reference each other
