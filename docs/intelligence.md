# Intelligence, sessions and skills

`IntelligenceEngine` supplies manual sessions, actor-specific durable jobs, an event cursor, and a semantic proposal review queue. Jobs and ordinary proposals live under `.mdb/intelligence/<actor-hash>.json`; reviewed wiki-change proposals use `.mdb/intelligence/wiki-changes.json` so authorized reviewers can see them across actor queues. This is internal operational data, not the canonical knowledge store. Approved output goes through Vault and receives an immutable Markdown revision.

## Deterministic and semantic work

`index` rebuilds disposable navigation/search state. `profile`, `wiki`, `memory`, `reflect` and `dream` require a supplied `ModelProvider`. The CLI and MCP server build a configured built-in provider from `mdb.yaml`/`ENGRAM_MODEL_PROVIDER`; SDK hosts may supply a provider directly. A null or unavailable provider disables model work. Model-required jobs become blocked with `CAPABILITY_UNAVAILABLE`, not fabricated summaries. The queue is bounded per run, uses leases, retries provider failures with delay, and dead-letters malformed/forbidden output or exhausted retries. A journal cursor enqueues index work and wiki work for imported sources; repeated processing deduplicates pending jobs and identical proposals.

A provider receives authorized documents, explicit goals, the job and an instruction treating all source content as data. Inputs are bounded; speculation discoveries are excluded as evidence for new generation. Provider output must use a stage-appropriate kind and exact supplied revision references. Validation checks schema, accessible evidence and destination scope. Semantic changes remain pending until explicit approval. Rejection records a reason; approval creates a document through an idempotent Vault write. Output confidence is indicative, not an objective probability.

The five wiki skills travel with the durable job input, so otherwise-identical requests for different skills do not deduplicate together. The engine selects a fixed in-code directive by skill; caller instructions are bounded and appended after that directive. Legacy persisted wiki jobs without `skill` continue as generic wiki compilation jobs. Update, maintenance, cross-linker and tag-taxonomy jobs require an accessible target `wiki_page`. Cross-linker and tag-taxonomy receive compact deltas: the host inserts exact anchor links outside fenced and inline code, or applies spelling-only tag mappings, while preserving the existing page text deterministically. Invalid deltas get one repair call, then are rejected; the resulting normal wiki proposal still requires review. Proposal metadata records the skill.

`proposeFromLint()` revalidates findings with the current actor-bound linter before staging work. Empty pages and exact duplicate copies can produce pending retire proposals; duplicate-title groups with different content and unsupported issue codes are skipped with reasons. Stale/deleted source findings enqueue a targeted `wiki-maintenance` job. No lint proposal is applied automatically. `mdb wiki lint --propose [--dry-run]` and `mdb_wiki_lint` with `propose:true` expose this bounded path; dry runs do not write jobs or proposals.

Wiki lint skips body-level checks for bodies over 200 KiB and emits the informational `page_too_large_for_body_checks` issue. Evidence and structured-link checks still run. This keeps very large imported or generated pages from monopolizing synchronous lint work; split or review such pages before relying on body-level findings.

## Reviewed wiki changes

`IntelligenceEngine.proposeWikiChange()` stages `wiki_change` proposals for `retire`, `restore`, `rename` and `merge`. The proposer must have read and write access to the target and every merge source; merge sources must be distinct active `wiki_page` documents in exactly the target scope. Merge content is bounded, cites accessible revisions, and passes deterministic `lintCitations`. Proposal fingerprints deduplicate identical pending requests. These operations need no model provider.

Review uses versioned Vault operations and expected revisions. Retire creates a deleted revision; restore creates a new active revision from the selected earlier revision; rename preserves the former title in bounded, deduplicated aliases; merge updates the target, adds source titles as aliases and tombstones each source with `mergedInto`. A stale target is rejected with `page_changed`. Rename stores its committed revision in proposal progress; if a human advances the page before approval can finish, retry returns a conflict and leaves the proposal pending. Retire and restore only resume when their committed revision is still the current head; a later head change is rejected with `page_changed`. Merge progress is persisted around each Vault step and each write has an idempotency key, so review can resume after interruption without repeating committed work; a changed source stops the merge while leaving its proposal pending. All touched scopes require write access at approval time. Search and lint use the current tombstone status.

Agents can stage changes and inspect their actor-visible proposals with `mdb_wiki_propose_change` / `mdb_wiki_proposals`, or use `mdb wiki propose ...` / `mdb wiki proposals`. `mdb_diff` is read-only. **Agents propose; the trusted host approves or rejects through SDK/CLI review.** MCP deliberately has no approve, reject, or direct wiki delete tool. CLI review is `mdb intelligence approve ID` or `mdb intelligence reject ID --reason TEXT` (also available through the existing profile review commands).

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
  maxOutputTokens: 4000
  allowPrivateContentToRemote: false
  critic: true                # model critic after deterministic checks
```

Reasoning model families such as `gpt-oss`, `o1`/`o3`/`o4`, `deepseek-r1`, `qwq`, and `*-thinking` may spend output budget on hidden reasoning before returning JSON. Configure `model.maxOutputTokens` to at least 4000 to reduce truncation; `mdb model show` and `mdb model test` warn when a recognized reasoning-model name is configured below that level.

Guarantees, each covered by `tests/models.test.ts` or `tests/pipelines.test.ts`:

- **Strict schema.** Output must be one JSON object with only `kind,title,body,evidence,status,metadata`; unknown fields, prototype keys, oversize or truncated output, and missing evidence are `INVALID_MODEL_OUTPUT` and dead-letter the job. `null`/`""` optional fields are treated as absent (observed from a real model).
- **No direct writes.** Output becomes a staged proposal in `.mdb/intelligence/`. Only `review(approve)` commits, and it re-validates evidence and re-runs the deterministic critic. Evidence must cite documents that were actually sent.
- **Privacy.** A `remote` provider is blocked (job `blocked`, provider never called) for any job whose scope is a workspace or whose documents include workspace content, unless `allowPrivateContentToRemote: true`. Secrets matching the redaction patterns are removed from every prompt. Non-loopback endpoints must be https and need `allowNetwork`.
- **Errors.** Provider errors carry fixed messages; response bodies, prompts, headers and keys are never stored or logged. Credential/404 failures block the job; transient ones retry with exponential backoff (honoring `Retry-After`, capped 30 s); unknown exceptions become a generic message.
- **Cancellation.** `run({signal})` and Ctrl-C in the CLI abort in-flight requests; the job returns to `pending` without consuming an attempt.

## One model switch: local agent or OpenAI-compatible API

One vault-wide provider serves user insight and interest collection (`profile`), Dream, the wiki/memory/reflect jobs and project insight relevance. There is no per-function routing.

```bash
mdb model show                                   # kind, locality, availability, key variable name + whether it is set (never the key), private-content gate
mdb model set --local-agent claude               # or codex | auto: a local agent CLI (sends prompts to its vendor: counts as remote)
mdb model set --api http://127.0.0.1:11434/v1 --model gpt-oss:20b --max-output-tokens 8000   # Ollama / any OpenAI-compatible API
mdb model set --api https://api.openai.com/v1 --model gpt-5 --api-key-env OPENAI_API_KEY --allow-network
mdb model set --provider none                    # deterministic maintenance only
mdb model test                                   # explicit: one synthetic prompt (no vault content), reports latency
```

`set` validates the candidate (builds the provider, no call) and refuses to save an invalid one unless `--no-check`. Switching between a local agent and an API drops the other kind's fields (`baseUrl`, `apiKeyEnv`, `command`, `modelName`). Keys are read from the named environment variable only. `ENGRAM_MODEL_PROVIDER` still overrides the file and `show` says so. Remote providers (agent CLIs by default, non-loopback APIs) receive no private workspace content unless `--allow-private-to-remote`.

### Project-specific insight injection

Injection (CLAUDE.md / AGENTS.md block and the SessionStart context) stays deterministic and offline. A model can improve it ahead of time:

```bash
mdb project relevance refresh --workspace my-project   # asks the configured provider; stores a derived, revisioned note in that workspace
mdb project relevance show --workspace my-project      # none | model | stale
mdb project relevance clear --workspace my-project     # back to the deterministic order
```

Only accepted, non-sensitive insights (global and this project's) are sent, plus up to 20 open task titles. The model returns ids only (`relevant` in order, `irrelevant`); unknown, repeated or overlapping ids reject the whole answer, and claim text always comes from the vault. A stored ranking applies only while the accepted set is unchanged (hash); otherwise injection is exactly the deterministic output. A fresh ranking can drop *global* insights marked irrelevant and reorders the rest; project-labelled insights are never dropped. With a remote provider and `allowPrivateContentToRemote: false` nothing is sent (`skipped_private`). Remote clients read the ranking through the read-only `mdb_insight_relevance` tool; they never compute it.

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
