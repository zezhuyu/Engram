# Internal agent skills

Engram ships 34 discoverable, bounded skills: all 22 requested KB workflows adapted to MDB, plus the implementation guide’s 12 native memory/intelligence skills. They are available to the internal agent through the SDK registry, CLI, and MCP, independent of Codex App discovery.

Canonical active instructions live in `skills/<name>/SKILL.md`. `listSkills()` returns their names, descriptions, operational modes, provenance and instructions; `getSkill(name)` loads one. `runSkill(name, input, {vault, search, intelligence})` invokes only a fixed built-in dispatch table with the host’s actor-bound services. `SkillRegistry` exposes equivalent list/get/execute methods. Skill inputs cannot replace actor identity or grants; no instruction text is evaluated as code and no subprocess or legacy script is spawned.

```bash
mdb skill list
mdb skill get wiki-page-compiler
mdb skill run memory-recall --input recall.json
```

An explicit local source import uses `{ "path": "/path/to/selected.md", "scope": { "type": "workspace", "workspaceId": "research" } }`. `memory-write` uses the same scope plus `title`, `body`, and an optional authored-note kind. Search uses `query` and optional `scopes`, metadata filters and mode. Source import preserves bytes; it does not imply that conversion or compilation has happened.

Semantic jobs require `scope` and a nonempty `objectIds` array selecting accessible evidence; the intelligence engine rechecks evidence before assembling provider context. Jobs remain queued proposals, never accepted writes. `semanticExecutionAvailable=false` means no provider is attached. An explicit intelligence run with no provider reports blocked/unavailable, while deterministic indexing works. Accept semantic output only through the intelligence review operation; every accepted derivative retains revision evidence. Promotion additionally requires `objectId`, a global target `scope`, `sanitizedBody`, and `review:true`, and goes through Vault’s distinct promotion permission.

History adapters require an explicitly selected export file, `captureConsent:true`, and `captureSource` present in an enabled capture allowlist. They never scan `~/.codex`, `~/.claude`, or any conversation directory. Prepare/redact the selected export before importing it; the immutable-source contract preserves its selected bytes rather than modifying the export. Automatic lifecycle observations have separate redaction in the intelligence engine.

## Operational capabilities

| Skills | Implemented operation / limitation |
|---|---|
| `memory-recall`, `wiki-query` | ACL-filtered lexical retrieval with exact revision references |
| `memory-write` | Versioned explicit authored notes/observations/working memory; semantic knowledge kinds rejected |
| `context-handoff` | Close an explicit session or retrieve an explicit query; no silent history capture |
| `source-ingestion`, `ingest-source`, `wiki-ingest`, `data-ingest` | Explicit local-file immutable source import; text/Markdown native, binaries preserved attachments |
| `codex-history-ingest`, `claude-history-ingest`, `wiki-history-ingest` | Explicit consent + configured source allowlist + selected export import |
| `wiki-maintenance`, `wiki-page-compiler`, `wiki-update`, `cross-linker`, `tag-taxonomy` | Reviewed wiki proposal queue; provider required for semantic execution |
| `profile-update` | Evidence-backed profile proposal queue; provider required |
| `insight-extraction` | Evidence-backed memory proposal queue; provider required |
| `retrospective` | Reflection proposal queue; provider required |
| `dream-discovery` | Hypothesis proposal queue; provider and explicit dream configuration required |
| `knowledge-promotion` | Explicitly reviewed sanitized derivative through Vault promotion ACL |
| `index-audit`, `knowledge-critique`, `wiki-lint` | Deterministic accessible-evidence audit; does not establish semantic truth or perform model critique |
| `wiki-status`, `llm-wiki` | Authorized document counts and honest capability report |
| `wiki-setup`, `wiki-rebuild` | Disposable navigation/search rebuild on an initialized vault; no destructive reset |
| `wiki-export` | ACL-filtered structured export returned to trusted host; no arbitrary destination writes |
| `download-source`, `creator-batch-wiki` | Unavailable: no integrated URL downloader or creator discovery/network adapter |
| `convert-to-markdown`, `transcribe-media` | Unavailable: no integrated PDF/HTML/OCR/ASR conversion provider |
| `prune-old-content` | Unavailable: no automatic age-based deletion of immutable canonical evidence |

Knowledge critique here checks deterministic evidence resolution only. Tag normalization, link recommendation, synthesis and dreaming need a provider; the retained upstream tools are not functional MDB integrations. An authorized host may prepare extracted text externally, then import it and create a separately reviewed derivative with exact source evidence.

## KB preservation and installation

All upstream skill folders and supporting scripts were copied byte-for-byte from `/Volumes/sambigdisk3/KB/.skills` to `skills/upstream-kb/`. `skills/upstream-manifest.json` records source paths and SHA-256 hashes; tests verify every retained file. Upstream licensing was not specified; these are local user-provided reference assets and no redistribution rights are asserted.

Upstream assets retain historical `raw/`, `.content/`, QMD and direct wiki-file scripts. They are deliberately excluded from discovery and dispatch. The active instructions use MDB’s scoped, versioned operations; imported sources and immutable revisions are never edited. No KB knowledge corpus was copied, only the requested skills/assets.

This execution sandbox marks `.codex` as read-only and rejected creation of `.codex/skills`. Native Codex directory installation is therefore not performed. Internal registry/CLI/MCP discovery works from `skills/`; a host with write access can install repository-relative symlinks from `.codex/skills/<name>` to `../../skills/<name>`. Never install `upstream-kb` as active skills.
