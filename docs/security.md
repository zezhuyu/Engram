# Security and privacy

MDB trusts the local host, not imported documents or tool arguments. The SDK binds `ActorContext` once. The local CLI represents the owner; HTTP MCP resolves each bearer credential to a server-side actor and scoped permissions before creating tools or returning content. The optional legacy HTTP token still maps every holder to one process actor; prefer one scoped credential per agent. Do not expose an owner CLI or owner-bound SDK as an untrusted remote service. Document text cannot supply identity or permissions.

Workspace ACLs and optional collection restrictions govern access. Global areas require their own capabilities. Read, write, history, promotion and purge authority are distinct. Authorization precedes document metadata, snippets, search scoring, references, context assembly and model inputs. Missing/forbidden object access avoids confirming protected existence. An unrestricted `OWNER` actor is intended only for trusted local administration.

## Inputs and evidence

Imported Markdown, original attachments, copied KB documentation and model output are untrusted data. MDB never executes their instructions. Paths are validated against traversal, absolute-path writes and symlink escapes. Existing vault symlinks are rejected by safe-path operations. These checks do not replace OS isolation against a malicious privileged process racing filesystem operations.

Generated knowledge requires accessible exact revision evidence. A proposal cannot use unavailable/private cross-scope evidence to publish globally. Shared knowledge must be a separately reviewed sanitized promotion. Source revisions and originals remain unchanged. Prompt instructions remind providers of this boundary, but schema validation, authorization and explicit review enforce persistence rules. Review establishes acceptance, not factual truth.

## Capture and providers

Automatic capture is disabled by default and requires consent both when the server registration is created and when a host hook is installed. Claude Code and Codex send only selected lifecycle fields to the authenticated capture endpoint. The remote client writes a minimized, redacted delivery spool under `~/.Engram-remote-spool`; bearer credentials are read from the environment and never stored there. Observation text receives a limited pattern-based secret redaction pass; it cannot guarantee removal of all secrets. Review selected input before enabling capture.

No model/provider means no model calls. Configuring an SDK provider is a trusted host action and can send supplied documents outside the machine if that provider does so. MDB ships no hosted provider implementation. Restrict the actor and provider's network execution environment accordingly. Semantic embeddings are unavailable in this MVP.

## Disk and erasure limits

Local-owner direct filesystem access bypasses application ACLs. Revisions, current views, journal, SQLite indexes, intelligence queues, exports and backups can contain private text; restrict disk access and use OS encryption where required. Indexes are not a privacy boundary simply because they are disposable. Purge cannot erase external input files or arbitrary backups/replicas; retain and delete those under a separate operational policy.

HTTP MCP is self-hosted and bearer-authenticated, but does not terminate TLS itself; use HTTPS at a trusted proxy or network layer. Credentials scope actor identity and permissions, and server-side workspace ACLs still govern every read/write. The server spool is durable within the canonical local vault; remote shared access is not multi-region replication or a distributed transaction. See `verification/` and tests for exercised attacks and remaining coverage; do not infer universal security from a passing local suite.

### TLS reverse proxy (Caddy)

Bind Engram to loopback and terminate public TLS at Caddy. `deploy/Caddyfile` is the supported minimal configuration. Keep bearer tokens in each agent's secret environment; Caddy forwards `Authorization` and the MCP session headers by default. Do not set `MDB_MCP_HTTP_HOST=0.0.0.0` when the service is intended to be reachable only through the proxy. Credential create, revoke, rotation, and failed bearer authorization are recorded in the owner-readable `.mdb/http-credentials.json` audit list; token values and hashes are never included in audit records.

```sh
MDB_MCP_TRANSPORT=http MDB_MCP_HTTP_HOST=127.0.0.1 MDB_MCP_HTTP_PORT=3333 node bin/mdb-mcp.js --root /srv/engram
caddy run --config deploy/Caddyfile
```

Point the sample domain at the deployment and verify the certificate and endpoint with `curl --fail-with-body https://memory.example.com/health`. For an internal-only deployment, use a private CA and install its trust root on every agent machine.

## Model provider boundary

Model output is untrusted. It is schema-validated, bound to supplied evidence, staged as a proposal and committed only by explicit review through `Vault`. Remote providers need `allowNetwork` and, for workspace content, `allowPrivateContentToRemote`; prompts are redacted for secrets; errors never include prompts, bodies or keys. Local Ollama/loopback endpoints are treated as local. A malicious provider endpoint chosen by the vault owner can still read whatever the owner permits it to receive.
