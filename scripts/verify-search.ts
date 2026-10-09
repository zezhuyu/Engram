import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'search', title: 'Search correctness, parity, staleness, index recovery, bounded retrieval, BM25 ranking, optional semantic/hybrid',
  files: ['dist/tests/search.test.js', 'dist/tests/search/golden.test.js', 'dist/tests/search/optimized.test.js', 'dist/tests/search/bounded.test.js', 'dist/tests/search/semantic.test.js', 'dist/tests/search/embedder.test.js'],
  gaps: [
    { item: 'Index-backed retrieval at 100k documents', status: 'NOT_RUN', reason: 'Building 100k documents through the fsynced commit protocol takes hours; 1k and 10k are measured. Bounded evaluation (tests/search/bounded.test.ts) reads a small fraction of matches for small pages; its effect at 10k/100k has NOT been re-measured since the change.' },
    { item: 'Semantic and hybrid retrieval quality with a real embedding model', status: 'NOT_RUN', reason: 'Mechanics, ACLs, revision consistency, privacy and failure handling are tested with a deterministic concept embedder and a real local HTTP server speaking the OpenAI embeddings protocol. No real model was evaluated, so retrieval quality is not claimed. Semantic/hybrid exist only with SQLite enabled and a configured provider.' },
    { item: 'sqlite-vec acceleration', status: 'NOT_RUN', reason: 'Run with ENGRAM_SQLITE_VEC pointing at the extension (passed once on macOS arm64 during development); otherwise the portable scan is used and tested. Neither path is an approximate index: both scan all accepted vectors.' },
    { item: 'Vector search at 100k documents', status: 'NOT_RUN', reason: 'Brute-force scan cost grows linearly; no benchmark has been run (deferred by request).' },
    { item: 'WAL concurrent reader/writer/checkpoint stress', status: 'NOT_RUN', reason: 'Databases use WAL; rebuild-kill and corruption cases ran, a dedicated concurrent checkpoint stress did not.' },
    { item: 'Ranking quality', status: 'UNSUPPORTED', reason: 'Filesystem parity is exact. With SQLite, keyword results are ordered by FTS5 BM25 (reported as ranking: bm25): result sets, revisions, lines and snippets are compared with the oracle, the order is checked to follow the reported score, and no relevance-quality evaluation was done.' },
    { item: 'Files edited outside the API during search', status: 'NOT_RUN', reason: 'Covered for reconciliation (storage tests); not combined with search in this suite.' }
  ],
  limitations: ['Filesystem and SQLite engines were compared on 19 golden queries over ASCII, CJK, accents, emoji, punctuation, code fences, frontmatter lookalikes, duplicate titles, tombstones and permission boundaries.', 'Both modes run the full golden corpus; the --no-sqlite functional suite is the default configuration of every other suite.']
}));
