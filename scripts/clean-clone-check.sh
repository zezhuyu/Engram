#!/bin/sh
# Proves the verification commands work from a CLEAN CLONE of the repository (no local state, no untracked files).
#   scripts/clean-clone-check.sh            clone HEAD exactly as committed
#   scripts/clean-clone-check.sh --overlay  also copy the working tree's uncommitted and untracked files that are not ignored into the clone
#                                           (use BEFORE committing to see what the commit must contain; rerun without --overlay afterwards)
# Needs: git, node >= 22.13, npm, network access for `npm ci`. Writes under $CLEAN_CLONE_PARENT (default: the repository's parent directory; never $TMPDIR); prints one line per step and a summary; exit code 0 only if every step passed.
set -u
SRC=$(git rev-parse --show-toplevel) || exit 2; OVERLAY=0; [ "${1:-}" = "--overlay" ] && OVERLAY=1
# The clone must NOT live under $TMPDIR: several tests assert that a temp-directory location grants no trust (release-evidence guards) and exercise watcher processes that treat temp paths specially, so a checkout inside $TMPDIR changes their outcome. Default: a hidden sibling directory of the repository.
PARENT=${CLEAN_CLONE_PARENT:-$(dirname "$SRC")}; WORK=$(mktemp -d "$PARENT/.tmp-engram-clean-clone-XXXXXX") || exit 2; REPORT="$WORK/steps.tsv"; : > "$REPORT"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"; }; trap cleanup EXIT
git clone --quiet --no-hardlinks "$SRC" "$WORK/repo" || exit 2; cd "$WORK/repo" || exit 2
if [ "$OVERLAY" = "1" ]; then
  # Untracked-but-not-ignored files plus every modified tracked file (staged or not): exactly what a `git add -A` of non-ignored files would commit.
  ( cd "$SRC" && { git ls-files --others --exclude-standard; git diff --name-only HEAD; } ) | sort -u | while IFS= read -r f; do
    [ -f "$SRC/$f" ] && mkdir -p "$(dirname "$f")" && cp -p "$SRC/$f" "$f"; done
fi
step() { name=$1; shift; start=$(date +%s); "$@" > "$WORK/$name.log" 2>&1; code=$?; secs=$(( $(date +%s) - start )); printf '%s\t%s\t%s\n' "$name" "$code" "$secs" >> "$REPORT"; printf '%-34s exit=%s %ss\n' "$name" "$code" "$secs"; return 0; }
need() { for f in "$@"; do [ -e "$f" ] || { echo "MISSING $f"; return 1; }; done; }
step required-files need package.json package-lock.json tsconfig.json bin/mdb.js bin/mdb-mcp.js scripts/lint.mjs scripts/lib/suite.ts scripts/verify-release.ts scripts/benchmark.ts scripts/benchmark-query.ts scripts/benchmark-durable-write.ts scripts/verify-scheduler-e2e.ts scripts/verify-launchd-e2e.mjs scripts/competitive/run.mjs scripts/competitive/lib.mjs fixtures/inputs/release-matrix.json fixtures/inputs/profile/labeled-corpus.json fixtures/inputs/dream/labeled-scenarios.json
step npm-ci npm ci --no-audit --no-fund
step build npm run build
step lint npm run lint
step unit-tests npm test
step benchmark-build-1k node dist/scripts/benchmark.js build --size 1000 --retain --root "$WORK/bench1k"
step benchmark-replay-1k node dist/scripts/benchmark.js replay --root "$WORK/bench1k" --runs 3 --warmups 1 --output-dir "$WORK/bench1k-out"
for suite in acid security search intelligence recovery memory profile wiki dream adaptive query unix platform; do step "verify-$suite" npm run "verify:$suite"; done
step suite-inventory npm run verify:suite-inventory
step verify-release npm run verify:release
echo; awk -F'\t' '{ n++; if ($2 != 0) bad++ } END { printf "%d steps, %d failed\n", n, bad }' "$REPORT"
bad=$(awk -F'\t' '$2 != 0 { c++ } END { print c+0 }' "$REPORT"); if [ "$bad" != "0" ]; then echo "logs kept in $WORK (KEEP=1 not needed on failure)"; KEEP=1; trap - EXIT; fi
[ "$bad" = "0" ]
