# Release profile contract

`npm run verify:all` includes `verify:release`, which defaults to
`full-intelligence-beta`. The release verifier reports the selected profile,
its exact required areas and mandatory gates, and all omitted areas/gates.
For automation, set `MDB_RELEASE_PROFILE` or pass `--profile=<name>` to
`verify:release`.

Supported profiles:

- `core-beta`: requires STORAGE, MEMORY, QUERY, UNIX, PLATFORM and PERFORMANCE,
  plus REMOTE_CAPTURE and AGENT_IDENTITY. It excludes the intelligence, Wiki,
  Dream, Preferences and Adaptive feature areas only when a trusted owner
  attestation at `verification/release-capabilities.json` binds the exact
  current source fingerprint, lists the disabled capabilities
  (`adaptive-intelligence`, `dream`, `preferences`, `wiki`), and binds at least
  one built artifact SHA-256. The attestation must be signed with the public
  key configured by `MDB_RELEASE_TRUSTED_PUBLIC_KEY` or
  `MDB_RELEASE_TRUSTED_PUBLIC_KEY_FILE`. A local editable list is not proof.
- `full-intelligence-beta`: requires every area and every mandatory feature
  gate. It may qualify as BETA while production-only GA evidence is incomplete.
- `ga`: requires every area, every mandatory gate, and every production evidence
  item to PASS or carry a valid trusted exclusion. Missing evidence exits
  nonzero; GA eligibility is still not owner authorization to publish.

GA exclusions are Ed25519-signed records in `fixtures/inputs/release-exclusions.json`.
Each signature covers `id`, `approvedBy`, `reason`, `approvedAt`, `expiresAt`,
`sourceFingerprint`, `git_commit`, `profile`, `policyVersion`, and a unique
`nonce`. The record is accepted only for the exact current fingerprint and
commit, `profile: "ga"`, and the current `engram-release-policy/2` version.
Approvals cannot be future-dated, expired, or valid for more than 90 days.
Duplicate IDs and nonces in one file invalidate the duplicates. Core and Full
profiles ignore this file; an exclusion never converts an automated gate.

Mandatory skipped tests are described in the tracked
`scripts/lib/skip-classifications.json` registry. Inventory entries point to a
classification ID and SHA-256 hash; the verifier checks its suite, platform,
prerequisite, reason, profile scope and review status. A skip remains `SKIPPED`
and keeps the mandatory suite gate non-PASS. `pending-owner-review` is not an
approval. `MDB_ALLOW_PENDING_SKIP_CLASSIFICATIONS=1` permits local inventory
development diagnostics only; release verification remains fail-closed by
default.

Any failed, incomplete, stale, missing, malformed, or source-mismatched
required automated gate makes the selected profile `NOT_RELEASABLE` and causes
`verify:release` to exit nonzero. `verify:all` therefore also exits nonzero
when its default full-intelligence profile is not eligible. A successful
`verify` test suite only says the tests passed; it does not authorize a release.

The CI release-qualification job pins `full-intelligence-beta`, runs the full
verification command and accepts only that profile with `BETA` or
`GA_ELIGIBLE`. Publication remains in a separate manually authorized job and
protected environment. CI environment reviewers and owner-controlled branch
protection are external configuration and must be verified separately.

No profile or publication check was exercised against a live CI environment in
this remediation; the workflow is covered by static regression tests only.
