# Remote MCP clients

Engram uses the existing HTTP MCP server. Start it with `MDB_MCP_TOOLSET=remote-web`, a vault root, and either a scoped credential created through the owner CLI or a configured OAuth resource-server verifier. The stable endpoint is `/mcp`; `/.well-known/oauth-protected-resource` publishes RFC 9728 metadata when OAuth validation is enabled.

## OAuth resource validation

Engram does not issue OAuth tokens. Configure a trusted authorization server and map its immutable subjects and scopes to Engram actor permission strings. Keep this JSON in a protected service environment, never in a vault or checked-in file.

```sh
MDB_MCP_TOOLSET=remote-web
MDB_MCP_HTTP_HOST=127.0.0.1
MDB_MCP_HTTP_PORT=3333
MDB_MCP_PUBLIC_URL=https://memory.example.org
MDB_MCP_HTTP_ALLOWED_HOSTS=memory.example.org
MDB_MCP_OAUTH_ISSUER=https://identity.example.org/
MDB_MCP_OAUTH_JWKS_URL=https://identity.example.org/.well-known/jwks.json
MDB_MCP_OAUTH_RESOURCE=https://memory.example.org/mcp
MDB_MCP_OAUTH_AUDIENCE=https://memory.example.org/mcp
MDB_MCP_OAUTH_CLIENT_IDS='["chatgpt-client-id","claude-client-id"]'
MDB_MCP_OAUTH_SUBJECTS_JSON='{"user-subject":{"actorId":"owner-web","permissions":["workspace:project:read","workspace:project:write"]}}'
MDB_MCP_OAUTH_SCOPE_MAP_JSON='{"memory.read":["workspace:project:read"],"memory.write":["workspace:project:write"]}'
MDB_MCP_HTTP_REQUESTS_PER_MINUTE=120
MDB_MCP_TOOLSET=remote-web
```

The example permission strings must also be granted to that actor by the vault ACL. Token scopes are intersected with the configured subject permission ceiling. Use short-lived signed access tokens. Engram revalidates signature and expiry on each call but does not introspect tokens: revoking refresh grants at the issuer does not invalidate an already-issued self-contained JWT before its expiry unless the issuer rotates the signing key. `MDB_MCP_HTTP_TOKEN` remains a single shared legacy credential and is not recommended for multi-user exposure.

The JWT resource-server verifier supports RS256 and ES256 JWKS. It does not implement the OAuth authorization-code callback, PKCE, dynamic client registration, refresh-token lifecycle, or provider-specific consent UI. Choose an issuer supported by the intended MCP host, configure that issuer to issue Engram-audience tokens, and test its real connector authorization before claiming host compatibility.

## HTTPS and tunnel profiles

- Local only: leave the HTTP MCP bound to `127.0.0.1`; continue using CLI, SDK, and stdio MCP without remote access.
- Tunnel: keep Engram on loopback, then proxy only `/mcp` through an authenticated HTTPS tunnel with a dedicated hostname. A tunnel is ingress, not identity or ACL authorization.
- Self-hosted: terminate TLS at Caddy or another maintained reverse proxy, restrict Host/origin, limit request size and rate, and do not expose debug or vault paths.
- OpenAI Secure MCP Tunnel is host-specific. The Agent Slack repository's current OpenAI/Anthropic tunnel support was inspected; neither tunnel path should be assumed interchangeable or a substitute for Engram's authorization.

Do not set a public bind until trusted authentication and HTTPS ingress are operational. Remote mode never scans conversations or imports host-native memory automatically. Search/get/create/patch use the same ACL and immutable commit path as local Engram.

## Host limits and manual live validation

As of 2026-10-09, OpenAI documents full MCP write support for eligible Business and Enterprise/Edu workspaces; Pro's developer-mode custom MCP is limited to read/fetch. Claude documents remote custom connectors for Free, Pro, Max, Team, and Enterprise. Those docs do not prove a particular connector login or invocation succeeded.

Register `https://<host>/mcp` in each product using its supported authorization flow. Confirm the tool list, perform an authorized search/get, then test writes only on an eligible account using a disposable record and inspect the returned revision from another authorized client. Disconnect and verify the issuer's token revocation policy. Record product, plan, date, topology, and evidence in `verification/remote-clients/` without recording prompts or tokens.

## Agent Slack

In the Agent Slack process environment, set `AGENT_SLACK_ENGRAM_MCP_URL=https://memory.example.org/mcp`, a JSON map keyed by Agent Slack workspace key, and dedicated token environment variables:

```sh
AGENT_SLACK_ENGRAM_WORKSPACES_JSON='{"project":{"tokenEnv":"ENGRAM_PROJECT_TOKEN","allowWrites":true,"scope":{"type":"workspace","workspaceId":"project"},"collectionId":"shared"}}'
ENGRAM_PROJECT_TOKEN=<secret from secret manager>
```

The Agent Slack tools expose `search_engram_memory`, `get_engram_memory`, `create_engram_memory`, and `patch_engram_memory`. Each configured Agent Slack workspace maps to one fixed Engram workspace. Writes are disabled unless `allowWrites` is true and Engram independently grants the credential write access. Caller arguments cannot select an Engram workspace. Store the dedicated token in the OS secret manager and pass it into the process environment; never log it. Results return only to the active MCP client request, which can render them in its authenticated user conversation. There is no recipient/channel delivery API implemented here, so the bridge must not publish retrieved private memory elsewhere.

## Standalone bundle source

`node scripts/standalone.mjs package [darwin|linux] [x64|arm64]` builds and packages on explicit invocation, embedding the latest Node 24 LTS runtime from the official Node release index and production dependencies (`ENGRAM_NODE_VERSION` can pin an exact version). Package on each target OS/architecture; cross-target native dependency packaging is refused. `install` creates a per-user LaunchAgent/systemd user service that starts at login. For boot-time startup use `sudo node scripts/standalone.mjs install-system [bundle-dir] [service-user]`; `uninstall-system` removes it. The privileged installer runs the service as the named non-root user so it reads that user's protected environment file and vault. Configure `~/.config/engram/engram.env` with `ENGRAM_DATA_DIR`, remote authentication and ingress variables, then set mode 600 before installing autostart. This task does not execute packaging or install commands. Remote exposure still requires the HTTPS/auth deployment above.
