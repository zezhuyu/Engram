---
name: wiki-query
description: Answer questions from this compiled wiki. Use when the user asks what is in the knowledge base, what do I know about a topic, find related pages, summarize knowledge from `wiki/pages`, or wants a grounded answer that prefers the wiki before falling back to `raw` or `output`.
---

# Wiki Query — Knowledge Retrieval

Answer from the compiled wiki first.

## Retrieval Order

1. Search `wiki/pages/`
2. Search `output/` if the request is about memory, insight notes, or user-specific operational context
3. Search `raw/` only when the wiki is missing detail or needs grounding
4. Read `freemind/` only when the user's quick notes are relevant
5. Never answer directly from `.content/` unless reprocessing is required

## Response Style

- Prefer synthesized answers
- Cite page paths where useful
- Mention gaps explicitly
- If only raw material exists, say the topic is not yet compiled into the wiki

## Fast Path

For simple lookups:
- inspect `wiki/INDEX.md`
- then open only the most relevant page(s)

## If the wiki is missing something important
Offer to:
- create or update the relevant wiki page
- save useful synthesis into `output/`
