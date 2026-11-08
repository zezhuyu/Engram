# Adaptive background intelligence

Engram can run a **daily, silent learning cycle** over a *sealed snapshot* of the vault: workspace summaries and workspace-scoped insights first, then global profile consolidation, then Dream over the full authorized corpus. Continuous capture, search and writes are unaffected and never wait for it. It is opt-in (`mdb intelligence schedule configure --enable`) and needs a configured model for the model-backed stages; without one those stages report `BLOCKED`.

## The cycle (a strict DAG)

`SEAL W -> every eligible workspace (summary + scoped insights) -> global profile roots -> Dream -> COMPLETE`

1. **Seal.** The cycle records the committed journal high-watermark `W`, a revision manifest hash, the access-policy version and the pipeline version. The snapshot is the journal prefix `[1..W]`: for each object, the revision its last record at or before `W` names. It is rebuilt from the append-only journal after a crash, never from mutable heads or timestamps. Records committed later are visible to normal reads and search at once, but are **excluded from this cycle** and become eligible next cycle. The only post-`W` inputs are derived outputs accepted in this same cycle, each listed in the cycle record (`permittedDerived`).
2. **Workspaces** (sequential, concurrency 1). For each workspace with committed changes in `(workspace cursor, W]`: a deterministic, evidence-linked Markdown summary (`kind: workspace_daily_summary`, written through the normal immutable revision API; sections with no evidence say `None evidenced`) and workspace-scoped preferences/insights through the existing profile extraction (evidence classes, explicit-over-inferred, sensitive review). The first run is labelled `INITIAL_BASELINE`: only the cycle's local day is described as change, older content is counted. Workspaces with nothing to do are explicit `NO_ELIGIBLE_CHANGES` successes. A per-workspace cursor advances only after that workspace fully succeeds.
3. **Global profile.** Accepted workspace insights are reconciled. A preference is promoted to global **only** if identical, non-sensitive and supported in at least two workspaces the principal may read, and then only as a *review-gated proposal*. Conflicting workspace preferences are preserved, never flattened. `PROFILE.md` / `USER_INSIGHT.md` are re-projected from accepted insight revisions and a root manifest (hashes + accepted revisions) is checkpointed even when nothing changed.
4. **Dream.** Starts only after every required workspace job and the global stage durably succeeded. It reads the **whole authorized sealed corpus** (including workspaces that were inactive for months, root knowledge and wiki) at or before `W`, plus the enumerated accepted outputs of this cycle. Hypotheses stay hypotheses and are persisted separately; discoveries are never evidence. The cycle records a corpus-visibility manifest and each dream's exact evidence.

Failure semantics: if a workspace stage fails or is blocked, global and Dream do not start; if Dream fails, workspace and global results are kept and only Dream is retried. `resume` always continues from the earliest incomplete stage on the **same snapshot**.

## States

`WAITING, ELIGIBLE, SNAPSHOTTING, WORKSPACES_RUNNING, WORKSPACES_COMMITTED, GLOBAL_PROFILE_RUNNING, GLOBAL_PROFILE_COMMITTED, DREAM_RUNNING, COMMITTING, COMPLETED, PAUSED, RETRY_WAIT, BLOCKED, FAILED, INVALIDATED` (`PROFILE_RUNNING`/`PROFILE_COMMITTED` are read-compatible aliases). Cycle records live in `.mdb/adaptive/cycles/` and contain ids, revisions, hashes and counts, not raw text.

## Scheduling

- Default target **03:00 in the configured IANA time zone** (not the system zone), quiet window 00:00-07:00. At most one scheduled cycle per local date (lease-protected single flight; DST fall-back and zone changes cannot produce a second run). After downtime, one catch-up cycle runs in the next idle window; the cursors make it cover everything not yet processed.
- Starts only after **60 minutes of confirmed inactivity**. Activity is any foreground commit (background writes with `adaptive:`/`proposal:` idempotency keys and the cycle's own sequence ranges are excluded) or an explicit `touchActivity`. The CLI notes activity for non-intelligence commands.
- **Learning** is conservative and uses metadata only: per-local-hour counts of commits plus which hours the scheduler was actually running. Hours without scheduler coverage are *unknown*, not quiet. It needs 14 reliable days inside a rolling 28-day window, moves the window at most one hour at a time, and needs a 25% improvement and 7 days since the last change (hysteresis). `--mode fixed` pins the time. Before that, the default time applies and `confidence` is reported.
- Cooperative pause: while a model call or stage is running a poll watches for foreground activity and resource pressure (load average, RSS). On either, the in-flight call is cancelled, the cycle checkpoints to `PAUSED`, and a later resume reuses the same sealed inputs. Manual runs (`--snapshot now`) ignore activity unless asked.
- Budget: `maxModelCallsPerCycle` bounds model-backed stage jobs per run segment (one Dream job makes several requests).

## Access, purge, recovery

- Policy (workspace grants + capture registrations) is hashed at seal time and re-checked before global and Dream; a change **invalidates** the cycle (`INVALIDATED`) and a new cycle is required. Every read is revision-exact and re-checks ACLs (`vault.get`); purged or unauthorized objects simply vanish from the input.
- **Purge propagates to derived artifacts**: before every cycle, purge events are scanned; workspace summaries, insights and discoveries that cite a purged source are purged too (they quote it), and root Markdown is re-projected.
- Workspace opt-out (`--exclude`, `--include`) removes a workspace from every stage, Dream included.
- Every state change is a durable checkpoint; summary and insight commits use idempotency keys containing workspace, cycle, interval, manifest hash and generator version, so a crash at any checkpoint recovers with no duplicate knowledge and no cursor skips (tested at every checkpoint).
- The cycle never holds the canonical write lock while a model runs; commits are short.
- Atomic snapshots across several vaults are **not** supported or claimed.

## CLI

```
mdb intelligence schedule status|configure|pause|resume|tick
    configure: --enable|--disable --timezone IANA --time HH:MM --quiet-start HH:MM --quiet-end HH:MM
               --mode adaptive|fixed --auto-accept none|low-risk --include A,B --exclude C --inactivity-minutes N
mdb intelligence run --snapshot now --stage daily [--key IDEMPOTENCY_KEY]
mdb intelligence cycles list | cycles show ID
mdb workspace daily list --workspace ID [--from DATE --to DATE]
mdb workspace daily show --workspace ID --date YYYY-MM-DD
mdb workspace changes --workspace ID --since DATE
```

SDK: `engram.adaptive` (`status`, `configure`, `tick`, `runCycle`, `resumeCycle`, `cycles`, `dailyList`, `dailyShow`, `changesSince`). Something must call `tick` periodically (cron, launchd, a supervisor): the library does not start a daemon. `autoAccept: 'low-risk'` commits only explicit, non-sensitive, critic-accepted insights; the default `none` leaves every insight pending review, so Dream then sees no new accepted insights.

## Verification and honest limits

`npm run verify:adaptive` runs `tests/adaptive/` (W+n fencing, stage ordering and failure semantics, per-workspace recovery, crash at every checkpoint, activity pause/resume, purge and policy invalidation, DST/time-zone/catch-up/duplicate schedulers, multi-process writers, SQLite on/off parity, opt-out, CLI). Release gates `ADAPTIVE_SCHEDULER`, `WORKSPACE_DAILY_SUMMARY`, `WORKSPACE_SCOPED_INSIGHT`, `GLOBAL_PROFILE_CONSOLIDATION` are computed from those cases. Not verified: real-model quality inside the cycle (deterministic fixtures only), a numeric foreground-latency budget (none is defined; p95/p99 are measured and recorded), real multi-week telemetry, and the unauthorized-promotion branch (the cycle runs as the owner). Summaries are deterministic restatements of committed records; no model interprets them. Foreground activity that lands inside the cycle's own commit window is attributed to the cycle.

## Running the scheduler unattended (opt-in)

Nothing starts by itself. A daily cycle runs only after `mdb intelligence schedule configure --enable`; the micro trigger only after `--micro on`.

| Command | What it does |
|---|---|
| `mdb intelligence schedule tick` | One bounded decision + run. Safe to call from cron. |
| `mdb intelligence schedule worker [--interval-s 300] [--max-ticks N]` | Long-running loop over the same `tick` (daily cycle, then the micro trigger). Jittered interval, exponential back-off on errors (capped at 30 min), stops on SIGINT/SIGTERM. Stateless between iterations: a restart, a second worker or `kill -9` never double-runs a cycle (vault lease plus once-per-local-date rule). |
| `mdb intelligence schedule service launchd\|systemd [--interval-s N]` | **Prints** a launchd plist / systemd user unit and the install and remove commands. It installs nothing. |
| `mdb intelligence schedule status` | Adds `nextDue`, `lastStarted`, `lastCompleted`, `lastOutcome`, `activeLease`, `deadLetters`, `providerReady`, `microEnabled`. `providerReady` says a provider object exists; `blockedReason` says when it may not be used (for example a remote provider and private workspace content). |
| `mdb intelligence schedule events [--limit N]` | Content-free telemetry (`dream_scheduled`, `dream_claimed`, `dream_started`, `dream_completed`, `dream_skipped`, `dream_retry`, `dream_dead_letter`, `feedback_applied`) with run id, schedule id, cycle id, watermark range, state, reason and bounded durations. A repeated skip reason is logged once. |
| `mdb intelligence schedule configure --micro on\|off [--micro-debounce-minutes 10] [--micro-max-per-day 6]` | Opt-in debounced micro Dream. |

### Behavior contract
- **Daily cycle**: unchanged DAG (seal, workspace summaries and insights, global profile roots, Dream over the full authorized corpus). One scheduled cycle per local date; a missed day is caught up once.
- **Dead letter**: a cycle with `deadLetterAfterAttempts` (default 5) genuine stage failures is quarantined until the next local date (`DEAD_LETTER` skip, `dream_dead_letter` event). Pauses for foreground activity or resource pressure do not count toward quarantine.
- **Micro trigger**: after accepted changes of the configured `kinds` (default `user_insight`, `insight`, `wiki_page`, `source`) go quiet for the debounce, one micro Dream job runs for that journal range, keyed by the range so it cannot run twice. Discoveries, daily summaries and every pipeline commit (`adaptive:`, `proposal:`, `rejected:` idempotency prefixes) never trigger it, so it cannot recurse. A running daily cycle has priority; `maxPerDay` caps cost; enabling never backfills history; with no provider it logs `MODEL_UNAVAILABLE` and runs nothing.
- **Model-free**: deterministic maintenance continues; model-backed stages report BLOCKED / `MODEL_UNAVAILABLE`, never success.

### Installing the service (owner action)
- macOS: `mdb intelligence schedule service launchd > dev.engram.intelligence-worker.plist`, then follow the printed `cp` and `launchctl load` line. Remove with `launchctl unload` and deleting the plist.
- Linux: `mdb intelligence schedule service systemd > engram-intelligence-worker.service`, then the printed `systemctl --user enable --now` line.
- Pause without uninstalling: `mdb intelligence schedule pause`; resume with `resume`. Backups: the schedule, cursors, cycle records and the event log live under `.mdb/adaptive/` and the feedback log under `.mdb/intelligence/`; include both in vault backups.

## Dream feedback and learning
- `mdb dream rate ID --label useful|not_useful|duplicate|incorrect|needs_evidence --note T` adds a new revision with the rating (the discovery status is unchanged). `mdb dream feedback ID --outcome tested|validated|rejected|superseded` still changes status; `validated` still needs the user or a cited experiment.
- Every rating or outcome is also an event in the append-only `dream-feedback.jsonl` (line number = version). Ranking parameters are derived from it as Beta(1 + positive, 1 + negative) per candidate family and enter the planner as a bounded multiplier in (0.5, 1.5). They only change which candidate pairs are tried first.
- Excluded from the parameters: model-sourced feedback, feedback about discoveries that were deleted or that the vault actor cannot read, and everything before the last reset. Nothing is written to `PROFILE.md` or any factual insight.
- `mdb dream learning status [--as-of-version N]` shows the parameters (re-evaluable at any earlier version); `mdb dream learning reset --note T` (owner) restarts from the prior while keeping the history.
- `npm run eval:dream-learning` runs the temporal-holdout evaluation (`verification/dream/learning-*.md`); `npm run verify:scheduler-e2e` runs real worker processes on the real clock (`verification/dream/scheduler-*.md`).

## Reads never modify a vault; the activity marker lives outside it
- `search`, `grep`, `get`, `history`, `context`, `links`, `backlinks`, `related`, `query` (except `query save`), `verify`, `doctor`, `capabilities` and the listing/status subcommands are read-only: they leave every file in the vault unchanged, apart from **rebuildable derived caches under `.mdb/indexes/`** (the persisted manifest, the filesystem trigram index, SQLite indexes), which are created only when the vault is writable and are skipped on a read-only filesystem. `tests/security/read-only.test.ts` checks this on both backends, including a `chmod`-read-only copy.
- The "someone is using the vault" marker that makes the nightly Dream wait is **telemetry kept outside the vault**: `$ENGRAM_STATE_DIR`, else `$XDG_STATE_HOME/engram`, else `~/.local/state/engram`, file `activity/<sha256 of the vault's real path>.json`. It is written only for a vault whose schedule is enabled and only by commands that are not read-only (`put`, `patch`, `delete`, `ingest`, ...). Delete the directory at any time; the only effect is that the scheduler loses the hint (journal commits still count as activity). An in-vault `.mdb/adaptive/activity.json` written by older versions is still read and is never written again.

## Starting the worker at boot on Linux (systemd)

`mdb intelligence schedule service systemd` prints a **user** unit (`WantedBy=default.target`). Install it for the account that owns the vault, and enable lingering so that the user's systemd manager starts at boot without anyone logging in:

```sh
sudo loginctl enable-linger USER
mkdir -p ~USER/.config/systemd/user   # save the printed unit here as engram-worker.service
systemctl --user daemon-reload && systemctl --user enable --now engram-worker.service
```

Without lingering the service only starts at the first login of that user. Verified on a real reboot of a Debian 12 guest (systemd 252): the service came back as a new process with no login, the schedule and its event history were intact, and the due cycle ran once.
