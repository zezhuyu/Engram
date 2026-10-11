import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'recovery', title: 'Backup, restore and disaster recovery',
  files: ['dist/tests/backups/backup-restore.test.js'],
  gaps: [
    { item: 'Restore on a different machine', status: 'NOT_RUN', reason: 'Restores go to a fresh directory on the same host.' },
    { item: 'Hard-purge propagation into existing backups', status: 'UNSUPPORTED', reason: 'A backup taken before a purge keeps the plaintext. This is tested and documented, not solved.' },
    { item: 'Backup cadence RPO/RTO policy', status: 'NOT_RUN', reason: 'Restore wall time is measured on a small vault; no cadence is defined or scheduled.' },
    { item: 'Incremental backup', status: 'UNSUPPORTED', reason: 'Backups are full copies under the writer lock.' }
  ],
  limitations: ['Backups hold the writer lock, so a backup during writes is a consistent point but delays writers.', 'A same-disk revision history is not a backup.']
}));
