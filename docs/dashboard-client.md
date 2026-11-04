# Client dashboard and remote administration

`mdb dashboard --client` starts the same password protected dashboard on the client machine. Open **Connections** to save server addresses and select one; selecting a server proxies dashboard API requests through the local process. Server credentials stay in a local file with mode `0600` and are never returned to the browser. The Connections screen accepts HTTP only for localhost, or an explicitly trusted tailnet endpoint; use HTTPS for other hosts.

## Create a server dashboard credential

Run these commands against the server vault. A credential is shown once and its SHA-256 hash is stored under `.mdb/dashboard/credentials.json` with mode `0600`:

```sh
mdb dashboard credential create --label laptop --mode admin
mdb dashboard credential list
mdb dashboard credential revoke --id dash_...
```

The default expiry is 90 days. Use `--expires-days 1..366` to change it and `--source-ips 192.0.2.10,192.0.2.11` to restrict source addresses. View credentials may call GET routes only. Dashboard credentials are distinct from MCP capture credentials.

## Enable a remote listener

Remote administration is disabled unless `MDB_DASHBOARD_REMOTE_ADMIN=true` is set on the server. Configure a private RFC1918 or tailnet interface, or configure TLS certificate and key paths:

```sh
MDB_DASHBOARD_REMOTE_ADMIN=true \
MDB_DASHBOARD_HOST=192.168.1.20 \
MDB_DASHBOARD_TLS_CERT=/etc/engram/dashboard.crt \
MDB_DASHBOARD_TLS_KEY=/etc/engram/dashboard.key \
mdb dashboard
```

A non-loopback listener without TLS is accepted only on a private interface. Wildcard binds require TLS. Remote dashboard process lifecycle is not exposed over HTTP; use the host's service manager. The dashboard audit records credential label, source IP, method and route without request bodies or token values.

The local browser signs into its local dashboard password. Connection metadata is stored beside the dashboard auth file. The credential file path and token are handled only by the local dashboard process. Protect both local state and remote TLS private keys. The local process requires the server credential file to be a regular file with mode `0600`.

Client settings show the local `mdb service` status and logs, permit install/start/stop/uninstall through the existing service manager, report local outbox status, and offer an explicit outbox drain when `ENGRAM_MCP_URL` and a protected token source are configured. Consent and workspace environment values are displayed read-only; changes remain in their existing validated CLI/configuration flows.
