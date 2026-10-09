import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'query', title: 'Typed query AST engine: operators, CLI/SDK/MCP parity, reference fuzz, security, recovery (QG1-QG5)',
  files: ['dist/tests/query/operators.test.js', 'dist/tests/query/vault.test.js', 'dist/tests/query/parity.test.js', 'dist/tests/query/fuzz.test.js', 'dist/tests/query/security.test.js', 'dist/tests/query/recovery.test.js'],
  allowedSkips: [],
  gaps: [
    { item: 'QG6: 100K benchmark', status: 'NOT_RUN', reason: 'See verification/query/benchmarks/: 1K and 10K are measured; a 100K corpus takes over an hour to build through the fsynced commit protocol. Recorded as NOT_RUN unless verification/query/benchmarks/100k.json exists.' },
    { item: 'Semantic and hybrid search', status: 'UNSUPPORTED', reason: 'No embedding provider exists. Capability negotiation is tested (CAPABILITY_UNAVAILABLE, labelled keyword downgrade only on request); real semantic retrieval is not implemented.' },
    { item: 'SQL pushdown of metadata, time and graph operators', status: 'UNSUPPORTED', reason: 'SQLite accelerates text search only (FTS5/trigram via the existing engine). Metadata, time and graph operators run on the journal-synced manifest, which is in memory and file-only; they are not SQL.' },
    { item: 'Spill to disk for sort/group/distinct/join', status: 'UNSUPPORTED', reason: 'Blocking operators are bounded by maxBufferRows and fail with RESOURCE_LIMIT rather than spilling.' },
    { item: 'Linear-time regex (RE2)', status: 'UNSUPPORTED', reason: 'JavaScript RegExp with conservative pattern rules and an 8 KiB per-line window; documented in docs/query.md.' },
    { item: 'Query execution on Linux', status: 'NOT_RUN', reason: 'All results were produced on macOS/APFS.' },
    { item: 'Resumable cursors across commits', status: 'UNSUPPORTED', reason: 'A cursor is bound to the journal sequence; after any commit it fails with SNAPSHOT_EXPIRED unless allowCursorDrift is requested (then results may shift).' },
    { item: 'Integration with the final retrieval-optimizer branch', status: 'NOT_RUN', reason: 'Developed in an isolated copy (Engram-query) against the retrieval code as it stood at copy time. Merge into the main tree and re-running verify:all is pending.' }
  ],
  limitations: ['Search-backed queries pin every returned row to the snapshot revision and re-verify objects that changed after the snapshot, but the text index itself is read at its own checkpoint.', 'Semantics of default ordering: id ascending for non-search queries, relevance for search; any other order must be requested.']
}));
