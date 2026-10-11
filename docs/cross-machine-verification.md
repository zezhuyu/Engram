# Cross-machine remote capture verification (runbook)

Status of the REMOTE_CAPTURE gate: **INCOMPLETE**. Everything below the physical-network line has passed on one machine (`verification/memory/remote-real-host-evaluation.json`). The steps here must be run on separate physical hosts and have **not** been run. Loopback, containers on one host and simulated networks do not count.

## Topology
- Host A: Engram HTTP MCP server, vault root `/srv/engram`, TLS terminated by Caddy (`deploy/Caddyfile`) with a certificate the clients verify (public CA, or a private CA installed in the clients' trust store; never `NODE_TLS_REJECT_UNAUTHORIZED=0`).
- Host B: Claude Code with credential `claude-b`.
- Host C: Codex with credential `codex-c`. With only two hosts, run both clients on Host B in separate project directories and `HOME`s.

## Procedure
1. Host A: `MDB_MCP_TRANSPORT=http MDB_MCP_HTTP_HOST=127.0.0.1 MDB_MCP_HTTP_PORT=3333 node bin/mdb-mcp.js --root /srv/engram`, Caddy in front. From B and C: `openssl s_client -connect HOST:443 -verify_return_error` and record the chain.
2. Host A: `mdb credential create --root /srv/engram --actor claude-b --permissions workspace:proj:read,workspace:proj:write --json` and the same for `codex-c` with its own workspace scope; create registrations (`docs/memory.md`).
3. Hosts B/C: `mdb memory adapter install ... --mcp-url https://HOST/mcp --token-env ENGRAM_TOKEN` per client; `mdb memory adapter status --host claude-code|codex`.
4. Run a real task in each client with no memory-writing instruction. Confirm observations arrive (`mdb memory timeline --root /srv/engram`) attributed to the correct actor.
5. Cut the network between B/C and A (firewall rule on A or unplug); keep working in both clients; confirm fail-open and a bounded spool (inspect the spool directory and `mdb memory adapter status`).
6. Restart the server on A during the outage; restore connectivity; `mdb memory drain-remote --token-env ENGRAM_TOKEN`. Expect exactly one committed record per idempotency key, and session-end handoffs delivered.
7. Replay a duplicated and reordered spool copy; confirm no duplicate commits and the journal verifies (`mdb verify --root /srv/engram`).
8. Revoke `claude-b` on A; confirm its next delivery is refused (401) and stays queued; issue a new credential, reinstall, confirm delivery resumes. Kill and restart the client process with events queued; confirm they drain.
9. Record host roles, addresses, certificate chain, event ids, acknowledgements, and any scenario not run in `verification/memory/cross-machine-report.md`.

Codex `Stop` is not required; use `SessionEnd` or the equivalent finalization the host mode emits.

## Isolated-container tier (runs without physical hosts)
`npm run verify:xhost` builds `ci/xhost/Dockerfile`, creates a dedicated Docker network (`xhost-net`, containers labelled `engram-xhost=1`; only those are ever removed), starts xhost-a (server + TLS), xhost-b and xhost-c, and executes all 14 scenarios, writing `verification/memory/xhost/` and `verification/memory/cross-machine-report.md`. It needs Docker and about five minutes. This is reported as its own tier and does not replace the physical-host run above. Set `XHOST_KEEP=1` to leave the containers up for debugging.


## Physical-host kit (the only way REMOTE_CAPTURE can pass)

`REMOTE_CAPTURE` is computed by `npm run verify:release`: it passes only when the container tier is green **and** `verification/memory/physical-hosts.json` says `physicalHostVerified: true`. That file is produced by `scripts/xhost/physical.mjs merge` from reports written on real, separate machines; the merge refuses a single machine, containers, a missing machine id, duplicated or lost events, an unreached step, or a step that was NOT_RUN.

On the server machine (Engram HTTP MCP behind a CA-verifiable TLS certificate, workspace + credential + registration created as in `docs/memory.md`):

```sh
node scripts/xhost/physical.mjs server --root /srv/engram --run-id RUNID   # after the clients finished
```

On each client machine (a different physical host; `--cut`/`--restore` are commands you supply that really interrupt and restore this machine's path to the server, e.g. a firewall rule; `--restart-server` optionally restarts the server during the outage):

```sh
ENGRAM_TOKEN=... node scripts/xhost/physical.mjs client --url https://HOST/mcp --registration REG --token-env ENGRAM_TOKEN \
  --run-id RUNID --cut 'sudo pfctl -f /etc/pf.block.conf -e' --restore 'sudo pfctl -d' [--restart-server 'ssh server sudo systemctl restart engram']
```

Copy the client and server JSON files to one place and run `node scripts/xhost/physical.mjs merge client.json [client2.json] server.json`. Revocation/reissue and client-process-kill scenarios stay with the container harness; the physical kit covers TLS verification, unauthorized rejection, online delivery, interruption, offline buffering and fail-open, duplicate/reordered replay, restoration and drain with exactly-once commit. Nothing here has been run on physical hosts yet; the acceptance rule itself is unit-tested (`tests/memory/physical-merge.test.ts`).

## Blocker recorded
No second or third physical host is configured or authorized for this session (no SSH hosts in `~/.ssh/config`; the only reachable machine is the development workstation). Nothing was connected to without authorization.
