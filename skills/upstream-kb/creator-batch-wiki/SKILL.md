---
name: creator-batch-wiki
description: Batch-ingest a creator homepage (YouTube or Rednote) and create wiki source pages for discovered videos/notes.
---

# Creator Batch Wiki

Use this when the user gives a **creator homepage** and wants to ingest many items at once.

## What it does

1. Discover creator items from homepage URL
   - YouTube: channel/handle pages (best support)
   - Rednote/Xiaohongshu: best-effort profile discovery
2. Ingest each discovered item into `.content/` + `raw/`
3. Generate compile packets for each raw file
4. Create `wiki/pages/sources/*.md` source pages
5. Sync `wiki/INDEX.md`, append `wiki/LOG.md`, and run QMD embed sync

## Command

```bash
bash setup.sh
.venv/bin/python .skills/creator-batch-wiki/scripts/creator_batch_wiki.py \
  "<creator-homepage-url>" \
  --max-items 0
```

### Useful options

- `--max-items 20` → limit scope
- `--dry-run` → discover only, no writes
- `--no-skip-existing` → reprocess even if already in wiki
- `--no-qmd` → skip QMD sync/embed
- `--platform youtube|rednote` → force platform detection

## Notes / caveats

- **YouTube:** works well for channel/handle pages.
- **Rednote:** profile pages are anti-bot and may hide note IDs server-side. If IDs are not discoverable, the script reports a warning and asks for direct `/explore/...` links.
- For large creators, start with `--dry-run` + small `--max-items` before full ingest.

## Example

```bash
.venv/bin/python .skills/creator-batch-wiki/scripts/creator_batch_wiki.py \
  "https://www.youtube.com/@OpenAI" \
  --max-items 10
```
