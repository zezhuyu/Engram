#!/usr/bin/env bash
set -euo pipefail

VM_DIR=${VM_DIR:-/Volumes/sambigdisk1/.tmp-engram-durability-vm}
QEMU=${QEMU:-qemu-system-aarch64}
VM_SSH_PORT=${VM_SSH_PORT:-2222}
SSH=(ssh -i "$VM_DIR/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$VM_SSH_PORT" root@127.0.0.1)
ROOT="$VM_DIR/alpine-root.qcow2"
DATA="$VM_DIR/engram-data.qcow2"
PID="$VM_DIR/powercut-qemu.pid"
RESULTS=${RESULTS:-"$(cd "$(dirname "$0")/.." && pwd)/vm-results.jsonl"}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$(dirname "$RESULTS")"
: > "$RESULTS"
: > "$VM_DIR/ack-ledger.jsonl"

boot() {
  "$QEMU" -name engram-durability-isolated -machine virt,accel=hvf -cpu host -smp 4 -m 4096 \
    -drive if=pflash,unit=0,format=raw,readonly=on,file="$VM_DIR/efi-code.fd" \
    -drive if=pflash,unit=1,format=raw,file="$VM_DIR/efi-vars.fd" \
    -drive if=none,file="$ROOT",format=qcow2,id=root -device virtio-blk-device,drive=root \
    -drive if=none,file="$DATA",format=qcow2,id=data -device virtio-blk-device,drive=data \
    -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$VM_SSH_PORT"-:22 -device virtio-net-device,netdev=net0 \
    -display none -serial file:"$VM_DIR/powercut-serial.log" -pidfile "$PID" -daemonize
  for _ in $(seq 1 180); do
    if "${SSH[@]}" 'true' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'VM did not become reachable' >&2; return 1
}

kill_vm() {
  if [[ -f "$PID" ]]; then
    local pid; pid=$(cat "$PID")
    kill -KILL "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep .1; done
    rm -f "$PID"
  fi
}
trap kill_vm EXIT

ack_ledger() {
  local line=$1
  node -e 'const fs=require("node:fs"); const fd=fs.openSync(process.argv[1],"a",0o600); fs.writeSync(fd,process.argv[2]+"\n"); fs.fsyncSync(fd); fs.closeSync(fd)' "$VM_DIR/ack-ledger.jsonl" "$line"
}

for stage in revision.temp_written journal.after_fsync commit.before_ack; do
  case_id=${stage//./_}
  boot
  "${SSH[@]}" 'mkdir -p /opt/engram/verification/durability/vm'
  scp -i "$VM_DIR/id_ed25519" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P "$VM_SSH_PORT" "$HERE/agent.mjs" root@127.0.0.1:/opt/engram/verification/durability/vm/agent.mjs
  "${SSH[@]}" "node /opt/engram/verification/durability/vm/agent.mjs prepare /mnt/engram/$case_id" > "$VM_DIR/prepare-$case_id.log"
  ack=$(sed -n 's/^ACK //p' "$VM_DIR/prepare-$case_id.log" | tail -1)
  [[ -n "$ack" ]] || { echo "missing acknowledged baseline for $stage" >&2; kill_vm; exit 1; }
  ack_ledger "{\"case\":\"$case_id\",\"ack\":$ack}"
  "${SSH[@]}" "nohup node /opt/engram/verification/durability/vm/agent.mjs cut /mnt/engram/$case_id $stage >/tmp/cut-$case_id.log 2>&1 </dev/null &" >/dev/null
  cut_seen=0
  for _ in $(seq 1 120); do
    if "${SSH[@]}" "grep -F 'CUT $stage' /tmp/cut-$case_id.log" >/dev/null 2>&1; then cut_seen=1; break; fi
    sleep .25
  done
  [[ $cut_seen -eq 1 ]] || { echo "cut point $stage not reached" >&2; kill_vm; exit 1; }
  kill_vm
  boot
  result=$("${SSH[@]}" "node /opt/engram/verification/durability/vm/agent.mjs recover /mnt/engram/$case_id" | sed -n 's/^RESULT //p' | tail -1)
  [[ -n "$result" ]] || { echo "missing recovery result for $stage" >&2; kill_vm; exit 1; }
  ack_survived=$(node -e 'const r=JSON.parse(process.argv[1]),a=JSON.parse(process.argv[2]);process.stdout.write(String(r.views.some(v=>v.id===a.id)))' "$result" "$ack")
  candidate_visible=$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.titles.includes("unacknowledged candidate")))' "$result")
  expected_candidate=false
  [[ "$stage" == "journal.after_fsync" || "$stage" == "commit.before_ack" ]] && expected_candidate=true
  [[ "$ack_survived" == true && "$candidate_visible" == "$expected_candidate" ]] || { echo "recovery outcome mismatch for $stage: ack=$ack_survived candidate=$candidate_visible expected=$expected_candidate" >&2; kill_vm; exit 1; }
  node -e 'const stage=process.argv[1],caseId=process.argv[2],ack=JSON.parse(process.argv[3]),result=JSON.parse(process.argv[4]); console.log(JSON.stringify({stage,case:caseId,acknowledgedBaseline:result.views.some(v=>v.id===ack.id),unacknowledgedCandidateVisible:result.titles.includes("unacknowledged candidate"),result}))' "$stage" "$case_id" "$ack" "$result" | tee -a "$RESULTS"
  kill_vm
done
