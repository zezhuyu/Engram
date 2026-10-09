---
name: transcribe-media
description: Transcribe local audio and video files such as mp3, wav, m4a, mp4, mov, and webm into markdown transcripts. Use when Codex needs an ASR-backed transcript from a source artifact that already exists in `.content/` or elsewhere in the workspace, either with local `mlx-whisper` or NVIDIA's hosted Parakeet endpoints for English and Chinese.
---

# Transcribe Media

Turn audio or video into a markdown transcript with timestamps.

## Use this skill

Use this skill after the original media file already exists locally.

Default targets in this repo:
- input media: `.content/`
- transcript markdown: `raw/`

## Workflow

1. Normalize the input media with `ffmpeg` into mono 16 kHz WAV.
2. Run either local `mlx-whisper` or NVIDIA hosted Riva/Parakeet ASR.
3. Emit markdown with metadata, full transcript text, and per-segment timestamps when available.

## Commands

Run setup first, then use the repo virtualenv Python:

```bash
bash setup.sh
.venv/bin/python .skills/transcribe-media/scripts/transcribe_media.py \
  .content/<file>.mp4 \
  --output raw/<name>.md
```

Pass `--model <hf-or-local-model>` when accuracy matters more than speed.

Run the script against NVIDIA's hosted Parakeet endpoint:

```bash
export NVIDIA_API_KEY=<your-key>
.venv/bin/python .skills/transcribe-media/scripts/transcribe_media.py \
  .content/<file>.mp4 \
  --output raw/<name>.md \
  --backend nvidia \
  --language en-US
```

Use `--language zh-CN` for Chinese or Mandarin-English mixed audio. The script chooses:
- `nvidia/parakeet-ctc-0.6b-asr` for English
- `nvidia/parakeet-ctc-0.6b-zh-cn` for Chinese

Set `NVIDIA_API_KEY` either:
- in the repo root `.env`, or
- in your shell with `export NVIDIA_API_KEY=...`

Install packages with:

```bash
.venv/bin/pip install -r requirements.txt
```

## Notes

- `ffmpeg` must be installed.
- Prefer a larger Whisper checkpoint for important lectures or long-form learning material.
- When `NVIDIA_API_KEY` is set, NVIDIA becomes the default backend automatically unless `--backend mlx` is passed.
- The NVIDIA backend reads `NVIDIA_API_KEY` and maps language to the current hosted function id for English or Chinese.
- Keep the original media file unchanged; write only the markdown transcript.
