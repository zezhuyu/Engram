import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'wiki', title: 'Wiki compilation, session memory and handoff (M3)',
  files: ['dist/tests/wiki/compile.test.js', 'dist/tests/memory/handoff.test.js', 'dist/tests/wiki/real-model.test.js'],
  allowedSkips: ['real model'],
  gaps: [
    { item: 'Real-model wiki compilation is opt-in', status: 'NOT_RUN', reason: 'Enable with MDB_REAL_MODEL_TEST=1 (default provider claude-cli). Passed once during M3 (see verification/wiki/m3.md); it spends a little model quota. Model quality (groundedness, hallucination rate) is not scored.' },
    { item: 'Claim extraction as a separate stage and lint of claim-to-span support', status: 'UNSUPPORTED', reason: 'Compilation is one model call per source (plus one repair attempt). The deterministic checks are: evidence is real and readable, target page was supplied, at least one source is cited, every statement cites [n] or says (inference), the page has not changed since compilation. Whether a cited span really supports the sentence is not machine-checked.' },
    { item: 'Page merge/split and topic pages beyond create/update', status: 'UNSUPPORTED', reason: 'A source updates at most one supplied page or creates one page.' },
    { item: 'Re-processing when a source is replaced by a new import of the same file', status: 'UNSUPPORTED', reason: 'Imported sources are immutable; a re-import is a new source object and is compiled like any new source. No explicit "supersedes" link between the two imports exists.' },
    { item: 'Task-complete signal from hosts', status: 'UNSUPPORTED', reason: 'No supported host emits a task-complete hook. task.completed arrives only through explicit `mdb memory record`.' }
  ],
  limitations: ['Retrospectives and handoffs are model output checked for citations, not for factual correctness.', 'Affected pages are chosen by dependency edges and keyword overlap, not semantic similarity.']
}));
