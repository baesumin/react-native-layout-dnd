# Shared contracts and grid API

This describes the step 2 shared contracts and existing grid API. The subsequent
[list and scroll API](list-scroll-api.md) implements `DndProvider`, `SortableList`,
`DragHandle`, and `useDndState` with ScrollView and optional FlatList adapters.
The [shared grid/list API](mixed-layout-api.md) adds `SortableGrid` and atomic
list/grid transfers to the same provider. Native verification remains required
first-release work. The grid API below remains available separately.

## Grid state

```tsx
import {
  GridController,
  GridZoneView,
  GridDragHandle,
  useGridState,
} from 'react-native-layout-dnd';

function Board() {
  const { value, onChange, setValue } = useGridState(initialValue);
  // Use setValue(valueOrUpdater) for external edits; it advances revision.
  return (
    <GridController
      value={value}
      onChange={onChange}
      renderItem={args => (
        <GridDragHandle itemId={args.item.id}>
          <Card {...args} />
        </GridDragHandle>
      )}
    >
      <GridZoneView zoneId="board" geometry={geometry} style={boardStyle} />
    </GridController>
  );
}
```

`GridDragHandle` forwards `HandleViewProps` (`accessible`, `accessibilityLabel`,
`accessibilityHint`, `accessibilityRole`, `accessibilityState`,
`accessibilityActions`, `onAccessibilityAction`, `importantForAccessibility`,
`testID`) to its native view, like the shared `DragHandle`; it sets no defaults.
Reduced motion follows `motion.reduceMotion` (see [Defaults and presentation](#defaults-and-presentation)),
and non-gesture moves can be committed through `computeMove` plus `setValue`.

`GridController` is an adapter over the shared `DndProvider`: `GridZoneView`
renders through `SortableGrid` and `GridDragHandle` is `DragHandle`. The
`GridValue` is converted to the provider's layout state once per committed
value (ordered zones keep their strategy, item data keeps its identity), and
every candidate, `change`, `onDragEnd` event and validation issue comes back in
the grid API's shapes. Values without a `revision` receive a synthetic one that
advances with each layout change, so the legacy session-only response protocol
still works. `onDragEnd` fires once the drag preview has settled, as the grid
API always did (the provider's `onDragSettled` timing), and zones show no
destination indicator because neighbors move instead. Acceptance compares
layout and revision only, so an owner that derives new item data for the
destination zone (a dock item built from a page item) is still accepted.

The provider owns the native recognizers. Handles whose `gestureRelations`
name the same `block`, `requireToFail` and `simultaneousWith` gestures share one
Pan recognizer attached at the root; a touch that starts inside a handle's
view activates that item after the `activation.delayMs` long press, and a touch
elsewhere fails the recognizer at once so related gestures such as a paging
scroll can run. Mounting, re-rendering or unmounting a handle only updates the
group's hit-target list, so an edit-mode toggle that re-renders every item does
not rebuild native handlers; a new `activation.delayMs` or a new relation
signature reconfigures the affected recognizer once. A handle with `disabled`
is skipped by the hit test and interrupts its own active drag. `onDiagnostic`,
`waitForDragPreviewReady` and the `invalidateGeometry` handle are available on
both APIs. A drag reports one `request` per logical cell it enters and
`request-coalesced` for pointer movement inside that cell, so an observer can
tell a coalesced packet from one that never arrived.

`useGridState` reads the initial value once, returns `value`, `onChange`,
`setValue`, and `respond`, and uses the same reducer as `createGridStateStore`.
The example app uses this path. Initial and external values must be valid.
Use immutable updates; do not mutate values or item data in place.

`createGridStateStore(initialValue)` provides `getSnapshot`, `subscribe`,
`onChange`, `setValue`, and `respond` without React. Its snapshot is suitable for
`useSyncExternalStore`. An external store can use `respondToGridProposal`:

```ts
const proposal = {
  ...change,
  baseRevision: change.baseRevision!,
  value: { ...nextValue, revision: nextValue.revision! },
};
const result = respondToGridProposal(current, proposal, allowed);
// result.status: accepted | rejected | stale | invalid
// Publish result.value atomically, including both source and destination zones.
```

The revisioned controller emits `change.baseRevision`; the candidate revision
is the base plus one for a changed move. An unchanged move keeps its revision
and emits no proposal. A successful response contains `{sessionId,
baseRevision, accepted}`. The state helper checks the entire candidate,
preserves item data, and writes the response. Rejection keeps the current layout
and revision. Session IDs must uniquely identify attempts; a response is final.

External edits advance revision even if only `data` changed. During dragging or
calculation they cancel the session. During an outstanding proposal they
interrupt it. A response with an unrelated session or base revision is ignored;
an acceptance with the wrong candidate layout/revision is a mismatch, while item
data may change in the accepting commit. Missing responses expire after
`responseTimeoutMs` (default 2000ms). Cancellation and settling render the latest
authoritative state and never restore an old snapshot.

`canDrop` is the synchronous permission callback, invoked for preview and
release. It receives the completed candidate; return `{allowed: false, reason}`
to reject it. External asynchronous decisions may instead delay the `onChange`
response within the timeout. A custom external store owns response deduplication
and must recheck current revision at the moment it commits. The pure reducer
does not own session timers: discard callbacks for expired or cancelled sessions
before calling it.

For migration, `GridValue.revision` remains optional. Omitting it retains the
legacy session-only response protocol and layout-based invalidation. New code
should use the state hook or explicitly supply a monotonic, nonnegative safe
integer revision. Revision exhaustion is rejected rather than wrapped.

## Movement policies

Both root and `/engine` export `DEFAULT_GRID_MOVEMENT_POLICY`,
`HOME_GRID_MOVEMENT_POLICY`, `GridMovementPolicy`, `resolveGridMovementPolicy`,
and `validateGridMovementPolicy`.

```tsx
<GridController
  value={value}
  onChange={onChange}
  movementPolicy={HOME_GRID_MOVEMENT_POLICY}
  renderItem={renderItem}
>
  {zones}
</GridController>
```

Pass the same `movementPolicy` to `computeMove` when computing manually.
The default disables home-specific adjacent insert/exchange normalization and
full-width row rotation. The home preset explicitly enables both and preserves
the extracted behavior. The application still assigns `placement: 'insert'`
or `'exchange'`, grid sizes, IDs, and domain-specific permissions; library code
does not inspect `data` to classify items. Missing placement means exchange.

| Option                       | Meaning / default                                                      |
| ---------------------------- | ---------------------------------------------------------------------- |
| `rowRotation`                | `disabled`; `full-width` enables corridor rotation                     |
| `adjacentInsertExchange`     | `disabled`; `single-cell` enables the home compatibility rule          |
| `candidateOrder`             | `['row-rotation', 'insert', 'exchange']`; distinct rules, at least one |
| `pointer.cellHysteresis`     | 0.12 extra cell pitches beyond half a cell; range 0–0.5                |
| `pointer.exchangeThreshold`  | 0.8 cell pitches; range 0.5–1                                          |
| `pointer.boundaryHysteresis` | 4 React Native logical pixels; finite and nonnegative                  |

The first applicable rule owns the result, including rejection. Failure does
not fall through to a different move. An empty destination is allowed without
an exchange rule. `unresolved` means the search budget ran out; `impossible`
means the selected rule could not place the items. Neither commits partial work.

The engine and pointer logic share rule selection. Preview and release use the
same threshold-adjusted target. Policy settings are copied for each session;
changing policy during a drag cancels it. Search budget is also fixed at start.

### Preview baseline

Inside the zone a drag started in, every valid and permitted spatial candidate
becomes the baseline for the next target. An exchange shown on the way therefore
stays where the user saw it: moving a widget over a second widget and then over
a third swaps the third against the layout displayed at the second step, as
launchers do. Returning to a target visited earlier restores exactly that
preview, and the item's own cell always restores the committed layout. Insert
moves are path-independent, so apps arrange the same way as before.

The path is dropped whenever the display returns to the committed value:
leaving every zone, entering another zone, and a rejected or impossible
candidate. Ordered zones and zones other than the source always compute from
the committed value, so a cross-zone exchange stays impossible. `change.from`
is the committed location, the proposal is the displayed layout, and its
revision is the committed revision plus one regardless of the number of steps.
`computeMove` itself stays a pure function of its input; the session decides
which baseline it receives.

## Defaults and presentation

`GridController.searchBudget` and `computeMove.searchBudget` default to 10,000
search steps. `activation` defaults to `{delayMs: 250}`. Invalid explicit options
report validation issues and disable dragging. `packItems` still takes an
explicit search budget.

`motion` accepts `{durationMs?: number, reduceMotion?: 'system' | 'always' |
'never'}`. Defaults are 180ms and the system accessibility setting. `always`
uses zero duration. Both neighboring items and the settling preview use this
configuration. Native behavior still needs device verification.

Use `dragPreviewStyle`, `renderDragPreview`, and `renderItem` for appearance.
The fallback preview uses neutral gray colors. A custom preview can opt into
`waitForDragPreviewReady` and call `onReady` once its drawable content commits.
Existing diagnostic and drag lifecycle callbacks remain available.

## Shared layout contract

`LayoutState<T>` separates caller data (`items: {id, data}[]`) from zone layout:

- `GridLayoutZone`: `kind: 'grid'`, rows, columns, and placements containing
  `itemId`, position, span, and optional placement policy. An optional
  `itemSpan` makes the zone an ordered grid (a dock): every placement has that
  span, the array order is the item order, positions are the reading-order
  slots of that order, a move inserts at the addressed slot and re-packs,
  removal closes the gap, and capacity is the slot count.
- `ListLayoutZone`: `kind: 'list'`, vertical/horizontal orientation, and ordered
  item IDs. Size and drag-axis constraints are separate concerns.
- `MoveProposal<State, Location>`: session ID, item ID, base revision, source,
  destination, and the entire candidate state.

`validateLayoutState` checks unique item and zone IDs, references each item
exactly once, rejects unknown references, and checks grid geometry and list
orientation without reading caller data. It does not apply movement permissions.

`fromGridValue` bridges current grids to this contract and preserves revision
and data references. Ordered grid slots expand to explicit grid coordinates and
keep their `itemSpan`. `toGridValue` exports grid zones with an `itemSpan` as
ordered grids and the rest as spatial grids; it rejects list zones with
`unsupported-zone`. An ordered-grid round trip is therefore lossless. These
conversions do not implement list
rendering or transfers themselves; list↔grid transfers run through `DndProvider`
with a caller-supplied span (`getGridItemLayout`), validate the full candidate
and approve both zones together (see the [shared grid/list API](mixed-layout-api.md)).

## Coordinate and measurement contract

`RectMeasurement` records `space: 'screen' | 'content'`, `source: 'measured' |
'estimated'`, rectangle, revision, and monotonic `timestampMs`. `ZoneCoordinateContext`
contains a measured screen viewport and the current scroll offset. All lengths
use React Native logical pixels; padding is included in content coordinates.

`screenToContent` applies `screen - viewport origin + scroll offset`;
`contentToScreen` applies the inverse. Rect variants preserve measured/estimated
provenance and check the item's measurement as well as the viewport. Every call
requires a matching revision. Optional `nowMs` and `maxAgeMs` impose an age limit
in the same clock domain. Invalid/stale measurements return a reason, not a
usable rectangle. Scroll offsets may be negative for bounce/insets and do not
advance layout revision.

These pure helpers are exported from root and `/engine`. The list ScrollView and
FlatList adapters use observed offsets, ID-based size caches and remeasurement. The grid
gesture runtime still measures a fixed layout per session and cancels on geometry
changes. FlatList source-cell unmount during a drag is exercised by the Debug
driver and the Release touch fixture; the unified grid adapter is `SortableGrid`
in the [shared grid/list API](mixed-layout-api.md). Physical-device acceptance
remains open.
