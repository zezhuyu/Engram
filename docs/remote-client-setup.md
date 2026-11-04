# Remote MCP clients

For a persistent macOS or Linux outbox watcher on a client machine, use the per-user service commands in [client-daemon.md](client-daemon.md). The daemon consumes the same `outbox watch` operation described below and keeps the credential in a 0600 token file.

Engram uses the existing HTTP MCP server. Start it with `MDB_MCP_TOOLSET=remote-web`, a vault root, and either a scoped credential created through the owner CLI or a configured OAuth resource-server verifier. The stable endpoint is `/mcp`; `/.well-known/oauth-protected-resource` publishes RFC 9728 metadata when OAuth validation is enabled.

## OAuth resource validation

Engram does not issue OAuth tokens. Configure a trusted authorization server and map its immutable subjects and scopes to Engram actor permission strings. Keep this JSON in a protected service environment, never in a vault or checked-in file.

```sh
MDB_MCP_TOOLSET=remote-web
MDB_MCP_HTTP_HOST=127.0.0.1
MDB_MCP_HTTP_PORT=3333
MDB_MCP_HTTP_ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
MDB_MCP_OAUTH_ISSUER=https://identity.example.org/
MDB_MCP_OAUTH_JWKS_URL=https://identity.example.org/.well-known/jwks.json
MDB_MCP_OAUTH_RESOURCE=http://127.0.0.1:3333/mcp
MDB_MCP_OAUTH_AUDIENCE=http://127.0.0.1:3333/mcp
MDB_MCP_OAUTH_CLIENT_IDS='["chatgpt-client-id","claude-client-id"]'
MDB_MCP_OAUTH_SUBJECTS_JSON='{"user-subject":{"actorId":"owner-web","permissions":["workspace:project:read","workspace:project:write"]}}'
MDB_MCP_OAUTH_SCOPE_MAP_JSON='{"memory.read":["workspace:project:read"],"memory.write":["workspace:project:write"]}'
MDB_MCP_HTTP_REQUESTS_PER_MINUTE=120
MDB_MCP_TOOLSET=remote-web
```

Authenticated requests use bounded fair admission keyed by the credential actor, not by TCP peer or socket count. Defaults are 128 active requests globally, 1 per authenticated principal, and 256 queued requests. The per-principal default is intentionally low because durable writes serialize on the Vault lock; it prevents one valid identity from placing a large FIFO batch ahead of other users. `MDB_MCP_HTTP_MAX_IN_FLIGHT`, `MDB_MCP_HTTP_MAX_IN_FLIGHT_PER_PRINCIPAL`, and `MDB_MCP_HTTP_MAX_QUEUED` can adjust those values within implementation ceilings of 512, 128, and 2,048. Idle keep-alive sockets do not consume request permits. If the bounded request queue is full, Engram returns HTTP 503 with `Retry-After` and a JSON-RPC error with `data.retryable: true` and `data.executed: false`; retry a write with its same idempotency key. Failed-auth audit counts are persisted in bounded aggregates at least once per second under normal operation and earlier when 64 failures accumulate; a hard process kill can lose only the not-yet-flushed interval. A separate global connection ceiling and incomplete-header timeout bound unauthenticated/idle sockets. Behind a reverse proxy, distinct credential actors receive separate fair queues; do not share one actor if users need separate fairness or audit identity.

For a single trusted principal that needs parallel request throughput, raise `MDB_MCP_HTTP_MAX_IN_FLIGHT_PER_PRINCIPAL` incrementally (for example, 4) and benchmark it with competing principals before deployment. This is a concurrency ceiling, not a promise of four-way durable-write execution: Vault commits still serialize. Keep the global and queued limits bounded, and retry only 503 responses marked `retryable: true` with the same idempotency key. Do not set the ceiling to 128 merely to maximize one principal's throughput; that can increase memory pressure and queueing for others.

For filesystem-backed vaults, the HTTP process also schedules trusted index maintenance independently of client identity. A missing large-vault index is built after startup, and the index is refreshed after the configured journal-change threshold. Search remains ACL-filtered and falls back to canonical files during or after a failed derived-index build; callers do not need to run a manual rebuild just to establish the normal search path.

The example permission strings must also be granted to that actor by the vault ACL. Token scopes are intersected with the configured subject permission ceiling. Use short-lived signed access tokens. Engram revalidates signature and expiry on each call but does not introspect tokens: revoking refresh grants at the issuer does not invalidate an already-issued self-contained JWT before its expiry unless the issuer rotates the signing key. `MDB_MCP_HTTP_TOKEN` remains a single shared legacy credential and is not recommended for multi-user exposure.

For hosted deployments, assign each client a separate actor within the subject grant. For example:

```sh
MDB_MCP_OAUTH_SUBJECTS_JSON='{"user-subject":{"actorId":"owner-web","permissions":["workspace:project:read","workspace:project:write"],"clients":{"chatgpt-client-id":{"actorId":"chatgpt-web","permissions":["workspace:project:read"]},"claude-client-id":{"actorId":"claude-web","permissions":["workspace:project:read","workspace:project:write"]}}}}'
```

Grant `chatgpt-web` and `claude-web` the corresponding vault ACLs separately. The parent permission list is the ceiling, not a fallback: a client missing from `clients` is refused. Reusing a mapped actor across different clients is rejected. Existing subject grants without `clients` retain their shared identity behavior and should not be used for this hosted profile. Configure ChatGPT write permissions only after the actual account supports writes. Use a separate scoped credential/actor for Agent Slack.

The JWT resource-server verifier supports RS256 and ES256 JWKS. It does not implement the OAuth authorization-code callback, PKCE, dynamic client registration, refresh-token lifecycle, or provider-specific consent UI. Choose an issuer supported by the intended MCP host, configure that issuer to issue Engram-audience tokens, and test its real connector authorization before claiming host compatibility.

## HTTP service and independent adapters

Engram is an HTTP service bound to `127.0.0.1:3333` by default. Local authenticated HTTP operation needs no certificate, Caddy, public DNS or tunnel. The private template is `deploy/hosted-mcp.env.example`; its issuer and ACL placeholders must be configured. OAuth resource/audience is an identity identifier, not a switch enabling TLS on the listener.

| Path | Transport | Approval and evidence |
| --- | --- | --- |
| Local MCP | Authenticated loopback HTTP `/mcp` | Automated HTTP/auth/ACL/revision tests |
| ChatGPT | OpenAI outbound Secure MCP Tunnel → private HTTP | Dedicated Engram profile; tunnel and actual ChatGPT evidence separately |
| Claude.ai | External HTTPS tunnel/gateway → private HTTP | Approve exact ingress; certificate and actual Claude.ai evidence separately |
| Tailscale | Existing explicit private-network mode | Opt-in only; neither public TLS nor hosted-client proof |

[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) supports private HTTP upstreams without inbound internet access. Reuse the installed official executable, but create an independent `engram-beta` profile and tunnel identity. Never change Agent Slack's `agent-slack` profile or its upstream `http://127.0.0.1:8899/mcp`. Select **Connection: Tunnel** in ChatGPT, with the intended Platform organization/workspace associations and app authorization. OAuth discovery can traverse the tunnel; the authorization server is not automatically tunneled and must be reachable by the required browser/client paths. Runtime tunnel credentials confer no Engram actor grant.

[Claude's connector transport documentation](https://claude.com/docs/connectors/building) recommends Streamable HTTP and also supports legacy HTTP+SSE. [Claude's network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) specify connections from Anthropic's cloud. [Its local-server testing guide](https://claude.com/docs/connectors/building/testing) recommends an external tunnel/public URL. For this deployment, use a verified HTTPS URL from an independently approved external adapter. Caddy is one optional adapter; Cloudflare Tunnel/ngrok are alternatives, not Engram dependencies. Existing Agent Slack Claude Console tunneling is not evidence of Claude.ai connector compatibility.

Do not expose plain HTTP publicly, disable token validation, trust forwarded identity headers, widen ACLs, or remove Host/origin checks to make a connector connect. An adapter may forward `/mcp`, the read-only `/version` response used by the dashboard's explicit connection test, and OAuth protected-resource metadata. Keep `/capture`, vault paths, health/admin UI and debug endpoints private. Limit unauthenticated traffic at any approved public ingress in addition to Engram's authenticated per-actor limits.

## Separate verification layers

Release evidence now has distinct `MCP_HTTP_SERVICE`, `OPENAI_MCP_TUNNEL`, `CHATGPT_HOSTED_MCP`, and `CLAUDE_HOSTED_MCP` items. `TRANSPORT_TLS` remains historical remote-capture evidence, not a certificate prerequisite for the HTTP service. HTTP tests, an HTTPS probe, a healthy tunnel, and real hosted invocations cannot substitute for one another. See `deploy/HOSTED-MCP-APPROVAL.md` for exact commands, acceptance checks and evidence schemas.

`scripts/verify-hosted-mcp.mjs` is an **optional external HTTPS gateway probe**. It validates certificates, unauthenticated rejection and authorized discovery/search. It does not test private HTTP or start a tunnel; its ChatGPT/Claude.ai/write fields remain NOT_RUN. Only actual product-side invocations establish hosted compatibility. Account write support must be observed in the target account, not inferred from implemented tools or Claude Code/Codex tests.

No tunnel activation, service installation, external account mutation or exposure change is authorized by these templates. Remote mode does not scan conversations or import host-native memories automatically. Search/get/create/patch still use Engram's ACL and immutable journal-backed commit path.

## Agent Slack

For Agent Slack on the same machine, use `AGENT_SLACK_ENGRAM_MCP_URL=http://127.0.0.1:3333/mcp`. Across machines, use the separately approved HTTPS adapter or explicit Tailscale mode. Configure a JSON map keyed by Agent Slack workspace key and dedicated token environment variables:

```sh
AGENT_SLACK_ENGRAM_WORKSPACES_JSON='{"project":{"tokenEnv":"ENGRAM_PROJECT_TOKEN","allowWrites":true,"scope":{"type":"workspace","workspaceId":"project"},"collectionId":"shared"}}'
ENGRAM_PROJECT_TOKEN=<secret from secret manager>
```

The Agent Slack tools expose `search_engram_memory`, `get_engram_memory`, `create_engram_memory`, `patch_engram_memory`, and `deliver_engram_memory`. Each configured Agent Slack workspace maps to one fixed Engram workspace. Writes are disabled unless `allowWrites` is true and Engram independently grants the credential write access. Caller arguments cannot select an Engram workspace. Store the dedicated token in the OS secret manager and pass it into the process environment; never log it. The current delivery adapter requires a separately configured, opted-in direct chat, rate limits delivery and deduplicates by idempotency key. Its `accepted` result means local Agent Slack chat persistence, not an external delivery receipt. Tool discovery does not establish configured memory access or delivery; test those separately with explicit recipient authorization.

## Standalone bundle source

`node scripts/standalone.mjs package [darwin|linux] [x64|arm64]` builds and packages on explicit invocation, embedding the latest Node 24 LTS runtime from the official Node release index and production dependencies (`ENGRAM_NODE_VERSION` can pin an exact version). Package on each target OS/architecture; cross-target native dependency packaging is refused. `install` creates a per-user LaunchAgent/systemd user service that starts at login. For boot-time startup use `sudo node scripts/standalone.mjs install-system [bundle-dir] [service-user]`; `uninstall-system` removes it. The privileged installer runs the service as the named non-root user so it reads that user's protected environment file and vault. Configure `~/.config/engram/engram.env` with `ENGRAM_DATA_DIR`, remote authentication and ingress variables, then set mode 600 before installing autostart. This task does not execute packaging or install commands. Local operation uses authenticated HTTP loopback. Hosted access uses the separately approved adapter above; Caddy and certificates are not bundle prerequisites.
