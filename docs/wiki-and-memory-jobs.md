# Wiki compilation, retrospectives and handoffs

## Wiki: incremental, cited, reviewed
A new source (an immutable import) queues a `wiki` job. The job never reads the whole wiki:
1. **Affected pages** are the pages that already derive from the source (the `derived_from` links, looked up in the journal-synced manifest), then the best keyword matches among pages in the same scope, at most three.
2. The model receives the new source plus those pages only, and either **updates** one of them (`metadata.targetPageId`, which must be one it was shown) or **creates** a page.
3. The engine, not the model, derives the dependency edges (`derived_from` → every cited source) and the compile metadata (`sourceIds`, `targetRevisionId`).
4. Mechanical checks: evidence objects and revisions exist and are readable; at least one cited object is a source, not only the page itself; every statement paragraph or list item carries `[n]` (n = position in the evidence array) or says `(inference)`; open questions are exempt. A failed check allows one repair attempt where the model is told the exact problem; after that the proposal is rejected with the reason kept.
5. Review: approval of an update creates a **new revision of the same page** (old text, evidence and dependency edges stay readable; edges accumulate). If the page changed after compilation the proposal is rejected (`page_changed`) and the human edit is kept.
Private workspace sources compile only inside their own workspace, never into the global wiki; promotion stays an explicit operation.

## Retrospective and handoff
Ending a session (a hook's `SessionEnd`, `mdb session end`, or `mdb memory sweep` for abandoned ones) queues two jobs in the owner's queue:
- a **retrospective** (`reflection`): goal, approaches, result, failures, follow-ups;
- a **handoff** (`working_memory`, `metadata.handoff: true`): state, decisions, open issues, next steps. For an abandoned session the instruction says INCOMPLETE and the object is marked `incomplete: true`; the outcome must be stated as unknown.
The model sees who said what (`speaker`, `source_class`); both objects must cite their evidence like wiki pages. They stay in the session's workspace and are fetched on demand (`mdb memory recent --types working_memory`); nothing is injected into a host automatically.
`mdb memory record --registration R --type note.created|decision|finding|task.completed --session S --text T [--speaker user]` saves an explicit item through the same checks; `task.completed` queues a retrospective.
