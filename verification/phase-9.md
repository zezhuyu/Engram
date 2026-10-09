# Phase 9 verification — shared HTTP MCP project initialization

Date: 2026-10-08. Platform: macOS arm64, Node v25.8.2.

Command: `npm run verify` → lint passed (147 TypeScript files, 0 failures), TypeScript passed, build passed, **269 tests: 266 pass, 0 fail, 3 skipped**.

After the final MCP config collision guard, `npm run typecheck`, `npm run lint`, `npm run build`, and `node --test dist/tests/project-init.test.js dist/tests/interfaces.test.js` passed; the focused suite passed **8/8**.

Coverage added in this phase:
- Claude Code project init configures `.mcp.json` to connect directly to the remote HTTP MCP endpoint and references its bearer token through the named environment variable.
- Codex project init configures `.codex/config.toml` with the remote endpoint and bearer-token environment variable while preserving unrelated settings and replacing only Engram's managed block.
- Remote project init does not create local vault state or install local capture hooks. Generated `CLAUDE.md` / `AGENTS.md` instructions direct agents to the shared MCP server, create the project workspace as needed, retrieve accepted global/project preferences, and store working notes through Engram.
- HTTP MCP contract tests verify `mdb_workspace_create` and scoped `mdb_insight_search` are available to connected hosts. Existing HTTP/stdio parity, ACL, internal skill, API and project-init tests passed.

Decision: no HTTP-to-stdio bridge was added. Current Claude Code and Codex MCP clients natively connect to remote HTTP MCP endpoints, so their own MCP client plus the Engram skill/tool surface is sufficient.

Limitations: the HTTP service assigns one process-level actor and permission set to all clients using its bearer token. Configure that identity for the intended shared personal-memory access boundary. The three skipped tests are the opt-in real-model case and GNU awk/sed sandbox checks because those tools are unavailable in this environment. `npm run verify:all` was not run in this phase.
