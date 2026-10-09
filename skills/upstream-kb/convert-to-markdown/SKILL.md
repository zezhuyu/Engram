---
name: convert-to-markdown
description: Convert local PDF, HTML, and image files into markdown suitable for retrieval and wiki ingestion. Use when Codex has already downloaded or received a document and needs a clean markdown representation for `raw/` or another analysis step, including OCR of text embedded in images.
---

# Convert to Markdown

Convert downloaded documents into markdown without storing long raw passages in `wiki/`.

## Use this skill

Use this skill for local files, especially:
- PDF files
- saved HTML pages
- image files that contain text
- direct web page captures

Default targets in this repo:
- source file: `.content/`
- markdown output: `raw/`

## Workflow

1. Detect the file type from the local path.
2. Convert PDFs with `pymupdf4llm`.
3. Fall back to `pdftotext` if PDF markdown extraction fails.
4. Convert HTML with `trafilatura` and keep links when possible.
5. OCR image files with `rapidocr_onnxruntime`.
6. For Rednote HTML captures, combine the post text with OCR from downloaded note images.
7. Write a markdown file with conversion metadata plus extracted content.

## Commands

```bash
bash setup.sh
.venv/bin/python .skills/convert-to-markdown/scripts/convert_to_markdown.py \
  .content/<file>.pdf \
  --output raw/<name>.md
```

## Notes

- Prefer PDF or HTML conversion before wiki synthesis.
- Install dependencies with `.venv/bin/pip install -r requirements.txt` or just run `bash setup.sh`.
- Include `rapidocr_onnxruntime` when the source may contain image text.
- Keep the generated markdown in `raw/` so later wiki pages can cite it.
- If a page is noisy, inspect the saved HTML and rerun conversion before editing the wiki.
