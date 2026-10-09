# Intelligence, sessions and skills

`IntelligenceEngine` supplies manual sessions, actor-specific durable jobs, an event cursor, and a semantic proposal review queue. It stores state under `.mdb/intelligence/<actor-hash>.json`. This is internal operational data, not the canonical knowledge store. Approved output goes through Vault and receives an immutable Markdown revision.

## Deterministic and semantic work

`index` rebuilds disposable navigation/search state. `profile`, `wiki`, `memory`, `reflect` and `dream` require a supplied `ModelProvider`. The default has no provider and disables dreaming. Model-required jobs become blocked with `CAPABILITY_UNAVAILABLE`, not fabricated summaries. The queue is bounded per run, uses leases, retries provider failures with delay, and dead-letters malformed/forbidden output or exhausted retries. A journal cursor enqueues index work and wiki work for imported sources; repeated processing deduplicates pending jobs and identical proposals.

A provider receives authorized documents, explicit goals, the job and an instruction treating all source content as data. Inputs are bounded; speculation discoveries are excluded as evidence for new generation. Provider output must use a stage-appropriate kind and exact supplied revision references. Validation checks schema, accessible evidence and destination scope. Semantic changes remain pending until explicit approval. Rejection records a reason; approval creates a document through an idempotent Vault write. Output confidence is indicative, not an objective probability.

Profile inference creates `user_insight` candidates; it does not silently replace explicit profile preferences. Wiki jobs propose derived pages instead of mutating sources. Memory/reflection jobs propose reusable knowledge based on recorded evidence. This is a small reviewed workflow, not a general autonomous agent executing external tools.

## Dream hypotheses

Dreaming requires both opt-in and a provider. Micro, deep and strategic mode labels are accepted inputs; this MVP uses a common bounded candidate pipeline rather than separate sophisticated scheduling algorithms. Multiple domains must be represented and cited. Output remains `hypothesis` and includes counterarguments and a test plan. There is no automatic experiment execution, assertion upgrade to fact or guarantee of novelty. Global dream output cannot cite private workspace material without separate sanitized promotion.

The sample provider is a deterministic fixture demonstrating Python-API + JavaScript-UI composition with evidence. It is not a real model result. A configured provider can use the same interface, but no hosted/network adapter ships here.

## Session capture

Explicit session start creates an open session. Observe creates separate immutable observations linked to it, with limited secret-pattern redaction. Session end versions the session to closed and queues reflection. No-provider mode preserves observations and the blocked reflection task without pretending a retrospective exists. No automatic host lifecycle hooks or conversation scanning are installed.

## KB inheritance

The repository preserves all 22 KB skill directories under `skills/upstream-kb`, with an import manifest. Their original scripts are reference material and are not automatically run. Adapted skills use actor-bound SDK/CLI operations; vault writes bypassing revisions are prohibited. Twelve native skills cover memory recall/write, handoff, ingestion, wiki/profile maintenance, insights, retrospective, discovery, promotion and audit/critique. `skills()` and skill lookup expose all 34 entries.

Operational adaptations include lexical wiki query, local source ingestion, index rebuild, accessible export and evidence audits. Semantic adapters queue reviewed proposals. External download, creator crawling, OCR/conversion and transcription explicitly report unavailable; pruning cannot discard immutable evidence through an upstream cleanup script. Conversation imports select an explicit export and apply capture consent checks. Skill availability describes implemented dispatch, not every capability promised by upstream KB instructions.

## Model providers

`ModelProvider` (`packages/core/types.ts`) is provider-independent: `generate(request, {signal, maxOutputTokens})` returns one proposal; optional `critique()` returns an accept/reject verdict. `locality` (`local`/`remote`) is declared by the provider; omitted means in-process host code, treated as local. `SyntheticFixtureModel` remains for tests and the sample.

Built-in HTTP backends (`packages/models/`) speak OpenAI chat-completions and are selected in `mdb.yaml`:

```yaml
model:
  provider: ollama            # ollama | openai | openai-compatible | null
  modelName: llama3.1
  allowNetwork: false         # required true for any non-loopback endpoint
  baseUrl: http://127.0.0.1:11434/v1   # optional; defaults per provider
  apiKeyEnv: OPENAI_API_KEY   # NAME of an env var; keys are never stored in the vault
  timeoutMs: 60000            # 100..600000
  maxRetries: 2               # 0..6, transient failures only (network, 408, 429, 5xx)
  maxInputTokens: 12000       # documents are trimmed to fit; estimate is chars/4
  maxOutputTokens: 2000
  allowPrivateContentToRemote: false
  critic: true                # model critic after deterministic checks
```

Guarantees, each covered by `tests/models.test.ts` or `tests/pipelines.test.ts`:

- **Strict schema.** Output must be one JSON object with only `kind,title,body,evidence,status,metadata`; unknown fields, prototype keys, oversize or truncated output, and missing evidence are `INVALID_MODEL_OUTPUT` and dead-letter the job. `null`/`""` optional fields are treated as absent (observed from a real model).
- **No direct writes.** Output becomes a staged proposal in `.mdb/intelligence/`. Only `review(approve)` commits, and it re-validates evidence and re-runs the deterministic critic. Evidence must cite documents that were actually sent.
- **Privacy.** A `remote` provider is blocked (job `blocked`, provider never called) for any job whose scope is a workspace or whose documents include workspace content, unless `allowPrivateContentToRemote: true`. Secrets matching the redaction patterns are removed from every prompt. Non-loopback endpoints must be https and need `allowNetwork`.
- **Errors.** Provider errors carry fixed messages; response bodies, prompts, headers and keys are never stored or logged. Credential/404 failures block the job; transient ones retry with exponential backoff (honoring `Retry-After`, capped 30 s); unknown exceptions become a generic message.
- **Cancellation.** `run({signal})` and Ctrl-C in the CLI abort in-flight requests; the job returns to `pending` without consuming an attempt.

## Critic and profile rules

Deterministic critic (`packages/intelligence/critic.ts`), always run first: rejects near-duplicates (Jaccard ≥ 0.85 against same-kind objects in scope and queued proposals), discoveries stated with unsupported certainty, and inferred profile items that conflict with or merely restate an explicit preference with the same `metadata.preferenceKey`. Inferred items that look sensitive (keyword heuristic, or model-declared `metadata.sensitivity: sensitive`) are flagged `sensitive` and cannot be approved without `confirmSensitive` (`mdb profile approve ID --confirm-sensitive`). The keyword heuristic can miss sensitive content; nothing is ever committed without review. The optional model critic can only reject or add flags. Rejections keep their rationale in the proposal record.

`reconcileProfile()` (also run after profile changes and `mdb profile reconcile`) marks an inferred insight `superseded` when a newer explicit preference with the same key disagrees; the old revision stays in history and explicit documents are never modified by inference. Inferred items without a `preferenceKey` cannot be conflict-checked and are flagged `unkeyed`.

`sessionEnd` queues a `reflect` job over exactly that session and its observations (idempotent). With no provider the job is `blocked`; no summary is fabricated.

## Swappable agent backends

`model.provider` in `mdb.yaml` (or the `ENGRAM_MODEL_PROVIDER` environment variable, which wins) selects who does the model work for the wiki, profile, memory, reflect, dream and critic jobs. The deterministic `index` job never calls a model.

| Value | Backend | Notes |
|---|---|---|
| `auto` (default) | first of `claude`, then `codex` found on PATH | unavailable, with a clear reason, when neither is installed; jobs then block instead of faking output |
| `claude-cli` | `claude -p --output-format text --tools "" --no-session-persistence --disable-slash-commands --strict-mcp-config --setting-sources ""` | prompt on stdin; no tools, hooks, MCP or session files |
| `codex-cli` | `codex exec --sandbox read-only --ephemeral --skip-git-repo-check -C <tmp> -o <file> -` | prompt on stdin, answer read from the last-message file |
| `openai`, `ollama`, `openai-compatible` | OpenAI chat-completions HTTP API | see above; `baseUrl`, `modelName`, `apiKeyEnv` |
| `null` | none | deterministic maintenance only |

Agent CLI specifics: each call runs in a throwaway directory, with `ENGRAM_DATA_DIR`/`MDB_ROOT` removed from its environment, stderr discarded, stdout capped at 2 MB, a timeout (default 180 s) that kills the process, cancellation that kills it, and one retry after a timeout or signal. `model.command` overrides the executable path, `model.modelName` is passed as `--model`/`-m`.

Privacy: `claude` and `codex` send prompts to their vendor, so they count as **remote**. Jobs over private workspace content are blocked unless `model.allowPrivateContentToRemote: true`; global content (wiki, shared, profile) is sent on an explicit `mdb intelligence run`. Set `model.locality: local` only for a wrapper that keeps data on this machine. Output from every backend takes the same path: strict schema, evidence check, critic, staged proposal, human review.

OpenAI-compatible API behavior covered by tests: trailing-slash base URLs, bearer auth only when a key exists, `stream:false`, output-token cap, `response_format` retried once without it when a server rejects it with 400/422, array-style `content` parts, bounded retries with `Retry-After`, timeouts, cancellation, sanitized errors.
