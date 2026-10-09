# Dreaming

A dream proposes a **hypothesis** that connects knowledge from different areas. It is never fact, never about the user, and never written without validation.

## Modes
| Mode | Search | Answer shape | Trigger |
|---|---|---|---|
| micro | local neighbourhood of a changed object plus a complementary object from another domain | one small, testable link | new accepted knowledge (event-driven) |
| deep | cross-domain far sampling: rare bridge terms, provides/consumes tags, `contradicts` relations, multi-hop paths; seeded, weighted by past validation rate | analogy / transfer / composition / contradiction with `mechanism` and `distance` | after `dream.deepThreshold` new objects, or `mdb dream run --mode deep` |
| strategic | goal-directed gap analysis; goals are accepted `user_insight` objects with category `goal` | opportunity with `goalRefs` and `prerequisites` | an accepted goal, or `--mode strategic` |

The planner is deterministic code (`packages/intelligence/dream/plan.ts`); the model only reasons over the candidate sets, and its search hints are suggestions. With SQLite vectors configured and synced, micro retrieval also uses a bounded set of semantic neighbors from global-scope documents. Workspace-only entries are never sent as embedding queries by this association path. Without a ready vector backend, lexical, tag and reference-graph retrieval continues unchanged. The plan (`trace`) records the number of semantic associations used and their candidate source.

## Critic
`judgeDiscovery` rejects: claims about the user, a single domain, restating a source, duplicates, repeats of a rejected idea whose evidence has not grown, ideas the corpus already contains, thin content. Discoveries derived from private, cross-workspace, high-impact or sensitive sources require human review. Rejected discoveries are stored with status `rejected` and their reasons, so they are suppressed next time.

## Lifecycle and feedback
`candidate -> tested -> validated | rejected`. `validated` needs user confirmation or experiment evidence, never repetition. `mdb dream feedback`, `reused_by` links and per-family success statistics (`.mdb/intelligence/dream-stats.json`) bias later sampling. Discoveries never trigger or seed dreams.

## Configuration (`dream.*`)
`enabled, maxCandidates, eventDriven, modes, maxProposalsPerRun, maxRunsPerDay, maxDurationMs, deepThreshold, autoAccept, quietHours`. Explicit CLI runs ignore quiet hours but not the other budgets. Providers that are remote cannot see private workspace content unless `model.allowPrivateContentToRemote`.

## CLI
`mdb dream run --mode micro|deep|strategic`, `dream feedback`, `dream status`, `dream list`.
