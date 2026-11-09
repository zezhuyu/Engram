# Importing a Markdown wiki

`mdb wiki import` copies an existing Markdown wiki into two collections in one workspace. It reads the source directories and commits each accepted source or page through the normal Vault APIs. It never scans conversations, fetches URLs, calls a model, executes imported text, or modifies the source tree.

```sh
mdb wiki import --from ./wiki --raw ./raw --workspace project-wiki --label "migration 2026-11" [--max-bytes N]
mdb wiki import --from ./wiki --raw ./raw --workspace project-wiki --dry-run --json
mdb wiki import verify --from ./wiki --raw ./raw --workspace project-wiki --json
```

The default collections are `wiki` and `sources`; use `--wiki-collection` and `--sources-collection` to change them. `--label` is recorded with imported metadata. The raw tree is optional. Items are processed sequentially, with progress on stderr every 25 files. One file error is reported while processing continues; any error makes the command fail.

| Input | Engram representation |
|---|---|
| Regular file in `--raw` | `source` document in the sources collection, original bytes preserved by `vault.ingest`; relative path and SHA-256 are metadata. Duplicate basenames remain distinct by relative path. |
| Markdown file under `--from` | `wiki_page` in the wiki collection; original Markdown text (including frontmatter) stays in the body, and parsed frontmatter, original body, path and SHA-256 are also metadata. |
| `tags`, `category`, `type`, `status`, `summary`, `language`, `created`, `updated` | Tags/category become tags; status becomes status; remaining values are retained as metadata. Templates receive the `template` tag. All original frontmatter keys and values are kept in `originalFrontmatter`. |
| `sources`, `source`, `[[wiki links]]` | Resolvable citations and page links become document relations. URLs are never fetched. Unresolved references remain in metadata and are included in the report. |

Dotfiles, symlinks, non-Markdown wiki files, and raw files above the default 25 MiB size cap are skipped and reported. `--max-bytes` changes the source cap in bytes. Frontmatter is limited to 1 MiB; oversized frontmatter and unreadable/non-UTF-8 files remain errors or skips as appropriate. Missing frontmatter is accepted. If YAML parsing fails, the page is still imported with its complete original Markdown as the body, a title from its first H1 (or filename), the `unparsed-frontmatter` tag, bounded `frontmatterError` and raw frontmatter metadata, and a path/reason entry under `pages.warnings`. These warnings are counted separately from per-file errors. The import is owner-CLI only. Workspace and collections are created only when missing; existing grants are not changed.

Wiki links and embeds (`[[...]]` and `![[...]]`) resolve in this order: paths relative to the wiki directory (with or without `.md`); project-root paths prefixed by the wiki directory name (for example `wiki/pages/concepts/x`); a `pages/` path variant; a unique case-insensitive filename stem anywhere in the wiki; then a unique case-insensitive title from frontmatter or the first H1. Aliases after `|` and heading anchors after `#` are removed before lookup. Ambiguous matches are left unresolved and reported with reason `ambiguous`; placeholders containing `<` or `>` and the exact `wikilink` placeholder are counted under `placeholders` and remain listed as unresolved. The report's `wikiLinks` section includes resolved and unresolved entries plus ambiguous and placeholder counts.

When `--raw` is provided, a target beginning with the raw directory's basename (for example `raw/article` or `raw/article.md`) or with `<project-root>/<raw-directory>/` is also matched against imported source `importPath` values. Source paths are checked with and without `.md`, followed by a unique filename-stem match. These page-to-source links use the same `references` relation as frontmatter citations; a citation and one or more wiki links to the same source produce only one relation. A matching raw file that was not imported is unresolved with reason `source-not-imported`; unrelated dangling page links remain `unresolved`.

Each item carries an import key based on its relative path and content hash. Repeating an unchanged import does not add revisions unless its computed citations or wiki links differ from the stored relation set; those differences use the normal revision-checked patch operation and are counted as `pages.relinked`. Once link sets match, further runs add no revisions. A changed page patches its existing document with the current revision; changed source bytes are ingested as a new immutable source. Each file is its own commit, so a later failure can be resumed by rerunning the command. `--dry-run` does not write to the vault. `verify` compares source hashes against committed original bytes and page hashes against current files, and reports `pages.stale-links` when the stored relation set differs from the current resolver; it is read-only.

The report includes imported, unchanged, updated, skipped, unresolved/resolved references, errors, and elapsed time. SQLite and navigation are rebuildable derivatives; original files remain authoritative outside the vault until the owner retires them separately.
