# Native performance reproduction

This diagnostic uses the example's development runtime through Metro CDP. It
uses React Native `Tracing.start/end`, React commit timestamps and JS
`requestAnimationFrame` gaps. It adds no dependency and does not replace
coordinator methods or prototypes.

Start Metro and the example on the intended simulator, then run from the repo:

```sh
node scripts/perf/trace.mjs --screen Lists --scenario idle --output /tmp/lists-idle.json
node scripts/perf/trace.mjs --screen Lists --scenario scroll --output /tmp/lists-scroll.json
node scripts/perf/trace.mjs --screen FlatList --scenario scroll --output /tmp/flatlist-scroll.json
node scripts/perf/trace.mjs --screen FlatList --scenario scroll --trace false --output /tmp/flatlist-scroll-no-trace.json
node scripts/perf/trace.mjs --screen FlatList --scenario drag --output /tmp/flatlist-drag.json
node scripts/perf/trace.mjs --screen FlatList --scenario edge-drop --output /tmp/flatlist-edge.json
node scripts/perf/trace.mjs --screen FlatList --scenario source-unmount --output /tmp/flatlist-unmount.json
node scripts/perf/summarize.mjs /tmp/flatlist-scroll.json /tmp/flatlist-drag.json --top 20
node scripts/perf/summarize.mjs /tmp/flatlist-scroll.json --match 'Dnd|List|Gesture'
node --test scripts/perf/metrics.test.mjs
```

Use `--target` to select another exact substring of the CDP target title. The
default is `iPhone 17 Pro Max`; ambiguous matches fail. Installed project
dependencies supply Babel, Worklets and Metro's `ws` package.

`--trace true` is the default. `--trace false` skips `Tracing.start/end` while
keeping the same driver, stage boundaries, validation, React commit counter and
JS rAF monitor. Compare these two modes separately: tracing can add substantial
`reportMeasure`, `createTask` and related instrumentation work. The JSON records
the mode; an untraced sample has no CPU profile events.

## Interpretation

- Static warmup and initial virtualization finish before tracing. For drag
  scenarios, activation happens after tracing and JS/React monitors start, so
  its initialization cost remains visible.
- Scroll requests and drag updates run on UI frames. Drag scenarios call actual
  gesture callbacks; they do **not** test touch recognition or long-press timing.
- `activation`, `drag`, `source-unmount`, `settle` and `drop` have separate timestamped
  intervals. Activation verifies matching native/session ownership, then waits
  for the first JS frame; this includes the initial blocked-frame gap. The
  verification poll interval is 20 ms. Other frame gaps crossing an interval
  boundary are excluded from its summary.
- `jsRafOverlapping*` additionally reports whole JS frame gaps intersecting each
  stage, including its boundaries. Observation continues through the first JS
  frame after UI completion, so a blocked JS thread cannot hide an entire drop
  behind zero within-stage samples. An overlapping gap can include time outside
  the stage and appear in multiple stages; do not add these counts or attribute
  its whole duration exclusively to one stage.
- A result is valid only when required scrolling, activation, update count,
  accepted revision and native/session cleanup checks pass. Source-unmount also
  requires the original native cell to become unmeasurable before release. It
  jumps eight viewports, moves the pointer above the list, waits up to 5000 ms to
  observe that loss, moves the pointer to the viewport center to stop auto-scroll,
  and waits another 1800 ms before releasing at the center. With committed slots
  the jump alone carries the source slot out of the window; leaving the list also
  reverts a candidate-order display, so the fallback mode unmounts it too.
  Failure to observe the original cell disappear invalidates the run.
  `edge-drop` keeps continuous edge scrolling through release.
- `validationTimeline` records UI ownership, pointer and list scroll offsets at
  the jump, observed source loss, centering and release. `releasePointer`,
  `scrollOffsetsAtRelease` and `sourceSettleMs` summarize the release conditions;
  `activity.publications` records the coordinator's target validation alongside
  them. Console warning/error events remain in `warnings`; CLI and summary
  output disclose their count, including expected native measurement warnings.
- `traceEvents` can be opened with Perfetto/Chrome tracing. `ProfileChunk`
  events contain sampled JavaScript call stacks. JS rAF gaps are **not FPS**.
- `scenarioValid` reports behavioral assertions separately from `metricValid`.
  Overall `valid` requires both. A self-scheduled JS rAF chain is rejected if
  it has 32 consecutive intervals below 1 ms, or exceeds 240 callbacks/s over
  at least 250 ms with most intervals below 2 ms. Invalid/backward timestamps,
  interleaved callback chains and a changed scheduling function are also
  rejected. Ordinary 60/120/240 Hz cadence, isolated short callbacks and long
  blocked intervals remain eligible. These are sampling sanity checks, not a
  display refresh-rate or smoothness measurement.
- The live monitor stops rescheduling after 32 consecutive sub-millisecond
  intervals, keeping a runaway timer chain from adding thousands of callbacks.
  Scenario execution and cleanup continue. `activity.monitor` records the
  stop reason, scheduler function description and runtime flags; raw intervals
  retain the rAF callback timestamp. Monitor generations prevent old callbacks
  from joining a newer capture. No application timer is replaced or throttled.
- The summarizer applies cadence checks to older raw artifacts too, retaining
  their `recordedValid` value and exposing the corrected `valid`/`metricValid`.
  Invalid rAF timing and over-budget summaries become `null`; sample counts and
  raw observations remain available for diagnosis. Exclude these captures from
  performance comparisons even when their scenario assertions passed, because
  excessive monitoring can itself change the workload. Raw input files are not
  rewritten.
- The summarizer weights CPU samples by their trace time deltas. Recursive
  function names count once per sample in inclusive totals. These overlapping
  totals cannot be added together; functions sharing a name are grouped, with
  their number of source locations reported. CPU rankings cover the whole
  trace, while React/RAF statistics retain the separately measured stages.
- Legacy `/tmp/dnd-trace-*.json` files are readable, but their missing stage and
  validity checks are identified explicitly. Do not equate their whole-capture
  timings with the new stage measurements.
- Runtime adapters inspect React fibers and original worklet closures. When
  internal structure changes, missing references fail explicitly. Update the
  adapter and rerun both sides of a comparison.

## Scenario notes (2026-09-18)

- `source-unmount` jumps the FlatList eight viewports and then moves the pointer
  above the list (inside the Provider root) before waiting for
  `measure(sourceRef) === null`. While the target stays inside the list the
  dragged item's cell rides along at its candidate slot and never leaves the
  window, so the previous version of this scenario only passed through the
  transient `target: null` publication that the layout-version race produced.
  Checkpoints: `source-scroll-jump`, `pointer-outside`, `source-unmounted`,
  `pointer-centered`. Stress values from before this change are not comparable.
- The driver recognizes both per-handle gesture owner fibers and the shared
  relation-group recognizer (`channel.targets`), and reports which in
  `adapter.gestureOwners`.

## Batches, interleaved comparisons and CPU attribution

`batch.sh` restarts the example before every sample and runs one scenario
list; `table.mjs` prints per-run validity, warnings and stage gaps plus medians
per scenario. `interleave.sh` alternates the files that differ between a
baseline commit and the working tree (`base cand cand base base cand` per
scenario), restarts the app per sample, records each run's source hashes and
restores the working tree at exit; `compare.mjs` groups its output by variant.
Never run Jest, builds or HMR edits while `interleave.sh` runs: it rewrites
`src` in place. `attribute.mjs` reads a `--trace true` artifact and attributes
one function's inclusive samples to its ancestor stacks, immediate callers or
anonymous bundle locations.

```sh
scripts/perf/batch.sh /tmp/dnd-p0 3 false "FlatList source-unmount" "FlatList edge-drop" "Lists drag"
node scripts/perf/table.mjs /tmp/dnd-p0
scripts/perf/interleave.sh /tmp/dnd-ab <baseline-commit> "FlatList source-unmount" "FlatList edge-drop"
node scripts/perf/compare.mjs /tmp/dnd-ab
node scripts/perf/attribute.mjs /tmp/dnd-p0-trace/FlatList-source-unmount-1.json --stacks runOnUISync --depth 10
node scripts/perf/attribute.mjs /tmp/dnd-p0-trace/FlatList-source-unmount-1.json --stacks createSerializable --top 20
node scripts/perf/attribute.mjs /tmp/dnd-p0-trace/FlatList-source-unmount-1.json --anon
```

`DND_SIM_UDID` and `DND_APP_ID` select the booted simulator and app; the
defaults are the iPhone 17 Pro Max used in the recorded measurements. Metro must
already serve the example and the installed app must be the Debug build.
Interleaving does not remove run-to-run drift; compare medians together with
every per-run value, and keep invalid or warning-bearing runs in the record.

## Fair comparisons

Restart the example before **each** sample so layout, scroll offsets and item
order match. Use the same device, app build, Metro mode, scenario, warmup,
duration and update count. Close other profilers and avoid HMR during samples.
Keep the `--trace` setting identical when comparing implementation versions.
Collect at least three runs of each version and compare medians plus the full
distribution. Keep invalid samples and their errors, but exclude them from
performance claims. JSON includes source/runtime hashes and the target title.

Development traces include diagnostic and React development overhead. Verify
touch behavior separately and measure release builds on a physical device before
claiming display-frame performance. The runner cancels an unfinished diagnostic
gesture on failure; it does not restart the simulator or reset example data.

## Release touch measurement scripts

`scripts/perf/release/` holds the runners used for the local Release
comparisons. They depend on two artifacts that live outside the repository and
were created by an earlier session: the bundle wrapper plus JS rAF observer and
collector in `/tmp/dnd-native-release-perf/` (`bundle-wrapper.cjs`,
`observer.js`, `collect.mjs`) and the XCUITest touch harness in
`/tmp/layout-dnd-touch-harness/` (see its README for the fixtures, including
`testFlatListLongEdgeDrag`). Set `DND_DEBUG_APP` to the built Debug `.app`, and
override `DND_SIM_UDID`, `DND_XCTESTRUN`, `DND_BUNDLE_MANIFEST`,
`DND_DERIVED_DATA` and `DND_BUNDLE_WRAPPER` when your paths differ. Without
`DND_SIM_UDID` the scripts use the booted simulator.

```sh
# Build instrumented Release apps for the baseline commit (base/) and the tree (cand/).
scripts/perf/release/build-variants.sh /tmp/dnd-release <baseline-commit>
# Interleave installs and XCTest runs according to a plan; variants are directory names.
node scripts/perf/release/touch-ab.mjs /tmp/dnd-release /tmp/dnd-release-ab scripts/perf/release/plan.example.json
node scripts/perf/release/summary.mjs /tmp/dnd-release-ab
```

Each run's `<name>.json.log` keeps the xcodebuild output, including the
`DND_TOUCH_INFO` line with the first and last visible task after the drop, which
shows how far the auto-scroll travelled. The observer also records
`metadata.longGaps` (JS gaps over 30 ms with the last instrumented function)
when an experiment build exposes `globalThis.__dndTimings`; production builds do
not define it.

## Screen-recording pop check (2026-09-18)

JS rAF gaps cannot see a card drawn at the wrong place for one frame. The
`scripts/perf/video/` scripts record the simulator while the Debug driver runs
and then track card edges frame by frame:

```sh
scripts/perf/video/record-run.sh /tmp/dnd-video base-edge1 FlatList edge-drop
python3 scripts/perf/video/pops.py /tmp/dnd-video/base-edge1.mp4
python3 scripts/perf/video/sheet.py /tmp/dnd-video/base-edge1.mp4 170,171,172,173 /tmp/dnd-video/pop.png
```

`record-run.sh` restarts the example before recording so every sample starts
from the same order and offset; it needs `ffprobe` for the frame count.
`pops.py` (ffmpeg + Pillow) extracts one vertical strip, classifies the example's
list, card and preview colors along a text-free column of the FlatList example
on the iPhone 17 Pro Max (3x defaults; pass `--x/--top/--bottom` for other
layouts), matches card edges between consecutive frames by mutual nearest
neighbour and reports edges that leave the frame's scroll delta by one slot
(150–450 px). A structural pop appears as a pair: one frame away, next frame
back. The example tints its drag copy (`PREVIEW_COLOR`) so the preview never
matches a list cell. The check is a lower bound: a card hidden behind the
preview is not tracked, and recordings run at roughly 60 fps. Compare variants
with the same procedure and confirm flagged frames on a contact sheet before
counting them; the drop settlement can legitimately move a card that far in a
long frame.

## Android emulator runs

`scripts/perf/android/boot-install.sh <log>` boots the `DND_AVD` AVD (`Medium_Phone` by default), installs
`example/android/app/build/outputs/apk/debug/app-debug.apk`, runs `adb reverse tcp:8081`
and prints Metro's inspector targets. `scripts/perf/android/batch.sh <outDir>
sdk_gphone64_arm64 "FlatList scroll" ...` then drives the same scenarios through
`trace.mjs --target <title>`, restarting the app with `am force-stop`/`am start` per
sample. The Debug APK loads the JS bundle from Metro, so library changes need no
rebuild; native dependency changes do. These runs are functional (`valid`,
`scenarioValid`) rather than timing references: the emulator is not a device and
runs a Debug bundle.
