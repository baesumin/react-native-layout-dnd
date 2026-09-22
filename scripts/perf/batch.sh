#!/bin/bash
# Debug UI-callback driver batch. Restarts the example app before each sample.
# Usage: scripts/perf/batch.sh <outDir> <samples> <trace true|false> "<Screen scenario>" ...
# Env: DND_SIM_UDID (booted simulator), DND_APP_ID. Metro must already serve the example.
set -u
UDID="${DND_SIM_UDID:-booted}"
APP="${DND_APP_ID:-layoutdnd.example}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$1"; shift
SAMPLES="$1"; shift
TRACE="$1"; shift
mkdir -p "$OUT"
cd "$REPO" || exit 1
echo "batch start $(date +%H:%M:%S) out=$OUT samples=$SAMPLES trace=$TRACE"
shasum -a 256 src/components/DndProvider.tsx src/components/SortableList.tsx src/gesture/DndGestureGroup.tsx src/gesture/DndGestureHost.tsx scripts/perf/runtime.js > "$OUT/source-hashes.txt"
run_one() {
  local screen="$1" scenario="$2" sample="$3"
  local base="$OUT/$screen-$scenario-$sample"
  local attempt
  for attempt in 1 2 3; do
    xcrun simctl terminate "$UDID" "$APP" >/dev/null 2>&1
    sleep 1
    xcrun simctl launch "$UDID" "$APP" -RCT_enableDev YES -RCT_enableMinification NO >/dev/null 2>&1
    sleep 3.5
    node scripts/perf/trace.mjs --screen "$screen" --scenario "$scenario" --trace "$TRACE" --output "$base.json" > "$base.log" 2>&1
    local code=$?
    if [ $code -eq 0 ]; then
      echo "$(date +%H:%M:%S) $screen $scenario #$sample ok"
      return 0
    fi
    # Retry only when the driver never connected (app not ready). A failed scenario is kept.
    if grep -q "Expected one target\|CDP connection timed out\|fetch failed\|ECONNREFUSED\|Example tab unavailable\|Example is not ready" "$base.log"; then
      echo "$(date +%H:%M:%S) $screen $scenario #$sample connect-retry ($attempt)"
      continue
    fi
    echo "$(date +%H:%M:%S) $screen $scenario #$sample FAILED (kept) exit=$code"
    return $code
  done
  echo "$(date +%H:%M:%S) $screen $scenario #$sample gave up connecting"
  return 1
}
for pair in "$@"; do
  set -- $pair
  screen="$1"; scenario="$2"
  for sample in $(seq 1 "$SAMPLES"); do
    run_one "$screen" "$scenario" "$sample"
  done
done
echo "batch end $(date +%H:%M:%S)"
