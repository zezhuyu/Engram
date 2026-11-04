# Release profile contract

`npm run verify:all` includes `verify:release`, which defaults to
`full-intelligence-beta`. The release verifier reports the selected profile,
its exact required areas and mandatory gates, and all omitted areas/gates.
For automation, set `MDB_RELEASE_PROFILE` or pass `--profile=<name>` to
`verify:release`.

Release provenance is trusted only when the fingerprinted source tree is clean
and HEAD's tracked blob bytes and modes match the working files. A dirty tree
makes every profile `NO-GO` with `PROVENANCE_DIRTY_TREE`; `MDB_ALLOW_DIRTY_TREE`
is not supported. Exported source without a Git directory requires
`MDB_RELEASE_ARCHIVE_ATTESTATION` to name a strict JSON record containing the
matching `fingerprint`, a 40–64 digit `git_commit`, and a SHA-256
`archive_sha256`. The exported-source CI job creates the record from the clean
checkout before `git archive`, then verifies the archive digest, expected Git
commit, and fingerprint of the extracted source before passing the attestation
to `verify:all`. Attestations reject duplicate JSON keys. Any symlink in a
fingerprinted source path (tracked or untracked, including broken links, loops,
and links to directories or outside the checkout) makes the source state dirty
with reason `SYMLINK_IN_SOURCE`; symlink target strings are fingerprinted for
diagnosis, but symlinks are never releasable. Regular files with more than one
hard link are also dirty with reason `HARDLINK_IN_SOURCE`; the linked paths are
listed because another name can mutate the fingerprinted inode. Strict JSON
evidence parsing rejects nesting deeper than 256 levels with a normal error.
The synthetic-evidence walker only opens regular `.json` files; sockets and
FIFOs are ignored by entry type and never opened.
Suite and release-read benchmark
reports record `treeState`; dirty or missing states are rejected. No-Git reports
can be used only when the candidate-level archive attestation passes (older
reports without the field are not releasable).

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
prerequisite, reason, profile scope and review status. A classification applies
only to profiles named in `requiredByProfiles`. A skip remains `SKIPPED` and
keeps the mandatory suite gate non-PASS, even if the suite report says PASS.
`pending-owner-review` is not an approval. Other `reviewedBy` values are still self-asserted; authenticating them requires the owner-controlled approver identity/key decision (O-01). `MDB_ALLOW_PENDING_SKIP_CLASSIFICATIONS=1`
permits local inventory development diagnostics only; release verification
remains fail-closed by default.

Release JSON inputs are parsed with duplicate-key rejection at every nesting
level. Synthetic fixture evidence is permitted only when both the evidence root
and current working directory resolve under the fixed canonical system temp
bases (`/tmp`, `/private/tmp`, `/var/tmp`, and macOS `DARWIN_USER_TEMP_DIR`)
with `MDB_RELEASE_FIXTURE=1`. `TMPDIR` does not define a trusted base. Evidence
trees containing any file or directory symlink, including broken links and
loops, are rejected.

## JSON read sites

Release-gate inputs and release evidence below use `parseStrictJson` (directly
or through `loadSuiteReport` / the release verifier's `read` helper). Other JSON
decoding remains ordinary `JSON.parse` only for runtime protocol messages,
package metadata, benchmark tooling, or non-release subsystem state.

| Path:line | Reads | Strict | Reason |
|---|---|---:|---|
| `scripts/lib/skip-classifications.ts:25` | Skip classification registry | yes | Registry controls release skip policy. |
| `scripts/lib/suite.ts:73,81,180` | Suite report, source-evidence manifest, and JSONL test-case evidence | yes | All three bind mandatory suite evidence. |
| `scripts/lib/release-evaluation.ts:49,76` | Evidence-tree JSON and release gate status file | yes | Synthetic scan and profile gate input. |
| `scripts/verify-release.ts:24,159` | Release reports, inventories, and benchmark evidence read by `read` / `readSync` | yes | Shared helpers call `parseStrictJson` for every source consumed by this gate. |
| `scripts/verify-suite-inventory.ts:10` | Suite inventory | yes | Inventory determines exact mandatory test coverage. |
| `scripts/update-suite-inventory.ts:11` | Existing suite inventory | yes | Existing policy inventory is the baseline for generation. |
| `scripts/verify-release-authorization.ts:11,12` | Detached authorization and generated release report | yes | Both are publication authorization inputs. |
| `scripts/verify-profile.ts:4` | Real-model profile evaluation report | yes | Report contributes to profile verification output. |
| `scripts/verify-memory.ts:4` | Remote-host memory evaluation report | yes | Report contributes to memory verification output. |
| `scripts/verify-dream.ts:4` | Real-model Dream evaluation report | yes | Report contributes to Dream verification output. |
| `scripts/xhost/report.mjs:4` | Xhost result report | yes | The report is used to produce the release evidence summary. |
| `scripts/xhost/physical.mjs:70` | Host-submitted physical test reports | yes | Merged source data contributes to the REMOTE_CAPTURE release gate. |
| `scripts/storage-monitor-self-test.mjs:126,128` | Child-process summary and diagnostic JSONL | no | Self-test output and diagnostics are not release evidence. |
| `scripts/install-linux-service.mjs:72` | Bundled service role metadata | no | Install-time metadata; no release-policy decision uses it. |
| `scripts/evaluate-profile.ts:14` | Labeled profile evaluation corpus | no | Evaluation input, not an evidence report consumed by the release gate. |
| `scripts/evaluate-profile-multi.ts:16` | Multi-profile evaluation corpus | no | Evaluation input, not release evidence. |
| `scripts/evaluate-dream.ts:14` | Dream evaluation scenarios | no | Evaluation input; the result is separately strict-read by the release verifier. |
| `scripts/profile-retrieval.ts:98,153` | Retrieval benchmark corpus manifest | no | Benchmark runner input, not a gate report. |
| `scripts/benchmark-durable-write.ts:18` | Durable-write benchmark corpus manifest | no | Benchmark runner input; its output is strict-read by release verification and records `treeState`. |
| `scripts/benchmark.ts:106,118,157` | Benchmark corpus manifest and journal records | no | Benchmark runner inputs; release-read outputs record `treeState` and are strict-read by release verification. |
| `scripts/benchmark-query.ts:18,96` | Query benchmark inputs and release-read report | no | Input data is runtime JSON; report records `treeState` and is strict-read by release verification. |
| `scripts/package-linux-deb.mjs:63`, `scripts/package-macos.mjs:28`, `scripts/package-client.mjs:11` | Package metadata | no | Build/package inputs, not release evidence. |
| `scripts/verify-launchd-e2e.mjs:22` | CLI stdout | no | Runtime command response, not a persisted report. |
| `scripts/verify-hosted-mcp.mjs:19,29,32` | HTTP/CLI protocol payloads and environment scope | no | Runtime protocol decoding, not persisted release evidence. |
| `scripts/verify-scheduler-e2e.ts:38` | CLI stdout | no | Runtime command response, not a persisted report. |
| `scripts/xhost/run.mjs:28,29,61,62,99,161,192,204,205` | Remote command output, settings, and temporary spool diagnostics | no | Orchestration protocol / diagnostics, not direct release-gate inputs. |
| `scripts/profiling/analyze-cpuprofile.mjs:3`, `scripts/profiling/final-profile.mjs:18,20,22,25,30`, `scripts/profiling/bench-compare.mjs:23,28`, `scripts/profiling/upper-bound-experiment.mjs:14` | Profiling output and local experiment files | no | Developer profiling artifacts, not release gate evidence. |
| `scripts/profiling/proto-sidecars.mjs:9,13,16,21,23`, `scripts/profiling/proto-journal-hint.mjs:4,9`, `scripts/profiling/proto-resident.mjs:9` | Journal / sidecar benchmark data and local socket messages | no | Developer performance experiments, not release gate evidence. |
| `scripts/competitive/economics.mjs:10-12`, `scripts/competitive/report.mjs:4`, `scripts/competitive/run.mjs:17,36`, `scripts/competitive/phase0.mjs:11` | Competitive benchmark manifests, samples, and CLI output | no | Separate comparative benchmark tooling, not release gate evidence. |
| `packages/mcp/oauth.ts:24,55,65`, `packages/mcp/credentials.ts:22` | OAuth config, keys/JWTs, and credential store | no | Runtime authentication/credential data is outside release evidence parsing. |
| `packages/mcp/index.ts:260,564` | Incoming HTTP/MCP JSON messages | no | Runtime protocol messages, not persisted release evidence. |
| `packages/core/vault.ts:93,180,542,561,584,618` | Vault state, committed journal, lock/operation markers, backup manifest | no | Runtime storage recovery inputs, not release reports. |
| `packages/core/storage-lifecycle.ts:213,233,253,280` | Operation markers and local intelligence telemetry | no | Runtime lifecycle state, not release evidence. |
| `packages/core/project-trust.ts:22`, `packages/core/project-binding.ts:59` | Local project trust and binding files | no | Runtime trust state, not release policy inputs. |
| `scripts/lib/strict-json.ts:11` | A JSON string token inside the strict parser | yes | `JSON.parse` validates an already-delimited token; the strict parser checks object keys and document grammar. |

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
