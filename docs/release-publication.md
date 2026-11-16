# Release publication authorization

The CI workflow runs release qualification after the Linux GNU, Linux reliability, and macOS jobs succeed on every push or pull request. Untagged commits skip the semantic-tag reachability step and are reported as qualification runs; version tags (`vMAJOR.MINOR.PATCH`, with optional prerelease/build metadata) must point to a commit reachable from `main`. The publish job is scheduled after package creation and qualification succeed. Its first authorization check requires an owner-signed authorization bound to the exact source, commit, and version tag, and the protected `engram-release` environment requires separate owner review. The release-creation command itself is restricted to version-tag refs and creates prereleases.

Release qualification accepts a suite's `SKIPPED` report only when every skip has a reviewed platform-specific or GNU-tool classification matching the runner and the inventory's classification hash. Reviewed real-model and real-host skips remain blocking because they indicate missing required evidence; see the [release profile contract](release-profile-contract.md).

The S8 / PLATFORM gate requires all 13 mandatory suites to be effective PASS on every platform listed in `fixtures/inputs/release-matrix.json` (currently `darwin` and `linux`). The qualification runner uses its own current-source suite reports; other platforms use reports imported from the CI artifact at `verification/platform-reports/<platform>/<suite>/report.json`, with each report's hash-bound `source-evidence.json` manifest. Imported evidence must match the current commit and source fingerprint, be clean-tree evidence, and match the reviewed per-platform inventory. Missing evidence is NOT_RUN, invalid evidence is FAIL, and valid but blocking skips are INCOMPLETE. CI does not sign these artifacts; trust is limited to the workflow run and GitHub artifact transport.

## Required repository configuration

Before enabling publication, a repository owner must configure the `engram-release` GitHub Actions environment with:

- Required reviewers limited to the release owner(s).
- Prevent self-review enabled.
- Deployment branches/tags restricted to version tags (`v*`).
- No environment secrets unless a documented release step requires one.
- `ENGRAM_RELEASE_AUTHORIZATION_JSON` containing a short-lived owner-signed authorization and `ENGRAM_RELEASE_AUTHORIZATION_PUBLIC_KEY` containing the corresponding trusted public key. The private signing key must remain offline and must never be stored in GitHub.
- Repository Actions permissions set to read-only by default; the publish job alone receives `contents: write`.

The workflow's `authorize_release` checkbox controls packaging on manual dispatch; it is not a replacement for the signed authorization or protected environment approval. A version-tag push can also reach the publish job, but cannot publish without the exact signed authorization and environment approval. If the environment has not been configured with the requirements above, publication is not authorized. Do not test this by publishing a release.

## Release sequence

1. Complete review and authorize a version tag through the repository's normal protected-branch process.
2. Allow tag CI to build and qualify the source. A tag push alone cannot publish.
3. If using manual dispatch for packaging, dispatch against that exact version tag and check `authorize_release`.
4. A separate required reviewer approves the protected `engram-release` environment.
5. Before publication, the workflow verifies the owner's detached signature over an authorization bound to the exact source fingerprint, commit SHA, semantic-version tag, release profile, release level, approver and fresh timestamp. The signature is checked against `ENGRAM_RELEASE_AUTHORIZATION_PUBLIC_KEY`; editable dispatch inputs do not count as authorization.
6. The workflow publishes direct installer assets only if current full verification and the selected release profile are eligible and the exact-source owner authorization verifies.

The authorization JSON has `schemaVersion: 1`, `purpose: "engram-release"`, `sourceFingerprint`, `ref` (for example `refs/tags/v1.2.3`), `commit`, `profile`, `releaseLevel` (`BETA` or `GA_ELIGIBLE`), `approvedBy`, `approvedAt` (no more than seven days old), and a base64 Ed25519 `signature`. Sign the canonical JSON object with the `signature` field omitted. The verifier rejects missing keys, stale/future timestamps, signature changes, or any source/ref/commit/profile/level mismatch. A BETA signature authorizes only the exact BETA candidate named; it does not promote Engram to GA.

The current Engram candidate remains BETA / NO-GO, so the release policy prevents publication. The owner has not provided a signed release authorization; no release is authorized.
