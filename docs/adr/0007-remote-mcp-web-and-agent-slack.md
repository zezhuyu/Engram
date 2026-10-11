# ADR 0007: Remote MCP for web clients and Agent Slack

Status: accepted for implementation; external host validation remains incomplete.

## Decision

Use the existing Engram HTTP MCP endpoint and `Vault`/SDK operations as the single memory gateway. The opt-in `remote-web` toolset exposes bounded `engram_*` operations; it does not expose delete, ACL editing, raw filesystem access, or general query mutation. Tool actors come from scoped HTTP credentials or verified JWT claims mapped by server configuration. Workspace ACLs remain authoritative. Writes use the normal journal-backed immutable revision path, create idempotency keys, and patch compare-and-swap revision IDs.

The OAuth mode is a resource-server verifier for tokens issued by a separately operated OAuth/OIDC authorization server. Engram validates issuer, JWKS signature, audience/resource, allowlisted client, subject mapping, scope intersection, and token lifetime. It does not implement login, authorization-code/PKCE, dynamic registration, refresh tokens, or a token issuer. Existing individually revocable Engram HTTP credentials remain available for trusted server-to-server adapters.

Agent Slack uses a small optional Python bridge that calls this same HTTP MCP service using a fixed workspace configuration and dedicated scoped credential. It returns results through the currently authenticated Agent Slack MCP request. It does not copy records into Agent Slack shared-memory files or provide arbitrary recipient/channel delivery.

## Rationale and constraints

- Markdown revisions and the committed journal remain canonical; all writes pass through `Vault`.
- Avoid duplicating ACL, authentication, search, and revision logic in clients.
- Host account plans determine available tools. The server cannot make a host support writes.
- Agent Slack's existing local shared memory and tunnel code have independent uses; Engram is an explicit external source, not a replacement or shadow database.
- Per-user macOS LaunchAgent and Linux systemd user-service packaging is provided as source only. No app bundle is built as part of this change.

## Verification boundary

Local HTTP, OAuth validation, ACL, replay/CAS, and fake Agent Slack-to-MCP tests are suitable for automated verification. Live ChatGPT/Claude authorization and actual user destination delivery require external accounts, credentials, deployment, and allowlisted recipients; they must remain unverified until performed.
