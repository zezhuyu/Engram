---
name: tag-taxonomy
description: Normalize and audit wiki tags for this repository. Use when the user says fix my tags, normalize tags, audit taxonomy, or when new wiki pages need a consistent tag vocabulary across `wiki/pages` and the index.
---

# Tag Taxonomy — Controlled Vocabulary

Keep tagging consistent and simple.

## Rules

- use a small stable vocabulary
- prefer lowercase tags
- prefer broad, reusable tags over overly narrow one-off tags
- do not let tags replace actual page links

## Audit Tasks

- find inconsistent variants
- find over-tagged pages
- find untagged pages if tagging is used in the repo
- propose canonical replacements

## Repository Adaptation

If no taxonomy file exists yet, infer a lightweight vocabulary from existing `wiki/pages/` and record proposals in `output/tag-taxonomy.md`.
