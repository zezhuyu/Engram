#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)



def require_module(name: str, help_text: str):
    try:
        return __import__(name)
    except ModuleNotFoundError:
        raise SystemExit(help_text)



def convert_pdf(path: Path) -> tuple[str, str]:
    try:
        pymupdf4llm = require_module(
            "pymupdf4llm",
            "Missing pymupdf4llm. Run with: uv run --with pymupdf4llm -- python ...",
        )
        markdown = pymupdf4llm.to_markdown(str(path))
        if markdown and markdown.strip():
            return markdown.strip() + "\n", "pymupdf4llm"
    except Exception:
        pass

    completed = subprocess.run(["pdftotext", str(path), "-"], capture_output=True, text=True)
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or f"Failed to extract PDF text from {path}")
    return completed.stdout.strip() + "\n", "pdftotext"



def ocr_image(path: Path) -> str:
    rapidocr = require_module(
        "rapidocr_onnxruntime",
        "Missing rapidocr_onnxruntime. Run with: uv run --with rapidocr_onnxruntime -- python ...",
    )
    engine = rapidocr.RapidOCR()
    result, _ = engine(str(path))
    if not result:
        return ""
    lines = []
    for item in result:
        if len(item) >= 2 and item[1]:
            lines.append(str(item[1]).strip())
    return "\n".join(line for line in lines if line)



def convert_image(path: Path) -> tuple[str, str]:
    text = ocr_image(path).strip()
    lines = [f"# Image OCR: {path.name}", "", f"- Source image: `{path}`", ""]
    if text:
        lines.extend(["## OCR Text", "", text, ""])
    else:
        lines.extend(["No text detected.", ""])
    return "\n".join(lines), "image-ocr"



def convert_rednote_html(path: Path) -> tuple[str, str]:
    metadata_path = path.parent / "rednote.note.json"
    if not metadata_path.exists():
        raise FileNotFoundError(metadata_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    lines = [
        f"# {metadata.get('title') or path.name}",
        "",
        "- Platform: `rednote`",
        f"- Author: `{metadata.get('author') or ''}`",
        f"- Note ID: `{metadata.get('note_id') or ''}`",
        f"- Source URL: `{metadata.get('source_url') or ''}`",
        f"- Final URL: `{metadata.get('final_url') or ''}`",
        "",
    ]
    desc = (metadata.get("desc") or "").strip()
    if desc:
        lines.extend(["## Post Text", "", desc, ""])
    tags = metadata.get("tags") or []
    if tags:
        lines.extend(["## Tags", "", ", ".join(f"#{tag}" for tag in tags), ""])

    local_images = [Path(p) for p in metadata.get("local_images") or [] if Path(p).exists()]
    if local_images:
        lines.extend(["## Images", ""])
        for image_path in local_images:
            lines.append(f"### {image_path.name}")
            lines.append("")
            lines.append(f"![]({image_path})")
            lines.append("")
            ocr_text = ocr_image(image_path).strip()
            if ocr_text:
                lines.extend(["#### OCR", "", ocr_text, ""])
            else:
                lines.extend(["#### OCR", "", "No text detected.", ""])
    return "\n".join(lines).rstrip() + "\n", "rednote-html+ocr"



def convert_html(path: Path) -> tuple[str, str]:
    metadata_path = path.parent / "rednote.note.json"
    if metadata_path.exists():
        return convert_rednote_html(path)

    trafilatura = require_module(
        "trafilatura",
        "Missing trafilatura. Run with: uv run --with trafilatura -- python ...",
    )
    html = path.read_text(encoding="utf-8", errors="ignore")
    markdown = trafilatura.extract(
        html,
        output_format="markdown",
        include_links=True,
        include_images=False,
        favor_recall=True,
        deduplicate=True,
    )
    if markdown and markdown.strip():
        return markdown.strip() + "\n", "trafilatura"
    parser = TextExtractor()
    parser.feed(html)
    return "\n\n".join(parser.parts).strip() + "\n", "html-parser-fallback"



def convert_text_like(path: Path) -> tuple[str, str]:
    return path.read_text(encoding="utf-8", errors="ignore"), "plain-text"



def detect_converter(path: Path) -> tuple[str, str]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return convert_pdf(path)
    if suffix in {".html", ".htm"}:
        return convert_html(path)
    if suffix in IMAGE_SUFFIXES:
        return convert_image(path)
    if suffix in {".md", ".txt", ".json", ".srt", ".vtt"}:
        return convert_text_like(path)
    raise SystemExit(f"Unsupported input for markdown conversion: {path}")



def build_document(path: Path, body: str, converter: str) -> str:
    timestamp = datetime.now(timezone.utc).isoformat()
    header = [
        f"# Converted source: {path.name}",
        "",
        f"- Source file: `{path}`",
        f"- Converter: `{converter}`",
        f"- Generated: `{timestamp}`",
        "",
        "---",
        "",
    ]
    return "\n".join(header) + body.lstrip("\n")



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert PDF or HTML into markdown")
    parser.add_argument("input_path")
    parser.add_argument("--output")
    return parser.parse_args()



def main() -> int:
    args = parse_args()
    input_path = Path(args.input_path).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Input file does not exist: {input_path}")
    output_path = Path(args.output).expanduser().resolve() if args.output else input_path.with_suffix(".md")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    body, converter = detect_converter(input_path)
    document = build_document(input_path, body, converter)
    output_path.write_text(document, encoding="utf-8")
    print(json.dumps({
        "input": str(input_path),
        "output": str(output_path),
        "converter": converter,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
