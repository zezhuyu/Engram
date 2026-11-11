import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'platforms', title: 'Platform and filesystem edge cases',
  files: ['dist/tests/platform/environment.test.js'],
  // Permission-bit denial cannot be exercised under root because root bypasses
  // those bits. Keep both cases visible as approved skips in containerized CI.
  gaps: [
    { item: 'Linux (ext4) run of any suite', status: 'NOT_RUN', reason: 'Only macOS/APFS hardware was available. Linux is not a supported release platform until the reliability lane passes there.' },
    { item: 'Windows', status: 'UNSUPPORTED', reason: 'POSIX link/rename/fsync semantics and mkdir locking are assumed; never run.' },
    { item: 'Real disk-full (ENOSPC) on a full volume', status: 'NOT_RUN', reason: 'ENOSPC is injected at stages; no small tmpfs/ramdisk was filled.' },
    { item: 'Network filesystems (NFS, SMB), multi-host shared volumes', status: 'UNSUPPORTED', reason: 'Not designed for or tested on shared volumes.' },
    { item: 'Node versions other than the one run', status: 'NOT_RUN', reason: 'Engines field requires >=22.13; only the version in the environment block was run.' }
  ],
  limitations: ['Case-insensitive filesystem behaviour is verified by rejecting identifiers that differ only by case, on a case-insensitive APFS volume; a case-sensitive volume was not run.']
}));
