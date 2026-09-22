#!/bin/bash
# Run the Debug perf/functional driver against the Android emulator app.
# Usage: scripts/perf/android/batch.sh <outDir> <metroTargetTitle> "<Screen scenario>" ...
set -u
ADB="${ANDROID_ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$1"; shift
TARGET="$1"; shift
mkdir -p "$OUT"
cd "$REPO" || exit 1
for pair in "$@"; do
  set -- $pair
  screen="$1"; scenario="$2"
  base="$OUT/$screen-$scenario-1"
  for attempt in 1 2 3; do
    "$ADB" shell am force-stop layoutdnd.example >/dev/null 2>&1
    sleep 1
    "$ADB" shell am start -n layoutdnd.example/.MainActivity >/dev/null 2>&1
    sleep 6
    node scripts/perf/trace.mjs --screen "$screen" --scenario "$scenario" --trace false --target "$TARGET" --output "$base.json" > "$base.log" 2>&1
    code=$?
    if [ $code -eq 0 ]; then echo "$(date +%H:%M:%S) android $screen $scenario ok"; break; fi
    if grep -q "Expected one target\|CDP connection timed out\|fetch failed\|ECONNREFUSED\|Example tab unavailable\|Example is not ready" "$base.log"; then
      echo "$(date +%H:%M:%S) android $screen $scenario connect-retry ($attempt)"; continue
    fi
    echo "$(date +%H:%M:%S) android $screen $scenario FAILED (kept) exit=$code"; break
  done
done
echo "android batch end $(date +%H:%M:%S)"
