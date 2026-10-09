---
name: ingest-source
description: "Run the full source-ingest pipeline for a URL or local file: download into `.content/`, route by type, and generate markdown or transcripts in `raw/`. Use when Codex should do the whole capture-to-markdown workflow for learning material in one step, including OCR when a source stores key information inside images."
---

# Ingest Source

Run the end-to-end capture pipeline for learning material.

## Use this skill

Use this skill when a user wants one command that:
1. downloads a remote source into `.content/`, or accepts a local file,
2. detects whether the artifact is media, PDF, or HTML,
3. produces markdown in `raw/`.

## Workflow

1. Download remote sources with `$download-source` behavior.
2. Route media files to `$transcribe-media`.
3. Route PDF and HTML files to `$convert-to-markdown`.
4. Return both the preserved source path and the generated markdown path.

## Command

```bash
bash setup.sh
.venv/bin/python .skills/ingest-source/scripts/ingest_source.py \
  "<URL-or-local-file>" \
  --content-dir .content \
  --raw-dir raw
```

For NVIDIA hosted ASR on media inputs:

```bash
export NVIDIA_API_KEY=<your-key>
.venv/bin/python .skills/ingest-source/scripts/ingest_source.py \
  "<URL-or-local-file>" \
  --content-dir .content \
  --raw-dir raw \
  --backend nvidia \
  --language zh-CN
```

## Notes

- Use this skill for the default happy path.
- Use the lower-level sibling skills when a step needs manual control or retry.
- Set `NVIDIA_API_KEY` in the repo `.env` or your shell to make NVIDIA the default transcription backend.
- Pass `--language en-US` or `--language zh-CN` to choose the matching hosted Parakeet endpoint.
- This skill is intentionally single-item and conservative; avoid playlist-style URLs unless you explicitly want multiple downloads.
