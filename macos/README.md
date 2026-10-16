# Engram macOS client and server apps

The release contains `Engram Client.app` and `Engram Server.app`. Both use `macos/assets/icon.png` as their main app icon and `macos/assets/menu_bar.png` as a template menu bar icon. They run as menu bar apps without a Dock window. The client runs Engram's existing outbox delivery worker; the server runs the existing authenticated HTTP MCP gateway. Local agents still connect using their native MCP settings and hooks.

## Build and release

`node scripts/package-macos.mjs dist-macos` builds the existing standalone runtime and both apps on the current Mac architecture. An existing standalone bundle may be supplied as the second argument to avoid rebuilding it. CI publishes separate client and server app downloads for macOS arm64 (`.dmg`) and Linux x64 (`.deb`), plus `SHA256SUMS`. Each macOS disk image opens directly to its `.app`, boot-service installer, and this README. Linux Debian packages install each role under `/opt/engram-*` and include systemd installation instructions. Release assets are per-role installable platform packages, not gzip archives.

The app bundles use ad hoc signatures. Developer ID signing and notarization require an Apple developer identity and are not configured here. Packaging tests compile and sign fixture app bundles without installing or opening production apps.

## Configuration and login startup

Move the app to a stable location such as `/Applications` before first opening it. Each app creates a private configuration file and enables Start at Login by default. Both apps use separate launchd labels, configuration files, and logs:

| Role | Configuration | Background job | Log |
| --- | --- | --- | --- |
| Client | `~/.config/engram/client.env` | `org.engram.client.worker` | `~/Library/Logs/Engram/client.log` |
| Server | `~/.config/engram/server.env` | `org.engram.server.worker` | `~/Library/Logs/Engram/server.log` |

Both load the existing `~/.config/engram/engram.env` first, if present, then the role-specific file. These are local shell environment files and must have mode 600 or 400. Never copy them into a release artifact.

For the client, set `ENGRAM_MCP_URL` to the authorized server endpoint and `ENGRAM_MCP_TOKEN` to a scoped credential. Optional settings are `ENGRAM_WORKSPACE`, `ENGRAM_PROJECT_DIR`, and `ENGRAM_OUTBOX`. Project reconciliation requires its existing trusted binding. Without endpoint/credential configuration the worker reports an error in its log; it does not claim a connection.

For the server, configure its existing `ENGRAM_DATA_DIR`, HTTP credential or OAuth validation settings, and ingress options. HTTP defaults to loopback on port 3333 with the remote-web toolset. Public access still requires authenticated HTTPS ingress.

Use Edit Configuration, then Stop Background Service and Start Background Service to apply changes. Quitting the menu bar app leaves the independently supervised worker running. Start at Login controls future user-login startup; turning it off leaves the currently running worker alive until it is stopped or the session ends. Stopping a worker removes its login worker plist. If Start at Login remains enabled, opening the app at the next login starts it again.

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
