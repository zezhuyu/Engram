# ADR 0006 — Native Unix text tools, no shell

Decision: implement the common Unix text filters natively over the same bounded record streams as the query engine instead of spawning system tools. Reasons: ACL-bound `mdb:` operands, identical behaviour on macOS and Linux, hard resource bounds, MCP exposure without process execution. Interop with installed tools happens through pipes and a narrow, sandbox-required bridge (jq, gawk --sandbox, GNU sed --sandbox) that never uses a shell. `find`/`tree` operate on a virtual tree derived from readable manifest entries. `tee` is the only command that writes files and it is CLI-only and refuses vault paths.
Consequences: documented subsets; GNU semantics where BSD differs; no spill; no external merge.
