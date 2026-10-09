#!/usr/bin/env sh
# Runs the Linux lanes in a container with GNU tools: ./ci/run-linux.sh [lane ...]   (default: unix query memory search platform)
set -eu
cd "$(dirname "$0")/.."
docker build -f ci/Dockerfile.linux -t engram-linux-ci .
lanes="${*:-unix query memory search platform}"
for lane in $lanes; do
  echo "== verify:$lane (linux, GNU tools)"
  docker run --rm engram-linux-ci sh -c "npm run verify:$lane && cat verification/$lane/report.md | head -20"
done
