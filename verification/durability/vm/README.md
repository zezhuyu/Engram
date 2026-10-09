# Disposable Linux durability VM

These scripts target the dedicated Alpine/QEMU VM and separate vault data disk prepared for this workstream. They do not use Docker Desktop. Do not point them at a shared or production VM.

## Prepared host and guest

Host prerequisites: macOS arm64, QEMU 11.1.2, Node.js, `ssh`, `scp`, and an isolated scratch directory. Guest prerequisites: Alpine Linux 3.24.2 ARM64 on an 8 GiB qcow2 root disk; a separate 2 GiB qcow2 ext4 data disk mounted at `/mnt/engram`; Node.js 24, npm, OpenSSH, `gcc`, `pkg-config`, `fuse3-dev`, and e2fsprogs. Root SSH is forwarded only to loopback. The guest SSH key, firmware variables, disks, and PID/log files live outside the repository in `/Volumes/sambigdisk1/.tmp-engram-durability-vm`.

Build Engram in the durability worktree, then copy the runtime into the guest once:

```sh
npm ci
npm run build
scp -i /Volumes/sambigdisk1/.tmp-engram-durability-vm/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P 2222 -r dist package.json package-lock.json root@127.0.0.1:/opt/engram/
ssh -i /Volumes/sambigdisk1/.tmp-engram-durability-vm/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 root@127.0.0.1 'cd /opt/engram && npm ci --omit=dev'
```

The guest must be powered off before either host runner starts. Each runner owns its QEMU process/PID and stops only that disposable guest. It does not stop Docker Desktop.

## VM power cuts

```sh
VM_SSH_PORT=2222 verification/durability/vm/run-powercuts.sh
```

The runner copies its guest agent, initializes each disposable vault, fsyncs a host acknowledgment-ledger row before the candidate operation, waits for a named fault callback, sends `SIGKILL` to the dedicated QEMU PID, reboots the same disks, and checks recovery, hashes, views, and idempotency. Results are written to `../vm-results.jsonl`; the acknowledgment ledger remains at the external scratch path and is copied to `../ack-ledger.jsonl` for evidence.

## Guest-kernel fsync error

```sh
VM_SSH_PORT=2222 verification/durability/vm/run-kernel-fsync-eio.sh
```

The runner compiles `fsync-eio.c` against guest libfuse, mounts a FUSE view over a disposable vault, returns `-EIO` for the journal file's FUSE `fsync` callback, and records the error received by Node's Linux `FileHandle.sync()` call. The kernel callback is controlled test instrumentation; it is not a hardware-generated device error. Structured evidence is written to `kernel-fsync-eio-result.json`.

## Evidence boundary

QEMU `SIGKILL` is a guest crash simulation. Qcow2 files are hosted by macOS APFS, so host memory and storage caches remain powered. The host acknowledgment ledger is outside the guest vault but resides on the same APFS device. These experiments do not test physical power removal, volatile controller/device cache loss, other filesystems, or hardware error rates.
