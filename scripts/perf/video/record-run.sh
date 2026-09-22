#!/bin/zsh
# Record the booted simulator while the Debug UI-callback driver runs one scenario.
# Usage: scripts/perf/video/record-run.sh <outDir> <name> <Screen> <scenario> [extra trace.mjs args]
# Env: DND_SIM_UDID (booted simulator), DND_APP_ID. Metro must already serve the example.
# The example is terminated and relaunched first so every sample starts from the
# same order and scroll offset. Output: <outDir>/<name>.mp4, .json, .driver.log.
set -u
UDID="${DND_SIM_UDID:-booted}"
APP="${DND_APP_ID:-layoutdnd.example}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$1"; NAME="$2"; SCREEN="$3"; SCENARIO="$4"; shift 4
mkdir -p "$OUT"
cd "$REPO" || exit 1
xcrun simctl terminate "$UDID" "$APP" >/dev/null 2>&1
sleep 1
xcrun simctl launch "$UDID" "$APP" -RCT_enableDev YES -RCT_enableMinification NO >/dev/null 2>&1
sleep 4
xcrun simctl io "$UDID" recordVideo --codec h264 --force "$OUT/$NAME.mp4" > "$OUT/$NAME.rec.log" 2>&1 &
REC=$!
sleep 1.5
node scripts/perf/trace.mjs --screen "$SCREEN" --scenario "$SCENARIO" --trace false --output "$OUT/$NAME.json" "$@" > "$OUT/$NAME.driver.log" 2>&1
CODE=$?
sleep 1
kill -INT "$REC"
wait "$REC"
VALID=$(python3 -c "import json;d=json.load(open('$OUT/$NAME.json'));print(d['valid'], d['result']['assertions'].get('accepted'))" 2>/dev/null)
FRAMES=$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/$NAME.mp4" 2>/dev/null)
echo "$NAME $SCREEN $SCENARIO driver=$CODE valid/accepted=$VALID frames=$FRAMES"
exit $CODE
