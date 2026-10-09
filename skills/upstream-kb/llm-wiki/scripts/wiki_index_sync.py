#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_WIKI_PAGES_DIR = REPO_ROOT / "wiki" / "pages"
DEFAULT_INDEX_FILE = REPO_ROOT / "wiki" / "Index.md"


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    frontmatter_text = text[4:end]
    body = text[end + 5 :]
    data = yaml.safe_load(frontmatter_text) or {}
    if not isinstance(data, dict):
        data = {}
    return data, body


def first_summary_line(body: str) -> str:
    lines = [line.strip() for line in body.splitlines()]
    chunks: list[str] = []
    for line in lines:
        if not line or line.startswith("#"):
            continue
        if line.startswith("-"):
            line = line.lstrip("- ").strip()
        chunks.append(line)
        if len(" ".join(chunks)) >= 160:
            break
    summary = " ".join(chunks).strip()
    return summary[:200].rstrip()


def normalize_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        if raw.startswith("[") and raw.endswith("]"):
            inner = raw[1:-1].strip()
            if not inner:
                return []
            return [part.strip().strip("'\"") for part in inner.split(",") if part.strip()]
        return [raw]
    return [str(value).strip()]


def group_name(frontmatter: dict[str, Any], relative_path: Path) -> str:
    page_type = str(frontmatter.get("type") or "").strip()
    if page_type:
        return page_type.replace("-", " ").replace("_", " ").title()
    parts = relative_path.parts
    if len(parts) > 1:
        return parts[0].replace("-", " ").replace("_", " ").title()
    return "Pages"


def format_entry(index_file: Path, page_file: Path, frontmatter: dict[str, Any], body: str) -> str:
    title = str(frontmatter.get("title") or page_file.stem.replace("-", " ").replace("_", " ").title()).strip()
    summary = str(frontmatter.get("summary") or first_summary_line(body) or "No summary yet.").strip()
    tags = normalize_tags(frontmatter.get("tags"))
    vault_link = page_file.relative_to(REPO_ROOT).with_suffix("").as_posix()
    line = f"- [[{vault_link}|{title}]]"
    if summary:
        line += f" — {summary}"
    if tags:
        tag_text = " ".join(f"#{tag}" for tag in tags)
        line += f" ( {tag_text} )"
    return line


def build_index(wiki_pages_dir: Path, index_file: Path) -> tuple[str, dict[str, int]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for page_file in sorted(wiki_pages_dir.rglob("*.md")):
        if not page_file.is_file():
            continue
        frontmatter, body = parse_frontmatter(page_file)
        rel = page_file.relative_to(wiki_pages_dir)
        groups[group_name(frontmatter, rel)].append(format_entry(index_file, page_file, frontmatter, body))

    timestamp = datetime.now(timezone.utc).isoformat()
    lines = [
        "---",
        "title: Wiki Index",
        f"updated: {timestamp}",
        "generated_by: .skills/llm-wiki/scripts/wiki_index_sync.py",
        "---",
        "",
        "# Wiki Index",
        "",
        f"*This index is automatically maintained. Last updated: {timestamp}*",
        "",
    ]
    counts: dict[str, int] = {}
    if not groups:
        lines.extend(["## Pages", "", "*No wiki pages yet.*", ""])
    else:
        for name in sorted(groups):
            lines.append(f"## {name}")
            lines.append("")
            entries = sorted(groups[name], key=str.casefold)
            counts[name] = len(entries)
            lines.extend(entries)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n", counts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild wiki/INDEX.md from wiki/pages")
    parser.add_argument("--wiki-pages-dir", default=str(DEFAULT_WIKI_PAGES_DIR))
    parser.add_argument("--index-file", default=str(DEFAULT_INDEX_FILE))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    wiki_pages_dir = Path(args.wiki_pages_dir).expanduser().resolve()
    index_file = Path(args.index_file).expanduser().resolve()
    wiki_pages_dir.mkdir(parents=True, exist_ok=True)
    index_file.parent.mkdir(parents=True, exist_ok=True)
    content, counts = build_index(wiki_pages_dir, index_file)
    index_file.write_text(content, encoding="utf-8")
    result = {
        "index_file": str(index_file),
        "wiki_pages_dir": str(wiki_pages_dir),
        "groups": counts,
        "total_pages": sum(counts.values()),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
