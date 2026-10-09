# Unix text interoperability: cat head tail grep cut sort uniq wc tr paste comm diff find tree tee + filter bridge

**Status: PASS** — 15/17 tests passed, 0 failed, 2 skipped; 139 recorded cases, 0 case failures.

Run at 2026-10-09T15:08:34.575Z, 17.4 s. Commit: no-git-repository.
Environment: Darwin 25.0.0 (arm64), tmp filesystem apfs, Node v25.8.2, SQLite 3.53.4, Apple M2 Max.
Seeds: none (deterministic)

Reproduce: `npm run build && node --test --test-reporter=tap dist/tests/unix/parity.test.js dist/tests/unix/features.test.js dist/tests/unix/sandbox.test.js`

## Tests

| Status | Test |
|---|---|
| PASS | formats: NDJSON rows keep their metadata through filters; auto-detection uses the first record only; JSON arrays work; bad input is an error |
| PASS | null-delimited records: -z on every record tool, and find -print0 |
| PASS | streaming and bounds: head stops reading (SIGPIPE-like), tail is a ring, sort/line/deadline limits are errors not hangs |
| PASS | exit codes follow the tools: grep 0/1/2, diff 0/1/2, comm and sort -c report disorder with 1, usage errors never look like success |
| PASS | vault operands: access control, pinned revisions, and local files inside a vault are refused |
| PASS | find and tree: deterministic, ACL-bound virtual tree; -print0; predicates; ndjson |
| PASS | grep --vault uses the text index and respects ACLs; cat/find ids chain into each other |
| PASS | tee: copies stdin to stdout and files; never writes inside a vault, never follows symlinks, not available through MCP |
| PASS | interoperability: installed jq / awk / sed consume our output; the bridge runs only sandboxable tools with an argument vector |
| PASS | MCP mdb_unix: same results as the CLI, bound to the host identity, no local files, bounded output |
| PASS | legacy meanings keep working: grep TEXT is still the index search, diff ID FROM TO is still the revision diff |
| PASS | GNU tools are present where the CI requires them |
| PASS | Unix command parity with the installed system tools |
| PASS | required tools are present on the Linux lane |
| SKIPPED | awk: gawk --sandbox runs programs but cannot run commands, redirect, pipe, or read program files |
| SKIPPED | sed: GNU sed --sandbox runs scripts but cannot execute, read or write files |
| PASS | the bridge never uses a shell: metacharacters in arguments are data |

## Not verified

| Status | Item | Reason |
|---|---|---|
| UNSUPPORTED | External-merge sort / spill | sort, diff and comm checks hold at most MDB_UNIX_MAX_BUFFER_LINES lines and fail with an error instead of spilling. |
| UNSUPPORTED | Locales and byte-exact non-UTF-8 data | Text tools assume UTF-8 and C-locale (byte/code point) ordering; invalid UTF-8 is replaced when a tool decodes lines (cat and tee copy bytes unchanged). |
| UNSUPPORTED | tail -f, grep -r, sort -o, diff -c, find -exec | Refused on purpose: no following, no recursion on the local file system, no output files other than tee, no command execution. |

## Limitations

- The macOS run classifies only the gawk/GNU sed dependent cases as expected skips; `MDB_REQUIRE_GNU=1 npm run verify:unix` passed 17/17 tests in Linux with gawk and GNU sed (verification/unix/gnu-report.json).
- Where BSD and GNU differ the documented subset follows GNU semantics and the test normalizes or excludes the BSD quirk (see tests/unix/parity.test.ts).
- find/tree operate on a virtual tree built from the vault metadata, not on files on disk.
