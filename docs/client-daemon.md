# Client delivery daemon

The supported client daemon runs the existing local outbox watcher as the current user. It does not need root, change system settings, or place the credential in launchd/systemd arguments. Store the bearer token in a separate file with mode `0600`; service output contains the token-file path only.

```sh
chmod 600 ~/.config/engram/client.token
mdb service install --url https://memory.example/mcp --token-file ~/.config/engram/client.token
mdb service status
mdb service logs
mdb service stop
mdb service start
mdb service uninstall
```

`ENGRAM_MCP_URL` and `ENGRAM_TOKEN_FILE` can replace the install flags. Optional `--workspace`, `--project-dir`, and `--outbox` set the watcher scope and local queues. `--platform macos|linux` selects a definition explicitly; otherwise the current OS is used. `--dry-run` prints the generated unit without writing. An existing identical install is safe to repeat; changing settings requires uninstall then install. Installation refuses root unless `--allow-root` is explicitly passed for an isolated account, and honors `ENGRAM_AUTO_RECONNECT=0`.

macOS installs `~/Library/LaunchAgents/dev.engram.outbox-watch.plist`, starts it at login, restarts failures with launchd throttling, and writes diagnostics to `~/Library/Logs/Engram/client-daemon.log` with a 5 MiB rotation before starts. Linux installs `~/.config/systemd/user/engram-outbox-watch.service`, enables it for the user session, restarts failures after 10 seconds, and sends output to the user journal (`mdb service logs`). For systemd to start the service at boot before login, an administrator may enable lingering with `loginctl enable-linger USER`; Engram does not run that command.

`status` reports installed, loaded, running, PID, last exit, and server host. It never reports the URL path, token, or vault location. `uninstall` stops/disables and removes only Engram's service definition and its private metadata; it preserves the outbox and token file. Tests inject a temporary home directory and fake service manager commands, so they never touch the real `~/Library` or `~/.config`.

## macOS menu bar

The Client app polls the server's unauthenticated `GET /version` every five seconds with a three-second timeout. The endpoint returns only `{"name":"engram","version":"…"}` and is subject to the MCP HTTP listener's network peer, Host allow-list, Origin, and bounded admission checks. The status item, tooltip, and first menu line show `Engram VERSION`, or `Engram (offline)` when no valid response arrives. Its menu opens the dashboard URL when configured, starts/stops the user daemon, opens daemon logs, and quits the app. The menu icon is the supplied template asset packaged at 40×40 pixels (20×20 points at 2×); the app icon continues to use `macos/assets/icon.png`.

The app reads `ENGRAM_MCP_URL` and `ENGRAM_TOKEN_FILE` from `~/.config/engram/client.env`. The token file remains independently managed and must be mode 0600. The server version is read from the repository package version, not the local client's installed version.

## Verification limits

Automated fixtures validate generated service definitions, lifecycle commands, token permissions, and HTTP endpoint privacy. They do not install a real LaunchAgent or systemd user service. `plutil -lint` runs when testing on macOS; `systemd-analyze verify` runs when available. Physical login/reboot behavior remains platform integration work.
