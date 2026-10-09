# Unix text interoperability

`mdb` provides native, bounded implementations of `cat head tail grep cut sort uniq wc tr paste comm diff find tree tee`, plus a controlled bridge to installed `jq` (and `gawk`/GNU `sed` when sandboxable). They are **not** wrappers around the system tools and they never start a shell. Supported options are listed below; anything else fails with a usage error (never ignored).

## Common behaviour
- **Input/output:** operands are `-` (stdin), `mdb:ID[@REV]` / `mdb://…` / bare `obj_…` (a vault object, read through the actor-bound Vault: ACLs apply, unreadable looks the same as missing, `@REV` pins a revision) and, for text tools only, local regular files. A local file inside a vault directory is refused (use `mdb:`), `cat` takes only vault objects and stdin.
- **Formats:** `--in auto|text|ndjson|json`, `--format auto|text|ndjson|json`. `auto` input is decided from the **first record only**: a JSON object with a string `text` field means NDJSON line rows, anything else is plain text. NDJSON rows keep their other fields through filters (`head`, `tail`, `grep`, `sort`, `uniq`, `cut`, `paste`…). Output `auto` = same format as the input. `json` is one array.
- **Delimiters:** `-z/--null` makes records NUL-delimited on input and output (`find -print0`).
- **Streaming:** `head`, `tail` (ring), `grep`, `cut`, `uniq`, `tr`, `paste`, `comm`, `cat`, `wc` stream; they stop reading when done and quietly exit when the reader closes the pipe. `sort`, `diff` buffer.
- **Determinism:** ordering is byte (code point) order, i.e. `LC_ALL=C`, with GNU's last-resort comparison; `sort -s` is stable. `find`/`tree` output is sorted by path. Same input, same bytes, every run.
- **Bounds** (override with environment): `MDB_UNIX_MAX_LINE_BYTES` (4 MiB), `MDB_UNIX_MAX_BUFFER_LINES` (1,000,000, for sort/diff/tail window), `MDB_UNIX_MAX_INPUT_BYTES` (2 GiB), `MDB_UNIX_DEADLINE_MS` (10 min). Exceeding one is an error (exit 1, 2 for grep/diff/comm/sort), never a silent truncation. `Ctrl-C`/deadline exit 130. There is no spill to disk.
- **Exit codes:** like the tools: `grep` 0 selected / 1 none / 2 error (with `-q` a match wins); `diff` 0 same / 1 differ / 2 trouble; `comm` and `sort -c` 1 on disorder; others 0 / 1 error.
- **Text assumptions:** UTF-8; invalid bytes become U+FFFD when a tool decodes lines (`cat`, `tee`, `head -c`, `tail -c` copy bytes unchanged). Regular expressions are JavaScript with POSIX BRE/ERE translation and the query engine's safety rules (no nested quantifiers, backreferences or lookaround; matched on the first 8 KiB of a line); use `-F` for anything else.

## Supported subsets
| Command | Options |
|---|---|
| `cat` | `-n -b -s -E`, `-` , `mdb:` operands; `--format ndjson` adds `documentId, revision, lineNumber, byteStart, byteEnd` |
| `head` | `-n N` (`-N`, `-n -N` all but last), `-c N` (`-c -N`), `-q -v`, `-z` |
| `tail` | `-n N` / `-n +N`, `-c N` / `-c +N`, `-q -v`, `-z` (`-f` refused: queries are snapshots) |
| `grep` | `-e -E -F -G -i -y -v -w -x -n -c -l -L -q -o -m -A -B -C -H -h -s -z`, multiple patterns, `--vault [--workspace W]` (index-backed search over the vault, output `path:line:text`). `-r` refused. |
| `cut` | `-b -c -f LIST -d -s --complement --output-delimiter -z` (`-c` counts code points) |
| `sort` | `-r -n -f -u -s -b -d -c -C -k F[.C][bdfnr][,F[.C]…] -t -z` (`-o -h -g -V -m` refused) |
| `uniq` | `-c -d -u -i -f N -s N -w N -z` (counts `%7d` like GNU) |
| `wc` | `-l -w -c -m -L` (GNU column widths) |
| `tr` | `-c -d -s -t`, ranges, `[:class:]`, `\n \t \ooo` escapes (stdin only, like tr) |
| `paste` | `-d LIST -s -z`, `-` shared across operands |
| `comm` | `-1 -2 -3 --check-order --nocheck-order --output-delimiter --total -i -z` |
| `diff` | normal and `-u/-U N`, `-q -s -i -w -b -B --label` (no timestamps in headers); `diff ID FROM TO` with three operands keeps its older meaning (vault revision diff). Edit scripts are minimal up to 3000 edits, correct but not minimal beyond. `-c`, `-y`, `-r` refused. |
| `find` | `[PATH…] -name -iname -path -ipath -title -ititle -type d\|f -kind -tag -updated-after -updated-before -mindepth -maxdepth -print -print0 -ls -not ! -a -o ( )`. Searches the **virtual** tree `/wiki /shared /discoveries /profile /workspaces/<ws>[/collections/<c>]/<id>.md` built from objects the actor can read. `-exec` refused. |
| `tree` | `[PATH] -L N -d -f -a -J --noreport --titles --charset ascii` |
| `tee` | `-a`, files only on the command line; refuses paths inside a vault (revisions are immutable) and symlinks; not available through MCP |

`grep` with one pattern and piped stdin, or any Unix-style flag, is Unix `grep`; `mdb grep TEXT [--scope …]` at a terminal or with search flags remains the index search. Use `mdb search` for the latter explicitly.

## Interoperability
- Pipe anything: `mdb find / -type f -print0 | xargs -0 -n1 mdb cat`, `mdb cat ID | awk …`, `mdb grep -n x mdb:ID --format ndjson | jq -r .text`.
- `mdb filter jq|awk|sed -- ARGS` runs an installed tool with an argument vector (no shell), scrubbed environment, a neutral working directory, stdin/stdout only, size and time limits. **jq** is allowed without file/module options; **awk** only if GNU awk (`--sandbox`) is installed; **sed** only if GNU sed (`--sandbox`) is installed. BSD awk/sed cannot be sandboxed and are refused; use `mdb query`, `mdb sed`, or your own shell pipeline. `mdb tools` reports what is installed and usable.
- MCP: `mdb_unix {command, args, input}` runs the same implementations in-process on a supplied string and `mdb:` operands: no local files, no `tee`, no filter bridge, output capped at 4 MB.

## Platforms
Pure Node (no platform calls). Parity tests compare against the installed system tools with `LC_ALL=C`; cases that only GNU tools define are recorded NOT_RUN when GNU tools are absent (macOS ships BSD). Linux: NOT_RUN in this repository's reports.
