#!/bin/bash
# Interleaved A/B: swaps the changed library files between the baseline commit
# and the current candidate working tree, restarting the Debug app per sample.
# Usage: scripts/perf/interleave.sh <outDir> <baselineCommit> "<Screen scenario>" ...
# Env: DND_SIM_UDID, DND_APP_ID. Never run Jest, builds or HMR edits while it runs:
# it rewrites the changed src files in place and restores the candidate at exit.
# Order per scenario: base cand cand base base cand. Restores the candidate at exit.
set -u
UDID="${DND_SIM_UDID:-booted}"
APP="${DND_APP_ID:-layoutdnd.example}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$1"; shift
BASE_COMMIT="$1"; shift
mkdir -p "$OUT/base" "$OUT/cand"
cd "$REPO" || exit 1
# Files that differ between the baseline commit and the candidate tree.
FILES=$(git diff --name-only "$BASE_COMMIT" -- src; git ls-files --others --exclude-standard -- src)
echo "batch start $(date +%H:%M:%S) files:"; echo "$FILES"
for f in $FILES; do
  mkdir -p "$OUT/cand/$(dirname "$f")" "$OUT/base/$(dirname "$f")"
  [ -f "$f" ] && cp "$f" "$OUT/cand/$f"
  if git cat-file -e "$BASE_COMMIT:$f" 2>/dev/null; then git show "$BASE_COMMIT:$f" > "$OUT/base/$f"; fi
done
restore() {
  local variant="$1"
  for f in $FILES; do
    if [ -f "$OUT/$variant/$f" ]; then cp "$OUT/$variant/$f" "$f"; else rm -f "$f"; fi
  done
}
trap 'restore cand; echo "restored candidate $(date +%H:%M:%S)"; shasum -a 256 src/components/DndProvider.tsx src/components/SortableList.tsx' EXIT
run_one() {
  local variant="$1" screen="$2" scenario="$3" sample="$4"
  restore "$variant"
  sleep 3
  # Warm Metro's bundle for the exact URL the app requests.
  curl -s -o /dev/null 'http://localhost:8081/index.bundle//&platform=ios&dev=true&lazy=true&minify=false&inlineSourceMap=false&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server&app=layoutdnd.example'
  local base="$OUT/$screen-$scenario-$variant-$sample"
  local attempt
  for attempt in 1 2 3; do
    xcrun simctl terminate "$UDID" "$APP" >/dev/null 2>&1
    sleep 1
    xcrun simctl launch "$UDID" "$APP" -RCT_enableDev YES -RCT_enableMinification NO >/dev/null 2>&1
    sleep 3.5
    node scripts/perf/trace.mjs --screen "$screen" --scenario "$scenario" --trace false --output "$base.json" > "$base.log" 2>&1
    local code=$?
    if [ $code -eq 0 ]; then echo "$(date +%H:%M:%S) $variant $screen $scenario #$sample ok"; return 0; fi
    if grep -q "Expected one target\|CDP connection timed out\|fetch failed\|ECONNREFUSED\|Example tab unavailable\|Example is not ready" "$base.log"; then
      echo "$(date +%H:%M:%S) $variant $screen $scenario #$sample connect-retry ($attempt)"; continue
    fi
    echo "$(date +%H:%M:%S) $variant $screen $scenario #$sample FAILED (kept) exit=$code"; return $code
  done
  echo "$(date +%H:%M:%S) $variant $screen $scenario #$sample gave up connecting"; return 1
}
for pair in "$@"; do
  set -- $pair
  screen="$1"; scenario="$2"
  n=0
  for variant in base cand cand base base cand; do
    n=$((n+1))
    run_one "$variant" "$screen" "$scenario" "$n"
  done
done
echo "batch end $(date +%H:%M:%S)"
