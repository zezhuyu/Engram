# Changelog

## Unreleased - dashboard interface refactor

### Changed
- Rebuilt both dashboards on one design system (framed sheet, IBM Plex fonts served from the dashboard's own origin, flat fills, grouped navigation, phone layout) and simplified actions to one primary action per screen.
- The server dashboard no longer carries any client settings, cached projects, or saved connections; the client dashboard no longer carries any server settings. Each dashboard now builds and serves only its own script, page shell, and routes.
- The client navigation is This device, Workspaces, Cached projects, Server, and Settings. The Server form now uses Review changes and Apply changes with a password re-check.
- The content security policy gained `font-src 'self'`.

- The ChatGPT tunnel services now start with the server dashboard when the connector is set up, are checked every two minutes, and stay off only after the owner presses Stop (`ENGRAM_TUNNEL_AUTOSTART=off` disables this).
- Both macOS menu bar apps have **Quit Engram Completely…**, which asks first, stops every service that app runs (client: delivery daemon, dashboard, replica sync; server: worker and dashboard, Dream worker, ChatGPT tunnel) and quits. The existing quit item is relabelled and still leaves services running.
- HTTP MCP server: a client that disconnects or stalls while sending a request body no longer keeps that credential's single admission permit forever (which blocked every later request from the same credential until a restart). The body read now settles on disconnect and times out after 60 s.
- Client service: restarting the launchd jobs waits for the old instance to unload and retries the transient `Bootstrap failed: 5` error, so the Client app no longer shows that alert or leaves replica sync unloaded.
- On a Client-only machine (Client app configuration, no Server configuration) the server-backed `mdb` commands now talk to the server by default, using the Client's saved URL and token file, instead of silently building a private local vault whose notes never reach Dream. `--root`, `--local`, and machines that also run the server are unchanged.
- Client replica sync: `mdb` now finds the replica whether or not `ENGRAM_DATA_DIR` is exported (a terminal and the background service used to look in different places, so `service start` reported "no initialized replica" and could not manage it). `service start` leaves a running service alone, so reopening the Client app no longer restarts replica sync (and opens a gap before launchd respawns it), and an unchanged replica unit is not booted out at every launch; after an app update, services still running the old version are restarted onto the new one.
- The Server app restores the Dream worker (`dev.engram.intelligence-worker`) whenever it starts. Previously **Quit Engram Completely** stopped it and reopening the app did not bring it back, so the nightly Dream run was silently skipped until the next login.
- The server dashboard status pill shows Disconnected, not the last good result, when the backend cannot be reached.
- Profile domains: Discovered topics list and a Discover now action.

### Removed
- Remote administration from the client dashboard: saved dashboard connections, the `X-Engram-Connection` proxy, and the `/api/client/connections` routes.

## Unreleased - client dashboard and remote admin

### Added
- Added opt-in dashboard admin/view credentials with hash-only storage, expiry, optional source-IP filters, GET-only view access, TLS listener support, and remote request audit records.
- Added local dashboard Connections and Client settings screens with a credential-isolated API proxy. Remote process lifecycle remains host-local. See `docs/dashboard-client.md`.

## Unreleased - client daemon and server version menu bar

### Added
- `mdb service install|uninstall|status|start|stop|logs` manages the outbox watcher as a user LaunchAgent on macOS or a systemd user service on Linux. Credentials are read from a private token file; see `docs/client-daemon.md`.
- HTTP `GET /version` returns the server package name and version only. The macOS Client menu bar shows the connected server version or an offline state and controls the client daemon.
### Added (dashboard identity and remote connectors)
- Added embedded Engram logo/favicons to the dashboard, login, and setup screens. Settings now documents OpenAI Secure MCP Tunnel and Claude remote connector configuration, stores write-only connector secrets with restrictive permissions, supports hash-backed scoped credential create/list/rotate/revoke, and offers an explicit guarded HTTPS version probe. The dashboard does not start tunnels or change network exposure. See `docs/dashboard.md`.

## Unreleased - memory & dream update (M0-M5)

### Added (dashboard URL notes)
- Chat offers explicit URL reading through the installed Claude or Codex CLI. URL reading is disabled until typed confirmation in Settings, uses bounded read-only CLI profiles, validates URLs and draft schemas, and keeps drafts ephemeral until owner approval. Approval ingests provenance through Vault and creates a note or owner-review proposal; audits retain only host and path hash. See `docs/dashboard.md` and `docs/dashboard-url-notes-smoke.md`.

### Added (dashboard chat and sources)
- Added ephemeral, ACL-filtered wiki chat with revision citations, optional provider synthesis and citation validation; imported pasted text and allowlisted uploads through immutable Vault ingestion; source-backed wiki proposals require owner review. Uploads use an 8 MiB default cap (`MDB_DASHBOARD_UPLOAD_LIMIT_BYTES`), private temporary files in `.mdb/scratch/dashboard-uploads`, and never fetch URLs. See `docs/dashboard.md`.

### Added (dashboard knowledge)
- Owner dashboard now lists/searches and filters authorized knowledge with cursor paging, reads details/history/diffs/links, and supports create, optimistic edit, tombstone, and restore through actor-bound Engram APIs. Added owner workspace creation and reviewed wiki lifecycle proposals; mutations are audited with redacted summaries, document JSON requests are bounded at 256 KiB, and Markdown is rendered as inert text. See `docs/dashboard.md`.

### Added (local dashboard)
- Dashboard bind host and port are configurable with `--host`/`--port` or `MDB_DASHBOARD_HOST`/`MDB_DASHBOARD_PORT`; local interface IPs (including Tailscale) enable remote mode, and Settings reports the active listener. See `docs/dashboard.md`.
- Complete single-page `mdb dashboard` UI for vault status, storage/index, jobs/scheduler, Dream/wiki, capture, settings, and audit. Includes per-change previews, etag-guarded updates, a durable attempt/outcome audit trail, accessible responsive navigation, and local-only browser protections. See `docs/dashboard.md`.
- Dashboard settings fail closed when an attempt cannot be audited; CLI lifecycle, model abort-signal forwarding, dashboard view models, and packaged dashboard assets have regression coverage.

### Added (adaptive background intelligence)
- **Adaptive daily cycle** (`packages/adaptive`, `docs/adaptive-intelligence.md`): sealed committed-journal snapshots, workspace-first DAG (workspace daily summaries + scoped insights -> global profile roots -> Dream over the full authorized corpus), 03:00-local scheduler with conservative idle-window learning, cooperative pause/resume, purge propagation, crash-safe per-workspace cursors. CLI `mdb intelligence schedule|cycles|run --snapshot now`, `mdb workspace daily|changes`; SDK `engram.adaptive`; lane `verify:adaptive`; gates `ADAPTIVE_SCHEDULER`, `WORKSPACE_DAILY_SUMMARY`, `WORKSPACE_SCOPED_INSIGHT`, `GLOBAL_PROFILE_CONSOLIDATION`.
- `IntelligenceEngine`: optional sealed-snapshot input (`job.input.snapshot` + resolver), `run({ jobId })`, `retryNow`; proposals carry `metadata.jobId`. All additive.

### Added
- **Passive memory (M1):** host hooks (Claude Code, Codex) record sessions into a redacted, bounded, fail-open spool; owner-registered identity binding; recall tools (`recent`, `timeline`, `time_range`, `search`, `get`, `insight search`) with progressive disclosure and token budgets; `mdb capabilities`.
- **Evidence-backed user insights (M2):** evidence classes (explicit, user_conversation, wiki_exposure, agent_observation, dream), hypothesis confirmation, conflict handling, `mdb profile correct|project|reconcile`, user-private storage with applicability scope.
- **Wiki & session memory (M3):** dependency-driven page updates, citation lint with one bounded repair, session-end retrospective and handoff, `mdb memory record`.
- **Dreaming (M4):** micro/deep/strategic planners, association retrieval, per-mode schema, discovery critic, rejected-idea suppression, feedback lifecycle (`candidate -> tested -> validated|rejected`), budgets (daily cap, quiet hours, duration), `mdb dream run|feedback|status|list`.
- Providers: OpenAI-compatible adapter, local agent CLI (`claude`/`codex`) backend, `auto` default; private content is not sent to remote providers by default.
- Index-backed retrieval (manifest + ripgrep / SQLite FTS5 overlay), batched backup, FIFO writer-lock queue.
- Verification lanes `verify:{acid,security,search,intelligence,recovery,platform,memory,profile,wiki,dream,release}`.

- **Query engine (v1):** typed AST (`mdb query`, `Engram.queries`, MCP `mdb_query*`), all RFC operator families, CandidateSource seam, snapshot-pinned reads, saved queries, explain; see docs/query.md.
- **Unix text tools:** native `cat head tail grep cut sort uniq wc tr paste comm diff find tree tee`, `mdb filter jq|awk|sed` bridge, `mdb tools`, MCP `mdb_unix`; see docs/unix.md.

- **Search:** bounded top-K evaluation for keyword/grep/regex; SQLite FTS5/BM25 keyword ranking; optional SQLite-backed semantic and hybrid retrieval (RRF, auto = hybrid when ready) with HTTP embedding providers and optional sqlite-vec; `mdb embed`. Memory capture: background drains register themselves so vault removal waits for them.

### Changed
- Data dir: `--root` > `ENGRAM_DATA_DIR` > `MDB_ROOT` > `~/.Engram`.
- Release report has separate verdicts per area; no aggregate GO while any lane is not PASS.
