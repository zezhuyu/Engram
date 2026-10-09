# Architecture

Engram (MDB) is a local, single-owner Markdown database for agent memory and knowledge. An actor-bound `Engram` SDK (also exported as `MDB`) connects one Vault to retrieval, intelligence, and a skill registry. CLI and MCP wrap the same operations; agents do not receive a separate storage implementation.

## Authority and derivatives

Immutable Markdown revisions and committed journal entries are authoritative. A revision written before its journal event is an orphan, not an accepted update. Current paths, head pointers, navigation, and SQLite indexes are materialized derivatives. Recovery reconstructs committed state rather than accepting arbitrary files as knowledge. Original imported bytes are immutable snapshots; extraction and synthesis produce separate objects.

Scopes are either global (`wiki`, `shared`, `discoveries`, `profile`) or workspace, optionally narrowed to a collection. Global means access-controlled sharing on this machine, not internet publication. The trusted host assigns actor identity and capabilities. Vault checks authorization before returning documents, while search checks again before scoring, snippets, history, and context. Explicit promotion creates a sanitized derivative; it does not make the original public.

## Modules

| Module | Responsibility |
|---|---|
| `packages/core` | Documents, scope/authorization, revisions, journal, recovery and CRUD |
| `packages/storage-local` | Safe local paths, immutable writes, atomic replacement and writer lock |
| `packages/storage-s3` | Optional S3 canonical object store and conditional commit-head journal |
| `packages/search-files` | Native lexical retrieval, context and graph/navigation operations |
| `packages/search-sqlite` | Optional disposable SQLite index and lexical fallback |
| `packages/search-postgres` | Optional PostgreSQL FTS index and pgvector semantic/hybrid retrieval |
| `packages/intelligence` | Manual sessions, bounded durable jobs and reviewed proposals |
| `packages/skills` | KB-adapted/native skill registry and SDK dispatch |
| `packages/sdk` | Actor-bound `Engram` / `MDB` facade |
| `packages/cli`, `packages/mcp` | Local-owner CLI; host-bound stdio/HTTP MCP, per-credential actor identity and remote capture ingestion |

## Knowledge workflow inherited from KB

KB's download → raw text → compiled wiki → indexed query workflow becomes explicit local import → immutable source revision → evidence-backed proposal → review → new knowledge revision → deterministic index rebuild. The 22 KB skill directories are copied under `skills/upstream-kb`; adapted instructions and 12 native MDB skills form a 34-skill registry. Upstream scripts are reference artifacts, not an automatic execution pipeline. MDB skills invoke its SDK/CLI instead of writing vault files directly.

Media conversion, OCR, transcription, external downloads, creator crawling and automatic conversation discovery are unavailable adapters. These names remain discoverable with explicit unavailable results. No provider is configured by default: indexing, capture, CRUD and lexical retrieval work; semantic synthesis and dreaming report unavailable. A deterministic sample provider demonstrates the review pipeline and labels its output as a fixture.

## Boundaries

The default remains local Markdown plus filesystem retrieval and optional SQLite. S3 can hold canonical object bytes and a CAS-published journal while local paths materialize current views and disposable indexes. Its protocol requires conditional object PUT and strongly consistent reads; it does not rely on POSIX rename/fsync. PostgreSQL is an alternative disposable search index; pgvector and embeddings are optional. Both remote backends remain optional and never replace Markdown revisions and journal records as authority. ACLs protect MDB-mediated operations, not a privileged owner who can read local caches or database contents. Jobs and indexes can contain sensitive information and need the same OS protection as revisions.
