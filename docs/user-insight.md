# User insights: evidence hierarchy, schema and rules

An insight is one claim about the user ("prefers two spaces", "is learning Rust", "reviews diffs before committing") stored as a Markdown object of kind `user_insight`. Insights are **user-private**: they live in the `profile` area (readable only with `global:profile:read` or as owner), never inside workspaces, whatever they apply to. The generated `PROFILE.md` (what the user stated) and `USER_INSIGHT.md` (inferred and exposure items) are projections of the accepted insights.

## Evidence classes (what each source may say about the user)
| Source class | Examples | May support |
|---|---|---|
| `explicit` | explicit notes, direct corrections (`mdb profile correct`) | any claim; strongest, latest wins |
| `user_conversation` | text the user wrote (speaker `user`, e.g. captured prompts) | any claim; an explicit statement is `explicit`, a pattern is only `inferred` |
| `wiki_exposure` | wiki pages, imported sources | `interest` only, as exposure. Never a preference, goal, capability or endorsement |
| `agent_observation` | assistant messages, tool output, task logs | supporting only; alone it yields an unconfirmed `hypothesis` |
| `dream` | discovery hypotheses | nothing; rejected as evidence |

Classes are computed from the cited objects, not from what the model says. A model cannot raise its evidence class or confidence: a declared class stronger than the sources support is rejected. `extractionConfidence` is a deterministic evidence-density estimate, not a statistically calibrated probability; `factualCertainty` distinguishes a direct user report from an inference and does not claim objective truth. Free-text correction markers are recognized from the cited user-authored source text and only become durable after the ordinary proposal review. Corrections that do not overlap the proposed subject are not treated as explicit.

## Schema (object metadata)
`insightSchema: 1`, `category` (preference | goal | interest | capability | working_style | knowledge_gap), `preferenceKey` (slug naming the subject), `evidenceClass` (explicit | inferred | exposure | hypothesis), `confidenceLabel` (legacy coarse label), `extractionConfidence` (evidence-density estimate), `factualCertainty`, `scopeLabel` (`global` or a workspace id: where it applies), `validFrom`, `visibility: user_private`, `sensitivity`, `sources[] {uri, revisionId, class, speaker, span}`; status `candidate → accepted → superseded | rejected`. The body is the claim. Object revisions preserve history; `supersedes` / `supersededBy` / `supersededReason` link replacements.

## Rules
- Every non-explicit source needs a **verbatim span** that occurs in it; invented quotes are rejected.
- Same subject, same applicability: a user statement beats inference, exposure and agent conclusions; a newer user statement supersedes an older one (old versions stay readable); two inferences that disagree are both kept for review. A workspace insight and a global one with the same key coexist.
- Sensitive-looking claims (keyword heuristic) or model-labelled sensitive ones need `--confirm-sensitive`, are never listed in projections or indexes (only a count), and are found only through an authorized `insight search`.
- Agent-only hypotheses need `--confirm-hypothesis`.
- Corrections are made by the user through the CLI/SDK (`mdb profile correct`); there is deliberately no MCP tool that lets an agent state a fact on the user's behalf.
- Extraction is incremental: user-authored events enqueue one profile job per scope, sources are taken in priority order (explicit, user conversation, wiki, agent), and a cursor prevents reprocessing. Model output is a proposal that passes these rules and then review.

## Commands
`mdb profile correct --key K --claim T --category C [--workspace W] [--source URI --revision R --span QUOTE]`, `mdb profile approve|reject ID [--confirm-sensitive] [--confirm-hypothesis]`, `mdb profile project`, `mdb insight search [QUERY] [--category C] [--status accepted|superseded|candidate] [--evidence-class explicit] [--limit N]`.
