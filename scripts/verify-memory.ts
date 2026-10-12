import { promises as fs } from 'node:fs';
import { runSuite, summarize } from './lib/suite.js';
const remote = await fs.readFile('verification/memory/remote-real-host-evaluation.json', 'utf8').then(JSON.parse).catch(() => undefined) as { status?: string; testResult?: { passed?: number; failed?: number; durationMs?: number }; limitations?: string[] } | undefined;
const remoteEvidence = remote ? ` Recent opt-in live run: ${remote.status}, ${remote.testResult?.passed} passed/${remote.testResult?.failed} failed in ${remote.testResult?.durationMs} ms. It used two actual CLIs and credentials through a stopped/restarted HTTP MCP server, including buffered replay, idempotency, SessionEnd and model handoff; limitation: clients/server were on one physical machine, so cross-machine transport remains NOT_RUN.` : ' The opt-in two-host outage/restart test has not been run.';
summarize(await runSuite({
  name: 'memory', title: 'Passive memory integration and secondary recall (M1)',
  files: ['dist/tests/memory/capture.test.js', 'dist/tests/memory/typed-ops.test.js', 'dist/tests/memory/default-workspace.test.js', 'dist/tests/memory/project-binding.test.js', 'dist/tests/memory/project-init-v2.test.js', 'dist/tests/memory/user-setup.test.js', 'dist/tests/memory/session-context.test.js', 'dist/tests/memory/file-sync.test.js', 'dist/tests/memory/recall.test.js', 'dist/tests/memory/real-host.test.js', 'dist/tests/memory/remote-real-host.test.js', 'dist/tests/memory/remote-spool.test.js', 'dist/tests/memory/physical-merge.test.js'],
  allowedSkips: ['real Claude Code', 'real Codex CLI', 'real Claude Code and Codex remote capture'],
  gaps: [
    { item: 'Independent authenticated agents cross-deliver passively across machines, including disconnect, retry, restart recovery and end-of-session retrospective/handoff', status: 'NOT_RUN', reason: `Cross-machine transport: NOT_RUN. ${remoteEvidence} Run MDB_REAL_REMOTE_HOST_TEST=1 with clients on separate machines for that evidence.` },
    { item: 'Codex Stop assistant-message lifecycle event', status: 'NOT_RUN', reason: 'The live Codex 0.161.0 non-interactive `codex exec` dispatched SessionStart, UserPromptSubmit, PostToolUse and SessionEnd, but did not dispatch Stop; assistant-message payload capture is therefore not evidenced for this invocation.' },
    { item: 'Other harnesses (OpenCode, Cursor, ...)', status: 'UNSUPPORTED', reason: 'No adapter. MCP, CLI and SDK remain available.' },
    { item: 'Semantic / hybrid recall', status: 'UNSUPPORTED', reason: 'No embedding provider or vector index; modes return CAPABILITY_UNAVAILABLE.' },
    { item: 'Recall benchmarks at 1k/10k/100k', status: 'NOT_RUN', reason: 'recent/timeline are manifest scans (O(authorized entries) in memory, no document reads); measured with the general benchmark in M5, not here.' },
    { item: 'Hook latency under a loaded host', status: 'NOT_RUN', reason: 'Fail-open and non-blocking behavior is tested (held writer lock, destroyed vault); per-hook wall time is dominated by Node start-up and was not benchmarked.' },
  ],
  limitations: ['Events can be lost if the spool overflows, the host is killed before a hook runs, or SessionEnd is not delivered; each case is counted or swept, never blocking the host.', 'Assistant replies and read-only tool output are not captured by default.', 'Secret redaction is pattern based; unknown secret formats need an --exclude pattern.']
}));
