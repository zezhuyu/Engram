# macOS packaging verification — 2026-10-13

## Results

- `npm run verify`: exit 0; lint, TypeScript checks and build passed; 503 tests, 491 passed, 12 skipped, 0 failed (258.7 seconds for tests).
- `node --test tests/macos-packaging.test.mjs`: exit 0; 4 passed, 0 failed. Fixture builds compiled the native app for macOS 13, created both app bundles, and verified their ad hoc signatures. Worker tests checked quoted configuration, private file permissions, credentials absent from arguments, and server loopback defaults.
- Workflow YAML parsing and `bash -n` for every embedded run script: passed.
- `node --check scripts/package-macos.mjs`, `node --check scripts/install-macos-boot.mjs`, and `git diff --check`: passed.

## Changed functionality

`macos/EngramApp.swift` provides the client/server menu bar controls and independent login workers. `macos/assets/` contains the supplied originals. `scripts/package-macos.mjs` generates application icons, compiles the native wrapper, and packages the existing runtime. `scripts/install-macos-boot.mjs` provides optional pre-login boot services running as a named non-root account. `.github/workflows/ci.yml` includes fixture tests and both native apps in the combined client/server release. `.gitignore` excludes native build output. Usage and configuration are documented in `macos/README.md`.

Existing MCP and outbox-watch operations are reused; no new dependencies were added. Existing uncommitted memory changes were preserved.

## Limits

No production app was built, opened, or installed locally. No launchd job was installed and no physical reboot was tested. Fixture packaging proves bundle construction and launcher behavior, not end-to-end remote connectivity or reboot behavior. GitHub Actions publication has not run remotely. Apple Developer ID signing and notarization require external credentials; the current bundles are ad hoc signed. Live backend tests account for the 12 skipped regression tests. Adaptive and release gate commands were not rerun for this macOS packaging change.
