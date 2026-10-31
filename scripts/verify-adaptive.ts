import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'adaptive', title: 'Adaptive background intelligence: sealed daily cycles, workspace-first DAG, scheduler, recovery (RFC)',
  files: ['dist/tests/adaptive/seal.test.js', 'dist/tests/adaptive/workspace.test.js', 'dist/tests/adaptive/profile.test.js', 'dist/tests/adaptive/recovery.test.js', 'dist/tests/adaptive/schedule.test.js', 'dist/tests/adaptive/concurrency.test.js', 'dist/tests/adaptive/latency.test.js', 'dist/tests/adaptive/worker.test.js', 'dist/tests/adaptive/micro-crash.test.js', 'dist/tests/adaptive/service-units.test.js'],
  // The launchd validator uses macOS-only plutil; the generated plist itself and
  // systemd unit are covered on every platform, while lint is reported as a
  // platform-scoped skip on Linux.
  allowedSkips: ['launchd plist is well-formed (plutil -lint on macOS), runs only the explicit worker command, and escapes special characters'],
  concurrency: 1,
  gaps: [
    { item: 'Real-model quality of workspace-scoped insight extraction and Dream inside the adaptive cycle', status: 'NOT_RUN', reason: 'All adaptive tests use deterministic provider fixtures; the underlying profile/dream prompts are evaluated separately (eval:profile, eval:dream) and the cycle adds no new prompts.' },
    { item: 'Foreground latency acceptance threshold', status: 'NOT_RUN', reason: 'The RFC requires measuring p95/p99 against a no-background baseline but defines no numeric budget; measurements are recorded in the latency case, the criterion is UNDEFINED.' },
    { item: 'Unauthorized cross-workspace promotion (SKIPPED_UNAUTHORIZED path)', status: 'NOT_RUN', reason: 'The cycle runs as the trusted owner, who can read every workspace; the denial branch is code-reviewed but cannot be reached in a test without a non-owner cycle principal.' },
    { item: 'Cross-vault atomic snapshots', status: 'UNSUPPORTED', reason: 'A snapshot is a prefix of one vault\'s committed journal; multi-vault atomic snapshots are explicitly not claimed.' },
    { item: 'Long-horizon telemetry behaviour (real 14-28 day history)', status: 'NOT_RUN', reason: 'Learning, hysteresis and coverage are tested on synthesized telemetry; no real multi-week usage exists.' }
  ],
  limitations: ['Root PROFILE.md/USER_INSIGHT.md are deterministic projections of accepted insight revisions (their history lives in the insight objects), not separately versioned documents.', 'Foreground-activity attribution cannot distinguish a foreground commit that lands inside the cycle\'s own commit window; it is treated as the cycle\'s own.', 'Workspace jobs run sequentially (concurrency 1) rather than in parallel.']
}));
