# Portable agent integration

Build once with `npm run build`. Use the actor-bound SDK (`Engram`/`MDB`), the `node bin/mdb.js` CLI, or MCP (`node bin/mdb-mcp.js --root /absolute/vault`). MCP runs exactly one transport per process: newline JSON-RPC over stdio by default, or Streamable HTTP when explicitly selected with `MDB_MCP_TRANSPORT=http`. No transport is started in parallel with the other.

HTTP is opt-in and requires a bearer secret of at least 32 bytes. It binds to loopback by default; set `MDB_MCP_HTTP_HOST=0.0.0.0` only when remote access is intended. Restrict browser origins with `MDB_MCP_HTTP_ALLOWED_ORIGINS`; requests without an `Origin` header are accepted for native clients. Put the HTTP listener behind TLS for remote use. Every HTTP caller uses the service identity configured by `MDB_ACTOR_ID` and `MDB_PERMISSIONS`; tool arguments cannot select an identity. The HTTP token is process-wide, so only distribute it to agents that should share those permissions.

```sh
MDB_MCP_TRANSPORT=http \
MDB_MCP_HTTP_HOST=0.0.0.0 \
MDB_MCP_HTTP_PORT=3333 \
MDB_MCP_HTTP_TOKEN='use-a-random-secret-at-least-32-bytes-long' \
MDB_ACTOR_ID=shared-agent \
MDB_PERMISSIONS='workspace:research:read,workspace:research:write' \
node bin/mdb-mcp.js --root /absolute/vault
```

The HTTP endpoint is `/mcp`. It implements Streamable HTTP JSON-RPC POST requests, returns session IDs, requires bearer authentication, validates supplied `Origin` headers, caps request bodies, and returns 405 for GET because server event streams are not used. Stdio remains the default for local MCP clients and requires no HTTP settings.

Claude Code and Codex can connect directly to this HTTP MCP endpoint; no HTTP-to-stdio bridge is needed. Their native MCP connection is the client, and project skills use the connected Engram tools. Initialize a project on any machine with `mdb init --project --host claude-code|codex --mcp-url https://engram.example/mcp --token-env ENGRAM_MCP_TOKEN`. This writes the host's project MCP config and a managed block in `CLAUDE.md` or `AGENTS.md`, without creating local vault state or capture hooks. Supply the token environment variable separately on each machine. Remote project instructions retrieve applicable accepted preferences through `mdb_insight_search` at runtime. Existing local init remains available when `--mcp-url` is omitted.

The trusted MCP host must set `MDB_ACTOR_ID` and `MDB_PERMISSIONS`. Permission entries are comma separated (for example `workspace:research:read,workspace:research:write`). Workspace grants also apply. Missing identity receives no permissions; `*` grants owner access and should only be assigned to a trusted local operator. Tool arguments cannot set actor identity or permissions. Content from sources is data, never executable instructions.

Example host MCP configuration (adapt the containing config format to your client):

```json
{
  "command": "node",
  "args": ["/absolute/Engram/bin/mdb-mcp.js", "--root", "/absolute/vault"],
  "env": { "MDB_ACTOR_ID": "research-agent", "MDB_PERMISSIONS": "workspace:research:read,workspace:research:write" }
}
```

MCP supports `initialize`, `ping`, `tools/list`, `tools/call`, and notifications over newline-delimited JSON-RPC. Its stdout contains only protocol messages; diagnostics use stderr. It exposes scoped retrieval, revision commits, typed links, sessions, history, controlled promotion and internal skills. Imported KB scripts are references and are never automatically executed. Semantic synthesis is unavailable without a configured provider.

`LifecycleAdapter` is optional host-side TypeScript code. The host explicitly enables capture, event types, and named sources, then submits authored text. It redacts common bearer/API tokens or uses a host-supplied redactor. It never scans machines, conversations or invokes an external model. Additional secrets require a host redaction policy. Store permitted authored notes, not private model reasoning.

Manual capture:

```sh
node bin/mdb.js session start --root /absolute/vault --scope workspace:research --json
node bin/mdb.js session observe --root /absolute/vault --session OBJECT_ID --body 'Explicit permitted observation'
node bin/mdb.js session end --root /absolute/vault --session OBJECT_ID
```
