---
name: prune-old-content
description: Remove old files or source folders from the workspace `.content/` directory when they are older than 14 days. Use when the user asks to prune, clean up, expire, or delete stale downloaded source artifacts from `.content`.
---

# Prune Old Content

Clean up stale artifacts in `.content/`.

This skill is for repository hygiene when the user explicitly wants old preserved source data removed.

## Default behavior

- target directory: `.content/`
- age threshold: `14` days
- preview first by default
- delete only when `--apply` is passed

## Deletion rule

The helper script evaluates **top-level entries inside `.content/`**:

- if the entry is a file and it is older than the threshold, it is removable
- if the entry is a folder, the script computes the **newest mtime anywhere inside the folder tree**
  - if that newest timestamp is still older than the threshold, the whole folder is removable
  - otherwise the folder is kept

This avoids deleting a source folder just because the folder itself is old while one file inside it was updated recently.

## Commands

Preview candidates:

```bash
bash setup.sh
.venv/bin/python .skills/prune-old-content/scripts/prune_old_content.py
```

Apply deletions:

```bash
bash setup.sh
.venv/bin/python .skills/prune-old-content/scripts/prune_old_content.py --apply
```

Custom threshold:

```bash
.venv/bin/python .skills/prune-old-content/scripts/prune_old_content.py --days 30
```

## Output

The script prints JSON with:

- mode (`preview` or `apply`)
- threshold days
- candidate count
- deleted count
- affected paths

## Notes

- Use this only for `.content/`, not for `raw/` or `wiki/pages/`
- This is destructive when `--apply` is used
- Preview first unless the user clearly requested deletion
