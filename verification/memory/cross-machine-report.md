# Cross-machine remote capture report

Generated 2026-10-09T17:04:48.314Z by `node scripts/xhost/run.mjs` (Docker 29.7.2).

**Tier: ISOLATED_CONTAINERS. Physical separate hosts: NOT_RUN.** Containers on one machine are isolated filesystems, process and network namespaces with real TLS, but they are not physical cross-machine deployment and do not satisfy that requirement.

## Topology

- Network `xhost-net` 172.31.77.0/24 (dedicated user-defined bridge, labelled engram-xhost=1)
- xhost-a 172.31.77.10
- xhost-b 172.31.77.11
- xhost-c 172.31.77.12
- xhost-a: Engram HTTP MCP bound to 127.0.0.1:3333, TLS terminator on 8443 (valid), 8444 (certificate from a rogue CA), 8445 (certificate for another host name). test CA (ECDSA P-256), node TLS terminator -> loopback HTTP upstream
- xhost-b: Claude Code adapter role, credential `claude-b` scoped to workspace ws-b. xhost-c: Codex adapter role, credential `codex-c` scoped to ws-c.
- Hooks are the commands the adapters install, fed real-format lifecycle payloads. The live Claude Code and Codex binaries are not run here (single-machine live evidence: remote-real-host-evaluation.json).

## Scenario matrix

| # | Expected behaviour | Procedure | Result | Checks |
|---|---|---|---|---|
| 1 | Each client initializes remote capture using supported lifecycle hooks | Install adapter on B/C; hooks for SessionStart, UserPromptSubmit, PostToolUse, SessionEnd use https and carry no token | PASS | 6/6 |
| 2 | Both clients generate meaningful memory events without memory-writing instructions | Replay real-format lifecycle payloads through the installed hook command; no explicit record call | PASS | 4/4 |
| 3 | Both clients deliver observations over TLS | openssl chain + hostname verification; rogue CA, wrong host, no-CA and plain HTTP refused | PASS | 9/9 |
| 4 | Interrupt network access between clients and server | `docker network disconnect` for B and C; probe fails | PASS | 1/1 |
| 5 | Continue operating both agents while disconnected | Hooks keep exiting 0 inside the 5 s hook timeout | PASS | 1/1 |
| 6 | Bounded local buffering and fail-open behaviour | 1100 concurrent hooks against a 1000-entry cap; all exit 0 | PASS | 3/3 |
| 7 | Restart the server while clients remain active | Kill and restart the server process while clients are offline | PASS | 3/3 |
| 8 | Restore connectivity | `docker network connect`; drain to zero | PASS | 1/1 |
| 9 | Exactly-once observable ingestion using idempotency keys | Unique event ids; each buffered envelope committed once | PASS | 3/3 |
| 10 | Session-end handoffs generated while disconnected are eventually delivered | SessionEnd delivered, sessions closed, HANDOFF jobs queued (no model run here) | PASS | 2/2 |
| 11 | Actor attribution and workspace permissions | createdBy/scope per event; cross-registration use returns 404 (X3b) | PASS | 3/3 |
| 12 | Duplicate, reordered and replayed events cannot corrupt committed memory | Reversed spool + duplicated envelopes; later replay of delivered envelopes; journal verify | PASS | 2/2 |
| 13 | Revoked credentials cannot resume delivery until reauthenticated | Revoke, 401, events retained, new credential drains them once | PASS | 6/6 |
| 14 | Client process restarts while events remain queued | SIGKILL the client container mid-write, restart, drain | PASS | 4/4 |

## All checks

### X1 Each client initializes remote capture with the supported lifecycle hooks — PASS

- PASS: client b init exited 0 ("")
- PASS: client b registered SessionStart/UserPromptSubmit/PostToolUse/SessionEnd hooks (["SessionStart","UserPromptSubmit","PostToolUse","SessionEnd"])
- PASS: client b hook commands use https remote URL and carry no token
- PASS: client c init exited 0 ("")
- PASS: client c registered SessionStart/UserPromptSubmit/PostToolUse/SessionEnd hooks (["SessionStart","UserPromptSubmit","PostToolUse","SessionEnd"])
- PASS: client c hook commands use https remote URL and carry no token

### X2 Both clients generate meaningful memory events without any memory-writing instruction — PASS

- PASS: Claude-role prompt and tool result arrived with original content (2)
- PASS: Codex-role prompt and tool result arrived with original content
- PASS: client spools drained to zero after online delivery
- PASS: every committed event has host, eventId and server-assigned actor (provenance)

### X3 Authenticated TLS transport: certificate verification and refusal of untrusted paths — PASS

- PASS: client b verifies the server chain and host name over TLS 1.2+ (["subject=CN = xhost-a","issuer=CN = xhost test CA","Verification: OK","New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384"])
- PASS: client c verifies the server chain and host name over TLS 1.2+ (["subject=CN = xhost-a","issuer=CN = xhost test CA","Verification: OK","New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384"])
- PASS: certificate from an untrusted (rogue) CA is refused ({"error":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"})
- PASS: certificate for the wrong host name is refused ({"error":"ERR_TLS_CERT_ALTNAME_INVALID"})
- PASS: a client without the CA does not trust the server (no verification bypass) ({"error":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"})
- PASS: the plain-HTTP upstream (loopback only) is not reachable from another host ({"error":"ECONNREFUSED"})
- PASS: client refuses a non-HTTPS remote URL and still fails open (exit 0, nothing queued, nothing sent in clear)

### X3b Unauthorized connections are rejected — PASS

- PASS: missing and unknown bearer tokens get 401 ({"noTok":{"status":401},"badTok":{"status":401}})
- PASS: a credential cannot use another actor's capture registration (404)

### X4-X8 Network interruption, offline operation, bounded buffering, server restart, restoration — PASS

- PASS: X4: clients are disconnected from the server network ({"error":"EAI_AGAIN"})
- PASS: X5/X6: hooks stay silent, exit 0 and finish inside the 5 s hook timeout while disconnected (fail-open) ([197,196,198,207,200,204,198,198])
- PASS: X6: events were durably buffered on each client ({"b":4,"c":4})
- PASS: X6: 1100 concurrent hook invocations all exited 0 while the spool was full (fail-open)
- PASS: X6: local buffer is bounded at the 1000-entry cap under concurrent writers ({"spoolEntries":1000})
- PASS: X12: client C spool reversed and three envelopes duplicated ("7 written, 4 originals")
- PASS: X7: server process is really down (loopback upstream refuses)
- PASS: X7: server process restarted and answers (401 without token)
- PASS: X7/X8: server restarted while clients were offline; connectivity restored and TLS endpoint answers
- PASS: X8: both client buffers drain to zero after restoration ({"dB":{"delivered":100,"queued":0},"dC":{"delivered":7,"queued":0}})
- PASS: X9: every committed event id is unique (no double commits) ({"events":1006})
- PASS: X9: each buffered fill event is committed exactly once ({"committed":996,"bufferedFillEnvelopes":996})
- PASS: X9/X12: duplicated and reordered offline events each appear exactly once ({"c2":1,"c3":1})
- PASS: X10: SessionEnd events generated while disconnected were delivered and closed both remote sessions ([{"id":"obj_mv17rhnt_361ca981929d48edbec4b028e3900bf5","createdBy":"claude-b","scope":{"type":"workspace","workspaceId":"ws-b"}},{"id":"obj_mv17ri4r_db0104e9b2254729b9ea695fbb67ed10","createdBy":"codex-c","scope":{"type":"workspace","worksp)
- PASS: X10: delivery of those SessionEnd events queued handoff generation on the server (no model was run in this harness) ({"handoffJobs":2})
- PASS: X12: committed journal verifies after duplicate/reordered/outage delivery ({"ok":true,"issues":[],"objects":1012})

### X11 Actor attribution and workspace permissions — PASS

- PASS: events land only in the credential owner’s workspace
- PASS: no cross-workspace writes by either actor
- PASS: no event is attributed to anything but the two credentialed actors

### X12b Replay of already delivered envelopes cannot corrupt committed memory — PASS

- PASS: server spool fully committed before replay ({"queued":0,"dropped":0,"rejected":0})
- PASS: replaying three delivered envelopes is accepted by the server but commits nothing new ({"delivered":3,"before":1006,"after":1006})
- PASS: journal still verifies after replay

### X13 Revoked credentials cannot resume delivery until reauthenticated — PASS

- PASS: credential revoked on the server ("")
- PASS: the revoked token is refused immediately (401) ({"status":401})
- PASS: client keeps working (fail-open) and retains the 3 undeliverable events ({"spool":3})
- PASS: draining with the revoked token delivers nothing ({"delivered":0,"queued":3})
- PASS: the old token still delivers nothing after a new credential exists
- PASS: with the newly issued credential the retained events are delivered exactly once ({"delivered":3})

### X14 Client process/container crash and restart with events still queued — PASS

- PASS: X14: receiver is down while the client keeps queueing
- PASS: after SIGKILL of the whole client container mid-write, buffered envelopes survive and none is corrupt (stray .tmp files are ignored) ({"good":27,"bad":0,"tmp":"0"})
- PASS: after restart the survivors drain and each is committed exactly once ({"buffered":27,"committed":27})
- PASS: final committed state is consistent: journal verifies

### X-final Final state consistency after all recoveries — PASS

- PASS: unique event ids, verified journal, empty server-side spool ({"events":1036,"serverSpool":{"queued":0,"dropped":0,"rejected":0}})

### OBS Failure reporting and observability — PARTIAL

- PASS: observed: hooks are silent by design (stdout empty, exit 0); the client-visible signal is spool depth; the server exposes committed events, journal verification and its spool stats; the client has no retry timer or backoff — delivery is attempted on each hook and on explicit drain-remote (each attempt bounded to 2 s and 100 files)
- NOT_RUN: NOT_RUN: physical separate hosts, real network paths, iptables DROP (hanging connections), clock skew, packet loss: not reproducible with containers on one machine

## Raw evidence

`verification/memory/xhost/results.json`, `verification/memory/xhost/raw/` (openssl output, drain results, server state, server log tail). Bearer tokens are redacted.
