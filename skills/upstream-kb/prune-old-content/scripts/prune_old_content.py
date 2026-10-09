#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTENT_DIR = REPO_ROOT / ".content"


@dataclass
class Candidate:
    path: Path
    entry_type: str
    newest_mtime: datetime
    age_days: float


def isoformat(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def newest_mtime_for_path(path: Path) -> datetime:
    latest = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    if path.is_dir():
        for child in path.rglob("*"):
            try:
                child_time = datetime.fromtimestamp(child.stat().st_mtime, tz=timezone.utc)
            except FileNotFoundError:
                continue
            if child_time > latest:
                latest = child_time
    return latest


def collect_candidates(content_dir: Path, cutoff: datetime) -> list[Candidate]:
    candidates: list[Candidate] = []
    for entry in sorted(content_dir.iterdir(), key=lambda p: p.name.casefold()):
        newest = newest_mtime_for_path(entry)
        if newest >= cutoff:
            continue
        age_days = (datetime.now(timezone.utc) - newest).total_seconds() / 86400.0
        candidates.append(
            Candidate(
                path=entry,
                entry_type="directory" if entry.is_dir() else "file",
                newest_mtime=newest,
                age_days=age_days,
            )
        )
    return candidates


def delete_candidate(candidate: Candidate) -> None:
    if candidate.path.is_dir():
        shutil.rmtree(candidate.path)
    elif candidate.path.exists():
        candidate.path.unlink()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prune old entries from .content")
    parser.add_argument("--content-dir", default=str(DEFAULT_CONTENT_DIR))
    parser.add_argument("--days", type=int, default=14, help="Delete entries older than this many days")
    parser.add_argument("--apply", action="store_true", help="Actually delete files/folders instead of previewing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    content_dir = Path(args.content_dir).expanduser().resolve()
    if not content_dir.exists():
        raise SystemExit(f"Content directory does not exist: {content_dir}")
    if not content_dir.is_dir():
        raise SystemExit(f"Content path is not a directory: {content_dir}")
    if args.days < 0:
        raise SystemExit("--days must be >= 0")

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.days)
    candidates = collect_candidates(content_dir, cutoff)

    deleted: list[str] = []
    if args.apply:
        for candidate in candidates:
            delete_candidate(candidate)
            deleted.append(str(candidate.path))

    result = {
        "mode": "apply" if args.apply else "preview",
        "content_dir": str(content_dir),
        "days": args.days,
        "cutoff": isoformat(cutoff),
        "candidate_count": len(candidates),
        "deleted_count": len(deleted),
        "candidates": [
            {
                "path": str(candidate.path),
                "relative_path": candidate.path.relative_to(REPO_ROOT).as_posix() if candidate.path.is_relative_to(REPO_ROOT) else str(candidate.path),
                "type": candidate.entry_type,
                "newest_mtime": isoformat(candidate.newest_mtime),
                "age_days": round(candidate.age_days, 2),
            }
            for candidate in candidates
        ],
        "deleted": deleted,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
