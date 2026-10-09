#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_WIKI_DIR = REPO_ROOT / "wiki" / "pages"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "wiki" / "meta" / "compile-packets"

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
TOKEN_RE = re.compile(r"[A-Za-z0-9]+|[\u4e00-\u9fff]+")


@dataclass
class PageCandidate:
    path: Path
    title: str
    page_type: str
    summary: str
    tags: list[str]
    sources: list[str]
    score: float
    exact_source_match: bool


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    frontmatter_text = text[4:end]
    body = text[end + 5 :]
    data: dict[str, Any] = {}
    current_key: str | None = None
    for raw_line in frontmatter_text.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        if line.lstrip().startswith("- ") and current_key:
            data.setdefault(current_key, [])
            if isinstance(data[current_key], list):
                data[current_key].append(line.split("- ", 1)[1].strip().strip('"').strip("'"))
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        current_key = key.strip()
        stripped = value.strip()
        if not stripped:
            data[current_key] = []
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            inner = stripped[1:-1].strip()
            data[current_key] = [
                part.strip().strip('"').strip("'")
                for part in inner.split(",")
                if part.strip()
            ]
        else:
            data[current_key] = stripped.strip('"').strip("'")
    return data, body


def body_without_converter_prelude(text: str) -> str:
    if "\n---\n" not in text:
        return text
    return text.split("\n---\n", 1)[1].lstrip()


def parse_sections(body: str) -> tuple[str, dict[str, list[str]]]:
    title = ""
    sections: dict[str, list[str]] = {}
    current = "__root__"
    sections[current] = []
    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        match = HEADING_RE.match(line)
        if match:
            heading_text = match.group(2).strip()
            if match.group(1) == "#" and not title:
                title = heading_text
            current = heading_text
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line)
    return title, sections


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def collect_section_text(sections: dict[str, list[str]], names: list[str]) -> str:
    chunks: list[str] = []
    lowered_map = {name.lower(): name for name in sections}
    for desired in names:
        actual = lowered_map.get(desired.lower())
        if actual:
            chunks.extend(sections.get(actual, []))
    return "\n".join(chunks).strip()


def first_nonempty_paragraph(text: str) -> str:
    parts = [normalize_whitespace(chunk) for chunk in text.split("\n\n")]
    for part in parts:
        if part:
            return part
    return ""


def tokenize(text: str) -> set[str]:
    return {match.group(0).lower() for match in TOKEN_RE.finditer(text or "")}


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
            return [part.strip().strip('"').strip("'") for part in inner.split(",") if part.strip()]
        return [raw]
    return [str(value).strip()]


def clean_tag(value: str) -> str:
    cleaned = value.strip().lstrip("#")
    cleaned = re.sub(r"\[.*$", "", cleaned).strip()
    return cleaned


def guess_page_type(title: str, excerpt: str) -> str:
    combined = f"{title} {excerpt}".lower()
    if any(keyword in combined for keyword in ["workflow", "pipeline", "process", "playbook", "strategy", "prompt"]):
        return "workflow"
    if any(keyword in combined for keyword in ["ability", "thinking", "mechanism", "model", "principle", "concept"]):
        return "concept"
    if any(keyword in combined for keyword in ["vs ", "versus", "compare", "comparison"]):
        return "comparison"
    return "topic"


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    return text.strip("-")


def guess_slug(title: str, raw_path: Path) -> str:
    slug = slugify(title)
    if slug:
        return slug
    fallback = slugify(raw_path.stem)
    return fallback or "wiki-page"


def guess_subdir(page_type: str) -> str:
    mapping = {
        "concept": "concepts",
        "entity": "entities",
        "topic": "topics",
        "workflow": "topics",
        "comparison": "comparisons",
        "overview": "overview",
    }
    return mapping.get(page_type, "topics")


def title_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def overlap_score(raw_title: str, raw_excerpt: str, raw_tags: list[str], frontmatter: dict[str, Any], body: str) -> float:
    page_title = str(frontmatter.get("title") or "").strip()
    page_summary = str(frontmatter.get("summary") or "").strip()
    page_tags = normalize_tags(frontmatter.get("tags"))
    page_text = " ".join([page_title, page_summary, " ".join(page_tags), body[:600]])
    raw_tokens = tokenize(" ".join([raw_title, raw_excerpt, " ".join(raw_tags)]))
    page_tokens = tokenize(page_text)
    token_overlap = len(raw_tokens & page_tokens) / max(len(raw_tokens), 1)
    title_score = title_similarity(raw_title, page_title) if raw_title and page_title else 0.0
    return min(1.0, token_overlap * 0.6 + title_score * 0.4)


def collect_candidates(raw_path: Path, raw_title: str, raw_excerpt: str, raw_tags: list[str], wiki_dir: Path) -> list[PageCandidate]:
    raw_rel = raw_path.relative_to(REPO_ROOT).as_posix()
    candidates: list[PageCandidate] = []
    for path in sorted(wiki_dir.rglob("*.md")):
        if not path.is_file():
            continue
        frontmatter, body = parse_frontmatter(path)
        sources = normalize_tags(frontmatter.get("sources"))
        exact = raw_rel in sources or any(source.endswith(raw_path.name) for source in sources)
        score = overlap_score(raw_title, raw_excerpt, raw_tags, frontmatter, body)
        if exact:
            score = max(score, 0.99)
        candidates.append(
            PageCandidate(
                path=path,
                title=str(frontmatter.get("title") or path.stem.replace("-", " ").title()).strip(),
                page_type=str(frontmatter.get("type") or "").strip() or "page",
                summary=str(frontmatter.get("summary") or "").strip(),
                tags=normalize_tags(frontmatter.get("tags")),
                sources=sources,
                score=score,
                exact_source_match=exact,
            )
        )
    return sorted(candidates, key=lambda item: (-item.score, item.path.as_posix()))


def build_packet(raw_path: Path, wiki_dir: Path, output_dir: Path, max_related: int) -> dict[str, Any]:
    raw_text = raw_path.read_text(encoding="utf-8", errors="ignore")
    body = body_without_converter_prelude(raw_text)
    raw_title, sections = parse_sections(body)
    post_text = collect_section_text(sections, ["Post Text"])
    tags_text = collect_section_text(sections, ["Tags"])
    excerpt = first_nonempty_paragraph(post_text) or first_nonempty_paragraph(body)

    raw_tags = []
    if tags_text:
        raw_tags.extend([clean_tag(tag) for tag in re.split(r"[,，\s]+", tags_text) if clean_tag(tag)])
    for hashtag in re.findall(r"#([^\s#,\]，]+)", post_text):
        cleaned = clean_tag(hashtag)
        if cleaned and cleaned not in raw_tags:
            raw_tags.append(cleaned)

    guessed_type = guess_page_type(raw_title, excerpt)
    guessed_slug = guess_slug(raw_title, raw_path)
    guessed_subdir = guess_subdir(guessed_type)
    suggested_path = Path("wiki") / "pages" / guessed_subdir / f"{guessed_slug}.md"
    candidates = collect_candidates(raw_path, raw_title, excerpt, raw_tags, wiki_dir)
    exact_matches = [item for item in candidates if item.exact_source_match]
    related = [item for item in candidates if not item.exact_source_match][:max_related]

    if exact_matches:
        action = "update_existing"
        target_path = exact_matches[0].path.relative_to(REPO_ROOT).as_posix()
    else:
        action = "create_new"
        target_path = suggested_path.as_posix()
        if related and related[0].score >= 0.22:
            action = "review_overlap_before_create"

    timestamp = datetime.now(timezone.utc).isoformat()
    relative_raw_from_suggested = Path("..") / ".." / ".." / raw_path.relative_to(REPO_ROOT)
    source_ref = relative_raw_from_suggested.as_posix()
    packet_path = output_dir / f"{raw_path.stem}.compiler.md"

    packet = {
        "generated": timestamp,
        "raw_file": raw_path.relative_to(REPO_ROOT).as_posix(),
        "raw_title": raw_title or raw_path.stem,
        "raw_excerpt": excerpt,
        "raw_tags": raw_tags,
        "suggested_type": guessed_type,
        "suggested_slug": guessed_slug,
        "suggested_path": suggested_path.as_posix(),
        "suggested_action": action,
        "target_path": target_path,
        "packet_file": packet_path.relative_to(REPO_ROOT).as_posix(),
        "exact_matches": [
            {
                "path": item.path.relative_to(REPO_ROOT).as_posix(),
                "title": item.title,
                "type": item.page_type,
                "score": round(item.score, 3),
            }
            for item in exact_matches
        ],
        "related_pages": [
            {
                "path": item.path.relative_to(REPO_ROOT).as_posix(),
                "title": item.title,
                "type": item.page_type,
                "score": round(item.score, 3),
            }
            for item in related
        ],
    }

    tag_lines = "\n".join(f"  - {tag}" for tag in raw_tags[:8]) or "  - <tag>"
    related_lines = "\n".join(
        f"- `{entry['path']}` — {entry['title']} (score {entry['score']})"
        for entry in packet["related_pages"]
    ) or "- No strong related pages detected."
    exact_lines = "\n".join(
        f"- `{entry['path']}` — {entry['title']} (score {entry['score']})"
        for entry in packet["exact_matches"]
    ) or "- No exact source-linked page found."

    markdown = f"""---
title: Compile Packet — {packet['raw_title']}
raw_file: {packet['raw_file']}
generated: {timestamp}
---

# Wiki Compile Packet

## Source

- Raw file: `{packet['raw_file']}`
- Source title: `{packet['raw_title']}`
- Suggested action: `{action}`
- Suggested page type: `{guessed_type}`
- Suggested output path: `{target_path}`

## Exact Source Matches

{exact_lines}

## Related Existing Pages

{related_lines}

## Source Excerpt

{excerpt or '*No concise excerpt detected.*'}

## Source Tags

{", ".join(f"#{tag}" for tag in raw_tags) if raw_tags else "*No tags detected.*"}

## Compiler Checklist

- Write the final wiki page in English.
- Keep the opening summary short and durable.
- Preserve the source's meaning rather than translating line by line.
- Update an existing page instead of creating a near-duplicate.
- Use Obsidian `[[wikilink]]` syntax for internal mentions.
- Keep raw evidence in `raw/`, not in the final wiki page body.

## Suggested Frontmatter

```yaml
---
title: <English page title>
type: {guessed_type}
summary: <one-sentence English summary>
sources:
  - {source_ref}
created: {timestamp}
updated: {timestamp}
language: en
tags:
{tag_lines}
---
```

## Suggested Page Skeleton

```md
# <English page title>

<Short definition or summary.>

## Core Idea

- ...

## Why It Matters

- ...

## Key Structure

- ...

## Notes and Limits

- ...

## Related Pages

- [[wiki/pages/<subdir>/<slug>|<Related page>]]

## Sources

- [[{raw_path.relative_to(REPO_ROOT).with_suffix('').as_posix()}|{raw_path.name}]]
```
"""

    output_dir.mkdir(parents=True, exist_ok=True)
    packet_path.write_text(markdown, encoding="utf-8")
    return packet


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a compile packet for turning raw markdown into wiki pages.")
    parser.add_argument("raw_files", nargs="+", help="raw markdown files to inspect")
    parser.add_argument("--wiki-dir", default=str(DEFAULT_WIKI_DIR))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--max-related", type=int, default=5)
    parser.add_argument("--json", action="store_true", help="Print JSON result only")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    wiki_dir = Path(args.wiki_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    wiki_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for raw_value in args.raw_files:
        raw_path = Path(raw_value).expanduser()
        if not raw_path.is_absolute():
            raw_path = (Path.cwd() / raw_path).resolve()
        if not raw_path.exists():
            raise SystemExit(f"Raw file does not exist: {raw_path}")
        results.append(build_packet(raw_path, wiki_dir, output_dir, args.max_related))

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
