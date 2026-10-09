# Investigation: writer-lock fairness

**Finding (before):** waiters polled `mkdir` every 10 ms with no ordering. Under CPU oversubscription plus 50 writers, 7 of ~300 operations exceeded the 10 s deadline and failed with `CONFLICT: Vault writer is busy` (starvation, not deadlock).

**Change:** the exclusive `mkdir` is unchanged, but contenders first take a timestamped ticket in `.mdb/locks/queue` and only the oldest live ticket may attempt the `mkdir` (FIFO). Waiters heartbeat their ticket every poll; tickets of dead processes (`kill -0`) or silent ones (>2 s without heartbeat, e.g. a SIGSTOPped process) are removed by whoever notices. Polling uses small jittered backoff (4→25 ms). Stale-lock detection and the guarded reclaim are unchanged. Tickets are ephemeral coordination files and are intentionally not fsynced; no durable state or commit ordering changed. `MDB_LOCK_TIMEOUT_MS` overrides the 10 s default.

**Evidence** (`tests/isolation/lock-fairness.test.ts`, lane `verify:acid`): 60 contenders all acquire with no contender overtaken by one that arrived >400 ms later; 40 contenders under 2× CPU-core busy processes: zero timeouts; a SIGKILLed waiter, a SIGSTOPped waiter and a SIGKILLed lock holder do not block the queue; the previous stale-lock, 50-process and fault-matrix tests still pass.

**Limits:** FIFO order is by wall-clock ticket time with process-start jitter, so near-simultaneous arrivals can swap. A frozen *holder* (SIGSTOP) still blocks everyone until the timeout, because its PID is alive. PID reuse can make a dead holder look alive. One vault-wide writer lock remains; there is no per-workspace write parallelism. Not tested on Linux or network filesystems.
