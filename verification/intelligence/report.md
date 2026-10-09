# Intelligence engine (deterministic, fake and optional real provider)

**Status: PASS** — 39/41 tests passed, 0 failed, 2 skipped; 0 recorded cases, 0 case failures.

Run at 2026-10-09T15:04:58.571Z, 10.9 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/intelligence.test.js dist/tests/pipelines.test.js dist/tests/models.test.js dist/tests/agents.test.js dist/tests/skills.test.js dist/tests/real-model.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | claude CLI adapter: tool-free non-interactive flags, prompt on stdin only, isolated cwd, vault env scrubbed |
| PASS | codex CLI adapter: read-only sandbox, ephemeral, last-message file, prompt on stdin |
| PASS | agent CLI failures are sanitized, bounded and cancellable |
| PASS | backend selection: auto prefers claude then codex; env and config swap it; missing CLIs are reported, never executed by doctor |
| PASS | jobs run through the agent CLI; private workspace content is blocked unless the owner opts in |
| PASS | swapping the backend in mdb.yaml or by environment changes which agent serves `mdb intelligence run`, including an OpenAI-compatible API |
| PASS | default configuration uses a local agent CLI when one exists, and is deterministic-only when none does |
| PASS | OpenAI-compatible API: path, headers, body, content-part arrays and response_format fallback all behave |
| PASS | manual session capture redacts secrets, revisions close once, automatic capture is opt-in |
| PASS | source synthesis is review-gated, evidence checked, durable and deduplicated |
| PASS | malformed provider output enters dead letter without canonical writes |
| PASS | dream fixture composes multiple domains as hypothesis, private scope never reaches global context |
| PASS | actor isolation, unauthorized evidence and cross-scope sharing are rejected before proposal persistence |
| PASS | revoking an actor grant withdraws queued proposal metadata and blocks review |
| PASS | explicit compiler inputs reach model exclusively and inaccessible object IDs fail before execution |
| PASS | adapter sends bounded chat request with auth, delimits untrusted documents, and strictly parses the proposal |
| PASS | transient 5xx and 429 are retried with bounded attempts; success is returned |
| PASS | authentication failures are not retried and errors never disclose bodies, prompts or keys |
| PASS | timeouts and caller cancellation abort the request without hanging or retrying cancellation |
| PASS | malformed, over-wide, truncated and non-JSON model output is rejected with INVALID_MODEL_OUTPUT |
| PASS | input over the token budget fails before any network request |
| PASS | critic verdicts are parsed strictly and can only accept or reject |
| PASS | configuration: ollama is local and keyless, remote needs network consent and a key from the environment |
| PASS | profile: explicit preference outranks conflicting inference, newer explicit statement supersedes older inference, history is preserved |
| PASS | profile: sensitive inferred items need explicit confirmation, rejection stores nothing, model-declared sensitivity is honored |
| PASS | session end queues a retrospective over exactly that session; approval links evidence and originals stay untouched |
| PASS | session end without a provider queues work that is blocked, never a fabricated summary |
| PASS | critic: duplicate and over-certain dreams are rejected with preserved rationale; no second discovery is stored |
| PASS | critic: a model critic can reject or flag but never approve; critic outages do not block deterministic review |
| PASS | privacy: remote providers never receive private workspace content unless the vault explicitly allows it |
| PASS | budgets, strict schema, sanitized errors, retries and cancellation at the job level |
| PASS | configured Ollama-style endpoint drives a wiki job end to end; output is staged, validated and never written directly |
| SKIPPED | real model: wiki synthesis and critic return schema-valid, evidence-bound, review-gated output |
| SKIPPED | real model evaluation: labeled preference extraction and micro/deep/strategic cross-domain hypotheses |
| PASS | registry exposes all 22 KB adapters and 12 MDB skills without legacy dispatch |
| PASS | upstream assets retain exact imported bytes |
| PASS | skills pass explicit scope to versioned APIs and refuse self-assigned identity |
| PASS | history imports need consent and configured capture source, never scan directories |
| PASS | semantic skills queue proposals and promotion requires explicit sanitized review |
| PASS | export and critique expose authorized documents only and source instructions have no authority |
| PASS | real actor-bound adapters preserve source bytes, revision history and workspace isolation |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Real-model evaluation pack (20+ documents, 4+ domains, scored) | Only a structural opt-in integration test exists (run once against local gpt-oss, see verification/phase-8.md). No evaluation pack, precision or groundedness metrics. |
| NOT_RUN | Wiki ingest→classify→extract→link→lint pipeline and incremental affected-page detection | Only source→proposal→review→page is implemented. |
| NOT_RUN | Task-complete trigger and context handoff | Session-end retrospective is implemented; no task-complete trigger or handoff document. |
| NOT_RUN | Distinct dream modes (micro/deep/strategic) with different candidate retrieval | The mode is accepted as a flag but candidate selection and ranking are identical. |
| NOT_RUN | Dream validation loop and recursion budget tests | No validation-outcome feedback and no test that dreams cannot breed on unvalidated dreams. |
| NOT_RUN | Worker: lease expiry with concurrent workers, index-job priority, replay of dead letters | Jobs, retries, dead letters and idempotency are tested sequentially; concurrent-worker and priority behaviour are not. |
| NOT_RUN | Job idempotency key bound to source revision + pipeline version | Jobs deduplicate by input digest, proposals by content fingerprint; pipeline version is not part of the key. |

## Limitations

- The critic is deterministic (lexical duplicate, certainty, preference conflict, sensitivity keywords) plus an optional model critic that can only reject or flag.
- Sensitive-content detection is a keyword heuristic.
