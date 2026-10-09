#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class CreatorItem:
    platform: str
    url: str
    item_id: str | None = None
    title: str | None = None
    creator: str | None = None


def is_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_host(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def detect_platform(url: str, explicit: str) -> str:
    if explicit != "auto":
        return explicit
    host = normalize_host(url)
    if host in {"youtube.com", "m.youtube.com", "youtu.be"}:
        return "youtube"
    if host in {"xiaohongshu.com", "xhslink.com", "rednote.com"}:
        return "rednote"
    raise SystemExit(f"Unsupported creator platform for URL: {url}")


def choose_ytdlp_launcher() -> list[str]:
    if shutil.which("yt-dlp"):
        return ["yt-dlp"]
    if shutil.which("uvx"):
        return ["uvx", "--from", "yt-dlp", "yt-dlp"]
    if shutil.which("uv"):
        return ["uv", "tool", "run", "--from", "yt-dlp", "yt-dlp"]
    raise SystemExit("yt-dlp is required for creator discovery. Install yt-dlp or uv/uvx.")


def run_capture(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(cmd, capture_output=True, text=True)
    if check and completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or f"Command failed: {' '.join(cmd)}"
        raise SystemExit(message)
    return completed


def parse_json_stdout(stdout: str, context: str) -> dict:
    text = stdout.strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
        return {"value": data}
    except json.JSONDecodeError:
        # Fallback: find final JSON object in noisy output
        start = text.rfind("{")
        if start != -1:
            fragment = text[start:]
            try:
                data = json.loads(fragment)
                if isinstance(data, dict):
                    return data
                return {"value": data}
            except json.JSONDecodeError:
                pass
        raise SystemExit(f"Expected JSON output for {context}, got:\n{text}")


def unique_preserve_order(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def extract_rednote_note_id(url: str) -> str | None:
    match = re.search(r"/explore/([0-9a-z]{24})", url)
    return match.group(1) if match else None


def extract_youtube_video_id(url: str) -> str | None:
    parsed = urllib.parse.urlparse(url)
    host = normalize_host(url)
    if host == "youtu.be":
        value = parsed.path.strip("/")
        return value or None
    if "youtube.com" in host:
        if parsed.path == "/watch":
            query = urllib.parse.parse_qs(parsed.query)
            value = (query.get("v") or [None])[0]
            return value
        short_match = re.match(r"^/(shorts|live)/([A-Za-z0-9_-]{6,})", parsed.path)
        if short_match:
            return short_match.group(2)
    return None


def creator_profile_from_rednote_note(url: str) -> str | None:
    # Best effort: download single note metadata and use author_id.
    script = Path(__file__).resolve().parents[2] / "download-source" / "scripts" / "download_source.py"
    cmd = [
        sys.executable,
        str(script),
        url,
        "--content-dir",
        ".content",
        "--slug",
        "creator-seed",
    ]
    result = run_capture(cmd, check=False)
    if result.returncode != 0:
        return None
    payload = parse_json_stdout(result.stdout, "download_source")
    metadata_file = payload.get("metadata_file")
    if not metadata_file:
        return None
    meta_path = Path(str(metadata_file))
    if not meta_path.exists():
        return None
    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    author_id = (metadata.get("author_id") or "").strip()
    if not author_id:
        return None
    return f"https://www.xiaohongshu.com/user/profile/{author_id}"


def discover_youtube_creator_items(creator_url: str, max_items: int) -> list[CreatorItem]:
    def list_entries(feed_url: str, per_feed_limit: int) -> list[dict]:
        cmd = choose_ytdlp_launcher() + [
            "--flat-playlist",
            "--ignore-errors",
            "--dump-single-json",
        ]
        if per_feed_limit > 0:
            cmd += ["--playlist-items", f"1-{per_feed_limit}"]
        cmd.append(feed_url)
        completed = run_capture(cmd, check=False)
        if completed.returncode != 0:
            return []
        payload_text = completed.stdout.strip()
        if not payload_text or payload_text == "null":
            return []
        data = parse_json_stdout(payload_text, f"youtube discovery ({feed_url})")
        return [entry for entry in (data.get("entries") or []) if isinstance(entry, dict)]

    parsed = urllib.parse.urlparse(creator_url)
    path = parsed.path.rstrip("/")
    # Creator homepage routes should expand to videos / streams / shorts feeds.
    creator_root_patterns = (
        path.startswith("/@")
        or path.startswith("/channel/")
        or path.startswith("/c/")
        or path.startswith("/user/")
    )
    feed_urls: list[str]
    if creator_root_patterns and not re.search(r"/(videos|streams|shorts)$", path):
        feed_urls = [
            creator_url.rstrip("/") + "/videos",
            creator_url.rstrip("/") + "/streams",
            creator_url.rstrip("/") + "/shorts",
        ]
    else:
        feed_urls = [creator_url]

    # Keep per-feed discovery bounded in large creators while honoring max_items when set.
    per_feed_limit = max_items if max_items > 0 else 200
    entries: list[dict] = []
    for feed_url in feed_urls:
        entries.extend(list_entries(feed_url, per_feed_limit))

    urls: list[str] = []
    for entry in entries:
        webpage_url = (entry.get("webpage_url") or "").strip()
        item_url = (entry.get("url") or "").strip()
        video_id = (entry.get("id") or "").strip()

        resolved = ""
        if webpage_url.startswith("http"):
            resolved = webpage_url
        elif item_url.startswith("http"):
            resolved = item_url
        elif video_id and re.match(r"^[A-Za-z0-9_-]{6,}$", video_id):
            resolved = f"https://www.youtube.com/watch?v={video_id}"
        elif item_url and re.match(r"^[A-Za-z0-9_-]{6,}$", item_url):
            resolved = f"https://www.youtube.com/watch?v={item_url}"

        if resolved:
            urls.append(resolved)

    deduped = unique_preserve_order(urls)
    if max_items > 0:
        deduped = deduped[:max_items]

    return [
        CreatorItem(
            platform="youtube",
            url=url,
            item_id=extract_youtube_video_id(url),
        )
        for url in deduped
    ]


def extract_note_ids_from_text(text: str) -> list[str]:
    ids = re.findall(r"/explore/([0-9a-z]{24})", text)
    ids += re.findall(r'"noteId"\s*:\s*"([0-9a-z]{24})"', text)
    ids += re.findall(r'"id"\s*:\s*"([0-9a-z]{24})"', text)
    return unique_preserve_order(ids)


def fetch_text(url: str) -> str:
    cmd = [
        "curl",
        "-L",
        "--silent",
        "--show-error",
        "--compressed",
        "-A",
        "Mozilla/5.0",
        url,
    ]
    completed = run_capture(cmd, check=False)
    if completed.returncode != 0:
        return ""
    return completed.stdout


def discover_rednote_creator_items(creator_url: str, max_items: int) -> tuple[list[CreatorItem], list[str]]:
    warnings: list[str] = []
    note_id = extract_rednote_note_id(creator_url)
    if note_id:
        return [CreatorItem(platform="rednote", url=creator_url, item_id=note_id)], warnings

    profile_url = creator_url
    if "/explore/" in creator_url:
        derived = creator_profile_from_rednote_note(creator_url)
        if derived:
            profile_url = derived
        else:
            warnings.append("Could not derive Rednote creator profile from seed note URL.")

    candidate_note_ids: list[str] = []

    # Method 1: direct HTML.
    html = fetch_text(profile_url)
    if html:
        candidate_note_ids.extend(extract_note_ids_from_text(html))

    # Method 2: r.jina mirror fallback for anti-bot pages.
    if not candidate_note_ids:
        mirror_url = f"https://r.jina.ai/http://{urllib.parse.urlparse(profile_url).netloc}{urllib.parse.urlparse(profile_url).path}"
        query = urllib.parse.urlparse(profile_url).query
        if query:
            mirror_url += f"?{query}"
        mirror = fetch_text(mirror_url)
        if mirror:
            candidate_note_ids.extend(extract_note_ids_from_text(mirror))

    candidate_note_ids = unique_preserve_order(candidate_note_ids)
    if max_items > 0:
        candidate_note_ids = candidate_note_ids[:max_items]

    if not candidate_note_ids:
        warnings.append(
            "No Rednote note IDs were discoverable from this profile page. "
            "This commonly happens due to anti-bot rendering. "
            "Try providing direct /explore/ links or a note collection URL."
        )
        return [], warnings

    items = [
        CreatorItem(
            platform="rednote",
            url=f"https://www.xiaohongshu.com/explore/{item_id}",
            item_id=item_id,
        )
        for item_id in candidate_note_ids
    ]
    return items, warnings


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def yaml_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def slugify_ascii(value: str) -> str:
    lowered = value.strip().lower()
    lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
    return lowered.strip("-")


def read_existing_source_signatures(source_dir: Path) -> tuple[set[str], set[str], set[str]]:
    urls: set[str] = set()
    rednote_ids: set[str] = set()
    youtube_ids: set[str] = set()
    for page in source_dir.glob("*.md"):
        text = page.read_text(encoding="utf-8", errors="ignore")
        for url in re.findall(r"https?://[^\s)\]>'\"]+", text):
            urls.add(url)
            rid = extract_rednote_note_id(url)
            if rid:
                rednote_ids.add(rid)
            yid = extract_youtube_video_id(url)
            if yid:
                youtube_ids.add(yid)
        for rid in re.findall(r"\b[0-9a-z]{24}\b", text):
            rednote_ids.add(rid)
    return urls, rednote_ids, youtube_ids


def extract_raw_title(raw_text: str) -> str:
    lines = raw_text.splitlines()
    for idx, line in enumerate(lines):
        if line.strip() == "---":
            for next_line in lines[idx + 1: idx + 20]:
                if next_line.startswith("# "):
                    return next_line[2:].strip()
    for line in lines:
        if line.startswith("# "):
            return line[2:].strip()
    return "Untitled"


def extract_raw_field(raw_text: str, field_name: str) -> str | None:
    pattern = rf"^- {re.escape(field_name)}:\s*`?(.*?)`?$"
    for line in raw_text.splitlines():
        match = re.match(pattern, line.strip())
        if match:
            value = match.group(1).strip()
            return value or None
    return None


def find_first_existing(path_glob: list[Path]) -> Path | None:
    for path in path_glob:
        if path.exists():
            return path
    return None


def build_source_page_content(
    *,
    title: str,
    summary: str,
    raw_rel: str,
    created: str,
    updated: str,
    heading: str,
    platform: str,
    creator: str,
    item_id: str,
    original_url: str,
) -> str:
    raw_name = Path(raw_rel).name
    return "\n".join(
        [
            "---",
            f"title: {yaml_quote(title)}",
            "type: source",
            f"summary: {summary}",
            "sources:",
            f"- {raw_rel}",
            f"created: {yaml_quote(created)}",
            f"updated: {yaml_quote(updated)}",
            "language: en",
            "---",
            "",
            f"# {heading}",
            "",
            f"- **Platform:** {platform}",
            f"- **Creator:** {creator}",
            f"- **Item ID:** `{item_id}`",
            f"- **Original URL:** {original_url}",
            f"- **Raw source:** [[raw/{raw_name}|{raw_name}]]",
            "",
            "## What this source contributes",
            "",
            "- Batch-ingested source item from creator-level ingestion workflow.",
            "- Preserved for downstream concept synthesis and cross-linking.",
            "",
        ]
    )


def create_source_page_for_item(
    *,
    item: CreatorItem,
    ingest_payload: dict,
    source_dir: Path,
) -> Path:
    output_raw = Path(str(ingest_payload.get("output", ""))).resolve()
    if not output_raw.exists():
        raise SystemExit(f"Ingest output raw file not found: {output_raw}")
    raw_rel = output_raw.relative_to(Path.cwd()).as_posix()
    raw_text = output_raw.read_text(encoding="utf-8", errors="ignore")

    created = now_iso()
    updated = created

    if item.platform == "rednote":
        source_title = extract_raw_title(raw_text)
        creator = extract_raw_field(raw_text, "Author") or "Unknown"
        item_id = item.item_id or extract_rednote_note_id(item.url) or "unknown"
        page_title = f"{source_title} (Xiaohongshu)"
        heading = page_title
        summary = "Batch-ingested Rednote source note from creator homepage workflow."
        slug = f"rednote-note-{item_id}"
    else:
        download_info = ingest_payload.get("download") or {}
        download_dir = Path(str(ingest_payload.get("download_dir") or download_info.get("output_dir") or ""))
        info_json = find_first_existing(sorted(download_dir.glob("*.info.json"))) if download_dir else None
        title_from_info = None
        creator = "Unknown"
        item_id = item.item_id or extract_youtube_video_id(item.url) or "unknown"
        canonical_url = item.url
        if info_json:
            try:
                info = json.loads(info_json.read_text(encoding="utf-8", errors="ignore"))
                title_from_info = (info.get("title") or "").strip() or None
                creator = (info.get("channel") or info.get("uploader") or creator)
                item_id = (info.get("id") or item_id)
                canonical_url = (info.get("webpage_url") or canonical_url)
            except Exception:
                pass
        source_title = title_from_info or extract_raw_title(raw_text)
        page_title = f"{source_title} (YouTube)"
        heading = page_title
        summary = "Batch-ingested YouTube source item from creator homepage workflow."
        slug_base = slugify_ascii(source_title)[:64]
        slug = f"youtube-{slug_base}-{item_id}" if slug_base else f"youtube-video-{item_id}"
        item = CreatorItem(platform=item.platform, url=canonical_url, item_id=item_id, title=item.title, creator=creator)

    page_path = source_dir / f"{slug}.md"
    body = build_source_page_content(
        title=page_title,
        summary=summary,
        raw_rel=raw_rel,
        created=created,
        updated=updated,
        heading=heading,
        platform="Xiaohongshu" if item.platform == "rednote" else "YouTube",
        creator=item.creator or creator,
        item_id=item.item_id or item_id,
        original_url=item.url,
    )
    page_path.write_text(body + "\n", encoding="utf-8")
    return page_path


def run_script_json(script: Path, args: list[str], context: str) -> dict:
    cmd = [sys.executable, str(script)] + args
    completed = run_capture(cmd)
    return parse_json_stdout(completed.stdout, context)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Batch ingest creator content into raw + wiki source pages (YouTube + Rednote)."
    )
    parser.add_argument("creator_url", help="Creator homepage URL (YouTube channel or Rednote profile).")
    parser.add_argument("--platform", choices=["auto", "youtube", "rednote"], default="auto")
    parser.add_argument("--max-items", type=int, default=0, help="Limit items. 0 means no explicit limit.")
    parser.add_argument("--content-dir", default=".content")
    parser.add_argument("--raw-dir", default="raw")
    parser.add_argument("--source-dir", default="wiki/pages/sources")
    parser.add_argument("--skip-existing", action="store_true", default=True)
    parser.add_argument("--no-skip-existing", dest="skip_existing", action="store_false")
    parser.add_argument("--dry-run", action="store_true", help="Discover only; do not ingest/write/sync.")
    parser.add_argument("--no-qmd", action="store_true", help="Skip qmd_sync step.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not is_url(args.creator_url):
        raise SystemExit(f"Not a valid http/https URL: {args.creator_url}")

    repo_root = Path(__file__).resolve().parents[3]
    ingest_script = repo_root / ".skills" / "ingest-source" / "scripts" / "ingest_source.py"
    compiler_script = repo_root / ".skills" / "wiki-page-compiler" / "scripts" / "wiki_compile_packet.py"
    index_script = repo_root / ".skills" / "llm-wiki" / "scripts" / "wiki_index_sync.py"
    log_script = repo_root / ".skills" / "llm-wiki" / "scripts" / "wiki_log_append.py"
    qmd_script = repo_root / ".skills" / "llm-wiki" / "scripts" / "qmd_sync.py"

    source_dir = (repo_root / args.source_dir).resolve()
    source_dir.mkdir(parents=True, exist_ok=True)

    platform = detect_platform(args.creator_url, args.platform)

    discovery_warnings: list[str] = []
    if platform == "youtube":
        items = discover_youtube_creator_items(args.creator_url, args.max_items)
    else:
        items, discovery_warnings = discover_rednote_creator_items(args.creator_url, args.max_items)

    if args.max_items > 0:
        items = items[: args.max_items]

    existing_urls, existing_rednote_ids, existing_youtube_ids = read_existing_source_signatures(source_dir)

    skipped_existing: list[str] = []
    actionable: list[CreatorItem] = []
    for item in items:
        if not args.skip_existing:
            actionable.append(item)
            continue
        already = item.url in existing_urls
        if item.platform == "rednote" and item.item_id and item.item_id in existing_rednote_ids:
            already = True
        if item.platform == "youtube" and item.item_id and item.item_id in existing_youtube_ids:
            already = True
        if already:
            skipped_existing.append(item.url)
        else:
            actionable.append(item)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "creator_url": args.creator_url,
                    "platform": platform,
                    "discovered": len(items),
                    "to_process": len(actionable),
                    "skipped_existing": len(skipped_existing),
                    "items": [item.__dict__ for item in actionable],
                    "warnings": discovery_warnings,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    created_pages: list[Path] = []
    processed_raw: list[Path] = []
    processed_urls: list[str] = []

    for item in actionable:
        ingest_args = [
            item.url,
            "--content-dir",
            args.content_dir,
            "--raw-dir",
            args.raw_dir,
        ]
        ingest_payload = run_script_json(ingest_script, ingest_args, "ingest_source")
        raw_path = Path(str(ingest_payload.get("output", ""))).resolve()
        if not raw_path.exists():
            raise SystemExit(f"Expected raw output from ingest, missing: {raw_path}")

        run_capture([sys.executable, str(compiler_script), raw_path.relative_to(repo_root).as_posix()])
        page_path = create_source_page_for_item(item=item, ingest_payload=ingest_payload, source_dir=source_dir)

        created_pages.append(page_path)
        processed_raw.append(raw_path)
        processed_urls.append(item.url)

    if created_pages:
        run_capture([sys.executable, str(index_script)])

        ingest_log_args = [
            "INGEST",
            "--collection",
            "raw",
            "--collection",
            "wiki",
            "--message",
            f"Creator batch ingest from homepage: processed {len(created_pages)} items ({platform})",
            "--meta",
            f"platform={platform}",
            "--meta",
            f"creator_url={args.creator_url}",
            "--meta",
            f"discovered={len(items)}",
            "--meta",
            f"processed={len(created_pages)}",
            "--meta",
            f"skipped_existing={len(skipped_existing)}",
        ]
        for path in processed_raw:
            ingest_log_args += ["--path", path.relative_to(repo_root).as_posix()]
        for page in created_pages:
            ingest_log_args += ["--path", page.relative_to(repo_root).as_posix()]
        ingest_log_args += ["--path", "wiki/INDEX.md"]
        run_script_json(log_script, ingest_log_args, "wiki_log_append INGEST")

        if not args.no_qmd:
            qmd_payload = run_script_json(qmd_script, ["--collection", "all", "--embed"], "qmd_sync")
            qmd_log_args = [
                "QMD_SYNC",
                "--collection",
                "raw",
                "--collection",
                "wiki",
                "--message",
                "Indexed and embedded creator batch ingest documents",
                "--meta",
                f"platform={platform}",
                "--meta",
                f"embedded_documents={len(created_pages) + len(processed_raw)}",
            ]
            run_script_json(log_script, qmd_log_args, "wiki_log_append QMD_SYNC")
        else:
            qmd_payload = {"status": "skipped"}
    else:
        qmd_payload = {"status": "skipped-no-new-pages"}

    print(
        json.dumps(
            {
                "creator_url": args.creator_url,
                "platform": platform,
                "discovered": len(items),
                "processed": len(created_pages),
                "skipped_existing": len(skipped_existing),
                "processed_urls": processed_urls,
                "raw_files": [p.relative_to(repo_root).as_posix() for p in processed_raw],
                "source_pages": [p.relative_to(repo_root).as_posix() for p in created_pages],
                "warnings": discovery_warnings,
                "qmd": qmd_payload,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
