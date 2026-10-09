import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'acid', title: 'ACID, isolation and invariant verification', concurrency: 1,
  files: ['dist/tests/acid/fault-matrix.test.js', 'dist/tests/isolation/multiprocess.test.js', 'dist/tests/isolation/lock-fairness.test.js', 'dist/tests/fuzz/state-machine.test.js', 'dist/tests/storage.test.js', 'dist/tests/durability.test.js'],
  gaps: [
    { item: 'Power-cut durability (hardware/VM)', status: 'NOT_RUN', reason: 'SIGKILL keeps the OS page cache, so it cannot prove fsync ordering. The protocol (file fsync, link, directory fsync incl. newly created parents, journal fsync) is implemented and inspected, but no power cut was performed.' },
    { item: 'fsync failure semantics (EIO from fsync itself)', status: 'NOT_RUN', reason: 'EIO/ENOSPC are injected at named stages around the fsync points, not returned by a failing fsync syscall (needs an injectable filesystem adapter or dm-error/FUSE).' },
    { item: 'Real short writes and disk-full ENOSPC', status: 'UNSUPPORTED', reason: 'Simulated by stage faults and by appending partial journal records; no fault-injecting filesystem was used.' },
    { item: 'Per-workspace write parallelism', status: 'UNSUPPORTED', reason: 'A single vault-wide writer lock serializes all writes. Independent workspaces do not run in parallel (documented design limit).' },
    { item: '100-process mixed workload', status: 'NOT_RUN', reason: '10 and 50 process runs executed; 100 not run.' },
    { item: 'Linearizability history checker', status: 'NOT_RUN', reason: 'Histories are recorded and checked for lost updates, conflicts and revision order; no real-time-order checker is claimed. Isolation claim: serialized writes per vault (single lock) with optimistic expected-revision conflict detection; reads are lock-free and see whole committed revisions.' },
    { item: 'Linux ext4 run', status: 'NOT_RUN', reason: 'Only macOS/APFS was available.' },
    { item: 'Network/shared filesystems, multi-host', status: 'UNSUPPORTED', reason: 'mkdir-based lock and link/rename semantics are only assumed on local filesystems.' }
  ],
  limitations: [
    'Commit point: the journal record is appended and fsynced. Unacknowledged transactions that passed the commit point may appear after recovery (tested and documented); transactions before it never do.',
    'Orphan revisions from pre-commit crashes are reported by recover() and retained, never presented as commits.',
    'Fuzz uses an in-repo seeded PRNG rather than fast-check to avoid a new dependency; failures print a replayable seed.',
    'The symlink-swap race is narrowed (verified-open of temp files) but not eliminated: Node has no openat().'
  ]
}));
