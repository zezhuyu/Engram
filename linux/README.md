# Engram Linux background client and server

Both standalone bundles include a private Node runtime and work without a desktop or an open application. The client runs the existing outbox delivery worker; the server runs the existing authenticated HTTP MCP gateway. The package build supports Linux x64 and arm64 on compatible glibc distributions with systemd; CI currently publishes x64. Linux remains a BETA build target until native clean-install, service-start, and reboot verification pass.

## Install from a Debian package

The CI release publishes separate `engram-client-linux-x64-SHA.deb` and `engram-server-linux-x64-SHA.deb` installers. Install either app directly:

```sh
sudo apt install ./engram-client-linux-x64-SHA.deb
sudo apt install ./engram-server-linux-x64-SHA.deb
```

The package installs its standalone runtime and launcher under `/opt/engram-client` or `/opt/engram-server`, and places `engram-client` / `engram-server` launch commands on `PATH`. The service installers are `engram-client-service` and `engram-server-service`. Package installation does not enable a background service; configure its protected environment file first, then explicitly run the service installer below.

## Build from source

On Linux, run `node scripts/package-linux.mjs dist-linux`. To reuse an existing standalone runtime, supply its directory as a second argument. CI publishes separate Debian installers for the client and server. No production bundle is built merely by installing this source code.

Each bundle contains its role launcher, `backend/`, and `install-service.mjs`. The bundled `backend/runtime/bin/node` runs the installer; no global Node installation is required.

## Configure

Create `~/.config/engram/client.env` and/or `server.env` for the account running the service, with mode **600** (400 is also accepted). Both launchers first load the existing private `engram.env` in the same directory, then the role configuration. These are trusted local shell environment files. Keep secrets out of bundle archives and service units.

Client configuration:

```sh
ENGRAM_MCP_URL=https://memory.example/mcp
ENGRAM_MCP_TOKEN=YOUR_SCOPED_CREDENTIAL
# Optional: ENGRAM_WORKSPACE, ENGRAM_PROJECT_DIR, ENGRAM_OUTBOX
```

Project reconciliation still requires an existing trusted binding. Server configuration uses existing MCP settings (`MDB_ROOT`, authentication/OAuth options, and HTTP configuration). The server launcher defaults to HTTP, the remote-web toolset, and loopback port 3333. Remote clients require authenticated HTTPS ingress.

## Automatically start at system boot (recommended for a daemon)

Run these commands after creating the configuration for `SERVICE_USER`:

```sh
sudo engram-client-service install system SERVICE_USER
sudo engram-server-service install system SERVICE_USER
```

The installer enables and starts `engram-client.service` / `engram-server.service` as the specified non-root account. They restart automatically, survive logout, and start before login at subsequent boots. systemd supervises the worker directly; no window or tray application is needed.

## User login startup

For per-user startup without sudo:

```sh
engram-client-service install user
engram-server-service install user
```

User services start at login. To also start them at boot and keep them running after logout, an administrator can enable lingering with `sudo loginctl enable-linger SERVICE_USER`. The installer does not change this account-wide setting. Choose either system or user mode for each role; it refuses existing conflicting unit files and the legacy `engram-mcp.service` server unit.

This behavior follows the upstream [systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [loginctl lingering documentation](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html).

## Manage

For system services:

```sh
systemctl status engram-client.service engram-server.service
journalctl -u engram-client.service -u engram-server.service -f
sudo systemctl restart engram-client.service
sudo systemctl stop engram-server.service
```

For user services, use `systemctl --user` and `journalctl --user`. Configuration changes take effect on restart. Remove a service with the same installer command using `uninstall` instead of `install`; system mode requires sudo. Removal stops the worker and disables startup, preserving configuration and memory data.

Linux desktop tray icons are not implemented; Linux bundles provide daemon operation. Alpine/musl and distributions without systemd require a compatible runtime/service manager and are not included in these packages. A successful enable command confirms service registration, not endpoint connectivity; check logs and health separately.
