#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

WECHAT_HOST_HINTS = {
    "mp.weixin.qq.com",
}

MEDIA_HOST_HINTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "music.youtube.com",
    "vimeo.com",
    "www.vimeo.com",
    "bilibili.com",
    "www.bilibili.com",
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
    "rednote.com",
    "www.rednote.com",
}
REDNOTE_HOST_HINTS = {
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
    "rednote.com",
    "www.rednote.com",
}
IGNORED_OUTPUT_NAMES = {"source-url.txt"}
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
}


def slugify(value: str) -> str:
    value = re.sub(r"https?://", "", value)
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "source"



def is_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)



def normalized_host(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host



def should_use_ytdlp(url: str) -> bool:
    return normalized_host(url) in {h[4:] if h.startswith('www.') else h for h in MEDIA_HOST_HINTS}



def is_rednote_url(url: str) -> bool:
    return normalized_host(url) in {h[4:] if h.startswith('www.') else h for h in REDNOTE_HOST_HINTS}



def is_wechat_url(url: str) -> bool:
    return normalized_host(url) in WECHAT_HOST_HINTS



def find_wechat_tool() -> str:
    candidate = Path.home() / ".local" / "bin" / "wechat-article-to-markdown"
    if candidate.exists():
        return str(candidate)
    if shutil.which("wechat-article-to-markdown"):
        return "wechat-article-to-markdown"
    raise SystemExit(
        "wechat-article-to-markdown not found. "
        "Install with: uv tool install wechat-article-to-markdown"
    )



def download_with_wechat(url: str, job_dir: Path, verbose: bool) -> dict[str, object]:
    tool = find_wechat_tool()
    completed = subprocess.run([tool, url], capture_output=True, text=True)
    combined = completed.stdout + completed.stderr
    if verbose:
        print(combined, file=sys.stderr, end="")
    if completed.returncode != 0:
        raise SystemExit(
            completed.stderr.strip() or completed.stdout.strip()
            or f"wechat-article-to-markdown failed for {url}"
        )
    match = re.search(r"已保存: (.+\.md)", combined)
    if not match:
        raise SystemExit(
            f"Could not find output path in wechat-article-to-markdown output:\n{combined}"
        )
    source_md = Path(match.group(1).strip())
    if not source_md.exists():
        raise SystemExit(f"Output file not found: {source_md}")
    article_path = job_dir / "article.md"
    shutil.copy2(source_md, article_path)
    images_dir = source_md.parent / "images"
    if images_dir.exists():
        dest_images = job_dir / "images"
        shutil.copytree(images_dir, dest_images, dirs_exist_ok=True)
    downloaded_files = sorted(str(p) for p in job_dir.iterdir() if p.is_file())
    return {
        "mode": "wechat-article",
        "output_dir": str(job_dir),
        "primary_file": str(article_path),
        "downloaded_files": downloaded_files,
        "source": url,
    }



def choose_job_dir(content_dir: Path, url: str, slug: str | None) -> Path:
    if slug:
        name = slugify(slug)
    else:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower().replace("www.", "")
        tail = Path(parsed.path).stem or parsed.path.strip("/").split("/")[-1] or "source"
        name = slugify(f"{host}-{tail}")[:72]
    stamp = datetime.now().strftime("%Y%m%d")
    job_dir = content_dir / f"{stamp}-{name}"
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir



def write_source_url(job_dir: Path, url: str) -> None:
    (job_dir / "source-url.txt").write_text(url + "\n", encoding="utf-8")



def find_ytdlp_launcher() -> list[str]:
    if shutil.which("yt-dlp"):
        return ["yt-dlp"]
    if shutil.which("uvx"):
        return ["uvx", "--from", "yt-dlp", "yt-dlp"]
    if shutil.which("uv"):
        return ["uv", "tool", "run", "--from", "yt-dlp", "yt-dlp"]
    raise SystemExit("yt-dlp is required for this host. Install yt-dlp or uv/uvx.")



def run(cmd: list[str], verbose: bool = False) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(cmd, capture_output=True, text=True)
    if verbose:
        if completed.stdout:
            print(completed.stdout, file=sys.stderr, end="")
        if completed.stderr:
            print(completed.stderr, file=sys.stderr, end="")
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or completed.stdout.strip() or f"Command failed: {' '.join(cmd)}")
    return completed



def curl_common_args() -> list[str]:
    return [
        "curl",
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--compressed",
        "-A",
        DEFAULT_HEADERS["User-Agent"],
        "-H",
        f"Accept-Language: {DEFAULT_HEADERS['Accept-Language']}",
    ]


def fetch_url(url: str) -> tuple[bytes, str | None, str]:
    meta = subprocess.run(
        curl_common_args() + ["-o", "-", "-w", "\n__CURL_META__%{content_type}\t%{url_effective}", url],
        capture_output=True,
    )
    if meta.returncode != 0:
        raise SystemExit(meta.stderr.decode("utf-8", errors="ignore").strip() or f"Failed to fetch {url}")
    stdout = meta.stdout
    marker = b"\n__CURL_META__"
    idx = stdout.rfind(marker)
    if idx == -1:
        raise SystemExit(f"Could not parse curl metadata for {url}")
    body = stdout[:idx]
    meta_line = stdout[idx + len(marker):].decode("utf-8", errors="ignore").strip()
    content_type, final_url = (meta_line.split("\t", 1) + [""])[:2]
    return body, content_type or None, final_url or url



def probe_url(url: str) -> tuple[str | None, str]:
    request = urllib.request.Request(url, headers=DEFAULT_HEADERS, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.headers.get_content_type(), response.geturl()
    except Exception:
        return None, url



def guess_filename(url: str, content_type: str | None) -> str:
    parsed = urllib.parse.urlparse(url)
    name = Path(urllib.parse.unquote(parsed.path)).name
    suffix = Path(name).suffix.lower()
    if name and suffix:
        return name
    if content_type:
        if content_type == "application/pdf":
            return (name or "document") + ".pdf"
        guessed_ext = mimetypes.guess_extension(content_type) or ""
        if guessed_ext in {".html", ".htm"}:
            return name or "page.html"
        if guessed_ext:
            return (name or "download") + guessed_ext
    return name or "page.html"



def choose_primary_file(job_dir: Path) -> Path:
    candidates = [
        path
        for path in job_dir.iterdir()
        if path.is_file() and path.name not in IGNORED_OUTPUT_NAMES and not path.name.startswith(".")
    ]
    if not candidates:
        raise SystemExit(f"No downloaded files found in {job_dir}")

    def score(path: Path) -> tuple[int, int, str]:
        suffix = path.suffix.lower()
        if suffix in {".mp4", ".mkv", ".mov", ".webm", ".m4v", ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}:
            priority = 0
        elif suffix == ".pdf":
            priority = 1
        elif suffix in {".html", ".htm"}:
            priority = 2
        elif suffix in {".md", ".txt"}:
            priority = 3
        elif suffix in {".vtt", ".srt", ".json", ".jpg", ".jpeg", ".png", ".webp", ".description"}:
            priority = 9
        else:
            priority = 5
        return (priority, len(path.name), path.name)

    return sorted(candidates, key=score)[0]



def extract_braced_json(text: str, brace_start: int) -> str:
    depth = 0
    in_string = False
    escape = False
    for index in range(brace_start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[brace_start:index + 1]
    raise ValueError("Could not find matching closing brace")



def decode_js_string(value: str) -> str:
    return value.encode("utf-8").decode("unicode_escape").replace("\\/", "/")



def choose_rednote_image_url(image: dict) -> str | None:
    if image.get("urlPre"):
        return decode_js_string(image["urlPre"])
    if image.get("urlDefault"):
        return decode_js_string(image["urlDefault"])
    if image.get("url"):
        return decode_js_string(image["url"])
    for item in image.get("infoList") or []:
        if item.get("url"):
            return decode_js_string(item["url"])
    return None



def extract_rednote_note_data(html: str) -> dict[str, object]:
    marker = '"note":{"xsecToken"'
    idx = html.find(marker)
    if idx == -1:
        raise SystemExit("Could not locate Rednote note data in page HTML")
    brace_start = html.find("{", idx + len('"note":'))
    note = json.loads(extract_braced_json(html, brace_start))
    image_entries = []
    for position, image in enumerate(note.get("imageList") or [], start=1):
        url = choose_rednote_image_url(image)
        if not url:
            continue
        image_entries.append(
            {
                "index": position,
                "url": url,
                "width": image.get("width"),
                "height": image.get("height"),
            }
        )
    return {
        "platform": "rednote",
        "note_id": note.get("noteId"),
        "title": note.get("title") or "",
        "desc": note.get("desc") or "",
        "author": (note.get("user") or {}).get("nickname") or "",
        "author_id": (note.get("user") or {}).get("userId") or "",
        "tags": [tag.get("name") for tag in note.get("tagList") or [] if tag.get("name")],
        "images": image_entries,
        "raw_note": note,
    }



def download_binary(url: str, output_path: Path) -> None:
    completed = subprocess.run(curl_common_args() + [url, "-o", str(output_path)], capture_output=True, text=True)
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or f"Failed to download binary from {url}")



def download_rednote_note(url: str, job_dir: Path, verbose: bool) -> dict[str, object]:
    html_bytes, content_type, final_url = fetch_url(url)
    html = html_bytes.decode("utf-8", errors="ignore")
    output_path = job_dir / "page.html"
    output_path.write_text(html, encoding="utf-8")
    note_data = extract_rednote_note_data(html)
    note_data["source_url"] = url
    note_data["final_url"] = final_url
    metadata_path = job_dir / "rednote.note.json"
    metadata_path.write_text(json.dumps(note_data, ensure_ascii=False, indent=2), encoding="utf-8")

    downloaded_files = [str(output_path), str(metadata_path)]
    images_dir = job_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    local_images = []
    for image in note_data["images"]:
        parsed = urllib.parse.urlparse(image["url"])
        suffix = Path(parsed.path).suffix or ".jpg"
        image_path = images_dir / f"image-{image['index']:02d}{suffix}"
        download_binary(image["url"], image_path)
        local_images.append(str(image_path))
        downloaded_files.append(str(image_path))
    note_data["local_images"] = local_images
    metadata_path.write_text(json.dumps(note_data, ensure_ascii=False, indent=2), encoding="utf-8")

    if verbose:
        print(f"[rednote] saved HTML to {output_path}", file=sys.stderr)
        print(f"[rednote] saved metadata to {metadata_path}", file=sys.stderr)
        print(f"[rednote] downloaded {len(local_images)} images", file=sys.stderr)

    return {
        "mode": "rednote-html",
        "output_dir": str(job_dir),
        "primary_file": str(output_path),
        "downloaded_files": downloaded_files,
        "content_type": content_type,
        "final_url": final_url,
        "metadata_file": str(metadata_path),
        "image_count": len(local_images),
        "title": note_data.get("title"),
    }



def download_with_ytdlp(url: str, job_dir: Path, verbose: bool) -> dict[str, object]:
    cmd = find_ytdlp_launcher() + [
        "--no-playlist",
        "--restrict-filenames",
        "--write-info-json",
        "--write-thumbnail",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "all,-live_chat",
        "--paths",
        f"home:{job_dir}",
        "--paths",
        f"temp:{job_dir / '.tmp'}",
        "-o",
        "%(title).180B [%(id)s].%(ext)s",
        url,
    ]
    run(cmd, verbose=verbose)
    primary_file = choose_primary_file(job_dir)
    files = sorted(str(path) for path in job_dir.iterdir() if path.is_file())
    return {
        "mode": "yt-dlp",
        "output_dir": str(job_dir),
        "primary_file": str(primary_file),
        "downloaded_files": files,
    }



def download_with_curl(url: str, job_dir: Path, verbose: bool) -> dict[str, object]:
    content_type, final_url = probe_url(url)
    filename = guess_filename(final_url, content_type)
    output_path = job_dir / filename
    cmd = [
        "curl",
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--compressed",
        "-A",
        DEFAULT_HEADERS["User-Agent"],
        url,
        "-o",
        str(output_path),
    ]
    run(cmd, verbose=verbose)
    return {
        "mode": "curl",
        "output_dir": str(job_dir),
        "primary_file": str(output_path),
        "downloaded_files": [str(output_path)],
        "content_type": content_type,
        "final_url": final_url,
    }



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download a source URL into .content")
    parser.add_argument("url")
    parser.add_argument("--content-dir", default=".content")
    parser.add_argument("--slug")
    parser.add_argument("--force-yt-dlp", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()



def main() -> int:
    args = parse_args()
    if not is_url(args.url):
        raise SystemExit(f"Not a valid http/https URL: {args.url}")
    content_dir = Path(args.content_dir).expanduser().resolve()
    job_dir = choose_job_dir(content_dir, args.url, args.slug)
    write_source_url(job_dir, args.url)
    if is_wechat_url(args.url):
        result = download_with_wechat(args.url, job_dir, verbose=args.verbose)
    elif args.force_yt_dlp or should_use_ytdlp(args.url):
        try:
            result = download_with_ytdlp(args.url, job_dir, verbose=args.verbose)
        except SystemExit:
            if is_rednote_url(args.url):
                result = download_rednote_note(args.url, job_dir, verbose=args.verbose)
            else:
                raise
    else:
        result = download_with_curl(args.url, job_dir, verbose=args.verbose)
    result["source"] = args.url
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
