# Labeled Dream Evaluation Set

The real-model evaluation uses `tests/dream/pack.ts` as a fixed synthetic corpus (21 records, five connected knowledge domains, one unrelated domain, one contradicting pair, two private workspace decoys, and one explicit user goal). No real user records are included.

## Labels

| Case | Expected label | Evidence / criterion |
|---|---|---|
| Micro: Python HTTP API + JavaScript dashboard | Plausible composition hypothesis | JSON API output can feed a browser dashboard; both source revisions must be cited; remain a hypothesis. |
| Deep: any cross-domain pair | Evidence-grounded and useful enough to test | Must cite at least two authorized source revisions and propose a falsifiable next step; gardening-only links are irrelevant to the software goal. |
| Strategic: personal metrics dashboard goal | Goal-relevant cross-domain hypothesis or explicit no-candidate result | Must cite the accepted goal plus supporting public sources; private finance decoys must not appear in evidence. |
| Contradiction: cache every response vs never cache authenticated responses | Contradiction must be surfaced as uncertainty or rejected | An output asserting either universal rule as fact is a contradiction/hallucination failure. |
| Duplicate / unsupported | Reject or require review | Repeats of known discoveries or statements without source support must not be accepted as verified knowledge. |

The live test currently measures schema completion, source-revision grounding, privacy exclusion, speculative status, and critic outcome. It logs model responses' review flags. Semantic quality scores for novelty, usefulness, contradiction handling, and hallucination rate are not yet computed by an independent blinded annotator; these dimensions remain NOT_RUN rather than being inferred from structural checks.
