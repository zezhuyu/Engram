#!/usr/bin/env bash
set -euo pipefail

VM_DIR=${VM_DIR:-/Volumes/sambigdisk1/.tmp-engram-durability-vm}
VM_SSH_PORT=${VM_SSH_PORT:-2222}
QEMU=${QEMU:-qemu-system-aarch64}
HERE=$(cd "$(dirname "$0")" && pwd)
SSH=(ssh -i "$VM_DIR/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$VM_SSH_PORT" root@127.0.0.1)
PID="$VM_DIR/fsync-eio-qemu.pid"
OUT=${OUT:-"$HERE/kernel-fsync-eio-result.json"}

"$QEMU" -name engram-fsync-eio-isolated -machine virt,accel=hvf -cpu host -smp 4 -m 4096 \
  -drive if=pflash,unit=0,format=raw,readonly=on,file="$VM_DIR/efi-code.fd" \
  -drive if=pflash,unit=1,format=raw,file="$VM_DIR/efi-vars.fd" \
  -drive if=none,file="$VM_DIR/alpine-root.qcow2",format=qcow2,id=root -device virtio-blk-device,drive=root \
  -drive if=none,file="$VM_DIR/engram-data.qcow2",format=qcow2,id=data -device virtio-blk-device,drive=data \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$VM_SSH_PORT"-:22 -device virtio-net-device,netdev=net0 \
  -display none -serial file:"$VM_DIR/fsync-eio-serial.log" -pidfile "$PID" -daemonize
cleanup() {
  if [[ -f "$PID" ]]; then
    local pid; pid=$(cat "$PID"); kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep .1; done
    kill -KILL "$pid" 2>/dev/null || true; rm -f "$PID"
  fi
}
trap cleanup EXIT
for _ in $(seq 1 180); do "${SSH[@]}" true >/dev/null 2>&1 && break; sleep 1; done
"${SSH[@]}" true >/dev/null
"${SSH[@]}" 'modprobe fuse; test -c /dev/fuse || mknod /dev/fuse c 10 229; chmod 666 /dev/fuse; mkdir -p /opt/engram/verification/durability/vm /mnt/engram/eio-backing /mnt/engram/eio-view'
scp -i "$VM_DIR/id_ed25519" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P "$VM_SSH_PORT" "$HERE/fsync-eio.c" root@127.0.0.1:/opt/engram/verification/durability/vm/fsync-eio.c
"${SSH[@]}" 'cd /opt/engram/verification/durability/vm && gcc -Wall -Wextra -O2 fsync-eio.c $(pkg-config fuse3 --cflags --libs) -o fsync-eio'

remote_result=$("${SSH[@]}" 'set -e
  rm -rf /mnt/engram/eio-backing /mnt/engram/eio-view
  mkdir -p /mnt/engram/eio-backing /mnt/engram/eio-view
  node --input-type=module -e '\''import {Vault} from "/opt/engram/dist/packages/core/vault.js"; await new Vault("/mnt/engram/eio-backing").init({sqlite:false})'\''
  FUSE_EIO_MATCH=commits.jsonl /opt/engram/verification/durability/vm/fsync-eio /mnt/engram/eio-backing /mnt/engram/eio-view -f >/tmp/fsync-eio-fuse.log 2>&1 &
  for i in $(seq 1 100); do mountpoint -q /mnt/engram/eio-view && break; sleep .1; done
  mountpoint -q /mnt/engram/eio-view
  set +e
  node --input-type=module -e '\''import {Vault} from "/opt/engram/dist/packages/core/vault.js"; const v=new Vault("/mnt/engram/eio-view"); try { console.log("INIT_START"); await v.init({sqlite:false}); console.log("INIT_OK"); await v.put({scope:{type:"global",area:"wiki"},kind:"note",title:"fsync EIO candidate",body:"test"}); console.log("PUT_ACK") } catch(e) { console.log("PUT_ERROR "+(e.code||e.name)+" "+e.message+" "+e.stack); }'\'' >/tmp/fsync-eio-node.log 2>&1
  node_status=$?
  set -e
  fusermount3 -u /mnt/engram/eio-view
  node --input-type=module -e '\''import {Vault} from "/opt/engram/dist/packages/core/vault.js"; const v=new Vault("/mnt/engram/eio-backing"); const r=await v.recover(); const q=await v.verify(); const d=await v.listDocuments(); console.log(JSON.stringify({recovery:r,verify:q.ok,titles:d.map(x=>x.title)}))'\'' >/tmp/fsync-eio-recovery.log
  node --input-type=module -e '\''import fs from "node:fs"; const nodeLog=fs.readFileSync("/tmp/fsync-eio-node.log","utf8"); const recovery=JSON.parse(fs.readFileSync("/tmp/fsync-eio-recovery.log","utf8")); const callback=fs.readFileSync("/tmp/fsync-eio-fuse.log","utf8").includes("INJECT_KERNEL_FSYNC_EIO"); const result={kernelFsyncError:(nodeLog.match(/PUT_ERROR ([A-Z0-9]+)/)||[])[1]||"NONE",fuseKernelCallbackReturnedEIO:callback,recovery}; console.log("JSON_RESULT "+JSON.stringify(result));'\''
  test "$node_status" -eq 0
')
printf '%s\n' "$remote_result" | sed -n 's/^JSON_RESULT //p' > "$OUT"
cat "$OUT"
grep -q '"kernelFsyncError":"EIO"' "$OUT"
grep -q '"fuseKernelCallbackReturnedEIO":true' "$OUT"
grep -q '"verify":true' "$OUT"
