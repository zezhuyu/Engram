# Engram macOS client and server apps

The release contains `Engram Client.app` and `Engram Server.app`. Both use `macos/assets/icon-white.png` (the logo on a white rounded plate; `icon.png` is the transparent original) as their main app icon and `macos/assets/menu_bar.png` as a template menu bar icon. They run as menu bar apps without a Dock window. The Client app supervises the outbox delivery worker and its own loopback-only dashboard; the Server app runs the existing authenticated HTTP MCP gateway. Local agents still connect using their native MCP settings and hooks.

## Build and release

`node scripts/package-macos.mjs dist-macos` builds the existing standalone runtime and both apps on the current Mac architecture. An existing standalone bundle may be supplied as the second argument to avoid rebuilding it. CI publishes separate client and server app downloads for macOS arm64 (`.dmg`) and Linux x64 (`.deb`), plus `SHA256SUMS`. Each macOS disk image opens directly to its `.app`, boot-service installer, and this README. Linux Debian packages install each role under `/opt/engram-*` and include systemd installation instructions. Release assets are per-role installable platform packages, not gzip archives.

The app bundles use ad hoc signatures. Developer ID signing and notarization require an Apple developer identity and are not configured here. Packaging tests compile and sign fixture app bundles without installing or opening production apps.

## Install from a release

Download the `.dmg` for your role and Mac from [GitHub Releases](https://github.com/zezhuyu/Engram/releases), drag the app to `/Applications`, then remove the quarantine flag. This is required on macOS because the apps are ad hoc signed and not notarized. Run it once per app, with that app's exact name:

```sh
sudo xattr -rd com.apple.quarantine "/Applications/Engram Server.app"
sudo xattr -rd com.apple.quarantine "/Applications/Engram Client.app"
```

Open the app afterwards. To update, replace the app in `/Applications`, run the same command on the new copy, and restart its background service. The app bundle contains only code: the vault (`~/.Engram` or `ENGRAM_DATA_DIR`) and the configuration in `~/.config/engram/` are never part of an update.

On first launch and each subsequent app launch, the app best-effort installs or refreshes `~/.local/bin/mdb`. This managed shim resolves the current Server app first and then the Client app in `/Applications` or `~/Applications`; a Server launch uses `ENGRAM_DATA_DIR` from `server.env` when set, otherwise `~/.Engram`. It never replaces a command without the `# engram-managed-shim v1` header and does not block app startup if installation fails. `mdb shim status` reports installation and PATH state. If needed, add the displayed `export PATH=...` line to your shell configuration; Engram does not edit shell startup files. Run `mdb shim remove` before removing the final Engram app if you want the command deleted; it removes only a managed shim.

## Configuration and login startup

Move the app to a stable location such as `/Applications` before first opening it. Each app creates a private configuration file and enables Start at Login by default. Both apps use separate launchd labels, configuration files, and logs:

| Role | Configuration | Background job | Log |
| --- | --- | --- | --- |
| Client | `~/.config/engram/client.env` | `dev.engram.outbox-watch`, `dev.engram.client-dashboard` | `~/Library/Logs/Engram/client-daemon.log`, `client-dashboard.log` |
| Server | `~/.config/engram/server.env` | `org.engram.server.worker` | `~/Library/Logs/Engram/server.log` |

Both load the existing `~/.config/engram/engram.env` first, if present, then the role-specific file. These are local shell environment files and must have mode 600 or 400. Never copy them into a release artifact.

For the client, set `ENGRAM_MCP_URL` to the authorized server endpoint and `ENGRAM_TOKEN_FILE` to a separate mode-0600 file containing the scoped bearer token. Optional settings are `ENGRAM_WORKSPACE`, `ENGRAM_PROJECT_DIR`, `ENGRAM_OUTBOX`, `ENGRAM_DASHBOARD_URL`, and `ENGRAM_CLIENT_DASHBOARD_PORT` (default `4872`). The Client app shows the connected server version from `/version`, or `Engram (offline)` when unreachable, and reports whether its local dashboard is running. **Open dashboard** opens the one-time setup URL while initial password setup is pending, then opens `http://127.0.0.1:<port>/`; an explicit `ENGRAM_DASHBOARD_URL` in `client.env` overrides the opened URL. **Copy first-time sign-in link** is available only while setup is pending. The setup URL is read from `~/.config/engram/client-dashboard.txt`, which is private mode `0600`, and is never written to the shared dashboard log or shown in a text field. The token-free first-time sign-in screen points users to the Client menu. Client dashboard auth state is under `~/Library/Application Support/Engram/client-dashboard/`. See `docs/client-daemon.md` for setup and CLI details.

The Server app also has **Open dashboard** and **Copy first-time sign-in link** menu actions. It reads its setup note from `~/.config/engram/dashboard.txt`; any LAN host in the saved link is changed to `127.0.0.1` when opening locally. `ENGRAM_DASHBOARD_PORT` selects the dashboard port (default `4871`).

On macOS both dashboard services show a native startup alert with the first-run URL. The window appears only on first use, when no dashboard password has been set yet; once a password exists no pop-up appears and the private access token is never shown or printed (the dashboard URL is shown without it). Set `MDB_DASHBOARD_ALERT=false` in the service environment to suppress it. For the Client dashboard, the token-bearing URL is visible in the alert and stored in the private `~/.config/engram/client-dashboard.txt` note; it never goes to the shared dashboard log. The Client status pill summarizes sync service, token-file safety, capture-server reachability and queued/conflicted/rejected events. An offline server is Attention while local buffering continues.

In the client dashboard, **Server** is the capture endpoint form. It previews changes to the client environment, outbox service, user capture config, configured agent MCP entries, and already-installed remote hooks. Applying requires reviewing the target list (**Review changes**) and re-entering the dashboard password. The form accepts a token file path (default `~/.config/engram/client.token`), never a token value. Administering a server from a client dashboard (saved connections) was removed; use the server's own dashboard.

For the server, configure its existing `ENGRAM_DATA_DIR`, HTTP credential or OAuth validation settings, and ingress options. HTTP defaults to loopback on port 3333 with the remote-web toolset. Public access still requires authenticated HTTPS ingress.

Use Edit Configuration, then Stop Background Service and Start Background Service to apply changes. Quitting the menu bar app leaves the independently supervised worker running. To stop everything, choose **Quit Engram Completely…**: after a confirmation it stops the worker (and, on a server, the dashboard, the Dream worker and the ChatGPT tunnel) and then quits the app. Nothing is uninstalled; with Start at Login on, the app starts again at the next login. Start at Login controls future user-login startup; turning it off leaves the currently running worker alive until it is stopped or the session ends. Stopping a worker removes its login worker plist. If Start at Login remains enabled, opening the app at the next login starts it again.

## Startup before user login

For a worker that must start at system boot before a user logs in, use the supplied `install-macos-boot.mjs` next to the extracted app. First configure the app, turn off Start at Login, and stop its login background service. Install the boot worker using the app's embedded Node runtime, for example:

```sh
sudo "/Applications/Engram Server.app/Contents/Resources/backend/runtime/bin/node" \
  ./install-macos-boot.mjs install "/Applications/Engram Server.app" SERVICE_USER
sudo "/Applications/Engram Client.app/Contents/Resources/backend/runtime/bin/node" \
  ./install-macos-boot.mjs install "/Applications/Engram Client.app" SERVICE_USER
```

Each boot job runs as the named non-root user with that user's HOME and configuration. The installer refuses an already installed boot job or an active login worker to prevent duplicate workers. Boot services use `org.engram.client.boot` / `org.engram.server.boot`; errors are logged to `/var/log/engram-client.log` / `/var/log/engram-server.log`. The menu bar app recognizes the boot service and does not start a second login worker. A menu bar icon appears only after user login.

Remove a boot worker with the same command using `uninstall` instead of `install`. User login startup requires no administrator access; boot installation requires sudo. This implementation has not installed startup jobs on the development machine or performed a physical reboot verification.
