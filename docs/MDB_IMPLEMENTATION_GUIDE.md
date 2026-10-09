# MDB — Implementation Guide for Local Codex

**Status:** implementation specification (proposed; not yet built)  
**Target:** local-first, Markdown-native agent memory/knowledge system  
**Primary implementation language:** TypeScript / Node.js  
**MVP scope:** local Markdown storage + native grep-like retrieval + optional first-party SQLite FTS5 + core agent integration + autonomous knowledge maintenance and dreaming  
**Deferred:** S3 adapter, PostgreSQL/other SQL adapters, distributed multi-host writes, hosted service

> **Core contract:** Markdown files and immutable, file-backed revisions are authoritative. Every feature required for normal operation works with `sqlite.enabled=false`. SQLite is an optional, rebuildable retrieval accelerator included in the MVP. Agents never modify original sources or old revisions. Cross-workspace knowledge sharing is permission-controlled and explicit.

---

## 0. Codex execution instructions

Implement MDB as a working repository, not a mockup. Work phase by phase, committing or checkpointing coherent increments, and run the verification gates before claiming each phase is complete. Preserve existing files in any user repository and inspect before editing. Prefer TypeScript, Node LTS, minimal dependencies, small cohesive modules, and real automated tests. Do not create a proprietary binary-only knowledge format. Do not make SQLite, vectors, a hosted LLM, Docker, Postgres, S3, or network access mandatory. Do not fabricate functional integrations; provide an honest capability report for unsupported agent adapters.

If the environment lacks an LLM provider, enable a deterministic maintenance-only mode; dreamy synthesis and semantic embeddings are explicitly disabled until configured. Create a `doctor` command describing which features are available. Design the interfaces for optional features now but do not spend MVP effort implementing S3 or PostgreSQL.

**Priority order:** correctness and immutability → workspace isolation → pure-file functionality → grep and indexes → optional SQLite acceleration → MCP/CLI → intelligence engine → dreaming → performance.

### Required delivered files

- Working TypeScript project, commands, tests, and README.
- `docs/architecture.md`, `docs/storage-format.md`, `docs/search.md`, `docs/security.md`, `docs/intelligence.md`, `docs/operations.md`.
- Sample local MDB vault and generated indexes, with explicitly synthetic fixtures.
- MCP server implementation with core tools; standalone CLI usable without an agent.
- Optional SQLite adapter, with tests covering parity and fallback.
- Intelligence worker with bounded tasks, event cursor/checkpoint, review queues, and deterministic no-LLM mode.
- `AGENTS.md` repository instructions: source immutability, scopes, tests, and safety rules.
- Phase reports in `verification/` with exact commands, results, and known limitations.

## 1. Product and scope

MDB is simultaneously:

1. A **Markdown-native document database** with typed objects, collections, versioning, backlinks, and CRUD.
2. A **federated agent knowledge platform**: a Global LLM Wiki, shared experiential intelligence, a discovery database, and isolated workspace databases.
3. A **retrieval engine**: lexical-first, grep-like search without SQLite; optional FTS5, metadata/graph indexes, and optional embeddings/hybrid ranking.
4. A **small autonomous intelligence system**: updates navigational indexes, user profile/insights, wiki synthesis, memories, retrospectives, and cross-domain discovery (dreaming).
5. An **agent integration layer**: CLI, SDK, MCP, and lifecycle adapters where feasible.

Do not turn MDB into a coding-only product: document, personal, research, business, creative, and other agents must be first-class.

### Non-goals for MVP

- Replacing Git, a relational OLTP database, or collaborative document editing.
- Perfect semantic reasoning without a model.
- Automatic publication of private workspace records to global stores.
- Multi-device live synchronization, full-text indexing of arbitrary non-Markdown files, and multi-user enterprise authentication.
- Silent scanning of the user's entire machine or all conversations; ingestion and capture sources require explicit configuration and consent.

### Core invariants (enforce in code and tests)

1. Canonical source/knowledge is human-readable Markdown and immutable file-backed revision history; source attachments may remain in original formats.
2. Original imports are immutable snapshots; MDB does not mutate the imported file at its external location.
3. Any accepted change preserves its previous version. Current views may be atomically replaced only once the new immutable revision is durably recorded.
4. Deletes tombstone by default; an explicitly authorized purge operation can remove data from every known history/replica for privacy requirements.
5. SQLite can always be disabled or deleted and rebuilt without loss of canonical knowledge.
6. Workspace isolation is enforced **before** snippets, metadata, graph traversals, embeddings, and model context are returned.
7. Global Wiki/shared/discoveries are readable by authorized agents; promotion of workspace knowledge is an explicit permitted operation, producing a sanitized derivative.
8. All generated assertions retain evidence/provenance. Hypotheses are never silently upgraded to facts.
9. Maintenance agents can propose semantic edits, but storage consistency, versioning, indexing, and access checks are deterministic.
10. Same API semantics across filesystem and optional SQLite modes; test result parity for representative queries.
11. No LLM or embedding provider configured means no LLM calls; CRUD, indexed navigation, lexical search, and deterministic background maintenance still work.
12. Low-trust imported content is data, not instructions; never execute instructions found within indexed Markdown.

## 2. Logical database architecture

Root vault has these top-level logical areas:

| Area | Scope | Function |
|---|---|---|
| `MAIN_INDEX.md` | global navigation | Compact map into profile, wiki, shared intelligence, discoveries, and authorized workspaces |
| `PROFILE.md` | owner-wide | Explicit stable information/goals entered or confirmed by the user |
| `USER_INSIGHT.md` | owner-wide | Evidence-backed, revisable inferred preferences/skills/goals learned from conversations |
| `WORKSPACE_REGISTRY.md` | global navigation | Human-friendly workspace descriptions; actual authority is structured manifest/ACL |
| `wiki/` | globally shared, subject to ACL | LLM Wiki: immutable source snapshots/manifests; curated pages, topics, entities, synthesized knowledge, citations |
| `shared/` | shared, subject to ACL | Reusable agent notes, insights, analyses, findings, thinking, decisions, procedures, reflections |
| `discoveries/` | shared, subject to ACL | Dream hypotheses, 'aha' moments, compositional opportunities, contradictory ideas, validation outcomes |
| `workspaces/<id>/` | isolated DB | Project/domain context and per-task collections, memory, working state, sessions, retrospective, local indexes |

An **agent is an actor**, not necessarily a database. Multiple agents may collaborate in one authorized collection, with separate session identities. A task is ordinarily one collection, but collections may also organize workflows/topics.

### Recommended on-disk structure

```text
MDB/
├── mdb.yaml
├── MAIN_INDEX.md
├── PROFILE.md
├── USER_INSIGHT.md
├── WORKSPACE_REGISTRY.md
├── wiki/
│   ├── INDEX.md
│   ├── sources/
│   │   ├── originals/<sha256>/<original-name>  # copied, immutable; non-md permitted
│   │   └── manifests/<source-id>.md
│   ├── pages/
│   ├── topics/
│   ├── entities/
│   ├── syntheses/
│   └── references/
├── shared/
│   ├── INDEX.md
│   ├── insights/
│   ├── notes/
│   ├── analyses/
│   ├── findings/
│   ├── thinking/
│   ├── decisions/
│   ├── procedures/
│   └── reflections/
├── discoveries/
│   ├── INDEX.md
│   ├── hypotheses/
│   ├── aha-moments/
│   ├── cross-domain/
│   ├── opportunities/
│   ├── validated/
│   └── retracted/
├── workspaces/
│   └── <workspace-id>/
│       ├── db.yaml
│       ├── PROFILE.md
│       ├── INDEX.md
│       ├── OVERVIEW.md
│       ├── memory/{episodic,semantic,procedural}/
│       ├── insights/
│       ├── decisions/
│       ├── sources/{originals,manifests}/
│       ├── wiki/{pages,topics,syntheses}/
│       ├── collections/
│       │   └── <collection-id>/
│       │       ├── PROFILE.md
│       │       ├── INDEX.md
│       │       ├── state.md
│       │       ├── working/
│       │       ├── notes/
│       │       ├── observations/
│       │       ├── insights/
│       │       ├── sessions/
│       │       └── retrospective.md
│       └── .mdb/index.sqlite            # optional, derived
└── .mdb/
    ├── manifest.json                    # configuration/format version only
    ├── objects/<object-id>/revs/<revision-id>.md # immutable, authoritative
    ├── heads/<object-id>.json           # regenerable current pointers from journal
    ├── events/<segment>.jsonl           # durable event/outbox journal
    ├── locks/
    ├── jobs/<job-id>.json
    ├── cursors/<consumer>.json
    ├── cache/
    ├── indexes/                         # disposable local caches
    └── global-index.sqlite             # optional, derived
```

**Important:** There are two classes of `.md`: (1) authoritative immutable revision objects under `.mdb/objects/…/revs/`; (2) human-friendly current document paths such as `wiki/pages/foo.md`, which are materialized current views of those revisions. Original imported source snapshots in `sources/originals` are never modified. Preserve source text/attachments unmodified; any parse/extraction/summary becomes a separate derivative with provenance.

Set storage permissions so only MDB's trusted write service can alter revision/original stores. On systems where a local owner has direct disk access, application-level immutability is a guarantee for MDB-mediated writes, not protection against arbitrary privileged filesystem mutations; document this limit.

### Scope and sharing rules

- `global` includes owner-authorized root, wiki, shared, and discoveries; **global** means shared among allowed agents, not public internet.
- `workspace` content has a workspace ACL. `collection` inherits and can narrow access. A workspace has independent ID, configuration, search scope, and optionally independent SQLite index.
- A query with `scope=all` searches **only** the caller's authorized scopes, not all physical files.
- Cross-workspace links are resolvable only if actor has access; otherwise respond with non-disclosing `not_accessible` (avoid leaks via existence, counts, snippets, graph edges).
- `promote` creates a new versioned sanitized global object, never changes visibility or content of an original private source; record the promotion origin in protected metadata. Do not surface inaccessible evidence in shared results.

## 3. Canonical object and document format

Use readable Markdown, UTF-8, LF preferred, YAML frontmatter. Require identifiers and schema version. Stable ID must survive path or title changes. Use a sortable ID generator (ULID/UUIDv7) with a readable prefix, but never depend on the prefix for authorization.

Example:

```markdown
---
schema_version: 1
id: ins_01JEXAMPLE000000000000000
revision_id: rev_01JEXAMPLE00000000000
revision_number: 2
kind: insight
title: Profile pipeline stages before optimizing
scope: workspace
workspace_id: research
collection_id: retrieval-task
status: supported
visibility: workspace
created_at: 2026-10-07T18:00:00Z
updated_at: 2026-10-07T19:00:00Z
created_by: agent-research
owner_id: user-local
tags: [retrieval, debugging]
confidence: 0.8
provenance:
  evidence:
    - uri: mdb://workspaces/research/objects/obs_01EXAMPLE
      revision_id: rev_01OLD
      span: "L12-L22"
  derived_from: [obs_01EXAMPLE]
relations:
  - type: applies_to
    target: mdb://wiki/objects/topic_retrieval
  - type: supports
    target: mdb://shared/objects/procedure_diagnostics
previous_revision_id: rev_01PREV
---
# Profile pipeline stages before optimizing

## Situation
...

## Evidence
...

## Reuse conditions
...

## Limitations
...
```

**Kinds:** `source`, `wiki_page`, `fact`, `observation`, `working_memory`, `note`, `insight`, `analysis`, `finding`, `thinking`, `decision`, `procedure`, `reflection`, `session`, `discovery`, `user_insight`; allow namespace-qualified user-defined kinds. Avoid assuming unstructured `thinking` means hidden model reasoning; store only explicit, permissible authored notes/analyses, not private internal model traces.

**Relations:** `derived_from`, `supports`, `contradicts`, `applies_to`, `related_to`, `supersedes`, `attempted_in`, `succeeded_in`, `failed_in`, `reused_by`. Maintain exact references and source revision, with unresolvable links represented safely.

**States:** evidence-backed knowledge: `candidate → supported → verified → promoted`; alternatives `disputed`, `superseded`, `retracted`. Discoveries use `hypothesis → testing → validated/rejected/retired`. An LLM-generated confidence estimate is not an objective probability; persist as indicative with validation method.

### Original sources and ingestion

- `mdb ingest <explicit-path>` copies source bytes into `sources/originals/<sha256>/…` and records metadata in an immutable Markdown source manifest (import path, MIME, hash, import time, consent/scope). Do **not** alter the original input.
- For external URLs, only add a fetcher later with explicit consent and network controls; sources may include `.pdf`, images, `.txt`, `.md`, etc. MVP supports Markdown/plain text natively. Unsupported extraction is recorded, not falsely summarized.
- Source snapshots are content-addressed and deduplicated within permitted scope; do not accidentally enable cross-scope content inference via hashes returned to unprivileged actors.
- A new external version becomes a new source snapshot/version with provenance, not an overwrite.

## 4. Durability, transactions and revisions

### Storage adapter (future S3-compatible shape)

```ts
interface ObjectStore {
  read(key: string): Promise<Uint8Array>;
  stat(key: string): Promise<{ etag?: string; size: number } | null>;
  list(prefix: string): AsyncIterable<{ key: string; size: number }>;
  putImmutable(key: string, bytes: Uint8Array): Promise<void>; // fails if exists with different bytes
  compareAndSwapPointer(key: string, expected: string | null, value: string): Promise<boolean>;
  removeForAuthorizedPurge(key: string): Promise<void>;
}
```

Implement `LocalObjectStore` now. Keep the interface compatible with S3's non-atomic multi-object behavior (no assumed cross-key transactions or filesystem rename on remote). `putImmutable` is not arbitrary overwrite. Restrict keys to MDB root, reject `..`, absolute paths, symlink escape, traversal, and reserved directories.

### Commit protocol (MVP single writer per vault)

1. Validate actor, path/scope, object schema, expected revision (optimistic concurrency), and source immutability.
2. Construct canonical Markdown revision with next revision ID; write to temp file and fsync where supported.
3. Atomically commit immutable revision by same-filesystem rename without replacing an existing immutable revision; fsync containing directory where supported.
4. Append a durable committed event/outbox record (journal), with transaction ID/idempotency key and previous/new revision IDs. Use an internal serialization/lock protocol so concurrent processes cannot interleave commits; recover interrupted events on startup.
5. Atomically replace a **current view** (and head pointer) with materialized revision content; allow this only after the revision is durably recorded. Rebuild current views from revision pointers/journal on recovery.
6. Emit background tasks for optional indexes and semantic maintenance. Failed downstream processing must not lose the committed document.

Make the journal/revision ordering and replay rules explicit and testable. If a crash leaves an immutable unreferenced revision, recovery must reconcile safely without presenting it as a completed commit; if a committed event lacks a view, rebuild the view. Use one-writer coordination per vault for MVP; readers may run concurrently. Record portable limitations for durability on filesystems without reliable atomic rename/fsync.

**External direct editor changes:** recognize current-view changes with a watcher + periodic reconcile. Do **not** silently rewrite immutable history. Import an external edit as a new revision after syntax validation and conflict checks; if it conflicts with an intervening commit, preserve the external content in a conflict/quarantine file, alert the user, and do not discard it. Explicitly warn that native edits to `sources/originals` or revision history are unsupported.

### Deletion and retention

- `delete` adds a tombstone revision and withdraws object from active search; history remains.
- `purge` is an explicit high-trust operation: remove all known local object revisions, attached originals solely owned by target, caches, vectors, snippets, and propagate deletion requests to configured replicas. Audit the fact of purge without retaining purged private text. Best effort with reporting; backups/replicas need documented retention/erasure semantics.
- Avoid accidental secrecy claims: optional SQL indexes and queue payloads may contain private content and require equivalent access controls/encryption policy.

## 5. Unified API and CLI

Define one core service and expose wrappers. Errors have stable codes: `NOT_FOUND_OR_FORBIDDEN`, `CONFLICT`, `INVALID_INPUT`, `CAPABILITY_UNAVAILABLE`, `INDEX_STALE`, `INTERNAL`.

```ts
type Scope =
  | { type: 'global'; area: 'wiki' | 'shared' | 'discoveries' | 'profile' }
  | { type: 'workspace'; workspaceId: string; collectionId?: string };

interface ActorContext { actorId: string; permissions: string[]; }
interface PutInput {
  scope: Scope; kind: string; title: string; body: string;
  tags?: string[]; links?: Relation[]; idempotencyKey?: string;
}
interface PatchInput {
  objectId: string; expectedRevisionId: string;
  title?: string; body?: string; metadataPatch?: Record<string, unknown>;
}
interface SearchInput {
  query: string;
  mode?: 'grep' | 'keyword' | 'semantic' | 'hybrid' | 'auto';
  scopes?: Scope[]; kinds?: string[]; tags?: string[];
  since?: string; until?: string; limit?: number; cursor?: string;
  includeHistory?: boolean;
}
interface SearchHit {
  uri: string; revisionId: string; title: string; kind: string;
  matchedHeading?: string; snippet: string; lineStart?: number; lineEnd?: number;
  score?: number; retrievalMode: string;
}
```

Core commands/functions:

- `mdb init [--root PATH] [--no-sqlite]`
- `mdb workspace create|list|info|grant|revoke`
- `mdb collection create|list|info`
- `mdb put`, `mdb get`, `mdb patch --revision`, `mdb delete`, `mdb history`, `mdb diff`, `mdb restore`
- `mdb ingest PATH --scope ...`
- `mdb grep TEXT [--regex] [--scope ...]`
- `mdb search QUERY --mode keyword|semantic|hybrid|auto --scope ...`
- `mdb links`, `mdb backlinks`, `mdb related ID --depth N`
- `mdb context --task "..." --scope ... --budget-tokens N`
- `mdb promote ID --to shared|wiki|discoveries --review`
- `mdb session start|observe|end`
- `mdb profile show|propose|approve|reject`
- `mdb intelligence run --job index|profile|wiki|memory|reflect|dream`
- `mdb index status|rebuild|verify`, `mdb doctor`, `mdb verify`, `mdb jobs status`

The CLI must produce human output by default and `--json` for automation. Implement CLI help and examples. Expose the same operations via SDK and MCP where safe.

### MCP tools (MVP)

`mdb_search`, `mdb_grep`, `mdb_get`, `mdb_put`, `mdb_patch`, `mdb_link`, `mdb_context`, `mdb_session_start`, `mdb_observe`, `mdb_session_end`, `mdb_workspace_list`, `mdb_collection_list`, `mdb_history`, `mdb_propose_insight`, `mdb_promote` (controlled). Avoid exposing a general file write primitive. Authorization is based on host-assigned identity and granted scopes, never self-declared actor IDs from an untrusted model argument. MCP responses carry citations/URIs and revision IDs.

### Native agent integration

- Generic MCP + CLI/SDK is the primary portable integration.
- Create optional host adapters for supported lifecycle events (session start/end, user-message completion, tool outcome capture), with opt-in event types and redaction.
- `agent-context` can inject the root profile, relevant workspace context, and high-confidence prior insights within a strict token budget. Do not automatically inject all content.
- For frameworks without hooks/event streams, document manual/wrapper capture; do not claim zero-effort capture for unsupported environments.

## 6. Search architecture: lexical-first, SQLite optional

### Pure filesystem mode (always available)

- `grep`: literal search by default, optional regex via `ripgrep` (`rg`) executable if installed; implement a streaming Node fallback so the system works if `rg` is absent.
- `keyword`: tokenize/query against Markdown body + title; use `rg` for candidates when available and rank document/section matches with a deterministic scorer (title/heading occurrence, term coverage, bounded frequency, freshness optionally). Preserve quoted phrase semantics and documented boolean behavior; never silently claim full FTS5 equivalence.
- Metadata queries: parse YAML frontmatter for scoped candidate files. Use compact scope manifests and optional in-memory parsed metadata cache (disposable) to avoid excessive reads.
- Cross-reference: parse wiki `[[links]]` and canonical `mdb://` links; build ephemeral adjacency index when necessary; allow periodic persisted derived file index in `.mdb/indexes/`.
- `semantic`: only if explicitly configured with embedding provider and index adapter; otherwise `CAPABILITY_UNAVAILABLE` with a clear fallback suggestion. Simple, bounded brute-force vector scanning in memory may be supported for small corpus, never required.
- `hybrid`: if semantic unavailable, return documented lexical-only degraded mode **only if caller opts into fallback**; otherwise return `CAPABILITY_UNAVAILABLE` rather than pretending hybrid ran.

### Optional SQLite search (included in MVP)

SQLite is derived; `.md` + immutable revisions are authoritative. Use a separate DB per workspace, plus a shared/global index. Prefer SQLite WAL for concurrent reads and one writer per DB. On startup check FTS5 availability; gracefully switch to filesystem mode when unavailable or index behind. Do not return incomplete stale results as if complete. Use version/checkpoint metadata and reconcile missing changes, or merge fresh-file fallback results.

Proposed minimum tables:

```sql
CREATE TABLE documents (
  rowid INTEGER PRIMARY KEY,
  object_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL,
  workspace_id TEXT,
  collection_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE chunks (
  rowid INTEGER PRIMARY KEY,
  document_rowid INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  FOREIGN KEY(document_rowid) REFERENCES documents(rowid)
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  heading, content,
  content='chunks', content_rowid='rowid',
  tokenize='unicode61', prefix='2 3'
);
CREATE VIRTUAL TABLE chunks_trigram USING fts5(
  content,
  content='chunks', content_rowid='rowid',
  tokenize='trigram'
);
CREATE TABLE edges (
  from_id TEXT NOT NULL,
  to_uri TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY(from_id, to_uri, relation)
);
CREATE TABLE index_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE INDEX idx_doc_scope ON documents(workspace_id, collection_id, kind, updated_at);
CREATE INDEX idx_chunks_doc ON chunks(document_rowid, ordinal);
```

Implement FTS sync reliably: either update base/FTS in a transaction with explicit actions, or triggers; never leave stale external-content FTS tables after updates. FTS5 trigram can accelerate eligible substring patterns, but regex requires final verification; short/pattern-only scans may fall back to scoped file search. `bm25` scores must be normalized/ordered consistently (FTS5's lower-is-better semantics); use bounded result sets. Never leak matches via global unscoped SQL output.

Optional semantic search: define `EmbeddingProvider` + `VectorIndexAdapter`. sqlite-vec plugin may be shipped as an optional extra if compatible with the runtime/platform; pin supported versions at implementation time and handle missing extension cleanly. Store embedding model ID, dimensions, chunk hash, source revision, and index checkpoint; reembed only affected chunks. Semantic search is **not** required for all offline MVP setups.

### Hybrid retrieval

1. Resolve authorized scopes and effective filters **first**.
2. Execute bounded lexical retrieval, optionally bounded embedding KNN retrieval.
3. Remove unauthorized/stale hits before response assembly.
4. Fuse via reciprocal rank fusion, e.g. `RRF = Σ 1/(k + rank_i)`, with configurable `k`.
5. Deduplicate at object/chunk level; optionally graph-expand top hits one hop after authorization.
6. Include stable URI, revision, heading, exact snippet + line numbers and provenance; respect context token budget.

`auto` defaults lexical-first. Only use semantic if user/config requests or lexical recall appears low and model is available; do not call a generative LLM for routine query routing. Exact/regex mode must never silently broaden to semantic search.

### Search speed and performance

- Scope partitioning (no irrelevant workspace scan).
- Chunk on headings with capped size/overlap; retain line mapping and source revision.
- SQLite inverted FTS5 + optional trigram; fast grep via ripgrep in non-SQL mode.
- Prefix and metadata indexes, bounded candidate sets, selective lazy vector retrieval.
- Incremental updates only for changed document/content hash; background embedding.
- Prepared SQL queries, bounded LRU caches, index checkpoints; do not let cache break ACL/purge.
- Avoid re-searching all history by default; only current views unless `includeHistory` authorized.
- Explicit benchmarks for 1k/10k/100k Markdown files, small/large chunks, cold/warm cache, concurrent reads/writes and several query types. Report p50/p95, correctness parity, index size, and rebuild duration. Performance targets are goals, not promises.

## 7. Hierarchical navigation and Wiki

`MAIN_INDEX.md` is a compact map, **not** a dump of every file. Organize `MAIN_INDEX → store INDEX → topic INDEX → wiki page/object`. Index pages should explain domains, notable concepts, curated entry points, and recent updates. Maintain deterministic navigational sections automatically and semantic summary sections via proposals from the Intelligence Engine. Never erase user-authored sections: use guarded generated blocks or dedicated generated files with clear ownership.

Wiki subsystem inspired by the LLM Wiki model:

- Immutable `sources/originals` + Markdown `sources/manifests` for citations, hashes and provenance.
- `wiki/pages` for synthetic topic pages; `topics`, `entities`, `syntheses` for organization.
- `ingest → classify → extract → compile → link → lint → refresh` workflows.
- Incremental updates: identify affected pages by source references and topic graph; do not rewrite the entire wiki after a single import.
- Distinguish externally sourced claims, agent inferences, and hypotheses. Every important synthesized claim should be traceable to evidence (with spans/URI) or explicitly marked as unsupported/inferred.
- Every authorized agent can read global wiki pages; workspace-specific wiki content remains workspace-isolated until promoted.

## 8. User profile and user insights

Root `PROFILE.md` is for explicit user-provided stable facts, goals, and preferences. `USER_INSIGHT.md` is for inferred/updated information extracted from conversations, task feedback, and behavior, respecting user controls and source consent.

Suggested sections: explicit preferences, goals, interests, current capabilities, working style, active projects (non-sensitive summaries), learned patterns (inferences), knowledge gaps, recent changes, evidence references, correction history. Avoid inferred sensitive personal profiling by default; provide opt-out, review, correction, redaction, and deletion.

Profile agent pipeline:

1. Receive authorized conversation or task-completion event with minimal necessary text.
2. Extract candidate enduring information (not every temporary utterance).
3. Compare against existing root and scoped profiles.
4. Classify `explicit` vs `inferred`; attach evidence, timestamp, confidence, scope, and sensitivity.
5. Reject repetitive/trivial or unsupported candidates; queue sensitive or conflicting updates for human review.
6. Commit approved candidate as a **new revision**, preserving previous revisions.
7. Refresh semantic navigation and emit change event to Dream Engine.

Never treat inferred profile items as rigid commands, never silently overwrite an explicit preference with an inference, and never expose private workspace details into global user summaries without authorization.

## 9. Autonomous Intelligence Engine (small internal agent system)

One bounded orchestrator with skills/stages rather than six heavyweight agents. Components:

| Role | Function | LLM need |
|---|---|---|
| Index Maintainer | Physical index reconciliation; generated navigation section refresh | None for physical; optional for semantic index prose |
| Profile Curator | Evidence-backed `PROFILE.md`/`USER_INSIGHT.md` proposals | Optional/required for sophisticated inference |
| Wiki Curator | Source classification, synthesis, links, citations | Model for synthesis |
| Memory Curator | Observation triage, summaries, handoffs, retrospectives | Model for synthesis |
| Dreamer | Cross-domain associations, compositional hypotheses, opportunities | Model |
| Critic | Dedup, contradiction/novelty/evidence/permission checks | Deterministic + model as needed |

The deterministic runtime handles journals, revision commits, ACL, index rebuilding, leases, retry and checkpoints. Agent stages are limited to querying approved knowledge and proposing **new derivative versions** through safe APIs. Maintain an immutable audit log of job actions and model metadata without sensitive prompt dumps by default.

### Triggers

- **on_write:** immediate deterministic derived-index update, then queue semantic/index/profile/wiki workflows if relevant.
- **on_session_end:** summarize selected observations, maintain working-state handoff, generate retrospective candidate.
- **on_task_complete:** analyze what worked, what failed, what should be reused; propose workspace insight and potential sanitized global promotion.
- **daily or idle deep pass:** revisit changes, contradictions, profile changes, and distant concepts for dreaming.
- **manual:** `mdb intelligence run ...`, `mdb dream run ...`, `mdb profile review`.

**Work queues:** persisted Markdown/JSON job descriptors in `.mdb/jobs/`, idempotency keys, leases, retries with exponential backoff, dead-letter state, bounded execution cost/time, checkpoints per consumer. Enqueue cycles must not recursively explode (dream artifacts do not trigger unlimited new dreams). If no model is configured, mark model-required jobs blocked/capability unavailable, not successful.

### Skills

Ship concise, real skill instructions: `memory-recall`, `memory-write`, `context-handoff`, `source-ingestion`, `wiki-maintenance`, `profile-update`, `insight-extraction`, `retrospective`, `dream-discovery`, `knowledge-promotion`, `index-audit`, `knowledge-critique`. They direct workflows but **do not** maintain physical storage invariants.

## 10. Dream Engine design

**Definition:** finds previously unrecorded, potentially useful relationships by combining source-grounded knowledge from different times, workspaces, agents, and domains; creates hypotheses, not unquestionable truths. Example: Python API skill + JavaScript UI skill → hypothesis to build a full-stack app; novelty may be personal, not globally novel.

### Dream inputs

- New/revised insights since per-scope cursor.
- Compact user portfolio (`PROFILE`, `USER_INSIGHT`), active goals, confirmed capabilities.
- Wiki knowledge, shared notes/analyses/findings/procedures, other authorized knowledge.
- Existing discoveries, rejected/validated outcomes, and their reasons.
- Task retrospectives and known failure modes.

### Modes

1. **Micro-dream** (on meaningful changes): fast, local neighborhood and few complementary candidates.
2. **Deep-dream** (user-configured idle/daily): broader domain traversal, distant or weakly associated pairings.
3. **Strategic dream** (goals changed or major completion): opportunities and gaps tied to user objectives.

### Pipeline

`event selection → evidence-filtered memory replay → association candidate retrieval → compositional idea generation → critic/novelty check → permission and sensitivity check → new discovery revision → human review or cautious exposure → validation outcome → feedback into ranking`.

**Association retrieval:** lexical/graph neighbors PLUS controlled exploration of distant concepts, domain capabilities, complementarity (`A provides X`, `B consumes X`), analogies, contradictions, and temporal changes. Pure vector similarity is insufficient for surprising useful recombination.

**Discovery schema:** id, title, source URIs and revision IDs, participating domains, mechanism of connection, proposed new capability, relevance to user goals, expected usefulness, counterarguments, constraints, novelty type (`personal`, `workspace`, `global`), evidence status, test plan, created-by/model, current lifecycle status.

**Critic rules:**

- Novelty against existing wiki/shared/discoveries; merge/relate duplicates.
- Verify prerequisite claims against references.
- Reject unsupported leaps or clearly known restatements unless newly useful to user.
- Record uncertainty and failure conditions.
- Check policy and permission of sources and resulting derivative; never surface protected source passages.
- No automatic execution of experiments or tool actions with side effects without separate authorization.
- No self-reinforcing recursive dreams from speculative discoveries alone.

Store accepted hypotheses under `discoveries/` and track whether agents actually reused/validated them. `reused_by` edges and feedback help prioritize useful discovery mechanisms. Never claim human cognition or guaranteed insight quality.

### After-action reviews

For completed tasks capture: intended goal, actions/approaches, result and evidence, mistakes/failed attempts, root causes, successful patterns, applicability/limits, time/cost where available, transferable recommendations, unresolved follow-ups. Preserve original session observations and references; derive a new `reflection` and candidate `insight` object. Do not claim failure/success without evidence.

## 11. Security, privacy, and trust boundaries

MVP is local, single-owner with multiple agents. Implement **capability-based agent scopes** now so eventual multi-user deployment does not require rearchitecting. Explicit default policy: each agent may read global stores as granted; workspace grants are separate; write/promote privileges distinct from read. Agents don't self-assign identity. For CLI local owner identity may be trusted; MCP host controls identity.

- Prevent traversal, symlink escapes, absolute-path writes, and malicious frontmatter injection.
- Normalize and validate URIs and YAML (avoid unsafe YAML object deserialization).
- Treat imported documents and tool output as untrusted; never allow document text to override runtime instructions or spawn commands.
- Minimize captured conversations; provide capture source allowlists/opt-out and secret redaction, with retention policies.
- Search ACL applies before result counts, rankings, snippets, cross-references, embeddings, and context assembly.
- LLM-generated pages must not be allowed to change ACL or alter original source snapshots directly.
- Security tests include path attacks, malicious Wiki text, unauthorized scope queries, leaked backlink metadata, source-content hashes, and cross-workspace promotion.
- Backups and replicas need access controls; ensure purge coverage is documented.

## 12. Plugin boundaries and future infrastructure

Use **two independent interfaces**:

```ts
interface StorageAdapter { /* reads, immutable writes, list, stat, CAS pointers */ }
interface SearchIndexAdapter {
  capabilities(): { keyword: boolean; substring: boolean; regex: boolean; metadata: boolean; semantic: boolean; graph: boolean };
  indexRevision(change: RevisionChange): Promise<void>;
  query(input: SearchInput, auth: ActorContext): Promise<SearchHit[]>;
  rebuild(scope: Scope): Promise<void>;
  health(): Promise<IndexHealth>;
}
```

MVP: `LocalObjectStore`, `FilesystemSearch`, and `SQLiteSearch` (first-party optional). Optional embedding plugin may augment either search engine. Future: `S3ObjectStore`, `PostgresSearch` (FTS + optional pgvector), and other SQL search adapters. SQL stores remain **derived**; no canonical Markdown should exist only inside SQL. Plugin capabilities and downgrade/fallback are explicit.

S3 later will require per-object conditional writes, current-head/manifests, sync conflict handling, retries, eventual independent verification of replication, and version/delete policies. Avoid coupling core to POSIX path/rename semantics except within `LocalObjectStore`.

## 13. Suggested TypeScript monorepo

```text
mdb/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/             # types, validation, URI, auth, operations
│   ├── storage-local/    # immutable local store, transactions, recovery
│   ├── search-files/     # streaming grep/keyword/metadata/graph
│   ├── search-sqlite/    # optional FTS5/trigram, graph, metadata
│   ├── search-vectors/   # optional embedding/vector interface
│   ├── knowledge/        # wiki compilation, links, index views
│   ├── intelligence/     # event worker, profile, dream, critic
│   ├── sdk/              # client SDK
│   ├── cli/              # mdb commands
│   └── mcp/              # agent tools and permissions
├── integrations/
│   ├── claude-code/
│   ├── codex/
│   └── generic/
├── skills/
├── examples/
│   └── sample-vault/
├── fixtures/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── security/
│   ├── failure-recovery/
│   ├── parity/
│   └── performance/
├── docs/
└── verification/
```

Prefer a single `mdb` CLI executable invoking the same core service as MCP. Use migrations only for optional derived SQL schemas and vault format metadata. Require minimum Node LTS version pinned in `package.json`; avoid unstable APIs and native dependencies in core. Keep scripts for `build`, `test`, `lint`, `typecheck`, `verify`, and benchmark.

## 14. Phased implementation plan with hard exit gates

### Phase 0 — Bootstrap and design contracts

- Initialize TS monorepo, CI/test harness, sample vault, docs, object schemas, interface and version definitions.
- Implement `mdb doctor`, `mdb init`, `--root` configuration, filesystem capability check.
- Document exact local-only privacy defaults and known limitations.

**Exit gate:** clean install, typecheck/lint/test passes, sample vault initializes without SQLite or network/LLM.

### Phase 1 — Immutable Markdown DB foundation

- Typed Markdown objects, YAML metadata validation, source ingestion, content-addressed snapshots.
- Versioned create/update/delete/history/diff/restore, journal, atomic current views, crash recovery, optimistic concurrency.
- Workspace isolation, collections, root and scoped profiles/index files, scope-aware references and ACL.
- Watcher + periodic reconcile for external current-view edits.

**Exit gate:** create/update/history/restore/read without SQLite; original sources identical hashes; simultaneous write conflict detected; crash-stage faults recover without losing committed changes; cross-workspace unauthorized reads denied.

### Phase 2 — Filesystem retrieval and navigation

- `grep` and `keyword` native fallback; metadata filters, scoped search, result snippets/line references, link parser and backlinks.
- Auto-generate deterministic index sections and `MAIN_INDEX`, per-workspace/collection `INDEX`, plus root registry.
- Context assembly with token budget, dedup, and ACL.

**Exit gate:** exact, regex, keyword, metadata, graph, and permission tests; `rg` not installed still searches; large test corpus results verified; no unapproved workspace content in global search.

### Phase 3 — Optional SQLite (part of MVP)

- SQLite first-party adapter, FTS5 BM25, trigram candidates, structured filters/edges, WAL, checkpoints, rebuild.
- Automatic fallback to filesystem for disabled/missing/stale indexes; parity tests.
- Optional semantic/provider/vector extension behind feature flags; implement hybrid only when semantic backend is configured.

**Exit gate:** removing all SQLite files loses no knowledge; fresh rebuild passes; equivalent authorized results with/without SQLite for lexical queries; stale index never silently excludes a newly committed document; no SQL toolchain needed for pure-file mode.

### Phase 4 — Agent interfaces and memory capture

- SDK/CLI/MCP tools, structured session start/observe/end and handoff, scoped capture events.
- At least one supported lifecycle adapter if technically available; generic manual/wrapper fallback.
- Versioned session summaries/retrospectives and task insights through configured model or queued proposals.

**Exit gate:** generic agent can create a workspace, remember observation, close session, and retrieve context next session; no-provider mode works without fake summaries; permission tests run through MCP endpoint.

### Phase 5 — Intelligence engine: index, profile, wiki, memory

- Durable bounded job worker with retries/checkpoints/idempotency.
- Profile candidate extraction/review/update, Wiki source-to-page synthesis/citations, knowledge consolidation, index semantic sections.
- Critic and review queue; source immutability and version preservation across every autonomous update.

**Exit gate:** newly ingested source leads to reviewed derived page without changing bytes of source; profile changes create new revision and evidence; malformed/failed model output quarantined; repeated event processing is idempotent; indexes are recoverable.

### Phase 6 — Dreaming and cross-workspace discovery

- Micro/deep/strategic dream modes, novelty and complementarity candidate retrieval, synthesized hypothesis records, validation state, approved promotion.
- Cross-workspace ACL, provenance, dedup/contradiction, no unbounded recurrence.

**Exit gate:** synthetic Python-API + JS-UI memories produce a **candidate** full-stack synthesis with both citations; inaccessible source never appears in discovery text; duplicate dream does not flood DB; changed user goals influence opportunities; unsupported conclusions are marked speculative.

### Phase 7 — Performance, hardening and package readiness

- Benchmarks, fuzz/property tests, backup/restore, purge checks, corruption-recovery, docs and release packaging.
- Verify behavior on macOS and Linux where possible, note unsupported platforms.

**Exit gate:** provide benchmark report (hardware/corpus size/p50/p95/index size), provenance audit, security checks, migration/rebuild docs, all quality gates passing.

**Future phases, not MVP:** S3 adapter, PostgreSQL/pgvector, other SQL search plugins, remote replication, hosted multi-user service.

## 15. Acceptance tests and failure simulations

Write automated tests **before** accepting core features. Required scenarios:

1. **Source integrity:** import MD/text/binary attachment, generate three wiki revisions; all original SHA-256 checksums unchanged.
2. **Versioning:** update current view, history records old/new, compare diff, restore generates *new* revision (never rewrites old).
3. **Power failure:** inject failure after revision write, after journal append, before view update, during optional index processing; recover deterministic committed state.
4. **Concurrent agents:** two patches against same revision → one wins, second returns `CONFLICT`; retries preserve both inputs via explicit merge.
5. **No SQLite:** full CRUD, grep, metadata, links, navigation, journal, autonomous deterministic index maintenance and profile view access work.
6. **SQLite parity:** representative phrase, keyword, Unicode, substring, regex, metadata, tags, scope, backlinks; compare returned canonical IDs and snippets where semantics overlap.
7. **Stale index:** file edit arrives while SQLite index is behind → correctly refresh/fallback; report health rather than silently omit.
8. **ACL:** Agent A cannot infer protected Workspace B via searches, matched counts, links, embeddings, error messages, or dream output.
9. **Permission promotion:** transfer generalizable insight to shared while raw secret stays private, sanitized output has scoped provenance.
10. **Profile:** stated preference change overrides inferred preference, old revision preserved; unsupported sensitive inference not persisted automatically.
11. **Memory:** session recording and retrospective produce linked objects with bounded token context; initial notes never deleted.
12. **Dream:** Python and JS example yields compositional *hypothesis*, evidence links, feasibility plan; a critic can reject and preserve rejection rationale.
13. **Dedupe:** same event delivered twice creates one logical revision/job/result.
14. **Injection and paths:** malicious source saying “ignore ACL” has no authority; traversal/symlinks cannot escape root.
15. **Deletion/purge:** tombstones hide active search results, privacy purge clears known revisions/index/caches and reports replica limitations.
16. **No model:** no-network/no-provider environment performs all deterministic operations; model-required features clearly unavailable.
17. **Rebuild:** wipe `.mdb/indexes` and all `.sqlite`, run `mdb index rebuild`; semantic navigation and lexical capabilities recovered without loss.
18. **S3-prep:** contract tests execute against a fake object store lacking filesystem rename; ensure abstraction does not assume POSIX writes outside local adapter.

## 16. Metrics / observability

Report exact measurements, not invented targets:

- CRUD commit and recovery latency; failed/conflicting writes.
- Filesystem and SQLite search p50/p95 by corpus size; memory usage; SQLite file size and rebuild time.
- Index lag, pending worker jobs, queue retries, malformed document count, unauthorized query count.
- Source integrity violations (must remain zero); missing evidence or broken references.
- Insight promotion, dedup rate, verified/rejected hypotheses, *validated* cross-workspace reuse.
- Dream runtime/token cost, candidate-to-useful ratio, discovery recursion guard hits.

Default logs avoid storing conversation/raw source text. Commands `mdb doctor`, `mdb index status`, `mdb jobs status`, and `mdb verify` provide inspectable operational state.

## 17. Recommended implementation defaults

```yaml
schema_version: 1
storage:
  adapter: local
  root: ~/MDB
  source_immutability: true
  preserve_revisions: true
  current_views: true
search:
  mode: auto
  default_behavior: lexical_first
  filesystem:
    enabled: true
    prefer_ripgrep: true
    node_fallback: true
  sqlite:
    enabled: true          # first-party optional in MVP; can turn off
    fts5: true
    trigram: true
    auto_initialize: true
    auto_rebuild: true
    on_stale: reconcile_or_fallback
  semantic:
    enabled: false        # opt-in; needs embeddings/vector adapter
  hybrid:
    enabled: false        # enabled when semantic configured
scope:
  default_visibility: private
  global_read: granted_agents_only
  cross_workspace: authorized_only
intelligence:
  enabled: true
  physical_index_maintenance: deterministic
  index_agent: true
  profile_agent: true
  wiki_agent: true
  memory_agent: true
  critic: true
  dream:
    enabled: false       # turn on when model explicitly configured
    incremental: true
    max_candidates_per_run: 10
    require_evidence: true
  model:
    provider: null
    allow_network: false
capture:
  enabled: false         # explicit opt-in per agent/event source
  redact_secrets: true
retention:
  tombstone_by_default: true
  purge_requires_explicit_authorization: true
```

If SQLite is not available, `mdb init` must still succeed, record fallback mode, and allow all core features. If user explicitly enables semantic or dream without configured model/provider, `mdb doctor` must report unavailable features and explain setup without pretending success.

## 18. Practical first commands Codex should support

```bash
mdb init --root ~/MDB
mdb doctor
mdb workspace create research
mdb collection create --workspace research retrieval-study
mdb put --workspace research --collection retrieval-study \
  --kind note --title "Initial retrieval observations" --file observations.md
mdb grep "retrieval" --scope workspace:research
mdb search "retrieval performance" --scope workspace:research --mode keyword
mdb history <object-id>
mdb index status
mdb index rebuild --scope workspace:research
mdb session start --workspace research --collection retrieval-study
mdb session observe --session <session-id> --file note.md
mdb session end --session <session-id>
mdb intelligence run --job index
mdb doctor --json
```

CLI flags are normative intent; adjust exact syntax consistently and document with integration tests.

## 19. Decisions to preserve / unresolved engineering details

**Locked:** Markdown source of truth; local-first; immutable sources/versioned derivatives; workspace DBs + task collections; Global Wiki/shared intelligence/discoveries; root main index and user insights; grep-first with optional SQLite MVP; optional embeddings; small intelligence agent for profile/index/wiki/memory/dream; future S3 and SQL search plugins; cross-project reuse through authorized promotion.

**Resolve during implementation and document:** exact YAML schema validation library; vault locking mechanism/macOS/Linux support; FTS trigram availability in shipped SQLite runtime; embedding adapter packaging; whether current views are user-editable with automatic revision import; how to model per-agent actor capabilities locally; expected behavior when SQLite is stale; token counter; normalization of wiki links; pruning without destroying source evidence. Choose the simplest correct approach, cover it with tests, and log tradeoffs in ADRs. Do not delay core implementation to debate future infrastructure.

---

## Final acceptance definition

MDB v1 is successful only if a developer can install it locally, initialize a vault, write and version Markdown knowledge, search with grep and scoped keyword retrieval **without SQLite**, optionally accelerate searches via SQLite, access a shared Wiki while keeping workspaces isolated, use core APIs through MCP, and operate an internal maintenance service that preserves original sources and revisions. With a configured model, the system must additionally propose evidence-backed profile/wiki/memory updates and generate cross-domain dream hypotheses in a separate Discovery DB, subject to review and permissions.

**No silent claims:** a feature is *done* only after working code, executable tests, a demonstration, and verification evidence. Features requiring a model, S3, PostgreSQL, or unsupported host hooks must explicitly say when unavailable.
