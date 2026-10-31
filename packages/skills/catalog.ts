export const skillCatalog = {
  "memory-recall": {
    "name": "memory-recall",
    "description": "Recall authorized agent memories with lexical retrieval.",
    "mode": "query",
    "origin": "mdb-native"
  },
  "memory-write": {
    "name": "memory-write",
    "description": "Save an explicit authored memory as a versioned MDB object.",
    "mode": "write",
    "origin": "mdb-native"
  },
  "context-handoff": {
    "name": "context-handoff",
    "description": "Retrieve context or close an explicit session for an agent handoff.",
    "mode": "handoff",
    "origin": "mdb-native"
  },
  "source-ingestion": {
    "name": "source-ingestion",
    "description": "Preserve an explicitly selected local source in MDB.",
    "mode": "ingest",
    "origin": "mdb-native"
  },
  "wiki-maintenance": {
    "name": "wiki-maintenance",
    "description": "Resolve supplied deterministic lint findings on one targeted wiki page.",
    "mode": "wiki",
    "origin": "mdb-native"
  },
  "profile-update": {
    "name": "profile-update",
    "description": "Propose evidence-backed user profile revisions.",
    "mode": "profile",
    "origin": "mdb-native"
  },
  "insight-extraction": {
    "name": "insight-extraction",
    "description": "Propose reusable evidence-backed insights from selected memories.",
    "mode": "memory",
    "origin": "mdb-native"
  },
  "retrospective": {
    "name": "retrospective",
    "description": "Propose a task reflection from explicit evidence.",
    "mode": "reflect",
    "origin": "mdb-native"
  },
  "dream-discovery": {
    "name": "dream-discovery",
    "description": "Propose a reviewed cross-domain hypothesis from authorized evidence.",
    "mode": "dream",
    "origin": "mdb-native"
  },
  "knowledge-promotion": {
    "name": "knowledge-promotion",
    "description": "Prepare explicitly reviewed sanitized knowledge promotion.",
    "mode": "promotion",
    "origin": "mdb-native"
  },
  "index-audit": {
    "name": "index-audit",
    "description": "Audit authorized document evidence and navigation.",
    "mode": "audit",
    "origin": "mdb-native"
  },
  "knowledge-critique": {
    "name": "knowledge-critique",
    "description": "Check accessible claims for evidence and unresolved references.",
    "mode": "audit",
    "origin": "mdb-native"
  },
  "cross-linker": {
    "name": "cross-linker",
    "description": "Propose reviewed links between authorized wiki documents.",
    "mode": "wiki",
    "origin": "kb-adapted"
  },
  "creator-batch-wiki": {
    "name": "creator-batch-wiki",
    "description": "Describe availability of explicit creator source capture.",
    "mode": "unavailable",
    "origin": "kb-adapted"
  },
  "download-source": {
    "name": "download-source",
    "description": "Report availability of external source download adapters.",
    "mode": "unavailable",
    "origin": "kb-adapted"
  },
  "transcribe-media": {
    "name": "transcribe-media",
    "description": "Report availability of media transcription adapters.",
    "mode": "unavailable",
    "origin": "kb-adapted"
  },
  "convert-to-markdown": {
    "name": "convert-to-markdown",
    "description": "Report availability of binary conversion and OCR adapters.",
    "mode": "unavailable",
    "origin": "kb-adapted"
  },
  "codex-history-ingest": {
    "name": "codex-history-ingest",
    "description": "Import an explicitly selected Codex export with capture consent.",
    "mode": "capture-ingest",
    "origin": "kb-adapted"
  },
  "claude-history-ingest": {
    "name": "claude-history-ingest",
    "description": "Import an explicitly selected Claude export with capture consent.",
    "mode": "capture-ingest",
    "origin": "kb-adapted"
  },
  "wiki-history-ingest": {
    "name": "wiki-history-ingest",
    "description": "Import an explicit agent history export with capture consent.",
    "mode": "capture-ingest",
    "origin": "kb-adapted"
  },
  "data-ingest": {
    "name": "data-ingest",
    "description": "Preserve a selected exported data file as an immutable MDB source.",
    "mode": "ingest",
    "origin": "kb-adapted"
  },
  "ingest-source": {
    "name": "ingest-source",
    "description": "Preserve a selected local source for evidence-backed MDB synthesis.",
    "mode": "ingest",
    "origin": "kb-adapted"
  },
  "wiki-ingest": {
    "name": "wiki-ingest",
    "description": "Preserve a local source before reviewed wiki compilation.",
    "mode": "ingest",
    "origin": "kb-adapted"
  },
  "wiki-page-compiler": {
    "name": "wiki-page-compiler",
    "description": "Propose wiki pages from authorized immutable source revisions.",
    "mode": "wiki",
    "origin": "kb-adapted"
  },
  "wiki-update": {
    "name": "wiki-update",
    "description": "Propose an evidence-backed revision of MDB wiki knowledge.",
    "mode": "wiki",
    "origin": "kb-adapted"
  },
  "wiki-query": {
    "name": "wiki-query",
    "description": "Retrieve grounded knowledge from authorized MDB documents.",
    "mode": "query",
    "origin": "kb-adapted"
  },
  "wiki-lint": {
    "name": "wiki-lint",
    "description": "Audit accessible wiki evidence and object references.",
    "mode": "audit",
    "origin": "kb-adapted"
  },
  "wiki-status": {
    "name": "wiki-status",
    "description": "Report authorized MDB contents and capabilities.",
    "mode": "status",
    "origin": "kb-adapted"
  },
  "wiki-setup": {
    "name": "wiki-setup",
    "description": "Rebuild disposable navigation for an initialized MDB vault.",
    "mode": "rebuild",
    "origin": "kb-adapted"
  },
  "wiki-rebuild": {
    "name": "wiki-rebuild",
    "description": "Rebuild disposable indexes without losing canonical knowledge.",
    "mode": "rebuild",
    "origin": "kb-adapted"
  },
  "wiki-export": {
    "name": "wiki-export",
    "description": "Return an ACL-filtered structured document export.",
    "mode": "export",
    "origin": "kb-adapted"
  },
  "prune-old-content": {
    "name": "prune-old-content",
    "description": "Explain retention limits for immutable MDB source evidence.",
    "mode": "unavailable",
    "origin": "kb-adapted"
  },
  "tag-taxonomy": {
    "name": "tag-taxonomy",
    "description": "Propose reviewed normalization of knowledge tags.",
    "mode": "wiki",
    "origin": "kb-adapted"
  },
  "llm-wiki": {
    "name": "llm-wiki",
    "description": "Explain and inspect the MDB knowledge workflow and capabilities.",
    "mode": "status",
    "origin": "kb-adapted"
  }
} as const;
