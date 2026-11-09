# Anthropic MCP Tunnels (research preview)

This guided setup is for Claude Managed Agents and the Messages API MCP connector. It is not a claude.ai custom connector. See Anthropic's [MCP Tunnels overview](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview). Setup requires Anthropic Console access with Manage tunnels permission, a Console-created tunnel, registered CA certificate, Docker Compose, and outbound access to Anthropic and Cloudflare.

1. In Console, create a tunnel and copy its `tnl_...` ID, assigned `*.tunnel.anthropic.com` domain, and token.
2. Save those values in Dashboard → Connectors → Anthropic MCP Tunnels. The token is write-only in Engram.
3. Generate certificates, then upload only `ca.crt` in Console → Certificates. The private keys never leave this machine.
4. Make the configured upstream reachable from the proxy container. The default is `http://host.docker.internal:3336`. Container `localhost` means the container itself. Engram's Claude gateway binds loopback by default, so the default upstream is not reachable until the owner explicitly starts it with `GATEWAY_BIND` set to a container-reachable address and inbound authentication enabled. This exposes the gateway beyond loopback on that interface; protect it with the firewall and prefer the Docker bridge/host-gateway address. Engram does not change the gateway bind.
5. Start the stack only from the dashboard after confirming `PULL AND START`. This downloads and runs the two digest-pinned images. Stop is also explicit.
6. Attach the MCP URL `https://<route>.<domain>/<path>` in Managed Agents or Messages API `mcp_servers`.

Non-secret tunnel metadata is merged into the vault's `.mdb/dashboard/connectors.json`. Files are stored under `${XDG_CONFIG_HOME:-~/.config}/engram/anthropic-tunnel/`. The directory and `data/` are 0700. `anthropic-tunnel.env`, `ca.key`, and `tls.key` are 0600. Public certificates and generated configs are private to the directory. The upstream quickstart's `chmod 644 tls.key` is intentionally not used. Engram never downloads or installs Docker, OpenSSL, cloudflared, or images automatically. Compose image pulls occur only after explicit confirmation.

Dashboard status reports local Docker, files, certificate expiry, and local container state. Container reachability is separate from host reachability. **Not verified live:** Anthropic account access, tunnel registration, CA acceptance, Cloudflare edge connection, or a real Managed Agents/Messages API tool call. No WIF support is included.
