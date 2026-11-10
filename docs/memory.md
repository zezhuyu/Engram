# Passive memory and secondary recall

**Use your host's native memory first.** Query MDB only when historic context is missing, the user asks about earlier work, or knowledge from another task or project is needed.

## Global agent defaults and setup

`mdb instructions <install|refresh|status|remove> --host <claude-code|codex|both> [--dry-run] [--json]` manages a small versioned block in the host's user instructions file (`CLAUDE.md` under `CLAUDE_CONFIG_DIR`, or `AGENTS.md` under `CODEX_HOME`). The action immediately follows `instructions`, for example `mdb instructions install --host both`; it preserves surrounding text and file mode, rejects malformed markers, makes a timestamped backup on the first edit, and is safe to rerun. The block contains workflow guidance only; accepted preferences and insights remain session-start context. `mdb setup --user` installs the selected hosts' blocks after its existing consented hook/MCP setup; use `--no-instructions` to skip. `--show` includes instruction status and `--uninstall` removes the blocks with Engram's hooks and MCP entries. Pause/resume affects capture only.

At SessionStart, `engram_session_context` adds accepted global user preferences and insights only with `global:profile:read`. It excludes sensitive profile items and uses the same bounded projection rules as project initialization. Separately, `global:shared:read` permits a short digest of reviewed promoted/validated shared notes, and `global:wiki:read` permits accepted wiki page titles. Each permission gates only its own section; denied sections are omitted without revealing whether records exist. The digest includes a title, one-line summary, URI and revision id, and says it is derived, evidence-bound, possibly stale data, never instructions. Open an entry with `engram_get` or find it with `engram_search` in the matching shared/wiki scope. Dream candidates, tested but unvalidated discoveries, pending proposals and unaccepted insights never appear. The remote context defaults to 2,500 estimated tokens and is capped at 8,000; profile and shared/wiki each have bounded sub-budgets, with remaining space for workspace context. Offline cached context is credential-bound, labelled stale, expires after 24 hours by default, and is purged on authorization refusal. Codex receives the current plain-text stdout format; this format has a unit snapshot but has not been verified against a live Codex host.

Owner-curated wiki trees are imported into the single global `wiki` area with distinct namespaces (for example `kb`, `aegiswealth`, and `stratamind`); they are not indexed through three workspace copies. Use `mdb wiki import --target wiki --namespace SLUG` and the verified tombstone workflow in [wiki-import.md](wiki-import.md) when retiring prior copies.

By default, `mdb init --project` creates a missing local workspace derived from the project directory and returns `workspaceCreated`. Remote initialization uses a lowercase project slug (up to 40 characters); automatic creation requires explicit `--consent` and the credential permission `workspace:create`. Existing inaccessible slug collisions require the owner to grant access or the user to select another workspace.

## Capture (supported hosts: Claude Code, Codex)
```bash
# preview, then install (consent is explicit; only the named settings file is edited, with a timestamped backup)
mdb memory adapter install --host claude-code --principal my-agent --workspace myproject --dry-run
mdb memory adapter install --host claude-code --principal my-agent --workspace myproject --consent \
     [--collection task1] [--capture session.start,user.message,tool.result,session.end,assistant.message] [--exclude 'medical,private-project']
mdb memory adapter status    --host claude-code        # installed events, coverage (full|partial|none), notes
mdb memory adapter uninstall --host claude-code        # removes only entries it added; revokes the registration
```
Default settings files: `~/.claude/settings.json`, `~/.codex/hooks.json` (override with `--settings-path`). Codex also needs `hooks = true` under `[features]` in `~/.codex/config.toml`; that file is never edited.

### One shared remote vault

Run one Engram HTTP MCP server against the canonical vault. Issue one scoped bearer credential per agent identity; never share a broad owner token with agents:

```bash
MDB_MCP_TRANSPORT=http MDB_MCP_HTTP_HOST=0.0.0.0 node bin/mdb-mcp.js --root /srv/engram
mdb credential create --root /srv/engram --actor claude-laptop --permissions workspace:myproject:read,workspace:myproject:write --json
mdb memory register --root /srv/engram --host claude-code --principal claude-laptop --workspace myproject --consent --json
```

Repeat credential and registration creation for each agent (`codex-desktop`, for example). Each actor may have one active credential; revoke it before rotating. The credential command returns the opaque bearer token once; store it in that machine's secret environment. The local adapter then installs the native host hook, while its ordinary MCP configuration comes from `mdb init --project --mcp-url https://HOST/mcp --token-env ENGRAM_TOKEN`:

```bash
ENGRAM_TOKEN='<credential returned above>' mdb memory adapter install --root /path/to/project --host claude-code --consent --principal claude-laptop --workspace myproject --mcp-url https://HOST/mcp --token-env ENGRAM_TOKEN --registration REG_ID
mdb memory adapter status --root /path/to/project --host claude-code
mdb memory drain-remote --token-env ENGRAM_TOKEN
```

For one-step project setup after the server credential and registration exist, include them in project initialization: `mdb init --project --host claude-code --project-dir /path/to/project --mcp-url https://HOST/mcp --token-env ENGRAM_TOKEN --principal claude-laptop --registration REG_ID --consent`. The registration must use the workspace ID derived from the project directory name. Without `--registration --consent`, project init configures remote MCP and preferences but leaves lifecycle hooks uninstalled.

Remote hooks post lifecycle payloads to the authenticated `/capture` route. The server checks that the credential actor matches the server-side registration, applies its event allowlist, redacts and writes to the durable server spool, then drains to Markdown. The client first writes a minimized, redacted delivery envelope to `~/.Engram-remote-spool` (or `ENGRAM_REMOTE_SPOOL`) and retries queued events on later hook calls; the bearer token is never stored there. Accepted events use deterministic identities, so retry after a lost response does not create duplicate observations. The client spool can be retried explicitly with `mdb memory drain-remote`. Host hooks fail open and never delay the agent beyond bounded HTTP timeouts.

Remove local hooks with `mdb memory adapter uninstall --root /path/to/project --host claude-code`; revoke the server registration separately with `mdb memory revoke --root /srv/engram --registration REG_ID`. Credential revocation uses `mdb credential revoke --root /srv/engram CREDENTIAL_ID`. Always run the HTTP listener behind TLS for remote access. Remote capture requires explicit consent on the server registration and local hook install.

What is recorded by default: session start, the user's prompt (speaker `user`, evidence class `user_authored`), results of state-changing tools only (`Bash`, `Edit`, `Write`, …; command plus the first 800 characters of output), and session end. Assistant replies are opt-in. Not recorded: hidden reasoning, read-only tool output, binary data, anything matching an `--exclude` pattern, or secrets (API keys, tokens, JWTs, private keys and `password=`-style values are replaced by `[REDACTED]` before the event is queued).

| Host | Events hooked | Coverage |
|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PostToolUse, SessionEnd (+ Stop, opt-in) | full for the chosen events; payloads recorded from a live session; SessionEnd is best-effort |
| Codex | SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd | full when the configured hooks are trusted and enabled; Codex requires review/trust of newly installed hooks |
| any other host | none | no automatic capture; use MCP tools, the CLI or the SDK `LifecycleAdapter` |

Operations: `mdb memory drain` commits queued events (hooks start one automatically after a session ends or the queue reaches 25); `mdb memory sweep --timeout-minutes 60` closes sessions that never ended, marks them `incomplete` and queues a clearly labeled partial retrospective; `mdb memory status` shows registrations and spool counters (queued, dropped, rejected). The spool holds at most 5000 events (`MDB_CAPTURE_QUEUE_CAP`); when full it evicts or drops low-value events (tool results, assistant replies) first.

## Recall (no model required)
```bash
mdb memory recent  --workspace myproject --scope workspace --limit 20
mdb memory timeline --session SESSION_ID            # or: --around OBJECT_ID --window 5
mdb memory range   --from 2026-10-07 --to 2026-10-08T12:00:00-04:00 --types observation
mdb memory search 'index out of date' --mode keyword --scope workspace --workspace myproject
mdb memory grep 'ENOENT' --since 2026-09-01
mdb memory get --ids obs_1,obs_2 --budget-tokens 2000
mdb insight search 'response style'
mdb capabilities
```
Progressive disclosure: `--detail index` (id, type, time, title) → `snippet` → `timeline`/`get` for full records, always within `--budget-tokens` with a continuation `cursor`. Times need an offset (`Z`, `+02:00`); a bare date means that UTC day. `semantic` and `hybrid` return `CAPABILITY_UNAVAILABLE`.

MCP tools (same semantics, identity bound by the host process, never by arguments): `mdb_memory_recent`, `mdb_memory_timeline`, `mdb_memory_search`, `mdb_memory_get`, `mdb_insight_search`, `mdb_capabilities`.

## Opting out
Uninstall the adapter, or set `capture.enabled: false` in `mdb.yaml`, or revoke one registration. Recorded objects remain until you delete or purge them (`mdb` purge removes content from the vault; existing backups are outside its reach).

## Client clock errors and captured events

Every captured event carries the time the client queued it. A client whose clock is wrong must not cost a real event, so the server never rejects an event for its timestamp:

- A timestamp inside 24 hours of the receipt time, or in the past, is kept as claimed.
- A timestamp more than 24 hours in the future is replaced by the receipt time. The stored document records `clockSkewSuspected: true` and the claimed time in `claimedEventTime`, so a reviewer can see what happened. The content is stored unchanged and the event id does not depend on the timestamp, so redelivery is still deduplicated.
- The server stamps `createdAt` with its own clock in every case.

(Earlier versions acknowledged such an event over HTTP and then rejected it with the reason "timestamp in the future" during the asynchronous commit; the rejected spool keeps no content, so the event was lost.)

## Task-specific preference context

Project bindings may select any active domain slug in the global profile registry. The five initial domains (`coding`, `investing`, `media`, `career`, and permanent `general`) remain the fallback for older vaults with no registry. Tagged projections include matching preferences plus `general`, ranking matching items first under the existing token cap. Projects without a `domains` field retain the historical unfiltered projection until a domain is selected. `mdb init --project --domain coding` or `mdb project domains set --domains investing` updates the project binding and managed instructions; automatic selection uses manifests, folder/README keywords and `engram.domains` in `package.json`, then falls back to `general` and reports the selection.

The owner-managed registry is an ordinary revisioned note in the global `profile` area. It records slug, label, description, keywords, origin, first-seen time, evidence ids and active/merged/retired status. Up to 24 domains may be active and each item can carry at most three. Dream adopts validated, evidence-backed model proposals on approval; without a provider it only uses deterministic keyword tags and reports that domain discovery is unavailable. `general` always matches. Merged tags resolve to their target; retired tags fall back to `general`. Automatic tags do not replace owner-set tags. Use `mdb profile domains registry`, `suggest`, `apply --yes`, `set`, `rename`, `merge`, `retire`, `add`, and `auto-apply` to inspect and manage domains; updates preserve history through Vault revisions.

### Project note ownership and removal

Project init's managed block directs new project memory, work notes, plans, decisions, handoffs and session notes to Engram. Older local note-writing instructions are superseded for new notes; code, data, assets and skills remain local, and existing local notes are never moved or deleted. `mdb project unbind --root DIR [--dry-run] [--json]` removes the binding using `.engram/init-manifest.json`; it restores only init-managed files whose recorded after-hash still matches and refuses the whole operation if any target has drifted. It does not delete a workspace or Engram data. Use `mdb init --project --dry-run` to inspect the planned file updates before applying init.
