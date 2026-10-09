#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

DEFAULT_NVIDIA_EN_FUNCTION_ID = "d8dd4e9b-fbf5-4fb0-9dba-8cf436c8d965"
DEFAULT_NVIDIA_ZH_FUNCTION_ID = "9add5ef7-322e-47e0-ad7a-5653fb8d259b"
DEFAULT_NVIDIA_URI = "grpc.nvcf.nvidia.com:443"
DEFAULT_NVIDIA_LANGUAGE = "en-US"


def load_dotenv_if_present() -> None:
    candidate_paths = []
    cwd_env = Path.cwd() / ".env"
    if cwd_env.exists():
        candidate_paths.append(cwd_env)
    repo_env = Path(__file__).resolve().parents[3] / ".env"
    if repo_env.exists() and repo_env not in candidate_paths:
        candidate_paths.append(repo_env)

    for env_path in candidate_paths:
        for raw_line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def require_mlx_whisper():
    try:
        import mlx_whisper
    except ModuleNotFoundError:
        raise SystemExit("Missing mlx-whisper. Run with: uv run --with mlx-whisper -- python ...")
    return mlx_whisper


def require_riva_client():
    try:
        import riva.client
    except ModuleNotFoundError:
        raise SystemExit("Missing nvidia-riva-client. Run with: uv run --with nvidia-riva-client -- python ...")
    return riva.client


def normalize_language(language: str | None) -> str:
    value = (language or "").strip()
    if not value:
        return DEFAULT_NVIDIA_LANGUAGE
    lowered = value.lower()
    if lowered in {"zh", "zh-cn", "zh_hans", "cmn", "cn", "mandarin"}:
        return "zh-CN"
    if lowered in {"en", "en-us", "en_us", "english"}:
        return "en-US"
    return value


def choose_default_backend() -> str:
    if os.getenv("TRANSCRIBE_MEDIA_BACKEND"):
        return os.environ["TRANSCRIBE_MEDIA_BACKEND"]
    return "nvidia" if os.getenv("NVIDIA_API_KEY") else "mlx"


def resolve_nvidia_function_id(language: str, override: str | None) -> str:
    if override:
        return override
    normalized = normalize_language(language)
    if normalized.lower().startswith("zh"):
        return os.getenv("NVIDIA_ASR_ZH_FUNCTION_ID", DEFAULT_NVIDIA_ZH_FUNCTION_ID)
    return os.getenv("NVIDIA_ASR_EN_FUNCTION_ID", DEFAULT_NVIDIA_EN_FUNCTION_ID)


def resolve_nvidia_model_label(language: str, explicit_model: str | None) -> str:
    if explicit_model:
        return explicit_model
    normalized = normalize_language(language)
    if normalized.lower().startswith("zh"):
        return "nvidia/parakeet-ctc-0.6b-zh-cn"
    return "nvidia/parakeet-ctc-0.6b-asr"


def format_seconds(value: float | int | None) -> str:
    seconds = float(value or 0)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    remainder = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{remainder:06.3f}"


def normalize_audio(input_path: Path, wav_path: Path) -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is required to normalize media before transcription.")
    completed = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(wav_path),
        ],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or f"ffmpeg failed for {input_path}")


def normalize_mlx_result(result: dict) -> dict:
    return {
        "text": (result.get("text") or "").strip(),
        "segments": result.get("segments") or [],
    }


def word_offset_ms_to_seconds(value: int | None) -> float | None:
    if value is None:
        return None
    return float(value) / 1000.0


def normalize_nvidia_result(response) -> dict:
    text_parts: list[str] = []
    segments: list[dict] = []
    for result in response.results:
        if not result.alternatives:
            continue
        best = result.alternatives[0]
        transcript = (best.transcript or "").strip()
        if transcript:
            text_parts.append(transcript)
        words = list(getattr(best, "words", []) or [])
        if words:
            segments.append(
                {
                    "start": word_offset_ms_to_seconds(getattr(words[0], "start_time", None)),
                    "end": word_offset_ms_to_seconds(getattr(words[-1], "end_time", None)),
                    "text": transcript,
                }
            )
        elif transcript:
            segments.append({"text": transcript})
    return {
        "text": "\n".join(part for part in text_parts if part).strip(),
        "segments": segments,
    }


def transcribe_with_mlx(wav_path: Path, model: str | None, language: str | None) -> dict:
    mlx_whisper = require_mlx_whisper()
    kwargs = {}
    if model:
        kwargs["path_or_hf_repo"] = model
    if language:
        kwargs["language"] = language
    return normalize_mlx_result(mlx_whisper.transcribe(str(wav_path), **kwargs))


def transcribe_with_nvidia(
    wav_path: Path,
    api_key: str | None,
    function_id: str,
    uri: str,
    model: str | None,
    language: str | None,
) -> dict:
    if not api_key:
        raise SystemExit("NVIDIA_API_KEY is required for --backend nvidia.")
    riva_client = require_riva_client()
    normalized_language = normalize_language(language)
    auth = riva_client.Auth(
        uri=uri,
        use_ssl=True,
        metadata_args=[
            ["function-id", function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr = riva_client.ASRService(auth)
    config = riva_client.RecognitionConfig(
        language_code=normalized_language,
        max_alternatives=1,
        enable_automatic_punctuation=True,
        enable_word_time_offsets=True,
        audio_channel_count=1,
    )
    if model:
        config.model = model
    audio_bytes = wav_path.read_bytes()
    response = asr.offline_recognize(audio_bytes, config)
    return normalize_nvidia_result(response)


def build_document(input_path: Path, result: dict, backend: str, model: str | None) -> str:
    timestamp = datetime.now(timezone.utc).isoformat()
    text = (result.get("text") or "").strip()
    segments = result.get("segments") or []
    lines = [
        f"# Transcript: {input_path.name}",
        "",
        f"- Source file: `{input_path}`",
        f"- Backend: `{backend}`",
        f"- Model: `{model or ('mlx_whisper default' if backend == 'mlx' else 'nvidia default')}`",
        f"- Generated: `{timestamp}`",
        "",
        "## Transcript",
        "",
        text,
        "",
    ]
    if segments:
        lines.extend(["## Segments", ""])
        for segment in segments:
            segment_text = (segment.get("text") or "").strip()
            if segment.get("start") is not None and segment.get("end") is not None:
                start = format_seconds(segment.get("start"))
                end = format_seconds(segment.get("end"))
                lines.append(f"- [{start} - {end}] {segment_text}")
            else:
                lines.append(f"- {segment_text}")
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    load_dotenv_if_present()
    parser = argparse.ArgumentParser(description="Transcribe media into markdown")
    parser.add_argument("input_path")
    parser.add_argument("--output")
    parser.add_argument("--backend", choices=["mlx", "nvidia", "nvidia-parakeet-zh"], default=choose_default_backend())
    parser.add_argument("--model")
    parser.add_argument("--language")
    parser.add_argument("--nvidia-api-key", default=os.getenv("NVIDIA_API_KEY"))
    parser.add_argument("--nvidia-function-id", default=os.getenv("NVIDIA_ASR_FUNCTION_ID"))
    parser.add_argument("--nvidia-uri", default=os.getenv("NVIDIA_ASR_URI", DEFAULT_NVIDIA_URI))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.backend == "nvidia-parakeet-zh":
        args.backend = "nvidia"
        if not args.language:
            args.language = "zh-CN"
    input_path = Path(args.input_path).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Input file does not exist: {input_path}")
    output_path = Path(args.output).expanduser().resolve() if args.output else input_path.with_suffix(".md")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory(prefix="transcribe-media-") as temp_dir:
        wav_path = Path(temp_dir) / "normalized.wav"
        normalize_audio(input_path, wav_path)
        backend_used = args.backend
        fallback_reason = None
        if args.backend == "mlx":
            result = transcribe_with_mlx(wav_path, model=args.model, language=args.language)
        else:
            normalized_language = normalize_language(args.language)
            try:
                result = transcribe_with_nvidia(
                    wav_path,
                    api_key=args.nvidia_api_key,
                    function_id=resolve_nvidia_function_id(normalized_language, args.nvidia_function_id),
                    uri=args.nvidia_uri,
                    model=args.model,
                    language=normalized_language,
                )
            except Exception as exc:
                fallback_reason = str(exc).strip() or exc.__class__.__name__
                backend_used = "mlx"
                result = transcribe_with_mlx(wav_path, model=None, language=normalized_language)

    reported_model = args.model
    if backend_used == "nvidia":
        reported_model = resolve_nvidia_model_label(normalize_language(args.language), args.model)
    elif backend_used == "mlx" and not reported_model:
        reported_model = "mlx_whisper default"

    document = build_document(input_path, result, backend=backend_used, model=reported_model)
    output_path.write_text(document, encoding="utf-8")
    payload = {
        "input": str(input_path),
        "output": str(output_path),
        "segments": len(result.get("segments") or []),
        "backend": backend_used,
        "model": reported_model or "default",
        "language": normalize_language(args.language),
    }
    if fallback_reason:
        payload["fallback"] = {
            "from": "nvidia",
            "to": "mlx",
            "reason": fallback_reason,
        }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
