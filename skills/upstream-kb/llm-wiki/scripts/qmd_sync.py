#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ENV_FILE = REPO_ROOT / ".env"
DEFAULT_CONFIG_FILE = REPO_ROOT / ".qmd" / "xdg-config" / "qmd" / "index.yml"
DEFAULT_XDG_CACHE_HOME = REPO_ROOT / ".qmd" / "xdg-cache"
DEFAULT_XDG_CONFIG_HOME = REPO_ROOT / ".qmd" / "xdg-config"


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def desired_collections(repo_root: Path, env_values: dict[str, str]) -> dict[str, dict[str, Any]]:
    wiki_name = env_values.get("QMD_WIKI_COLLECTION", "wiki")
    raw_name = env_values.get("QMD_RAW_COLLECTION", "raw")
    return {
        wiki_name: {
            "path": str((repo_root / "wiki" / "pages").resolve()),
            "pattern": "**/*.md",
            "context": {"": "LLM-generated wiki pages. Use this first for answering questions."},
        },
        raw_name: {
            "path": str((repo_root / "raw").resolve()),
            "pattern": "**/*.md",
            "context": {"": "Extracted markdown and transcripts from source files. Use this for grounding, ingest, and fact checking."},
        },
    }


def ensure_qmd_config(config_file: Path, collections: dict[str, dict[str, Any]]) -> dict[str, Any]:
    config_file.parent.mkdir(parents=True, exist_ok=True)
    if config_file.exists():
        config = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}
    else:
        config = {}
    if not isinstance(config, dict):
        config = {}
    current = config.get("collections") or {}
    if not isinstance(current, dict):
        current = {}
    current.update(collections)
    config["collections"] = current
    config_file.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return config


def run_command(cmd: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ensure QMD config and refresh indexed collections")
    parser.add_argument("--collection", action="append", choices=["wiki", "raw", "all"])
    parser.add_argument("--embed", action="store_true", help="Run qmd embed after qmd update")
    parser.add_argument("--force-embed", action="store_true", help="Use qmd embed -f")
    parser.add_argument("--config-file", default=str(DEFAULT_CONFIG_FILE))
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not shutil.which("qmd"):
        raise SystemExit("qmd command not found. Install qmd before using qmd_sync.py")

    env_values = load_env_file(Path(args.env_file).expanduser().resolve())
    collection_defs = desired_collections(REPO_ROOT, env_values)
    requested = set(args.collection or ["all"])
    if "all" not in requested:
        keep_names = set()
        if "wiki" in requested:
            keep_names.add(env_values.get("QMD_WIKI_COLLECTION", "wiki"))
        if "raw" in requested:
            keep_names.add(env_values.get("QMD_RAW_COLLECTION", "raw"))
        collection_defs = {name: cfg for name, cfg in collection_defs.items() if name in keep_names}

    config_file = Path(args.config_file).expanduser().resolve()
    config = ensure_qmd_config(config_file, collection_defs)

    env = os.environ.copy()
    env["XDG_CACHE_HOME"] = str(DEFAULT_XDG_CACHE_HOME)
    env["XDG_CONFIG_HOME"] = str(DEFAULT_XDG_CONFIG_HOME)

    update_proc = run_command(["qmd", "update"], env=env)
    if update_proc.returncode != 0:
        raise SystemExit(update_proc.stderr.strip() or update_proc.stdout.strip() or "qmd update failed")

    embed_output = None
    if args.embed or args.force_embed:
        embed_cmd = ["qmd", "embed"]
        if args.force_embed:
            embed_cmd.append("-f")
        embed_proc = run_command(embed_cmd, env=env)
        if embed_proc.returncode != 0:
            raise SystemExit(embed_proc.stderr.strip() or embed_proc.stdout.strip() or "qmd embed failed")
        embed_output = embed_proc.stdout.strip()

    status_proc = run_command(["qmd", "status"], env=env)
    status_output = status_proc.stdout.strip() if status_proc.returncode == 0 else status_proc.stderr.strip()

    result = {
        "config_file": str(config_file),
        "collections": list(collection_defs.keys()),
        "update_stdout": update_proc.stdout.strip(),
        "embed_ran": bool(args.embed or args.force_embed),
        "embed_stdout": embed_output,
        "status": status_output,
        "config": config,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
