# Operations

Client presence is stored as atomic JSON in `.mdb/client-presence.json` beneath the server data root (file mode 0600, directory mode 0700). It is outside the Markdown journal and is disposable: deleting it clears the dashboard's client status inventory, and clients repopulate it with their next heartbeat. It contains no credential tokens or file contents.

Use Node >=22.13; Node 24 LTS is recommended. From the repository run `npm install`, `npm run build`, then `node bin/mdb.js help`. CLI commands use the trusted local owner. `--root PATH`, `ENGRAM_DATA_DIR` (or legacy `MDB_ROOT`), or the default `~/.Engram` select the vault, in that order of precedence. Use a dedicated directory rather than mixing a vault with repository files.

## Initialize, inspect and maintain

```bash
node bin/mdb.js init --root ./my-vault --no-sqlite
node bin/mdb.js doctor --root ./my-vault --json
node bin/mdb.js verify --root ./my-vault --json
node bin/mdb.js index rebuild --root ./my-vault
node bin/mdb.js index status --root ./my-vault
node bin/mdb.js intelligence run --job index --root ./my-vault
node bin/mdb.js jobs status --root ./my-vault
```

Omit `--no-sqlite` to enable optional SQLite configuration. A missing SQLite runtime/index does not remove pure-file retrieval. Inspect returned fallback and health information; rebuild after enabling SQLite or deleting caches. `doctor` reports vault/configuration state and probes optional Node SQLite/FTS5 availability in memory. Its provider/dream report describes the standalone vault and cannot discover a provider attached to a separate SDK instance; setting a provider name in YAML does not load one. `verify` audits canonical revisions and source hashes. Neither substitutes for the automated suite.

## Command-line shim

`mdb shim install|status|remove [--dir PATH] [--json] [--dry-run]` manages a small `mdb` launcher in `~/.local/bin` (or the selected directory). macOS app first launch and standalone service installation invoke install automatically. The shim resolves the current Server app first and then Client app under `/Applications` and `~/Applications`; Server runs pin `ENGRAM_DATA_DIR` from only that assignment in `~/.config/engram/server.env`, defaulting to `~/.Engram`. An existing command without the `# engram-managed-shim v1` header is left untouched. Remove, including `mdb setup --user --uninstall`, deletes only an Engram-managed shim. No shell startup file is edited. If the directory is absent from `PATH`, status and the dashboard Settings page show the path and a copyable `export PATH=...` suggestion.

Create workspace and collection scopes before writes. Owner grants can be managed explicitly:

```bash
node bin/mdb.js workspace create research --root ./my-vault
node bin/mdb.js workspace grant research agent-a --permissions read,write --root ./my-vault
node bin/mdb.js collection create task --workspace research --root ./my-vault
node bin/mdb.js workspace revoke research agent-a --root ./my-vault
```

Host-supplied permission capabilities are independent of workspace grant records. Revocation of a workspace record does not revoke an explicit equivalent host capability; change both where applicable.

## Recovery and external edits

```bash
node bin/mdb.js recover --root ./my-vault
node bin/mdb.js reconcile --root ./my-vault
node bin/mdb.js index rebuild --root ./my-vault
```

Recovery follows committed journal records, repairs current views/heads and reports orphan revisions. When it replaces an altered view, it preserves the old bytes in quarantine. Reconcile explicitly imports valid edits to current non-source views as new revisions and quarantines invalid/conflicting edits. Run reconcile before recovery if the intention is to accept external edits. No watcher starts automatically. An owner-bound SDK host can call `vault.watch({ intervalMs: 5000, onError })` to enable recursive notifications plus periodic reconciliation, then `close()` the returned handle. Native watcher unavailability still leaves the interval fallback; the unreferenced handle requires another live host event source. Never edit revision history, source originals or journal records.

Writer locks are local and have a timeout; dead-owner recovery uses local process identity. Stop a competing live writer or retry a genuine conflict rather than deleting its lock. Multi-host/network-filesystem writes are unsupported.

The HTTP MCP server stops accepting requests on SIGINT/SIGTERM and gives active requests up to five seconds to drain. It then closes only its own remaining HTTP connections so long-lived or stalled clients cannot prevent shutdown indefinitely. In-flight writes interrupted during this shutdown window must be retried with their idempotency key; recovery follows the journal commit point.

## Sessions and reviewed work

For owner-run, resumable migration of a Markdown wiki and its raw source files, see [Wiki import](wiki-import.md). Use fixture trees for validation; the importer reads source trees and leaves them unchanged.

```bash
node bin/mdb.js session start --scope workspace:research:task --root ./my-vault
node bin/mdb.js session observe --session SESSION_ID --body 'Explicit authored observation' --root ./my-vault
node bin/mdb.js session end --session SESSION_ID --root ./my-vault
node bin/mdb.js profile approve PROPOSAL_ID --reason 'Evidence reviewed' --root ./my-vault
node bin/mdb.js profile reject PROPOSAL_ID --reason 'Unsupported inference' --root ./my-vault
```

Replace placeholders with returned IDs. Review commands handle semantic proposals, including wiki/memory/discovery proposals despite their CLI namespace. The standalone CLI configures no model provider; semantic jobs remain blocked. Supply a trusted provider through the SDK for real synthesis. Capture is manual unless a source has explicit capture consent/allowlisting. Model output never directly changes the vault.

## Backup, restore and retention

```bash
node bin/mdb.js backup ./my-vault-backup --root ./my-vault
node bin/mdb.js backup restore ./my-vault-backup ./restored-vault
node bin/mdb.js verify --root ./restored-vault
node bin/mdb.js index rebuild --root ./restored-vault
```

Backup requires an empty destination outside the vault, excludes writer locks and rejects symlinks. It contains private canonical and derivative data: protect it like the original vault. Restore to a fresh location; do not overwrite another vault casually. Tombstone delete requires an expected revision and preserves history. Authorized purge is a separate SDK operation with explicit confirmation; the CLI has no purge command. Purge cannot erase copied exports, external input, arbitrary backups or future replicas. Rebuild navigation after purge and inspect its limitations report.

## Verification and demonstration

`npm run verify` runs lint, TypeScript checking and built Node tests. `npm run sample` constructs an explicitly synthetic vault; `npm run benchmark` measures local corpus timings. Phase evidence resides in `verification/phase-N.md`. The fixture dream is a reproducible proposal/review demonstration, not real LLM output. Review those reports for platform, corpus, measured values and untested requirements. No S3/PostgreSQL migration, cloud backup, vector setup or remote service is included.

## Verification workflow

| Command | What it does | Evidence |
|---|---|---|
| `npm run verify` | lint, typecheck, fast tests (unit, search, security) | console |
| `npm run test:reliability` | fault matrix, multi-process isolation, state-machine fuzz, backup/restore | console |
| `npm run verify:acid` / `:security` / `:search` / `:intelligence` / `:recovery` | run one lane and write `verification/<lane>/report.{json,md}` (commands, seeds, environment, per-test status, explicit NOT_RUN / UNSUPPORTED list) | `verification/*/report.json` |
| `npm run benchmark -- 10000 15` | seeded corpus benchmark → `verification/benchmarks/<size>.json` | JSON |
| `npm run verify:release` | reads current-source reports and computes the selected release-profile decision; exits non-zero when any required area or mandatory gate is not PASS | `verification/release-report.{json,md}` |

Replay a fuzz failure with `MDB_FUZZ_SEED=<seed> node --test dist/tests/fuzz/state-machine.test.js`. All destructive tests run against disposable vaults created under the OS temp directory; helpers refuse any other path.

Supported platform for this release: macOS (APFS). Linux has not been run. Power-loss durability is untested.

### Multi-project migration helper

`scripts/project-migration.mjs` prepares a per-project backup and dry-run report, then requires a separate `--apply` invocation before initialization. Run `--help` for all options and the backup layout. Example:

```sh
node scripts/project-migration.mjs --project-dir /path/to/project --workspace project --hosts claude-code,codex --backup-root /path/to/backups
node scripts/project-migration.mjs --project-dir /path/to/project --workspace project --hosts claude-code,codex --backup-root /path/to/backups --apply
```

An optional `--notes-include-file FILE` supplies newline-separated relative Markdown include patterns; they are used only with `--file-sync-consent`. `--rollback --backup-dir DIR` restores the backed-up init targets, runs `mdb project unbind`, and compares the restored tree with the integrity manifest saved at apply time.

Tree integrity scanning uses streamed 1 MiB reads with sequential (one-file-at-a-time) hashing, so file contents are never retained in memory. By default files up to 256 MiB are SHA-256 hashed; larger files are compared by size and nanosecond mtime and are labelled as metadata-only in the manifest. The default total-size safety cap is 64 GiB; `--size-cap BYTES` changes it and `--hash-limit-mb N` changes the per-file threshold. Reports include bytes hashed, elapsed time, skipped directory counts, and periodic progress on long scans. A 14 GiB tree takes at least the time required to read and hash its files up to the threshold; large files above 256 MiB need only metadata checks. Actual duration depends on file count and storage; a 14 GiB tree with tens of thousands of small files should be budgeted as several minutes on an external disk, with no fixed wall-time guarantee.

The default runtime-ignore patterns are `.omx/state/**`, `.omx/logs/**`, `.omx/metrics/**`, `.omx/notepad*`, `.git/index`, `.git/index.lock`, `.git/*.lock`, `.DS_Store`, `**/.DS_Store`, `**/__pycache__/**`, `**/*.pyc`, and `.engram/**`. These cover known volatile runtime state, transient filesystem/cache artifacts, and files generated by the binding itself. Ignored paths remain in each manifest; changed ignored paths are reported with a count and path list. Repeat `--runtime-ignore GLOB` to add project-specific volatile paths. Directories named `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `.next`, `coverage`, and `target` are skipped at every depth, along with `.git/objects`; `.git/HEAD`, refs, and other `.git` files remain represented. Skipped directories report per-name file counts. Symlinks are recorded as link targets and are never followed.

The helper never selects a real project on its own. Preview the target and backup first, then run the separate apply command; keep the resulting backup directory for rollback.
# Running the CI checks locally

Engram supports Node.js `>=22.13.0`; GitHub Actions currently exercises Node 22. To reproduce the Linux GNU checks on macOS or another host, use a disposable checkout copy and a Node 22 container:

```sh
tmp="$(mktemp -d)"
git archive --format=tar HEAD | tar -xf - -C "$tmp"
docker run --rm -v "$tmp:/work" -w /work node:22-bookworm bash -lc '
  apt-get update && apt-get install -y gawk jq ripgrep
  npm ci
  npm run verify
  node --test tests/linux-packaging.test.mjs
  npm run verify:unix
  npm run verify:query
  npm run verify:search
  npm run verify:memory
  npm run verify:security
  npm run verify:recovery
  npm run verify:platform
'
rm -rf "$tmp"
```

The Linux service smoke test needs a runner with a working systemd instance and elevated service-install permissions; Docker containers without systemd cannot validate that step. Run it on the GitHub runner with `sudo env ENGRAM_TEST_SYSTEMD=1 "$(command -v node)" --test tests/linux-systemd-smoke.mjs`. On macOS, reproduce CI's no-agent environment by running tests with a temporary empty `PATH`; dashboard model URL validation is required to work without `claude` or `codex` installed. For an exact Node 22 runtime without changing system Node, use `npx -y node@22 --version` and `npx -y node@22 node_modules/typescript/bin/tsc --noEmit` (or the matching Node 22 binary from your version manager).

### Replica epoch after restore

After restoring a server vault to an earlier point, invalidate replica cursors before clients resume pushes. Run `mdb replica epoch bump --scope workspace:ID` for each restored workspace, or `mdb replica epoch bump` to bump the global epoch marker. The command writes the new random epoch and an audit row under `resolveStoragePath('state')/replication/`; it does not modify the vault journal. A client receiving a different epoch must stop pushes, retain its pending queue, and explicitly select `keep-pending-and-refetch` resync. The replica library and operator procedure are present in Phase 1; no automatic restore hook is installed.
# Replica device registry

The server stores pull-client enrollment metadata in `<vault>/.mdb/replication-devices.json`, outside the canonical journal and immutable revisions. The registry is a disposable projection: it is atomically replaced, restricted to 0600 (with `.mdb` at 0700), bounded to 50 devices per credential and 20 scopes per device, and pruned after 90 days without activity. It contains device IDs, neutralized labels, workspace IDs, scope versions, and activity timestamps, but no bearer tokens or document contents. Credential revocation and rotation remove the associated records. Deleting this registry resets enrollments; clients must enroll again.

Replica writes use `POST /replica/v1/push` with a 4 MiB/100-operation bound. Accepted operations return authoritative actor-stamped revision bytes so clients can reconcile their provisional revision before pulling further history. A client may invoke `syncOnce` when it is online; no background worker is installed by this phase. Rejected operations require explicit owner review/discard, and conflict candidates require pull plus explicit resolution. Credential revocation prevents later access and removes device enrollment records, but cannot erase bytes already cached on a disconnected client.

When local edits diverge from an origin update, the replica keeps candidate revisions in immutable history and installs the origin head through the guarded `replicatedFork` journal marker. Resolve by creating a revision on the pulled server head; the conflict closes only after push acceptance and authoritative reconciliation. `discardCandidate(objectId)` chooses the pulled server head while retaining conflict history. Failed individual feed installs are durably recorded in `.replica/deferred.jsonl`, retried before later pulls up to three times, then remain visible in `status()` and the sync report for operator review. Check `deferred`, `held`, `diverged`, and per-object errors before considering a replica settled. Do not remove deferred records or conflict state by hand.


## Replica restore and quota operations

For an origin restore from backup, stop replica writes while the origin is replaced, restore and verify the vault, then inspect `mdb replica epoch status`. The `mdb backup restore SOURCE DESTINATION` command automatically rotates the global server epoch; keep its printed epoch and audit record with the restore record. Each client will report `epoch-changed`; do not clear its queue. Review `mdb replica status --id ID`, then run `mdb replica resync --id ID`. This keeps local pending operations and refetches the restored origin. Operations whose parent is absent are retained and rejected as `PARENT_MISSING` for explicit review; do not force-push them.

Replica cache defaults are 2 GiB, 10,000 pending operations, 256 MiB of pending operation bytes, and 64 MiB per locally cached source blob. Pending-cap failures return `QUOTA_EXCEEDED` before the write commits. `mdb replica status --id ID` shows configured quotas, pending usage, and blob counts. `mdb replica add WORKSPACE --force` is the explicit override when the authorized bounded workspace estimate exceeds the default cache cap. Source originals are fetched on demand with `mdb replica fetch-blob SHA256 --workspace WORKSPACE`; oversized originals remain available through the live server path.

### Older-backup restore with multiple replicas

1. Stop writers and replica daemons, then take and verify a fresh backup of the current origin so the pre-restore state remains recoverable.
2. Restore the selected older backup to the origin's normal destination using `mdb backup restore SOURCE DESTINATION`. Verify the restored vault before reopening service.
3. Check `mdb replica epoch status`. `mdb backup restore` automatically rotates the global epoch; record its output and retain the epoch audit file. For a manually replaced origin that did not use this command, run `mdb replica epoch bump` once.
4. Keep both replicas online only after the origin is healthy. They will report `epoch-changed`; inspect each `mdb replica status --id ID`, then run `mdb replica resync --id ID`. This retains local revisions and queued operations while refetching the restored origin. Do not delete or rewrite pending queues.
5. Sync again. A queued operation whose parent is absent is retained as `rejected: PARENT_MISSING`; it is never force-pushed. Inspect it with `mdb replica conflicts list` / `show`. After an owner reviews the candidate, `mdb replica republish OPID --reviewed` creates a fresh origin object carrying the candidate's content and provenance. Source objects require a fresh reviewed ingest with the source original available.
6. Confirm the intended revisions at the origin and both replicas with `mdb replica verify --id ID`, review open conflicts and pending counts, and retain the old and new backup plus epoch audit record with the incident notes.
