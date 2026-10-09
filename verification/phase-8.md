# Phase 8 verification — model providers, critic, profile and retrospective pipelines

Date: 2026-10-07. Platform: darwin arm64, Node v25.8.2.

Command: `npm run verify` → lint 0 failures, tsc clean, **60 tests: 59 pass, 0 fail, 1 skipped** (the opt-in real-model test).

Opt-in real model: `MDB_REAL_MODEL_TEST=1 MDB_TEST_PROVIDER=ollama MDB_TEST_MODEL=gpt-oss:latest node --test dist/tests/real-model.test.js` → **pass** (local Ollama, loopback, synthetic content, ~19 s). The first run failed: the model emitted `"span": ""` and strict validation dead-lettered the job; optional `null`/`""` fields are now treated as absent (unit-tested).

## Covered
- `tests/models.test.ts` (8): request shape and auth, delimiter-forging documents, retries on 5xx/429 with attempt bound, no retry on 401, error sanitization (bodies/prompt/key never in message or stack), timeout, cancellation (mid-flight and pre-aborted), strict schema rejections, truncation, token budget before network, critic verdict parsing, provider config rules (ollama local/keyless, remote needs allowNetwork + env key + https, no URL credentials).
- `tests/pipelines.test.ts` (9): profile precedence (explicit beats inference, newer explicit supersedes older inference, history preserved, explicit doc never rewritten); sensitive-information review (confirmation required, rejection stores nothing, model-declared sensitivity honored); session-end retrospective over exactly that session (idempotent, secrets redacted, evidence linked, originals untouched); no-provider mode blocked without fabrication; critic rejection (duplicate, unsupported certainty, model reject with rationale, model accept stays pending, critic outage flagged); remote-provider privacy gate; token-budget trimming; strict-schema dead letter; sanitized/blocked/retry errors; job-level cancellation without consuming attempts; HTTP adapter end to end through the engine.

## Limitations
- Sensitive-content detection is a keyword heuristic and can miss content; nothing is committed without review regardless.
- Token counting is chars/4, not a real tokenizer; providers may count differently.
- Inferred profile items without `metadata.preferenceKey` cannot be conflict-checked (flagged `unkeyed`).
- Real-model quality (prose, usefulness, dream novelty) is not evaluated, only structure; only one local model (gpt-oss) and the OpenAI-compatible protocol were exercised. No hosted OpenAI call was made.
- Duplicate detection is lexical (Jaccard), not semantic.
- Retrospective covers at most the 19 newest observations plus the session document (engine document cap of 20).
- The `memory` job has no automatic trigger; run it manually.
