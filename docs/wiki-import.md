# Importing and retiring a Markdown wiki

`mdb wiki import` imports a curated Markdown tree into the global `wiki` area by default. Each source tree must use its own lowercase namespace slug, so equal relative paths do not overwrite one another. Page and source documents live under `wiki/pages/<namespace>/` and `wiki/sources/manifests/<namespace>/`; `metadata.wikiNamespace` and namespace-prefixed `metadata.importPath` retain the source identity. `vault.ingest` keeps the exact source bytes under immutable originals.

```sh
mdb wiki import --from ./kb/wiki --raw ./kb/raw --target wiki --namespace kb --label "migration 2026-11"
mdb wiki import --from ./aegis/wiki --raw ./aegis/raw --target wiki --namespace aegiswealth
mdb wiki import --from ./strata/wiki --raw ./strata/raw --target wiki --namespace stratamind
mdb wiki import --from ./kb/wiki --raw ./kb/raw --target wiki --namespace kb --dry-run --json
mdb wiki import verify --from ./kb/wiki --raw ./kb/raw --target wiki --namespace kb --json
```

For backward compatibility, `mdb wiki import --workspace project-wiki ...` still imports into the `wiki` and `sources` collections of that workspace. `--target workspace --workspace NAME` is equivalent. Global imports require `--namespace`; only lowercase slugs containing lowercase letters, digits, and single hyphens are accepted.

Imported originals are always ingested byte-for-byte. Page Markdown (including frontmatter) stays intact in the body. Parsed frontmatter is metadata; citations and wiki links become Vault relations. A link resolves against the current namespace first and only; it cannot silently bind to a same-named page from another imported tree. Source links keep their existing raw-tree resolution behavior. URLs are never fetched and document content is untrusted data.

Global pages without an explicit status default to `accepted` only for owner-curated imports. Explicit frontmatter status is preserved. Pages marked with model-generation provenance (`generatedBy`, `generated_by`, `model`, `modelName`, `model_name`, or `provenance: model`) default to `candidate` and record `importProvenance: compiled-from-model`. No review rule is bypassed; imported pages enter the normal searchable wiki only when their stored status is eligible. Workspace-target imports retain their previous `active` default.

`verify` is read-only. It reports page/source counts, source SHA-256 mismatches against the source tree and stored immutable originals, stale links, and resolution totals. An unchanged second import creates no revisions. Each changed import remains resumable at file boundaries.

## Retiring a previous workspace copy

After importing and verifying one old workspace into the global namespace with the same name, take a backup, then preview retirement:

```sh
mdb wiki retire-workspace --workspace kb --into-wiki-verified --dry-run
mdb wiki retire-workspace --workspace kb --into-wiki-verified [--allow-leftovers]
```

The command verifies every imported source and wiki page against the same relative path in `wikiNamespace: kb`. Source files are checked against immutable original bytes. For pages it compares the importer's `metadata.importSha256`, which records the original file bytes even if link resolution changed the stored page text. Missing or mismatched counterparts fail closed. The report lists verified/unverified counts and offending paths. Unimported workspace documents are reported as leftovers and block retirement unless `--allow-leftovers` is explicitly supplied; they are never deleted. A dry run performs all checks and lists intended tombstones without changing the journal or workspace metadata.

After successful retirement, the workspace metadata contains `retired: true` and it is omitted from normal workspace lists used by dashboard pickers and agent enumeration. Its documents and history remain readable to actors who explicitly request that workspace. Restore through the same command:

```sh
mdb wiki retire-workspace --workspace kb --restore
# equivalent shorthand
mdb wiki retire-workspace --restore kb
```

Restore creates normal Vault restore revisions for the retired imported documents and clears the marker. The reserved `personal` workspace cannot be retired.

Restore any retired object from its prior revision with the normal versioned restore command:

```sh
mdb restore OBJECT_ID PRIOR_REVISION_ID --revision TOMBSTONE_REVISION_ID
```

SQLite, indexes, and navigation remain disposable derivatives. The controller should retire the existing `kb`, `aegiswealth`, and `stratamind` workspaces only after taking a real-vault backup and running a successful global import plus `verify` for each namespace. This tool does not perform that live migration or remove workspace directories.

For the imported-then-retired `kb`, `aegiswealth`, and `stratamind` workspaces, `mdb workspace reactivate NAME` clears only the retired marker so the workspace can hold ongoing project notes again. It does not restore the tombstoned imported copies; their history remains available, and `wiki retire-workspace --restore` can still restore those documents later. Reactivation is owner-only and is recorded in the workspace-retirement audit log.
