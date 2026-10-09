# Cross-domain dreaming: association retrieval, modes, critic, feedback (M4)

**Status: PASS** — 15/15 tests passed, 0 failed, 0 skipped; 14 recorded cases, 0 case failures.

Run at 2026-10-09T03:16:29.258Z, 17.8 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/dream/retrieval.test.js dist/tests/dream/dream.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | a Python API + JavaScript UI pair yields a candidate composition hypothesis, never a fact or a claim about the user |
| PASS | three modes, three different behaviours: algorithms, prompts, output schemas, budgets and candidate sets |
| PASS | modes are separate opt-ins and strategic dreaming needs a stated goal |
| PASS | critic: duplicate, trivial, unsupported, already-known and over-certain ideas are rejected, each with a persisted, restart-proof reason |
| PASS | privacy: an agent cannot dream over what it cannot read; a remote model never sees private notes; private-derived ideas are reviewed and kept out of shared indexes |
| PASS | feedback drives status and ranking; rejected ideas do not come back without new evidence; repetition never validates |
| PASS | model failure modes are safe: malformed, refusing, timing-out, unavailable and cancelled providers never write knowledge |
| PASS | no runaway dreaming: discoveries never seed dreams, triggers are rate-limited and deduplicated, and every budget is enforced |
| PASS | the evaluation pack has 20+ documents across 5 knowledge domains, contradictions and private notes |
| PASS | configured SQLite vectors add bounded semantic associations to Dream micro retrieval; unavailable backend preserves lexical graph behavior |
| PASS | micro: a local neighbourhood of the changed object plus a few complementary objects from other domains, within a small budget |
| PASS | deep: rare cross-domain bridges, provides/consumes pairs, contradictions and long paths, excluding direct neighbours and unrelated domains |
| PASS | strategic: goal-directed capabilities, competing domains and gaps; a goal nothing supports yields a gap report and no model call |
| PASS | the three modes use different algorithms, budgets and candidate sets; the retrieval trace shows it |
| PASS | retrieval respects authorization: an agent without access to the private workspace never gets its objects into the pool, graph or plan |

## Not verified

| Status | Item | Reason |
|---|---|---|
| FAIL | Independent semantic quality scoring for novelty, feasibility, usefulness, contradictions and hallucinations | Real-model evaluation FAIL: mode mean qualities={"micro":{"count":1,"meanQuality":0.8333333333333334},"deep":{"count":1,"meanQuality":0.6666666666666666},"strategic":{"count":1,"meanQuality":1}}, critic rejection recall=1, supported acceptance=1, evidence grounding=1. See verification/dream/real-model-evaluation.json. |
| NOT_RUN | Discovery usefulness over time | Feedback and success-rate weighting are tested for mechanics; no longitudinal data exists. |
| UNSUPPORTED | Experiment execution | Validation needs user confirmation or recorded experiment evidence; Engram never runs experiments. |

## Limitations

- Discoveries are hypotheses. The critic is heuristic (lexical similarity); novelty is not proven.
