# Wiki compilation, session memory and handoff (M3)

**Status: PASS** — 10/11 tests passed, 0 failed, 1 skipped; 10 recorded cases, 0 case failures.

Run at 2026-10-09T15:07:32.353Z, 6.8 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/wiki/compile.test.js dist/tests/memory/handoff.test.js dist/tests/wiki/real-model.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | session end yields a cited retrospective AND a handoff, each keeping user, assistant and tool statements distinct, with no forced context |
| PASS | an abandoned session produces a partial handoff that says it is incomplete and invents no outcome |
| PASS | explicit decisions, findings, notes and task completion go through the same registration, redaction and queue, with correct speaker evidence |
| PASS | uncited or mis-sourced retrospectives are rejected and nothing is promoted to shared knowledge |
| PASS | a new source becomes a cited, reviewable page with dependency edges; the original bytes never change |
| PASS | incremental compile: a related source updates only the affected page as a new revision; unrelated pages and the rest of the wiki are untouched |
| PASS | dependency edges find affected pages without keyword overlap, and a source on a new topic creates a new page |
| PASS | citation lint and target validation: uncited claims, bad citation numbers, unsupplied or source-less targets never become knowledge |
| PASS | privacy and consistency: private sources are never compiled into the global wiki, a page that changed since compilation is not overwritten, repeated events are idempotent |
| PASS | one bounded repair attempt: a model that fixes its citations is accepted, one that does not is still rejected, and there is never a loop |
| SKIPPED | real model: incremental wiki compilation obeys the safety gates (and we record whether it also complied with the citation rules) |

## Not verified

| Status | Item | Reason |
|---|---|---|
| NOT_RUN | Real-model wiki compilation is opt-in | Enable with MDB_REAL_MODEL_TEST=1 (default provider claude-cli). Passed once during M3 (see verification/wiki/m3.md); it spends a little model quota. Model quality (groundedness, hallucination rate) is not scored. |
| UNSUPPORTED | Claim extraction as a separate stage and lint of claim-to-span support | Compilation is one model call per source (plus one repair attempt). The deterministic checks are: evidence is real and readable, target page was supplied, at least one source is cited, every statement cites [n] or says (inference), the page has not changed since compilation. Whether a cited span really supports the sentence is not machine-checked. |
| UNSUPPORTED | Page merge/split and topic pages beyond create/update | A source updates at most one supplied page or creates one page. |
| UNSUPPORTED | Re-processing when a source is replaced by a new import of the same file | Imported sources are immutable; a re-import is a new source object and is compiled like any new source. No explicit "supersedes" link between the two imports exists. |
| UNSUPPORTED | Task-complete signal from hosts | No supported host emits a task-complete hook. task.completed arrives only through explicit `mdb memory record`. |

## Limitations

- Retrospectives and handoffs are model output checked for citations, not for factual correctness.
- Affected pages are chosen by dependency edges and keyword overlap, not semantic similarity.
