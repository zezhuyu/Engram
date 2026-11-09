# Engram BETA: private HTTP and hosted adapter review

Status: configuration proposal only. No tunnels or services activated. No network exposure changed. Engram remains BETA. This supersedes the public-HTTPS-first proposal; historical reports remain intact.

**Step 7 update (2026-11-08):** The dashboard's OpenAI/ChatGPT setup now follows the tested no-public-URL, no-OAuth topology: `tunnel-client → 127.0.0.1:3335` keyed gateway → `127.0.0.1:3333/mcp`. The gateway selects a server-held least-privilege Engram credential by the required workspace name. The older OAuth/DCR commands and OAuth acceptance criteria below describe the previous hosted proposal and are superseded for this dashboard-managed OpenAI path; they remain historical evidence and are not rewritten as completed tests. Claude's external HTTPS connector remains a separate path.

## Architecture

```text
ChatGPT → OpenAI tunnel control plane (HTTPS)
                  ↑ outbound polling by dedicated engram-beta tunnel-client
                  ↓ private upstream HTTP
              Engram 127.0.0.1:3333/mcp
                  ↑ private upstream HTTP
Claude.ai → approved external HTTPS tunnel/gateway (optional adapter)
```

Both paths use the same existing HTTP service, resource-server token verifier, per-client actors, vault ACLs and immutable journal/revision operations. Caddy is optional and external. No public TLS certificate is needed for local HTTP or the OpenAI tunnel upstream. Tailscale stays a separate explicit opt-in mode.

## 1. Private HTTP baseline

Use `deploy/hosted-mcp.env.example`. Endpoint: `http://127.0.0.1:3333/mcp`; transport `http`; toolset `remote-web`; bind `127.0.0.1`; port `3333`; allowed Hosts `127.0.0.1:3333,localhost:3333`. No public URL is configured. Start the existing entry point with `node bin/mdb-mcp.js --root <disposable-beta-vault>` after supplying the protected environment and ACLs. Do not start a second MCP server or implement HTTPS in Engram.

Authentication is mandatory even on this endpoint. The example uses OAuth signed tokens, explicit issuer/JWKS, exact resource/audience, approved clients, immutable subject mappings and separate ChatGPT/Claude actor grants. Engram does not provide login, PKCE, consent, registration, refresh or issuer services. Choose/configure the external issuer before live authorization. Local OAuth resource identity defaults to the loopback URL; confirm the hosted resource discovery and exact issuer audience through each adapter before authorizing deployment. The service currently supports one OAuth resource/audience: both client paths must agree on it; do not disable audience checks or create a second server to avoid coordination.

## 2. ChatGPT: dedicated outbound OpenAI Secure MCP Tunnel

Read-only evaluation confirmed the already installed client supports `--mcp-server-url`, `--profile`, `--profile-dir`, secret environment references and an ephemeral loopback health listener. The existing Agent Slack profile points at `http://127.0.0.1:8899/mcp`. Reuse only this executable:

`/Users/yuzezhu/Library/Application Support/agent-slack-desktop/tools/tunnel-client/tunnel-client`

Read-only profile inventory found only `agent-slack.yaml`; there is no existing Engram profile to reuse. Proposed **new dedicated** profile: `engram-beta` in an isolated `~/.config/engram/tunnel-client/` directory. Review template: `deploy/engram-beta.tunnel.yaml.example`. No active profile has been created. Proposed upstream: `http://127.0.0.1:3333/mcp`. Control plane: `https://api.openai.com`; outbound TCP 443 only; no inbound firewall/DNS changes. Health/admin listener: `127.0.0.1:0`. Runtime key: `env:ENGRAM_TUNNEL_RUNTIME_KEY`, supplied from the secret manager with Tunnels Read + Use and the approved organization context. No plaintext key in arguments or templates.

Commands below are for review, **not executed**. Replace the tunnel ID only after approval of the exact Platform organization/workspace associations and newly dedicated tunnel identity. Never use `--force`, reuse `agent-slack`, redirect its upstream, replace its key, or stop its process. The proposed tunnel ID must differ from Agent Slack's configured ID; a separate profile name alone does not isolate a shared control-plane tunnel.

```sh
# Approved IDs only; runtime secret already supplied locally by the secret manager.
: "${ENGRAM_TUNNEL_ID:?Approved dedicated Engram tunnel ID required}"
: "${ENGRAM_OPENAI_ORGANIZATION_ID:?Approved Platform organization ID required}"
"/Users/yuzezhu/Library/Application Support/agent-slack-desktop/tools/tunnel-client/tunnel-client" init \
  --profile engram-beta \
  --profile-dir "$HOME/.config/engram/tunnel-client" \
  --tunnel-id "$ENGRAM_TUNNEL_ID" \
  --sample sample_mcp_with_dcr \
  --mcp-server-url http://127.0.0.1:3333/mcp \
  --control-plane-base-url https://api.openai.com \
  --control-plane-api-key-ref env:ENGRAM_TUNNEL_RUNTIME_KEY \
  --health-listen-addr 127.0.0.1:0
"/Users/yuzezhu/Library/Application Support/agent-slack-desktop/tools/tunnel-client/tunnel-client" doctor --profile engram-beta --profile-dir "$HOME/.config/engram/tunnel-client" --control-plane.organization-id "$ENGRAM_OPENAI_ORGANIZATION_ID" --explain
"/Users/yuzezhu/Library/Application Support/agent-slack-desktop/tools/tunnel-client/tunnel-client" run --profile engram-beta --profile-dir "$HOME/.config/engram/tunnel-client" --control-plane.organization-id "$ENGRAM_OPENAI_ORGANIZATION_ID"
```

Creating/managing the Platform tunnel requires Read + Manage; selecting/running it requires Read + Use. Associate only the intended organization and ChatGPT workspace. In ChatGPT choose **Add custom MCP server → Connection: Tunnel**, select the dedicated identity, configure OAuth, and inspect the actual account's tool/write permissions. This private path is not public plugin distribution.

Security implication: an outbound worker forwards MCP requests from the authorized OpenAI contexts into the private endpoint. OpenAI transport access must never imply memory access. OAuth discovery may traverse the tunnel, but the authorization server itself is not automatically tunneled. Verify forwarded bearer tokens, discovery URLs, issuer reachability, client identity and audience end to end; a healthy polling loop alone is insufficient. Do not inject an owner/global upstream credential to bypass this check.

## 3. Claude.ai: separate external adapter

Official documentation describes cloud-originating remote connectors using Streamable HTTP (recommended) or legacy HTTP+SSE, and a public URL for local-server testing. A private loopback/tailnet URL alone is insufficient. No documented Claude.ai selection flow for OpenAI tunnels or Agent Slack's Claude Console tunnel was found; treat those transports separately.

Proposed optional Caddy route: `https://memory.example.com/mcp` → `http://127.0.0.1:3333/mcp`, using `deploy/Caddyfile` and `deploy/claude-gateway.env.example`. The hostname is a placeholder, not an approved deployment. Before activation, review the **actual hostname**, DNS target, ingress interface/ports, certificate issuance/storage, allowed origin/Host values, unauthenticated edge rate limits, firewall policy and issuer client registration/callback `https://claude.ai/api/mcp/auth_callback`. Caddy's sample body/path restrictions do not supply unauthenticated rate limiting. Select/configure a maintained ingress control before public deployment. Caddy is not installed or required here.

An external outbound HTTPS tunnel such as Cloudflare Tunnel is an alternative with no local inbound listener, but still creates a public ingress URL and third-party transport boundary. Present its exact account, hostname, upstream, path policy and credential handling separately before activation. Do not reuse Agent Slack tunnel state or credentials.

Allow only `/mcp`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`; keep vault/debug/admin and `/capture` private. Validate public certificate chain/name/expiry. Preserve bearer authorization and Host/origin protection. Claude.ai requires an approved OAuth client and independent actor grant. Shared organization request headers cannot provide individual OAuth identity separation and are not the proposed multi-user configuration.

## 4. Independent acceptance evidence

| Release evidence | Proof required | Current state |
| --- | --- | --- |
| `MCP_HTTP_SERVICE` | Real loopback HTTP discovery, authorized reads, versioned writes, rejected tokens/ACLs and client isolation | Automated verification; see current run report |
| `OPENAI_MCP_TUNNEL` | Dedicated profile, outbound polling/forwarding, unchanged Agent Slack, HTTP upstream, OAuth discovery/token preservation, authorized discovery/read and denied access | NOT_RUN; activation requires approval |
| `CHATGPT_HOSTED_MCP` | Actual ChatGPT account invocation, discovery/read, supported versioned writes, denied access, separate actor | NOT_RUN; account authorization required |
| `CLAUDE_HOSTED_MCP` | Actual Claude.ai account invocation with the same checks, using its separately verified adapter | NOT_RUN; account and ingress authorization required |
| External HTTPS probe | Public certificate and protocol/authentication checks on approved Claude gateway | NOT_RUN; optional adapter, not HTTP service prerequisite |

Record each layer in its own `verification/remote-clients/` JSON file. Required fields are `status`, `layer`, `observedAt`, `evidence` (nonempty artifact paths) and `checks`. HTTP layer is `http-service` with true `loopbackHttp`, `discovery`, `authorizedRead`, `rejectedAccess`, `clientIsolation`, `versionedWrite`. Tunnel layer is `openai-tunnel` with true `outboundOnly`, `dedicatedEngramProfile`, `agentSlackUnchanged`, `upstreamHttp`, `oauthDiscovery`, `tokenForwarding`, `discovery`, `authorizedRead`, `rejectedAccess`, `clientIsolation`. Hosted layer is `hosted-client` with product `chatgpt` or `claude.ai` and true `actualHostedInvocation`, `discovery`, `authorizedRead`, `rejectedAccess`, `clientIsolation`, `versionedWrite`. Include product/account plan, adapter topology, operation/revision IDs and sanitized evidence. Unsupported writes remain INCOMPLETE with the exact account restriction; they are never PASS. Local Claude Code/Codex or simulated clients cannot satisfy a hosted item. The policy validates attestation structure; humans must review that artifacts actually prove the claimed observations.

After approval, use disposable records for reads/create/patch/CAS/replay checks; compare returned immutable revisions through a second authorized client. Exercise readonly writes, foreign workspace/collection/global reads, expired/wrong issuer/audience/client tokens, disconnect/refresh revocation policy and tunnel recovery. Do not store tokens, private prompts or sensitive content in artifacts. A missing evidence file remains NOT_RUN. Existing historical `TRANSPORT_TLS` is remote-capture evidence and is not repurposed as the private HTTP service gate.

## Approval boundary / exact unresolved inputs

Review this architecture and local templates first. Activation remains blocked until explicit approval identifies: dedicated Engram tunnel ID, Platform organization, ChatGPT workspace, runtime secret reference, OAuth issuer/client IDs/actor grants and resource/audience. Claude activation additionally requires the chosen external adapter and actual hostname/network/security configuration above. No persistent service installation is included. Keep BETA and preserve all historical evidence and Git index state.

Sources checked 2026-10-14: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [Claude transport](https://claude.com/docs/connectors/building), [Claude cloud network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude tunnel/testing guidance](https://claude.com/docs/connectors/building/testing).


## Phase 1 readiness inspection (2026-10-14)

Prepared the repository-only official-sample-based profile above. Its dedicated secret reference and directory prevent accidental loading of the Agent Slack profile/key. No profile initialization, doctor network call, daemon, service or public endpoint was started. Installed client reports version `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`; local quickstart, sample, init/doctor/run help were inspected without account requests.

Current prerequisites are **not satisfied**: no listener at `127.0.0.1:3333` (lsof and TCP connect checks); no protected `~/.config/engram/engram.env`; no runtime/admin key or OAuth configuration in this shell. Agent Slack's encrypted runtime-key file exists, but was not decrypted, validated or reused. Its existence proves neither Engram credential availability nor organization permissions. Agent Slack profile/settings hashes are recorded in the readiness evidence and must remain unchanged. Account roles, tunnel ownership/association, ChatGPT custom-MCP permission and write eligibility are UNVERIFIED because authenticated account access is unavailable here.

Approval must identify the dedicated Engram tunnel ID, Platform organization ID, ChatGPT workspace, new runtime-key secret reference, vault/root and issuer/client actor grants. Supply the key through the approved local secret manager into `ENGRAM_TUNNEL_RUNTIME_KEY`, never into chat or CLI arguments. The `ENGRAM_OPENAI_ORGANIZATION_ID` variable in doctor/run selects the approved organization. Before running, review inherited tunnel-client environment overrides (configuration precedence is flags > environment > YAML > defaults); remove stale MCP target/static-Authorization, control-plane target, profile, remote-UI and Cloudflare overrides. Do not use the embedded stub or add a global upstream Authorization header. Start only the existing Engram HTTP entry point with the approved protected environment; it is currently stopped. A successful local fixture test cannot establish readiness of that stopped endpoint.

Separate sanitized evidence belongs to `verification/remote-clients/openai-tunnel.json` for connectivity and `chatgpt-hosted.json` for actual ChatGPT invocation. A successful doctor check still does not establish hosted-client PASS. Real ChatGPT writes require an explicitly approved disposable workspace/collection and a write actor grant; the current example ChatGPT grant is readonly and must not be silently widened.

### Later phases and stale source evidence

Phase 2 waits for activation AND account authorization. Phase 3's optional Caddy/gateway templates remain prepared only; no public hostname is approved, Caddy is unavailable for executable config validation, and unauthenticated edge rate controls remain a deployment prerequisite. Phase 4 source inspection found historical Preferences and Dream PASS records without matching intelligence/provider hashes, and durability evidence without a matching `packages/core/vault.ts` hash. Rerun against current sources in the later verification phase, preserving all old records; do not bind old results to new hashes. Real OS scheduler service installation still requires separate authorization. Unavailable physical power removal, production integrations and hosted calls stay NOT_RUN.

The Phase 1 readiness report and reviewable patch are in `/Volumes/sambigdisk1/code/engram-audit2/review/tunnel-readiness-20261014/`. This update introduces no commit proposal or Git mutation; commit boundaries are proposed separately and require per-commit approval.
