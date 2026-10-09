#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
from pathlib import Path
import re


MEDIA_EXTENSIONS = {".mp3", ".wav", ".aiff", ".aif", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".webm", ".m4v"}
HTML_EXTENSIONS = {".html", ".htm"}
PDF_EXTENSIONS = {".pdf"}
TEXT_EXTENSIONS = {".md", ".txt", ".srt", ".vtt", ".json"}


def is_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def run_json(cmd: list[str]) -> dict:
    completed = subprocess.run(cmd, capture_output=True, text=True)
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or completed.stdout.strip() or f"Command failed: {' '.join(cmd)}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Expected JSON output from {' '.join(cmd)} but got:\n{completed.stdout}") from exc


def detect_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in MEDIA_EXTENSIONS:
        return "media"
    if suffix in PDF_EXTENSIONS:
        return "pdf"
    if suffix in HTML_EXTENSIONS:
        return "html"
    if suffix in TEXT_EXTENSIONS:
        return "text"
    raise SystemExit(f"Unsupported source type: {path}")


def choose_output_name(path: Path) -> str:
    parent_name = path.parent.name
    stem = path.stem
    if parent_name.startswith("20"):
        return f"{parent_name}.md"
    return f"{stem}.md"


def looks_chinese(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text or ""))


def infer_language_from_sidecar(source_path: Path) -> str | None:
    """
    Try to infer language from yt-dlp sidecar metadata.
    Returns an ASR language code like zh-CN / en-US or None.
    """
    try:
        candidates = sorted(source_path.parent.glob("*.info.json"))
    except Exception:
        return None
    if not candidates:
        return None
    info_path = candidates[0]
    try:
        info = json.loads(info_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None

    language = (info.get("language") or "").strip().lower()
    if language.startswith("zh"):
        return "zh-CN"
    if language.startswith("en"):
        return "en-US"

    title = str(info.get("title") or "")
    description = str(info.get("description") or "")
    channel = str(info.get("channel") or "")
    if looks_chinese(f"{title}\n{description}\n{channel}"):
        return "zh-CN"
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download or ingest a source into markdown")
    parser.add_argument("source")
    parser.add_argument("--content-dir", default=".content")
    parser.add_argument("--raw-dir", default="raw")
    parser.add_argument("--output")
    parser.add_argument("--slug")
    parser.add_argument("--backend", choices=["mlx", "nvidia", "nvidia-parakeet-zh"])
    parser.add_argument("--model")
    parser.add_argument("--language")
    parser.add_argument("--nvidia-api-key")
    parser.add_argument("--nvidia-function-id")
    parser.add_argument("--nvidia-uri")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    script_path = Path(__file__).resolve()
    skills_dir = script_path.parents[2]
    download_script = skills_dir / "download-source" / "scripts" / "download_source.py"
    convert_script = skills_dir / "convert-to-markdown" / "scripts" / "convert_to_markdown.py"
    transcribe_script = skills_dir / "transcribe-media" / "scripts" / "transcribe_media.py"

    if is_url(args.source):
        download_cmd = [
            sys.executable,
            str(download_script),
            args.source,
            "--content-dir",
            args.content_dir,
        ]
        if args.slug:
            download_cmd += ["--slug", args.slug]
        download_result = run_json(download_cmd)
        primary_path = Path(download_result["primary_file"]).resolve()
        source_path = primary_path
        download_dir = Path(download_result["output_dir"]).resolve()
    else:
        source_path = Path(args.source).expanduser().resolve()
        if not source_path.exists():
            raise SystemExit(f"Source file does not exist: {source_path}")
        download_result = None
        download_dir = source_path.parent

    raw_dir = Path(args.raw_dir).expanduser().resolve()
    raw_dir.mkdir(parents=True, exist_ok=True)
    output_path = Path(args.output).expanduser().resolve() if args.output else raw_dir / choose_output_name(source_path)

    kind = detect_kind(source_path)
    if kind == "media":
        cmd = [sys.executable, str(transcribe_script), str(source_path), "--output", str(output_path)]
        if args.backend:
            cmd += ["--backend", args.backend]
        if args.model:
            cmd += ["--model", args.model]
        resolved_language = args.language or infer_language_from_sidecar(source_path)
        if resolved_language:
            cmd += ["--language", resolved_language]
        if args.nvidia_api_key:
            cmd += ["--nvidia-api-key", args.nvidia_api_key]
        if args.nvidia_function_id:
            cmd += ["--nvidia-function-id", args.nvidia_function_id]
        if args.nvidia_uri:
            cmd += ["--nvidia-uri", args.nvidia_uri]
        transform_result = run_json(cmd)
    elif kind in {"pdf", "html", "text"}:
        cmd = [sys.executable, str(convert_script), str(source_path), "--output", str(output_path)]
        transform_result = run_json(cmd)
    else:
        raise SystemExit(f"Unsupported kind: {kind}")

    print(json.dumps({
        "source": args.source,
        "download": download_result,
        "detected_kind": kind,
        "source_file": str(source_path),
        "output": str(output_path),
        "transform": transform_result,
        "download_dir": str(download_dir),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
