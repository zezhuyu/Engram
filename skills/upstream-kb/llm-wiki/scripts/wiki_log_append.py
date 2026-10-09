#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_LOG_FILE = REPO_ROOT / "wiki" / "Log.md"
LOG_HEADER = "---\ntitle: Wiki Log\n---\n\n# Wiki Log\n"


def ensure_log_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or not path.read_text(encoding="utf-8", errors="ignore").strip():
        path.write_text(LOG_HEADER, encoding="utf-8")


def quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Append a structured entry to wiki/LOG.md")
    parser.add_argument("action", help="Short action label, e.g. INGEST or WIKI_UPDATE")
    parser.add_argument("--log-file", default=str(DEFAULT_LOG_FILE))
    parser.add_argument("--message")
    parser.add_argument("--path", action="append", dest="paths", default=[])
    parser.add_argument("--collection", action="append", dest="collections", default=[])
    parser.add_argument("--meta", action="append", default=[], help="Extra key=value metadata (repeatable)")
    parser.add_argument("--timestamp", help="ISO timestamp override")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    log_file = Path(args.log_file).expanduser().resolve()
    ensure_log_file(log_file)
    timestamp = args.timestamp or datetime.now(timezone.utc).isoformat()
    fields: list[str] = []
    if args.paths:
        fields.append(f"paths={quote('; '.join(args.paths))}")
    if args.collections:
        fields.append(f"collections={quote(','.join(args.collections))}")
    if args.message:
        fields.append(f"message={quote(args.message)}")
    for item in args.meta:
        if "=" not in item:
            raise SystemExit(f"Invalid --meta value (expected key=value): {item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise SystemExit(f"Invalid empty metadata key in: {item}")
        fields.append(f"{key}={quote(value.strip())}")
    suffix = " " + " ".join(fields) if fields else ""
    line = f"- [{timestamp}] {args.action.upper()}{suffix}\n"
    with log_file.open("a", encoding="utf-8") as handle:
        if log_file.stat().st_size > 0 and not log_file.read_text(encoding="utf-8", errors="ignore").endswith("\n"):
            handle.write("\n")
        handle.write(line)
    print(json.dumps({"log_file": str(log_file), "line": line.strip()}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
