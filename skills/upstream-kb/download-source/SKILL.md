---
name: download-source
description: Download source material from YouTube, Rednote/Xiaohongshu, website pages, PDF URLs, WeChat posts, and direct file links into the workspace `.content/` directory. Use when Codex needs to preserve the original artifact before transcription or markdown conversion, including Rednote image-note posts that need HTML plus image capture.
---

# Download Source

Preserve the original source artifact inside `.content/` before any conversion work.

## Use this skill

Use this skill when a user provides a URL and the workspace should keep a local copy of the original source.

Default targets in this repo:
- original artifact: `.content/`
- downstream markdown/transcript: `raw/`

## Workflow

1. Normalize the URL into a dated job directory under `.content/`.
2. Save the source URL in `source-url.txt`.
3. Use `yt-dlp` for media-heavy platforms such as YouTube and Rednote when possible.
4. Fall back to HTML capture for Rednote/Xiaohongshu image-note posts and download the referenced images into an `images/` subdirectory.
5. Use `curl` for direct files, HTML pages, and WeChat article pages.
6. Return the primary downloaded file path as machine-readable JSON so another skill can continue the pipeline.

## Commands

Use the helper script directly:

```bash
bash setup.sh
.venv/bin/python .skills/download-source/scripts/download_source.py "<URL>" --content-dir .content
```

Install Python packages with `.venv/bin/pip` through `bash setup.sh`. The script still auto-detects `yt-dlp` from `PATH` for media-first platforms.

## Notes

- Treat WeChat posts as HTML capture, not as media downloads.
- Treat Rednote/Xiaohongshu as best-effort: upstream extractor support can change.
- For Rednote note-style posts, save `page.html`, `rednote.note.json`, and downloaded note images so OCR can happen downstream.
- Keep `.content/` as the immutable-ish source bucket; do conversion in a downstream skill instead of mutating the original file.
