# Linux daemon verification — 2026-10-13

## Implementation

- `scripts/package-linux.mjs`: client and server bundles with the existing standalone Node runtime, role launcher, service installer and instructions.
- `scripts/install-linux-service.mjs`: systemd user-login and system-boot installation/removal. System workers run as a named non-root account. Private configuration, restart supervision, journal logs, duplicate-unit checks and rollback are included.
- `scripts/package-macos.mjs`: reuses the existing worker launcher for Linux with platform-specific runtime paths and permission checks; existing macOS behavior is preserved.
- `.github/workflows/ci.yml`: Linux fixture and live systemd checks, Linux client/server release archives, and the existing combined two-asset release.
- `.gitignore`: ignores `dist-linux/`. `linux/README.md` documents setup and lifecycle. The macOS README now describes both Linux release roles.

No source dependencies were added. Existing uncommitted memory changes were preserved.

## Evidence

| Command | Result |
| --- | --- |
| `npm run verify` | Exit 0: lint, typecheck and build passed; 503 tests, 491 passed, 12 skipped, 0 failed; test duration 284.6 seconds. |
| `node --test tests/linux-packaging.test.mjs` in isolated Ubuntu 24.04 | 7 passed, 0 skipped, 0 failed. Includes real Linux launcher execution and `systemd-analyze verify` for both units. |
| `ENGRAM_TEST_SYSTEMD=1 node --test tests/linux-systemd-smoke.mjs` as root in isolated Ubuntu running systemd | 1 passed, 0 failed. Both roles installed and enabled, ran as the fixture non-root account, survived installer exit, automatically restarted after SIGKILL, restarted on command, and were disabled and removed. |
| `node --test tests/macos-packaging.test.mjs` | 4 passed, 0 failed; both fixture app signatures verified. |
| Workflow YAML parse, embedded `bash -n`, new script syntax checks and `git diff --check` | Passed. |

The Linux environment was a disposable privileged Docker container running systemd as PID 1. It mounted repository sources read-only. Tests used fixture workers and a container runtime, not production memory services; the container and its test services/accounts were removed afterward. A real unit-format defect found during initial testing (`WorkingDirectory` quoting) was corrected before the passing runs.

## Limits

No production app/bundle was built or installed. No physical reboot, live remote memory connection, or Linux arm64 execution was tested. Boot enablement and supervised worker execution were verified with real systemd; physical reboot remains a separate check. User-mode installation was covered by installer tests; login/logout and lingering were not exercised live. Production bundles require compatible glibc Linux and systemd. CI publishes Linux x64; matching-host packaging also supports arm64. GitHub Actions publication has not yet run remotely. The 12 full-suite skips are live backend tests. Adaptive/release gate commands were not rerun for this packaging change.
