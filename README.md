# Engram / MDB

A local Markdown database for agent knowledge, memory and reviewed synthesis. Immutable revisions and a committed journal preserve accepted history; SQLite and navigation are disposable derivatives. SDK, CLI and stdio MCP share the same scoped operations.

Use Node >=22.13 (Node 24 LTS recommended). Install and build from this repository:

```bash
npm install
npm run build
node bin/mdb.js help
npm run verify
```

The `mdb` and `mdb-mcp` package executables wrap the built code. The examples use repository paths so no global install is necessary.

## First vault

```bash
# or: export ENGRAM_DATA_DIR=./my-vault ; omit --root for ~/.Engram
node bin/mdb.js init --root ./my-vault --no-sqlite
node bin/mdb.js init --project --host claude-code --project-dir . --root ~/.Engram
node bin/mdb.js workspace create research --root ./my-vault
node bin/mdb.js collection create retrieval --workspace research --root ./my-vault
node bin/mdb.js put --root ./my-vault --workspace research --collection retrieval \
  --kind note --title 'Retrieval observation' --body 'Lexical search works without SQLite.' --json
node bin/mdb.js grep 'SQLite' --root ./my-vault --scope workspace:research
node bin/mdb.js context --task 'Lexical search' --root ./my-vault \
  --scope workspace:research --budget-tokens 500
```

Keep the returned `id` and `revisionId`. Every accepted update requires the expected revision; history survives updates and tombstone deletion:

```bash
node bin/mdb.js get OBJECT_ID --root ./my-vault
node bin/mdb.js patch OBJECT_ID --revision CURRENT_REVISION --body 'Updated authored note.' --root ./my-vault
node bin/mdb.js history OBJECT_ID --root ./my-vault
node bin/mdb.js restore OBJECT_ID OLD_REVISION --revision CURRENT_REVISION --root ./my-vault
```

Replace the uppercase placeholders with actual returned values. Restore creates a new revision. `ingest /explicit/local/file.md --scope wiki` copies original bytes and creates a source manifest; it never downloads a URL or alters the input. Binary extraction is unsupported. Where data lives: `--root PATH` on any command, else the `ENGRAM_DATA_DIR` environment variable, else the legacy `MDB_ROOT`, else `~/.Engram` (created by `mdb init`). A leading `~` is expanded. The SDK uses the same resolution when `new Engram()` is given no root, and `mdb-mcp` honors the variable too.

`mdb init --project --host claude-code|codex` initializes local project memory: it creates a workspace, installs that host's memory capture hooks, and adds a managed block to `CLAUDE.md` or `AGENTS.md`. Existing instructions outside the managed block are preserved, and accepted preferences are injected. For a shared remote Engram server, use `mdb init --project --host claude-code|codex --mcp-url https://<server>/mcp [--token-env ENGRAM_MCP_TOKEN]`. This configures native HTTP MCP and preferences without a local vault; add `--principal ACTOR --registration REG_ID --consent` to also install the remote passive lifecycle hook for a previously provisioned server registration. Set the named token environment variable on every machine. Claude Code and Codex connect directly over HTTP, so no HTTP-to-stdio bridge is needed. Host MCP support is documented by [Claude Code](https://code.claude.com/docs/en/mcp) and [Codex](https://developers.openai.com/codex/mcp).

## SDK and agent integration

After building, import the SDK from `./dist/packages/sdk/index.js` (or `engram-mdb` when installed):

```js
import { Engram } from './dist/packages/sdk/index.js';
const db = new Engram('./my-vault', {
  actorId: 'research-agent',
  permissions: ['workspace:research:read', 'workspace:research:write'],
});
const hits = await db.query({ query: 'retrieval', mode: 'keyword' });
const instructions = await db.skill('wiki-query');
const result = await db.runSkill('memory-recall', { query: 'retrieval' });
```

`MDB` is an alias for `Engram`. Assign the actor in trusted host code, not document/model arguments. The local CLI is an owner interface. For an MCP host, launch:

```bash
MDB_ACTOR_ID=research-agent \
MDB_PERMISSIONS=workspace:research:read,workspace:research:write \
node bin/mdb-mcp.js --root ./my-vault
```

MCP uses stdio by default. To opt into a remote HTTP listener, set `MDB_MCP_TRANSPORT=http` and (when remote access is intended) `MDB_MCP_HTTP_HOST=0.0.0.0`; only one transport runs at a time. HTTP accepts individually issued scoped credentials (`mdb credential create`) and retains `MDB_MCP_HTTP_TOKEN` as a legacy single-identity option. Put remote access behind TLS. Native host MCP connections are the client; internal Engram skills invoke those MCP tools. See [integrations/README.md](integrations/README.md) and [docs/memory.md](docs/memory.md) for setup.

MCP exposes search/get/put/patch/link/context, sessions, authorized workspace and collection operations, history, proposals, promotion and skills over the selected stdio or HTTP transport. The self-hosted HTTP server binds each credential to its own actor and permissions, and serves authenticated lifecycle ingestion for Claude Code and Codex. Hook agents retain their native primary memory; Engram passively records allowlisted lifecycle events and supplies bounded secondary recall. Per-machine delivery spools retry outages without storing bearer tokens. There is no managed Engram hosting service. Missing host identity gives an anonymous actor with no grants. Do not give untrusted hosts `*` permissions.

## KB skills and intelligence

All 22 KB skill directories are preserved in `skills/upstream-kb/`, with an import manifest. The internal registry offers 22 adapted skills plus 12 native memory/knowledge skills; adapted agent instructions use MDB operations instead of direct vault writes.

```bash
node bin/mdb.js skills list --root ./my-vault
node bin/mdb.js skills show wiki-query --root ./my-vault
node bin/mdb.js skills run memory-recall --input '{"query":"retrieval"}' --root ./my-vault
node bin/mdb.js intelligence run --job index --root ./my-vault
node bin/mdb.js jobs status --root ./my-vault
```

The default backend is `auto`: a local agent CLI (`claude`, then `codex`) if one is on PATH, otherwise deterministic maintenance only. Swap it with `model.provider` in `mdb.yaml` or `ENGRAM_MODEL_PROVIDER=claude-cli|codex-cli|openai|ollama|openai-compatible|null` (see docs/intelligence.md). Deterministic maintenance always runs locally. Wiki/profile/memory/reflection/dream synthesis needs a model: configure the built-in `ollama`, `openai` or `openai-compatible` backend in `mdb.yaml` (see docs/intelligence.md) or pass a `ModelProvider` through the SDK. Output is always a validated, evidence-bound proposal that needs explicit review; remote providers never receive private workspace content unless `model.allowPrivateContentToRemote` is set. A model critic and a deterministic critic screen proposals first. Semantic/vector search is unavailable. Download, creator crawling, OCR, transcription and automatic conversation scanning are unavailable adapters, not silently simulated integrations. Upstream Python scripts are preserved references and never automatically executed.

### Real-model integration test (opt-in)

```bash
MDB_REAL_MODEL_TEST=1 MDB_TEST_PROVIDER=ollama MDB_TEST_MODEL=llama3.1 npm test
```
Skipped by default. Sends only synthetic text; use `MDB_TEST_BASE_URL`, `MDB_TEST_API_KEY_ENV` and `MDB_TEST_ALLOW_NETWORK=1` for hosted endpoints.

## Capabilities and limits

| Area | Behavior |
|---|---|
| Storage | Markdown revisions, immutable imported bytes, journal recovery, optimistic conflicts, tombstones |
| Retrieval | Native literal/regex/keyword search, scope/tag/kind filters, cited context and relations |
| SQLite | Optional `node:sqlite` FTS5 MATCH/BM25 and trigram candidates; lexical parity and stale-index fallback |
| S3 | Optional canonical immutable object storage with conditional journal-head publication; configure `MDB_STORAGE_BACKEND=s3` and `MDB_S3_BUCKET` |
| PostgreSQL | Optional FTS index and relevance ranking; configure `postgres.enabled` and `MDB_POSTGRES_URL`; pgvector enables semantic/hybrid retrieval |
| Isolation | Host-bound identity, workspace/collection/global checks, reviewed sanitized promotion |
| Agent use | SDK, CLI, stdio/HTTP MCP, per-agent scoped credentials, passive Claude Code/Codex hooks, 34 internal skills |
| Intelligence | Bounded persistent jobs, event cursor, retries, evidence validation and review queue |
| Dream demo | Evidence-linked synthetic fixture; no claim of real model synthesis |
| Deferred | Distributed replication and unsupported media/network adapters |

Create/recreate the synthetic sample with `npm run sample`; see `examples/sample-vault/`. Run `npm run benchmark` for measured local timing and `verification/phase-*.md` for exact verification evidence and limitations. These commands do not establish cross-platform or power-loss guarantees.

Workspace validation uses locally available dependency copies. A clean registry installation was not verified here because registry DNS access was unavailable; see phase reports for packaging evidence.

Read [architecture](docs/architecture.md), [storage and recovery](docs/storage-format.md), [search](docs/search.md), [security](docs/security.md), [intelligence](docs/intelligence.md) and [operations](docs/operations.md). Local-owner disk access bypasses application ACLs; exports/backups need separate protection and erasure policies.
