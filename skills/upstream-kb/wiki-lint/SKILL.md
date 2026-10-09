---
name: wiki-lint
description: Audit the health of this repository's wiki. Use when the user asks for a wiki audit, lint, health check, duplicate detection, orphan pages, missing links, stale pages, missing source references, or wants the wiki and QMD state checked for consistency.
---

# Wiki Lint — Health Audit

Audit the wiki as a maintained knowledge system.

## Checks

1. Duplicate or overlapping pages in `wiki/pages/`
2. Broken relative links between wiki pages
3. Orphan or weakly linked pages
4. Pages missing source references to `raw/`
5. Pages that appear stale relative to newer `raw/` material
6. `wiki/INDEX.md` entries missing or outdated
7. `wiki/LOG.md` missing operations after major wiki changes
8. QMD `wiki` and `raw` collection drift when relevant metadata is available

## Repair Strategy

- Prefer updating existing pages over creating new ones
- Merge near-duplicates
- Add links between related pages
- Fix page titles and summaries when they drift
- Log meaningful repairs in `wiki/LOG.md`

## Report Format

Summarize by category:
- duplicates
- broken links
- orphan pages
- stale pages
- index/log inconsistencies
- QMD sync concerns
