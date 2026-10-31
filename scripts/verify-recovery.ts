import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'recovery', title: 'Backup, restore and disaster recovery',
  files: ['dist/tests/backups/backup-restore.test.js'],
  gaps: [
    { item: 'Restore on a different machine', status: 'NOT_RUN', reason: 'Restores go to a fresh directory on the same host.' },
    { item: 'Hard-purge propagation into existing backups', status: 'UNSUPPORTED', reason: 'A backup taken before a purge keeps the plaintext. This is tested and documented, not solved.' },
    { item: 'Backup cadence RPO/RTO policy', status: 'NOT_RUN', reason: 'Restore wall time is measured on a small vault; no cadence is defined or scheduled.' },
    { item: 'Incremental backup', status: 'UNSUPPORTED', reason: 'Backups are full copies; the consistent-cut lock is bounded, but the copy itself is not incremental.' }
  ],
  limitations: ['The 10K-document backup replay produced a coherent 30,040-file snapshot in 99.0 seconds; an acknowledged concurrent write completed in 315.2 ms (under the 1 s writer-stall target). This is one warm-cache Darwin arm64 run, not a general backup-duration guarantee. Same-disk revision history is not a backup.']
}));
