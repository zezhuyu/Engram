# User intelligence and the evidence hierarchy (M2)

**Status: PASS** — 26/26 tests passed, 0 failed, 0 skipped; 17 recorded cases, 0 case failures.

Run at 2026-10-09T15:06:43.594Z, 15.9 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/profile/insights.test.js dist/tests/pipelines.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | profile: explicit preference outranks conflicting inference, newer explicit statement supersedes older inference, history is preserved |
| PASS | profile: sensitive inferred items need explicit confirmation, rejection stores nothing, model-declared sensitivity is honored |
| PASS | session end queues a retrospective over exactly that session; approval links evidence and originals stay untouched |
| PASS | session end without a provider queues work that is blocked, never a fabricated summary |
| PASS | critic: duplicate and over-certain dreams are rejected with preserved rationale; no second discovery is stored |
| PASS | critic: a model critic can reject or flag but never approve; critic outages do not block deterministic review |
| PASS | privacy: remote providers never receive private workspace content unless the vault explicitly allows it |
| PASS | budgets, strict schema, sanitized errors, retries and cancellation at the job level |
| PASS | configured Ollama-style endpoint drives a wiki job end to end; output is staged, validated and never written directly |
| PASS | a direct correction supersedes an earlier inferred preference: linked evidence, preserved history, regenerated projection |
| PASS | free-text corrections are detected without a model flag and keep extraction confidence separate from factual certainty |
| PASS | free-text correction reconciles a differently keyed inference by matching the corrected subject |
| PASS | model abstentions are rejected instead of being stored as user insights |
| PASS | profile extraction repairs one schema-invalid model abstention and keeps it rejected |
| PASS | wiki and imported sources show exposure only: they never become a preference, goal, capability or endorsement |
| PASS | agent conclusions never override the user: contradicted ones are rejected, unconfirmed ones need explicit confirmation |
| PASS | workspace-scoped and global preferences coexist without false conflicts |
| PASS | sensitive candidates need confirmation, are never listed in projections or shared indexes, and are visible only to authorized readers |
| PASS | extraction is idempotent, projections are byte-stable, and the source history behind an insight stays reachable |
| PASS | evidence must be real, authorized, content-consistent and correctly attributed; the model cannot raise its own evidence or confidence |
| PASS | passively captured user messages feed profile extraction incrementally, ahead of agent output, without reprocessing |
| PASS | CLI: profile correct, insight search and projection work end to end; agents have no tool to speak for the user |
| PASS | a schema-valid no_insight abstention completes the job, stores nothing, and is counted as an abstention |
| PASS | malformed profile output is repaired within a bounded budget and never invents evidence |
| PASS | persistent malformed profile output dead-letters after the repair budget and is counted as malformed |
| PASS | no_insight is only valid for the profile stage |

## Not verified

| Status | Item | Reason |
|---|---|---|
| FAIL | Labeled real-model extraction quality (precision, recall, false-positive rate, schema reliability, scope, provenance) | Real-model labeled evaluation status FAIL: precision=1, recall=1, falsePositiveRate=0, jobSuccessRate=0.6875, scopeAccuracy=1, evidenceGrounding=1. See verification/profile/real-model-evaluation.json. |
| UNSUPPORTED | Sensitive-attribute detection beyond keywords | A keyword heuristic plus the model's own label; it can miss sensitive content. Nothing is committed without review. |
| NOT_RUN | Calibration against external factual truth labels | Extraction confidence reflects evidence provenance and density; factual certainty is represented separately and does not claim external calibration. |

## Limitations

- Insights are user-private by storage ACL; anyone with global:profile:read (or the owner) can read them.
- Evidence from a private workspace can support an insight stored in the profile area; the insight text itself is then user-private, not workspace-private.
