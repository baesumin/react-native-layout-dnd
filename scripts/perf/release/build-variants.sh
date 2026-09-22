#!/bin/bash
# Build instrumented Release apps for the baseline commit and the candidate tree.
# Usage: scripts/perf/release/build-variants.sh <outDir> <baselineCommit>
# Uses the existing Release DerivedData for incremental builds; copies each .app
# and its bundle manifest aside. Restores the candidate sources at exit.
# Env: DND_SIM_UDID (defaults to the booted simulator), DND_DERIVED_DATA, DND_BUNDLE_WRAPPER.
set -u
UDID="${DND_SIM_UDID:-$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-]\{36\}\)) (Booted)/\1/p' | head -1)}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DERIVED="${DND_DERIVED_DATA:-/tmp/layout-dnd-native-release}"
WRAPPER="${DND_BUNDLE_WRAPPER:-/tmp/dnd-native-release-perf/bundle-wrapper.cjs}"
OUT="$1"; BASE_COMMIT="$2"
mkdir -p "$OUT/base" "$OUT/cand" "$OUT/src-base" "$OUT/src-cand"
cd "$REPO" || exit 1
FILES=$(git diff --name-only "$BASE_COMMIT" -- src; git ls-files --others --exclude-standard -- src)
for f in $FILES; do
  mkdir -p "$OUT/src-cand/$(dirname "$f")" "$OUT/src-base/$(dirname "$f")"
  [ -f "$f" ] && cp "$f" "$OUT/src-cand/$f"
  if git cat-file -e "$BASE_COMMIT:$f" 2>/dev/null; then git show "$BASE_COMMIT:$f" > "$OUT/src-base/$f"; fi
done
restore() {
  local variant="$1"
  for f in $FILES; do
    if [ -f "$OUT/src-$variant/$f" ]; then cp "$OUT/src-$variant/$f" "$f"; else rm -f "$f"; fi
  done
}
trap 'restore cand; echo "restored candidate sources $(date +%H:%M:%S)"; shasum -a 256 src/components/DndProvider.tsx src/components/SortableList.tsx src/engine/listIndex.ts src/gesture/DndGestureGroup.tsx src/gesture/DndGestureHost.tsx src/controller/dndSession.ts src/engine/layoutMove.ts example/src/ListExample.tsx' EXIT
build() {
  local variant="$1"
  restore "$variant"
  echo "== build $variant start $(date +%H:%M:%S) =="
  shasum -a 256 src/components/DndProvider.tsx src/components/SortableList.tsx src/engine/listIndex.ts src/gesture/DndGestureGroup.tsx src/gesture/DndGestureHost.tsx src/controller/dndSession.ts src/engine/layoutMove.ts example/src/ListExample.tsx > "$OUT/$variant/source-hashes.txt"
  xcodebuild -workspace example/ios/LayoutDndExample.xcworkspace -scheme LayoutDndExample \
    -configuration Release -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED" -jobs 4 CODE_SIGNING_ALLOWED=NO CLI_PATH="$WRAPPER" build \
    > "$OUT/$variant/xcodebuild.log" 2>&1
  local code=$?
  echo "== build $variant exit=$code $(date +%H:%M:%S) =="
  grep -E "BUILD SUCCEEDED|BUILD FAILED|error:" "$OUT/$variant/xcodebuild.log" | tail -5
  if [ $code -ne 0 ]; then return $code; fi
  rm -rf "$OUT/$variant/LayoutDndExample.app"
  cp -R "$DERIVED/Build/Products/Release-iphonesimulator/LayoutDndExample.app" "$OUT/$variant/LayoutDndExample.app"
  cp /tmp/dnd-native-release-perf/bundle-manifest.json "$OUT/$variant/bundle-manifest.json"
  shasum -a 256 "$OUT/$variant/LayoutDndExample.app/main.jsbundle" "$OUT/$variant/LayoutDndExample.app/LayoutDndExample" > "$OUT/$variant/app-hashes.txt"
  cat "$OUT/$variant/app-hashes.txt"
}
build cand || exit 1
build base || exit 1
echo "builds done $(date +%H:%M:%S)"
