# Hosted MCP deployment review — BETA, not activated

The existing Engram server remains the only memory server. Its proposed upstream is
`http://127.0.0.1:3333/mcp`, using `MDB_MCP_TOOLSET=remote-web`. The Caddy example
allows only `/mcp` and the two protected-resource metadata paths, limits request
bodies to 1 MB, and returns 404 for `/capture` and every other path. Authorization
is enforced by Engram before tool execution; the proxy does not assign identities.

## Values required before an exact activation approval

- Dedicated hostname and selected existing ingress provider.
- Actual authorization-server issuer/JWKS URL, resource audience and registered
  OAuth clients, with PKCE/consent/callback support appropriate to each host.
- Immutable authorized subject, separate client actors and ACLs in a disposable
  `hosted-beta` workspace. No wildcard grants or production memory in first tests.
- Target ChatGPT workspace/plan and Claude.ai account, including administrator
  authorization where required. Account capability is established in the product.

`hosted-mcp.env.example` contains reserved example domains and placeholder IDs;
it is not a live, approved configuration. Never deploy the placeholders.

## Exposure and security implications for the final approval

With Caddy, the named host would accept inbound HTTPS on TCP 443, and automatic
certificate issuance/renewal may use TCP 80. Public clients can request OAuth
metadata and attempt MCP authentication. Only valid short-lived, issuer/audience/
client-bound JWTs reach tools. User scopes are intersected with client-specific
grants and vault ACLs. The issuer still needs a real host-compatible authorization
flow; Engram does not implement that flow. JWT revocation is bounded by expiry
(maximum one hour) and cached signing keys (five minutes). Issuer and ingress
operators participate in the trust boundary. Do not log bearer headers or bodies.
The existing application rate limit applies after authentication, per actor.
Unauthenticated failures may write credential-audit records; the final ingress
configuration must address rate limiting before authentication. The Caddy example
only bounds request size and routes; it does not supply a client-IP rate limiter.

The proposed first activation is foreground-only, with no persistent service.
The exact hostname, bind ports, provider commands, certificate method and filled
environment must be presented for approval before activation. No firewall, DNS,
systemd, launchd or tunnel operation has been performed for this preparation.

OpenAI Secure MCP Tunnel is a separate outbound HTTPS option using an approved
Platform tunnel ID/runtime key and a local upstream. That transport identity
does not grant Engram user permissions. The Agent Slack implementation already
shows the `tunnel-client init --mcp-server-url` path; reuse its existing lifecycle
when selecting that mode. Claude Console's mcp-proxy/cloudflared stack is also
host-specific; do not assume it is a Claude.ai remote connector.

Tailscale remains a distinct explicit opt-in (`MDB_TRANSPORT_TRUST=tailscale`).
Its private HTTP transport does not constitute verified HTTPS evidence.

## Evidence sequence after approval

1. Verify the deployed hostname certificate chain/name/expiry without `-k` or
   `NODE_TLS_REJECT_UNAUTHORIZED=0`; run the network probe with a disposable grant.
2. Connect each actual hosted account; record account plan, consent, discovery,
   search/get and product-side tool results, without tokens or private prompts.
3. Where supported, create then patch a disposable canary, independently inspect
   immutable revisions/journal, and reject stale expected revisions.
4. Attempt unauthorized workspace/object access, wrong-client session reuse,
   revoked credentials, and writes from the read-only ChatGPT actor.
5. Record each unsupported or unexecuted operation as NOT_RUN, with the reason.
   Local CLI, simulated HTTPS and API probes do not establish hosted invocation.
