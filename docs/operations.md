# Operations

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

## Sessions and reviewed work

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
| `npm run verify:release` | reads the reports and computes the GO / NO-GO / STORAGE-ONLY BETA decision; exits non-zero if a P0 storage gate is not PASS | `verification/release-report.{json,md}` |

Replay a fuzz failure with `MDB_FUZZ_SEED=<seed> node --test dist/tests/fuzz/state-machine.test.js`. All destructive tests run against disposable vaults created under the OS temp directory; helpers refuse any other path.

Supported platform for this release: macOS (APFS). Linux has not been run. Power-loss durability is untested.
